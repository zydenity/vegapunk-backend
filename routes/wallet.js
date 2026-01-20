// server/routes/wallet.js
// Factory that builds a wallet router with injected mysql2/promise pool and auth middleware.

const express = require('express');
// If you're on Node < 18, ensure you installed: npm install node-fetch
const fetch = require('node-fetch');

// Fallback from .env (for when API fails)
const FALLBACK_USDT_PHP = Number(process.env.USDT_PHP_RATE || 58.0);

// VPK is an in-house token
// 0.01 USDT = 1 VPK  =>  1 USDT = 100 VPK
const RATE_USDT_TO_VPK = 100;

// Simple in-memory cache
let _cachedRate = FALLBACK_USDT_PHP;
let _cachedAt = 0; // timestamp in ms

// How long to keep a rate before refreshing
const RATE_TTL_MS = 60 * 1000; // 1 minute

async function getUsdtPhpRate() {
  const now = Date.now();

  if (now - _cachedAt < RATE_TTL_MS && _cachedRate) {
    return _cachedRate;
  }

  try {
    const url =
      'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=php';

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const rate = Number(data?.tether?.php);

    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error('Invalid rate from API');
    }

    _cachedRate = rate;
    _cachedAt = now;

    return rate;
  } catch (err) {
    console.error('getUsdtPhpRate failed, using fallback:', err.message);
    return FALLBACK_USDT_PHP;
  }
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

