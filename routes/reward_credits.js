// /server/routes/reward_credits.js (CommonJS)
const express = require('express');
const { evaluateRewardCreditsForUser } = require('../lib/reward_credits');

function makeRewardCreditsRouter({ db, requireAuth }) {
  if (!db) throw new Error('reward_credits: db is required');
  if (typeof requireAuth !== 'function') throw new Error('reward_credits: requireAuth is required');

  const r = express.Router();

  // small helper
  const creditRefId = (creditId) => `reward_credit:${creditId}`;

  async function listCredits(req, res) {
    const userId = Number(req.userId || 0);
    if (!userId) return res.status(401).json({ error: 'NO_TOKEN' });

    const conn = await db.getConnection();
    try {
      // keep statuses fresh (non-fatal)
      try {
        await evaluateRewardCreditsForUser(conn, userId);
      } catch (e) {
        console.error('[reward credits] evaluate failed (non-fatal):', e?.message || e);
      }

      const [rows] = await conn.query(
        `
        SELECT id, user_id, amount_usdt, title, note, conditions_json, progress_json, status,
               created_at, claimable_at, claimed_at, expires_at, updated_at
          FROM reward_credits
         WHERE user_id=?
         ORDER BY id DESC
         LIMIT 200
        `,
        [userId]
      );

      return res.json({ ok: true, credits: rows });
    } catch (e) {
      console.error('[reward credits] list error:', e);
      return res.status(500).json({ error: 'SERVER_ERR' });
    } finally {
      conn.release();
    }
  }

  // ✅ Support BOTH:
  // - GET /v1/reward-credits
  // - GET /v1/rewards/credits   (Flutter)
  r.get('/', requireAuth, listCredits);
  r.get('/credits', requireAuth, listCredits);

  async function claimCredit(req, res) {
    const userId = Number(req.userId || 0);
    if (!userId) return res.status(401).json({ error: 'NO_TOKEN' });

    const creditId = Number(req.params.id);
    if (!Number.isFinite(creditId) || creditId <= 0) {
      return res.status(400).json({ error: 'BAD_CREDIT_ID' });
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      // keep status fresh (non-fatal)
      try {
        await evaluateRewardCreditsForUser(conn, userId);
      } catch (e) {
        console.error('[reward credits] evaluate failed (non-fatal):', e?.message || e);
      }

      const [[c]] = await conn.query(
        `SELECT * FROM reward_credits WHERE id=? FOR UPDATE`,
        [creditId]
      );

      if (!c || Number(c.user_id) !== Number(userId)) {
        await conn.rollback();
        return res.status(404).json({ error: 'NOT_FOUND' });
      }

      // ✅ expired handling: COMMIT the status change (no rollback)
      if (c.expires_at && new Date(c.expires_at) <= new Date()) {
        await conn.query(
          `UPDATE reward_credits SET status='expired', updated_at=NOW() WHERE id=?`,
          [creditId]
        );
        await conn.commit();
        return res.status(400).json({ error: 'EXPIRED' });
      }

      // already claimed -> idempotent response
      if (c.status === 'claimed') {
        await conn.rollback();
        return res.json({ ok: true, already: true, claimed_usdt: Number(c.amount_usdt || 0) });
      }

      if (c.status !== 'claimable') {
        await conn.rollback();
        return res.status(400).json({ error: 'NOT_CLAIMABLE', status: c.status });
      }

      const amt = Number(c.amount_usdt);
      if (!Number.isFinite(amt) || amt <= 0) {
        await conn.rollback();
        return res.status(400).json({ error: 'BAD_AMOUNT' });
      }

      // ✅ idempotency: filter by user_id + accept old numeric ref_id too
      const refNew = creditRefId(creditId);
      const [already] = await conn.query(
        `SELECT id
           FROM wallet_ledger
          WHERE user_id=?
            AND type='reward_credit'
            AND (ref_id=? OR ref_id=?)
          LIMIT 1`,
        [userId, refNew, String(creditId)]
      );

      if (already.length) {
        // ensure credit reflects claimed
        await conn.query(
          `UPDATE reward_credits SET status='claimed', claimed_at=COALESCE(claimed_at,NOW()), updated_at=NOW()
            WHERE id=?`,
          [creditId]
        );
        await conn.commit();
        return res.json({ ok: true, already: true, claimed_usdt: amt });
      }

      // credit wallet
      await conn.query(
        `INSERT INTO wallet_balances (user_id, asset, balance)
         VALUES (?, 'USDT', ?)
         ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
        [userId, amt]
      );

      await conn.query(
        `INSERT INTO wallet_ledger
           (user_id, ts, asset, chain, type, amount, ref_id, meta)
         VALUES (?, NOW(), 'USDT', 'SYSTEM', 'reward_credit', ?, ?, ?)`,
        [userId, amt, refNew, JSON.stringify({ creditId, title: c.title || null })]
      );

      await conn.query(
        `UPDATE reward_credits
            SET status='claimed', claimed_at=NOW(), updated_at=NOW()
          WHERE id=? AND status='claimable'`,
        [creditId]
      );

      await conn.commit();
      return res.json({ ok: true, claimed_usdt: amt });
    } catch (e) {
      await conn.rollback();
      console.error('claim reward credit error:', e);
      return res.status(500).json({ error: 'SERVER_ERR' });
    } finally {
      conn.release();
    }
  }

  // ✅ Support BOTH:
  // - POST /v1/reward-credits/:id/claim
  // - POST /v1/rewards/credits/:id/claim  (Flutter)
  r.post('/:id/claim', requireAuth, claimCredit);
  r.post('/credits/:id/claim', requireAuth, claimCredit);

  return r;
}

module.exports = makeRewardCreditsRouter;
