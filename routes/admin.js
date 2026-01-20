// routes/admin.js — Ph1taka Admin API (back-office)
const express = require('express');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const { z }   = require('zod');
const AIRDROP_TRIGGER_UNITS = Number(process.env.AIRDROP_TRIGGER_UNITS || 110);
/**
 * Factory to create the admin router.
 *
 * @param {object} opts
 * @param {import('mysql2/promise').Pool} opts.db
 * @param {string} opts.JWT_SECRET          - main app JWT secret
 * @param {Function} [opts.creditDepositAndWebhook] - optional helper from server.js
 */
module.exports = function makeAdminRouter({ db, JWT_SECRET, creditDepositAndWebhook }) {
  const router = express.Router();

  // Separate secret for admin tokens
  const ADMIN_JWT_SECRET =
    process.env.ADMIN_JWT_SECRET || (JWT_SECRET ? `${JWT_SECRET}_admin` : 'dev-admin-secret');

  /* ───────────────────── helpers ───────────────────── */

  function issueAdminJwt(admin) {
    return jwt.sign(
      {
        sub: admin.id,
        kind: 'admin',
        role: admin.role,
        name: admin.name,
        email: admin.email,
      },
      ADMIN_JWT_SECRET,
      { expiresIn: '7d' }
    );
  }

function requireAdmin(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';

  if (!token) return res.status(401).json({ error: 'NO_TOKEN' });

  try {
    const payload = jwt.verify(token, ADMIN_JWT_SECRET);

    if (payload.kind !== 'admin') {
      return res.status(401).json({
        error: 'BAD_TOKEN',
        detail: 'NOT_ADMIN_TOKEN',
        kind: payload.kind,
      });
    }

    req.adminId   = payload.sub;
    req.adminRole = payload.role;
    req.adminName = payload.name;

  req.admin = {
    id: payload.sub,
    role: payload.role,
  name: payload.name,
   email: payload.email,
  };
    return next();
  } catch (err) {
    console.log('[requireAdmin] verify fail:', err.message);
    return res.status(401).json({ error: 'BAD_TOKEN', detail: err.message });
  }
}

  function requireRole(...roles) {
    return (req, res, next) => {
      if (!req.adminRole || !roles.includes(req.adminRole)) {
        return res.status(403).json({ error: 'FORBIDDEN' });
      }
      next();
    };
  }

  // optionally expose guard to reuse outside if needed
  router.requireAdmin = requireAdmin;

  /* ───────────────────── AUTH ───────────────────── */

  // POST /admin/login { email, password }
  router.post('/login', async (req, res) => {
    try {
      const schema = z.object({
        email: z.string().email(),
        password: z.string().min(4),
      });

      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'BAD_BODY' });
      }

      const { email, password } = parsed.data;

      const [rows] = await db.query(
        'SELECT id, email, password_hash, name, role FROM admin_users WHERE email=? LIMIT 1',
        [email.toLowerCase()]
      );
      const admin = rows[0];
      if (!admin) return res.status(401).json({ error: 'BAD_LOGIN' });

      const ok = await bcrypt.compare(password, admin.password_hash);
      if (!ok) return res.status(401).json({ error: 'BAD_LOGIN' });

      const token = issueAdminJwt(admin);
      return res.json({
        token,
        admin: {
          id: admin.id,
          email: admin.email,
          name: admin.name,
          role: admin.role,
        },
      });
    } catch (e) {
      console.error('[ADMIN] login', e);
      res.status(500).json({ error: 'SERVER_ERR' });
    }
  });

  // GET /admin/me
  router.get('/me', requireAdmin, async (req, res) => {
    try {
      const [rows] = await db.query(
        'SELECT id, email, name, role, created_at FROM admin_users WHERE id=? LIMIT 1',
        [req.adminId]
      );
      if (!rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
      res.json(rows[0]);
    } catch (e) {
      console.error('[ADMIN] me', e);
      res.status(500).json({ error: 'SERVER_ERR' });
    }
  });

  /* ───────────────────── DASHBOARD SUMMARY ───────────────────── */

  // GET /admin/summary – quick stats for dashboard cards
  /* ───────────────────── DASHBOARD SUMMARY ───────────────────── */

  // GET /admin/summary – quick stats for dashboard cards
  router.get('/summary', requireAdmin, async (req, res) => {
    try {
      // ── users & KYC ─────────────────────────────────────────────
      const [[userCount]] = await db.query(
        'SELECT COUNT(*) AS total_users FROM users'
      );

      const [[kycCounts]] = await db.query(
        `SELECT
           SUM(status='pending')   AS kyc_pending,
           SUM(status='verified')  AS kyc_verified,
           SUM(status='rejected')  AS kyc_rejected
         FROM user_kyc`
      );

      // ── deposits ────────────────────────────────────────────────
      const [[depositCounts]] = await db.query(
        `SELECT
           SUM(status='pending')  AS dep_pending,
           SUM(status='credited') AS dep_credited
         FROM crypto_deposits`
      );

      // ── wallet totals ───────────────────────────────────────────
      const [[walletTotals]] = await db.query(
        `SELECT
           COALESCE(SUM(CASE WHEN asset='USDT' THEN balance ELSE 0 END),0) AS total_usdt,
           COALESCE(SUM(CASE WHEN asset='MHV'  THEN balance ELSE 0 END),0) AS total_mhv
         FROM wallet_balances`
      );

      // ── staking: pool + rounds + progress ──────────────────────
      const [[stakingPool]] = await db.query(
        `SELECT COALESCE(SUM(amount_usdt),0) AS pool_usdt
           FROM staking_positions
          WHERE status='active'`
      );

      const [[airdropStats]] = await db.query(
        `SELECT
           COUNT(*) AS rounds_done,
           COALESCE(SUM(airdrop_units),0) AS total_airdrops
         FROM staking_airdrops`
      );

      const [[unitsRow]] = await db.query(
        `SELECT COALESCE(SUM(units),0) AS total_units
           FROM staking_positions`
      );

      const totalUnits  = Number(unitsRow?.total_units || 0);
      const roundsDone  = Number(airdropStats?.rounds_done || 0);
      const triggerSize = AIRDROP_TRIGGER_UNITS;

      const unitsUsed        = roundsDone * triggerSize;
      let unitsIntoCurrent   = totalUnits - unitsUsed;
      if (!Number.isFinite(unitsIntoCurrent) || unitsIntoCurrent < 0) {
        unitsIntoCurrent = 0;
      }
      const progressToNext = triggerSize > 0
        ? Math.max(0, Math.min(1, unitsIntoCurrent / triggerSize))
        : 0;

      // ── referrals: global aggregates ────────────────────────────
      const [[refAgg]] = await db.query(
        `SELECT
           COUNT(*) AS total_events,
           COALESCE(SUM(CASE WHEN status='pending'  AND asset='USDT'
                             THEN commission_amount END),0) AS pending_usdt,
           COALESCE(SUM(CASE WHEN status='credited' AND asset='USDT'
                             THEN commission_amount END),0) AS lifetime_usdt
         FROM referral_events`
      );

      const [[refCounts]] = await db.query(
        `SELECT
           COUNT(DISTINCT referee_id) AS total_referred,
           COUNT(DISTINCT CASE WHEN u.pin_hash IS NOT NULL
                               THEN referee_id END) AS active_referred
         FROM referral_events e
         LEFT JOIN users u ON u.id = e.referee_id`
      );

      // ── response ────────────────────────────────────────────────
      res.json({
        users: {
          total: Number(userCount.total_users || 0),
        },
        kyc: {
          pending:  Number(kycCounts.kyc_pending  || 0),
          verified: Number(kycCounts.kyc_verified || 0),
          rejected: Number(kycCounts.kyc_rejected || 0),
        },
        deposits: {
          pending:  Number(depositCounts.dep_pending  || 0),
          credited: Number(depositCounts.dep_credited || 0),
        },
        wallet: {
          total_usdt: Number(walletTotals.total_usdt || 0),
          total_mhv:  Number(walletTotals.total_mhv  || 0),
        },

        // NEW: staking block
        staking: {
          pool_usdt:       Number(stakingPool?.pool_usdt || 0),
          rounds_done:     roundsDone,
          total_airdrops:  Number(airdropStats?.total_airdrops || 0),
          trigger_units:   triggerSize,
          units_into_current: unitsIntoCurrent,
          progress_to_next:   progressToNext, // 0..1
        },

        // NEW: referrals block
        referrals: {
          total_events:          Number(refAgg?.total_events || 0),
          lifetime_rewards_usdt: Number(refAgg?.lifetime_usdt || 0),
          pending_rewards_usdt:  Number(refAgg?.pending_usdt || 0),
          total_referred:        Number(refCounts?.total_referred || 0),
          active_referred:       Number(refCounts?.active_referred || 0),
        },
      });
    } catch (e) {
      console.error('[ADMIN] summary', e);
      res.status(500).json({ error: 'SERVER_ERR' });
    }
  });


  /* ───────────────────── WALLET USERS ───────────────────── */

  // GET /admin/wallet/users?limit=&offset=
  // GET /admin/wallet/users?limit=&offset=
// GET /admin/wallet/users?limit=&offset=
router.get('/wallet/users', requireAdmin, async (req, res) => {
  try {
    const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    const [rows] = await db.query(
      `SELECT
          u.id,
          COALESCE(CONCAT(k.first_name, ' ', k.last_name), u.full_name) AS display_name,
          u.full_name,
          u.phone,
          u.email,
          COALESCE(SUM(CASE WHEN w.asset='USDT' THEN w.balance ELSE 0 END),0) AS usdt_balance,
          COALESCE(SUM(CASE WHEN w.asset='MHV'  THEN w.balance ELSE 0 END),0) AS mhv_balance,
          MIN(wb.ts_first) AS first_tx_at,
          MAX(wb.ts_last)  AS last_tx_at,
          COALESCE(k.status, 'unverified') AS kyc_status
       FROM users u
       LEFT JOIN wallet_balances w
              ON w.user_id = u.id
       LEFT JOIN (
           SELECT user_id,
                  MIN(ts) AS ts_first,
                  MAX(ts) AS ts_last
             FROM wallet_ledger
            GROUP BY user_id
       ) wb ON wb.user_id = u.id
       LEFT JOIN (
           SELECT k2.user_id,
                  k2.status,
                  k2.first_name,
                  k2.last_name
             FROM user_kyc k2
             JOIN (
                 SELECT user_id, MAX(id) AS max_id
                   FROM user_kyc
                  GROUP BY user_id
             ) latest
               ON latest.user_id = k2.user_id
              AND latest.max_id  = k2.id
       ) k ON k.user_id = u.id
      WHERE u.id NOT IN (54, 107)          -- 👈 hide these IDs
      GROUP BY u.id
      ORDER BY u.id DESC
      LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    res.json(rows);
  } catch (e) {
    console.error('[ADMIN] wallet/users', e);
    res.status(500).json({ error: 'SERVER_ERR' });
  }
});




  // GET /admin/wallet/users/:id – full wallet view for one user
  router.get('/wallet/users/:id', requireAdmin, async (req, res) => {
    try {
      const userId = Number(req.params.id);
      if (!userId) return res.status(400).json({ error: 'BAD_ID' });

      const [[user]] = await db.query(
        'SELECT id, full_name, phone, email, created_at FROM users WHERE id=? LIMIT 1',
        [userId]
      );
      if (!user) return res.status(404).json({ error: 'NOT_FOUND' });

      const [balances] = await db.query(
        'SELECT asset, balance FROM wallet_balances WHERE user_id=?',
        [userId]
      );

      const [ledger] = await db.query(
        `SELECT id, ts, asset, chain, type, amount, ref_id, meta
           FROM wallet_ledger
          WHERE user_id=?
          ORDER BY id DESC
          LIMIT 200`,
        [userId]
      );

      res.json({
        user,
        balances,
        ledger: ledger.map((r) => ({
          id: r.id,
          ts: r.ts,
          asset: r.asset,
          chain: r.chain,
          type: r.type,
          amount: (r.amount ?? 0).toString(),
          ref_id: r.ref_id,
          meta: r.meta
            ? typeof r.meta === 'string'
              ? (() => {
                  try { return JSON.parse(r.meta); } catch { return r.meta; }
                })()
              : r.meta
            : null,
        })),
      });
    } catch (e) {
      console.error('[ADMIN] wallet/users/:id', e);
      res.status(500).json({ error: 'SERVER_ERR' });
    }
  });

  /* ───────────────────── KYC MANAGEMENT ───────────────────── */

  // GET /admin/kyc/pending
  router.get('/kyc/pending', requireAdmin, async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT k.id,
                k.user_id,
                k.status,
                k.rejection_reason,
                k.created_at,
                k.updated_at,
                u.full_name,
                u.phone,
                u.email
           FROM user_kyc k
           LEFT JOIN users u ON u.id = k.user_id
          WHERE k.status='pending'
          ORDER BY k.created_at ASC
          LIMIT 200`
      );
      res.json(rows);
    } catch (e) {
      console.error('[ADMIN] kyc/pending', e);
      res.status(500).json({ error: 'SERVER_ERR' });
    }
  });
  // GET /admin/kyc/rejected
  router.get('/kyc/rejected', requireAdmin, async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT k.id,
                k.user_id,
                k.status,
                k.rejection_reason,
                k.created_at,
                k.updated_at,
                u.full_name,
                u.phone,
                u.email
           FROM user_kyc k
           LEFT JOIN users u ON u.id = k.user_id
          WHERE k.status='rejected'
          ORDER BY k.updated_at DESC, k.created_at DESC
          LIMIT 200`
      );
      res.json(rows);
    } catch (e) {
      console.error('[ADMIN] kyc/rejected', e);
      res.status(500).json({ error: 'SERVER_ERR' });
    }
  });

  // GET /admin/kyc/:id – view one KYC
  router.get('/kyc/:id', requireAdmin, async (req, res) => {
    try {
      const kycId = Number(req.params.id);
      if (!kycId) return res.status(400).json({ error: 'BAD_ID' });

      const [[row]] = await db.query(
        `SELECT k.*,
                u.full_name,
                u.phone,
                u.email
           FROM user_kyc k
           LEFT JOIN users u ON u.id = k.user_id
          WHERE k.id=?`,
        [kycId]
      );
      if (!row) return res.status(404).json({ error: 'NOT_FOUND' });

      res.json(row);
    } catch (e) {
      console.error('[ADMIN] kyc/:id', e);
      res.status(500).json({ error: 'SERVER_ERR' });
    }
  });
  // GET /admin/kyc/:id/duplicates – inspect possible duplicate accounts
  router.get('/kyc/:id/duplicates', requireAdmin, async (req, res) => {
    try {
      const kycId = Number(req.params.id);
      if (!kycId) return res.status(400).json({ error: 'BAD_ID' });

      const [[row]] = await db.query(
        `SELECT k.id,
                k.user_id,
                u.full_name,
                u.phone,
                u.email
           FROM user_kyc k
           LEFT JOIN users u ON u.id = k.user_id
          WHERE k.id=? LIMIT 1`,
        [kycId]
      );
      if (!row) return res.status(404).json({ error: 'NOT_FOUND' });

      const baseUserId = row.user_id;
      if (!baseUserId) {
        // No user associated → nothing to compare
        return res.json([]);
      }

      const [dups] = await db.query(
        `SELECT u2.id        AS user_id,
                u2.full_name AS full_name,
                u2.phone     AS phone,
                u2.email     AS email,
                COALESCE(k2.status, 'none') AS kyc_status
           FROM users u0
           JOIN users u2
             ON u2.id <> u0.id
            AND (
                  (u0.phone IS NOT NULL AND u0.phone <> '' AND u2.phone = u0.phone)
               OR (u0.email IS NOT NULL AND u0.email <> '' AND u2.email = u0.email)
               OR (u0.full_name IS NOT NULL AND u0.full_name <> '' AND u2.full_name = u0.full_name)
            )
           LEFT JOIN user_kyc k2 ON k2.user_id = u2.id
          WHERE u0.id = ?
          GROUP BY u2.id
          ORDER BY u2.id DESC
          LIMIT 50`,
        [baseUserId]
      );

      res.json(dups);
    } catch (e) {
      console.error('[ADMIN] kyc/duplicates', e);
      res.status(500).json({ error: 'SERVER_ERR' });
    }
  });

  // POST /admin/kyc/:id/decision { action: 'approve' | 'reject', reason? }
  // POST /admin/kyc/:id/decision { action: 'approve' | 'reject', reason? }
  // POST /admin/kyc/:id/decision { action: 'approve' | 'reject', reason? }
  router.post('/kyc/:id/decision', requireAdmin, async (req, res) => {
    try {
      const kycId = Number(req.params.id);
      if (!kycId) return res.status(400).json({ error: 'BAD_ID' });

      const schema = z.object({
        action: z.enum(['approve', 'reject']),
        reason: z.string().max(255).optional(),
      });

      const parsed = schema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'BAD_BODY' });
      }

      const { action, reason } = parsed.data;

      const [[kyc]] = await db.query(
        'SELECT id, user_id, status FROM user_kyc WHERE id=? LIMIT 1',
        [kycId]
      );
      if (!kyc) return res.status(404).json({ error: 'NOT_FOUND' });

      const currentStatus = kyc.status; // 'unverified' | 'pending' | 'verified' | 'rejected'

      if (action === 'approve') {
        // ✅ allow re-approval from pending OR rejected
        if (currentStatus !== 'pending' && currentStatus !== 'rejected') {
          return res
            .status(400)
            .json({ error: 'INVALID_STATE', status: currentStatus });
        }

        await db.query(
          `UPDATE user_kyc
              SET status='verified',
                  rejection_reason=NULL,
                  updated_at=NOW()
            WHERE id=?`,
          [kycId]
        );
      } else {
        // reject allowed from pending or verified
        if (currentStatus !== 'pending' && currentStatus !== 'verified') {
          return res
            .status(400)
            .json({ error: 'INVALID_STATE', status: currentStatus });
        }

        await db.query(
          `UPDATE user_kyc
              SET status='rejected',
                  rejection_reason=?,
                  updated_at=NOW()
            WHERE id=?`,
          [reason || '', kycId]
        );
      }

      // final response
      res.json({
        ok: true,
        id: kycId,
        status: action === 'approve' ? 'verified' : 'rejected',
      });
    } catch (e) {
      console.error('[ADMIN] kyc decision', e);
      res.status(500).json({ error: 'SERVER_ERR' });
    }
  });





  /* ───────────────────── DEPOSITS ───────────────────── */

  // GET /admin/deposits/pending
  router.get('/deposits/pending', requireAdmin, async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT d.id,
                d.user_id,
                u.full_name,
                u.phone,
                u.email,
                d.chain,
                d.asset,
                d.address,
                d.tx_hash,
                d.amount_expected,
                d.amount_received,
                d.confirmations,
                d.required_confirmations,
                d.status,
                d.created_at
           FROM crypto_deposits d
           LEFT JOIN users u ON u.id = d.user_id
          WHERE d.status='pending'
          ORDER BY d.created_at DESC
          LIMIT 200`
      );
      res.json(rows);
    } catch (e) {
      console.error('[ADMIN] deposits/pending', e);
      res.status(500).json({ error: 'SERVER_ERR' });
    }
  });

  // POST /admin/deposits/:id/credit – manual credit (superadmin only)
  router.post(
    '/deposits/:id/credit',
    requireAdmin,
    requireRole('superadmin'),
    async (req, res) => {
      try {
        if (!creditDepositAndWebhook) {
          return res.status(501).json({ error: 'CREDIT_HELPER_NOT_CONFIGURED' });
        }

        const depositId = Number(req.params.id);
        if (!depositId) return res.status(400).json({ error: 'BAD_ID' });

        const schema = z.object({
          amount: z.union([z.string(), z.number()]).optional(),
          tx_hash: z.string().optional(),
        });
        const parsed = schema.safeParse(req.body || {});
        if (!parsed.success) return res.status(400).json({ error: 'BAD_BODY' });

        const { amount, tx_hash } = parsed.data;

        await creditDepositAndWebhook({
          depositId,
          amount,
          txHash: tx_hash,
          meta: { source: 'admin_manual', by_admin: req.adminId },
        });

        res.json({ ok: true, depositId });
      } catch (e) {
        console.error('[ADMIN] deposits credit', e);
        res.status(500).json({
          error: 'CREDIT_FAILED',
          detail: String(e.message || e),
        });
      }
    }
  );

  return router;
};