module.exports = function makeWalletRouter(db, requireAuth) {
  const router = express.Router();

  if (typeof requireAuth === 'function') {
    router.use(requireAuth);
  } else {
    router.use((req, res) => res.status(401).json({ error: 'Unauthorized' }));
    return router;
  }

  /**
   * GET /v1/wallet/balances
   * {
   *   balances: [{asset,balance}],
   *   totals: {
   *     USDT,
   *     VPK,
   *     TOTAL_USDT_EQ, // USDT + VPK/100
   *     PHP
   *   },
   *   rates: { USDT_PHP }
   * }
   */
  router.get('/v1/wallet/balances', async (req, res, next) => {
    try {
      const userId = req.userId;

      const [rows] = await db.query(
        `SELECT asset, COALESCE(SUM(balance),0) AS balance
           FROM wallet_balances
          WHERE user_id = ?
          GROUP BY asset
          ORDER BY asset`,
        [userId]
      );

      const balances = rows.map((r) => ({
        asset: r.asset,
        balance: String(r.balance ?? 0),
      }));

      const usdtRow = rows.find((r) => r.asset === 'USDT');
      const vpkRow  = rows.find((r) => r.asset === 'VPK');

      const usdt = toNum(usdtRow?.balance);
      const vpk  = toNum(vpkRow?.balance);

      const totalUsdtEq = usdt + (vpk / RATE_USDT_TO_VPK);
      const usdtPhpRate = await getUsdtPhpRate();

      res.json({
        balances,
        totals: {
          USDT: usdt,
          VPK: vpk,
          TOTAL_USDT_EQ: totalUsdtEq,
          PHP: totalUsdtEq * usdtPhpRate,
        },
        rates: {
          USDT_PHP: usdtPhpRate,
        },
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * GET /v1/wallet/ledger?limit=20&before=<id>
   */
  router.get('/v1/wallet/ledger', async (req, res, next) => {
    try {
      const userId = req.userId;
      const pageSize = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
      const beforeId = Number(req.query.before || 0);

      let sql = `
        SELECT id, ts, asset, chain, type, amount, ref_id, meta
          FROM wallet_ledger
         WHERE user_id = ?`;
      const args = [userId];

      if (beforeId > 0) {
        sql += ` AND id < ?`;
        args.push(beforeId);
      }

      sql += ` ORDER BY id DESC LIMIT ?`;
      args.push(pageSize + 1);

      const [rows] = await db.query(sql, args);
      const hasMore = rows.length > pageSize;
      const data = rows.slice(0, pageSize);

      const PLUS = new Set([
        'deposit',
        'refund',
        'transfer_in',
        'stake_payout',
        'stake_refund',
        'stake_referral',
        'referral_reward',
        'referral_bonus',
        'swap_in',
      ]);

      const MINUS = new Set([
        'withdraw',
        'transfer_out',
        'purchase',
        'fee',
        'stake_lock',
        'swap_out',
      ]);

      const items = data.map((r) => {
        let meta = null;
        try {
          meta =
            r.meta == null
              ? null
              : typeof r.meta === 'string'
              ? JSON.parse(r.meta)
              : r.meta;
        } catch {
          meta = null;
        }

        const base = toNum(r.amount);
        const signed =
          PLUS.has(r.type) ? base :
          MINUS.has(r.type) ? -base : base;

        const tsIso =
          r.ts instanceof Date ? r.ts.toISOString() : new Date(r.ts).toISOString();

        return {
          id: r.id,
          ts: tsIso,
          asset: r.asset,
          chain: r.chain,
          type: r.type,
          amount: signed,
          ref_id: r.ref_id,
          meta,
        };
      });

      res.json({
        items,
        next_before: hasMore ? items[items.length - 1].id : null,
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * POST /v1/wallet/swap
   * Body: { from_asset: 'USDT'|'VPK', to_asset: 'VPK'|'USDT', amount: <number in from_asset> }
   *
   * Rate:
   *   1 USDT = 100 VPK
   */
  router.post('/v1/wallet/swap', async (req, res, next) => {
    const userId = req.userId;
    const body = req.body || {};

    const fromAsset = String(body.from_asset || '').toUpperCase();
    const toAsset   = String(body.to_asset   || '').toUpperCase();
    const amountFrom = Number(body.amount);

    const supported =
      (fromAsset === 'USDT' && toAsset === 'VPK') ||
      (fromAsset === 'VPK' && toAsset === 'USDT');

    if (!supported) {
      return res.status(400).json({ error: 'PAIR_NOT_SUPPORTED' });
    }

    if (!Number.isFinite(amountFrom) || amountFrom <= 0) {
      return res.status(400).json({ error: 'BAD_AMOUNT' });
    }

    let amountUsdt = 0;
    let amountVpk = 0;

    if (fromAsset === 'USDT') {
      amountUsdt = amountFrom;
      amountVpk = amountUsdt * RATE_USDT_TO_VPK;
    } else {
      amountVpk = amountFrom;
      amountUsdt = RATE_USDT_TO_VPK === 0 ? 0 : (amountVpk / RATE_USDT_TO_VPK);
    }

    let conn;
    try {
      conn = await db.getConnection();
      await conn.beginTransaction();

      const [[row]] = await conn.query(
        `SELECT COALESCE(SUM(balance),0) AS bal
           FROM wallet_balances
          WHERE user_id = ? AND asset = ?`,
        [userId, fromAsset]
      );

      const currentBal = toNum(row?.bal);
      if (currentBal + 1e-9 < amountFrom) {
        await conn.rollback();
        return res.status(400).json({
          error: 'INSUFFICIENT_FUNDS',
          balance: currentBal,
        });
      }

      // Debit from_asset
      await conn.query(
        `INSERT INTO wallet_balances (user_id, asset, balance)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
        [userId, fromAsset, -amountFrom]
      );

      // Credit to_asset
      const creditTo = (toAsset === 'USDT') ? amountUsdt : amountVpk;
      await conn.query(
        `INSERT INTO wallet_balances (user_id, asset, balance)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
        [userId, toAsset, creditTo]
      );

      const meta = JSON.stringify({
        pair: `${fromAsset}->${toAsset}`,
        rate_usdt_to_vpk: RATE_USDT_TO_VPK,
        amount_usdt: amountUsdt,
        amount_vpk: amountVpk,
      });

      // Ledger: from out
      await conn.query(
        `INSERT INTO wallet_ledger
           (user_id, ts, asset, chain, type, amount, ref_id, meta)
         VALUES (?, NOW(), ?, ?, ?, ?, NULL, ?)`,
        [userId, fromAsset, 'BSC', 'swap_out', amountFrom, meta]
      );

      // Ledger: to in
      await conn.query(
        `INSERT INTO wallet_ledger
           (user_id, ts, asset, chain, type, amount, ref_id, meta)
         VALUES (?, NOW(), ?, ?, ?, ?, NULL, ?)`,
        [userId, toAsset, 'BSC', 'swap_in', creditTo, meta]
      );

      await conn.commit();

      res.json({
        ok: true,
        from_asset: fromAsset,
        to_asset: toAsset,
        amount_from: amountFrom,
        amount_usdt: amountUsdt,
        amount_vpk: amountVpk,
        rate: RATE_USDT_TO_VPK,
      });
    } catch (e) {
      if (conn) {
        try { await conn.rollback(); } catch (_) {}
      }
      next(e);
    } finally {
      if (conn) conn.release();
    }
  });

  return router;
};
