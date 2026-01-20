// MOCK endpoints for local testing against your schema
// - POST /v1/deposits/crypto            -> create intent (DB row in crypto_deposits)
// - GET  /v1/deposits/status/:id        -> auto-progress + auto-credit wallet on first 'credited'
// - POST /dev/deposits/:id/set          -> force confirmations/amount (mirrors to DB; credits if >= REQUIRED)
// - POST /dev/deposits/:id/credit       -> manual credit (idempotent)
// - GET  /dev/last                      -> last mock id
// - GET  /dev/list                      -> list intents in memory
// - POST /dev/reset                     -> reset in-memory mock state

const express = require('express');
const mysql = require('mysql2/promise');

module.exports = function makeDepositsMock(requireAuth, poolArg) {
  const router = express.Router();
  router.use(express.json());

  // 🔐 protect all mock routes
  if (typeof requireAuth === 'function') {
    router.use(requireAuth);
  } else {
    router.use((_req, res) => res.status(401).json({ error: 'Unauthorized' }));
    return router;
  }

  const REQUIRED = Number(process.env.CONFIRMATIONS_REQUIRED || 12);

  // Reuse external pool if provided; else create a local one
  const pool =
    poolArg ||
    mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
      database: process.env.DB_NAME || 'ph1taka',
      waitForConnections: true,
      connectionLimit: 10,
    });

  // In-memory mirror of live intents: id -> { userId, chain, asset, address, status, conf, amountReceived }
  const depot = new Map();

  const getUserId = (req) => Number(req.userId);
  const mkAddr = () => '0x' + [...Array(40)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

  /* ───────────── DB helpers ───────────── */

  async function insertDepositRow({ userId, chain, asset, network_symbol, address, required }) {
    const sql = `
      INSERT INTO crypto_deposits
        (user_id, chain, asset, network_symbol, address, address_index,
         amount_expected, tx_hash, amount_received, confirmations, required_confirmations,
         status, swept, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, 0, ?, 'pending', 0, NOW(), NOW())
    `;
    const [r] = await pool.query(sql, [userId, chain, asset, network_symbol, address, required]);
    return r.insertId;
  }

  async function mirrorDeposit({ id, status, confirmations, amount_received }) {
    const sql = `
      UPDATE crypto_deposits
         SET status = ?,
             confirmations = ?,
             amount_received = CASE WHEN ? IS NULL THEN amount_received ELSE ? END,
             updated_at = NOW()
       WHERE id = ?
    `;
    await pool.query(sql, [status, confirmations, amount_received, amount_received, id]);
  }

  // Idempotent wallet credit. Reads user/asset/chain from crypto_deposits.
  async function creditWalletTxDb({ depositId, amount, required }) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [depRows] = await conn.query(
        `SELECT user_id, asset, chain FROM crypto_deposits WHERE id = ? FOR UPDATE`,
        [depositId]
      );
      if (!depRows.length) throw new Error('deposit_not_found');
      const { user_id: userId, asset, chain } = depRows[0];

      // If ledger already has this deposit, no-op (idempotent)
      const [exists] = await conn.query(
        `SELECT id FROM wallet_ledger WHERE type='deposit' AND ref_id=? LIMIT 1`,
        [depositId]
      );
      if (exists.length) {
        await conn.commit();
        return;
      }

      // Upsert wallet_balances (ensure UNIQUE(user_id, asset) exists for best behavior)
      await conn.query(
        `INSERT INTO wallet_balances (user_id, asset, balance)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
        [userId, asset, amount]
      );

      // Insert ledger row
      await conn.query(
        `INSERT INTO wallet_ledger (user_id, ts, asset, chain, type, amount, ref_id, meta)
         VALUES (?, NOW(), ?, ?, 'deposit', ?, ?, ?)`,
        [userId, asset, chain, amount, depositId, JSON.stringify({ mock: true })]
      );

      // Mark deposit credited (don’t clobber existing tx/amount if already set)
      await conn.query(
        `UPDATE crypto_deposits
            SET status='credited',
                confirmations = GREATEST(COALESCE(confirmations,0), ?),
                amount_received = COALESCE(amount_received, ?),
                tx_hash = COALESCE(tx_hash, ?),
                updated_at = NOW()
          WHERE id = ?`,
        [required, amount, `MOCK-TX-${depositId}`, depositId]
      );

      await conn.commit();
      console.log('[MOCK] Credited deposit -> ledger/balance', { depositId, userId, asset, amount });
    } catch (e) {
      await conn.rollback();
      console.error('[MOCK] creditWalletTxDb error', e);
      throw e;
    } finally {
      conn.release();
    }
  }

  /* ───────────── Routes ───────────── */

  // Create intent -> DB row + in-memory
  router.post('/v1/deposits/crypto', async (req, res) => {
    try {
      const userId = getUserId(req);
      const asset = String(req.body?.asset || 'USDT').toUpperCase();
      const chain = String(req.body?.chain || 'BSC').toUpperCase();
      const network_symbol = chain; // or 'BEP20'
      const address = mkAddr();

      const id = await insertDepositRow({
        userId, chain, asset, network_symbol, address, required: REQUIRED,
      });

      depot.set(id, {
        userId, chain, asset, network_symbol, address,
        status: 'pending', conf: 0, amountReceived: null,
      });

      res.json({
        id, address, chain, asset,
        required_confirmations: REQUIRED,
        status: 'pending',
      });
    } catch (err) {
      console.error('[MOCK] create_intent_failed', err);
      res.status(500).json({ error: 'create_intent_failed', detail: String(err.message || err) });
    }
  });

  // Poll -> auto-progress + auto-credit + mirror to DB
  router.get('/v1/deposits/status/:id', async (req, res) => {
    const id = Number(req.params.id);
    const d = depot.get(id);
    if (!d) return res.status(404).json({ error: 'not_found' });

    try {
      if (d.status === 'pending') d.status = 'seen';
      else if (d.status === 'seen') { d.status = 'confirming'; d.conf = 1; }
      else if (d.status === 'confirming' && d.conf < REQUIRED) {
        d.conf++;
if (d.conf >= REQUIRED) {
  d.status = 'credited';
  if (!d.amountReceived) d.amountReceived = '100000.00';

  // auto-credit ledger + balance (idempotent)
  await creditWalletTxDb({
    depositId: id,
    amount: d.amountReceived,
    required: REQUIRED,
  });
}

      }

      await mirrorDeposit({ id, status: d.status, confirmations: d.conf, amount_received: d.amountReceived });

      res.json({
        id,
        status: d.status,
        confirmations: d.conf,
        required_confirmations: REQUIRED,
        amount_received: d.amountReceived,
        chain: d.chain,
        asset: d.asset,
        address: d.address,
      });
    } catch (err) {
      console.error('[MOCK] status_failed', err);
      res.status(500).json({ error: 'status_failed', detail: String(err.message || err) });
    }
  });

  // Dev: force confirmations/amount (credits if conf >= REQUIRED)
  router.post('/dev/deposits/:id/set', async (req, res) => {
    const id = Number(req.params.id);
    const d = depot.get(id);
    if (!d) return res.status(404).json({ error: 'not_found' });

    try {
      let { conf, amount } = req.body || {};
      conf = Number(conf ?? d.conf);
      if (!Number.isFinite(conf)) conf = d.conf;
      conf = Math.max(0, Math.min(REQUIRED, conf));

      if (conf === 0) { d.status = 'pending'; d.conf = 0; d.amountReceived = null; }
      else if (conf === 1) { d.status = 'seen'; d.conf = 0; d.amountReceived = null; }
      else if (conf > 1 && conf < REQUIRED) { d.status = 'confirming'; d.conf = conf; }
      else { d.status = 'credited'; d.conf = REQUIRED; if (amount != null) d.amountReceived = String(amount); }

      if (d.status === 'credited' && d.amountReceived) {
        await creditWalletTxDb({ depositId: id, amount: d.amountReceived, required: REQUIRED });
      }

      await mirrorDeposit({ id, status: d.status, confirmations: d.conf, amount_received: d.amountReceived });
      res.json({ ok: true, id, state: d });
    } catch (err) {
      console.error('[MOCK] dev_set_failed', err);
      res.status(500).json({ error: 'dev_set_failed', detail: String(err.message || err) });
    }
  });

  // Dev: manual credit (idempotent)
  router.post('/dev/deposits/:id/credit', async (req, res) => {
    const depositId = Number(req.params.id);
    const amount = String(req.body?.amount ?? '12.34');
    try {
      const d = depot.get(depositId) || {};
      d.status = 'credited';
      d.conf = REQUIRED;
      d.amountReceived = amount;
      depot.set(depositId, d);

      await creditWalletTxDb({ depositId, amount, required: REQUIRED });

      res.json({ ok: true, id: depositId, state: d });
    } catch (err) {
      console.error('[MOCK] dev_credit_failed', err);
      res.status(500).json({ error: 'dev_credit_failed', detail: String(err.message || err) });
    }
  });

  // Dev utils
  router.get('/dev/last', (_req, res) =>
    res.json({ lastId: Math.max(0, [...depot.keys()].sort((a, b) => b - a)[0] || 0) })
  );
  router.get('/dev/list', (_req, res) =>
    res.json({ items: [...depot.entries()].map(([id, s]) => ({ id, ...s })) })
  );
  router.post('/dev/reset', (_req, res) => { depot.clear(); res.json({ ok: true }); });

  return router;
};
