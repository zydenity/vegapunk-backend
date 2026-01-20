// /server/routes/admin_reward_credits.js (CommonJS)
const express = require('express');
const { z } = require('zod');
const { evaluateRewardCreditsForUser } = require('../lib/reward_credits');
const { notifyRewardCreditEmailsForUser } = require('../lib/notify_reward_credits');

module.exports = function makeAdminRewardCreditsRouter({ db, requireAdmin }) {
  if (!db) throw new Error('makeAdminRewardCreditsRouter: db is required');
  if (typeof requireAdmin !== 'function') {
    throw new Error('makeAdminRewardCreditsRouter: requireAdmin is required');
  }

  const r = express.Router();
  r.use(requireAdmin);

  // ───────────────── helpers ─────────────────
  const safeJson = (v) => {
    if (v == null) return null;
    if (typeof v === 'object') return v;
    if (typeof v === 'string' && v.trim() !== '') {
      try {
        return JSON.parse(v);
      } catch (_) {
        return null;
      }
    }
    return null;
  };

  // DB enum -> Flutter status
  const toAppStatus = (dbStatus) => {
    switch ((dbStatus || '').toLowerCase()) {
      case 'locked':
        return 'pending';
      case 'claimable':
        return 'eligible';
      case 'claimed':
        return 'credited';
      case 'expired':
        return 'expired';
      case 'cancelled':
        return 'expired';
      default:
        return 'pending';
    }
  };

  // Extract "done" counters from progress_json (supports multiple key styles)
  function pickProgressNumber(progress, keys, def = 0) {
    if (!progress || typeof progress !== 'object') return def;
    for (const k of keys) {
      const v = progress[k];
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
    }
    return def;
  }

  function normalizeCreditRow(row) {
    const conditions = safeJson(row.conditions_json) || {};
    const progress = safeJson(row.progress_json) || null;

    const depositUsdtMin = Number(conditions.deposit_usdt_min || conditions.depositUsdtMin || 0);
    const depositSource = (conditions.deposit_source || conditions.depositSource || 'any').toString();
    const referralsMin = Number(conditions.referrals_min || conditions.referralsMin || 0);

    const depositUsdtDone = pickProgressNumber(
      progress,
      ['depositUsdtDone', 'deposit_usdt_done', 'deposit_done', 'depositDone'],
      0
    );

    const referralsDone = pickProgressNumber(
      progress,
      ['referralsDone', 'referrals_done', 'ref_done', 'refDone'],
      0
    );

    return {
      id: Number(row.id),
      userId: Number(row.user_id),
      status: toAppStatus(row.status),
      amountUsdt: Number(row.amount_usdt || 0),
      title: row.title || null,
      note: row.note || null,

      requirements: {
        depositUsdtMin,
        depositSource,
        referralsMin,
      },

      progress: progress
        ? {
            ...progress,
            depositUsdtMin,
            depositUsdtDone,
            depositSource,
            referralsMin,
            referralsDone,
          }
        : {
            depositUsdtMin,
            depositUsdtDone,
            depositSource,
            referralsMin,
            referralsDone,
          },

      expiresAt: row.expires_at || null,
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,

      depositUsdtMin,
      depositUsdtDone,
      depositSource,
      referralsMin,
      referralsDone,
    };
  }

  async function buildStatusMap(userIds) {
    if (!userIds.length) return {};

    const [counts] = await db.query(
      `
      SELECT user_id,
             SUM(CASE WHEN status='locked' THEN 1 ELSE 0 END) AS pending,
             SUM(CASE WHEN status='claimable' THEN 1 ELSE 0 END) AS eligible,
             SUM(CASE WHEN status='claimed' THEN 1 ELSE 0 END) AS credited,
             SUM(CASE WHEN status IN ('expired','cancelled') THEN 1 ELSE 0 END) AS expired
        FROM reward_credits
       WHERE user_id IN (?)
       GROUP BY user_id
      `,
      [userIds]
    );

    const [latest] = await db.query(
      `
      SELECT rc.*
        FROM reward_credits rc
        JOIN (
          SELECT user_id, MAX(id) AS max_id
            FROM reward_credits
           WHERE user_id IN (?)
           GROUP BY user_id
        ) x ON x.max_id = rc.id
      `,
      [userIds]
    );

    const out = {};
    for (const uid of userIds) {
      out[uid] = {
        counts: { pending: 0, eligible: 0, credited: 0, expired: 0 },
        latest: null,
      };
    }

    for (const c of counts) {
      out[c.user_id] = out[c.user_id] || { counts: {}, latest: null };
      out[c.user_id].counts = {
        pending: Number(c.pending || 0),
        eligible: Number(c.eligible || 0),
        credited: Number(c.credited || 0),
        expired: Number(c.expired || 0),
      };
    }

    for (const row of latest) {
      const uid = row.user_id;
      const progress = safeJson(row.progress_json);

      out[uid] =
        out[uid] || {
          counts: { pending: 0, eligible: 0, credited: 0, expired: 0 },
          latest: null,
        };

      out[uid].latest = {
        id: Number(row.id),
        status: toAppStatus(row.status),
        amountUsdt: Number(row.amount_usdt || 0),
        title: row.title || null,
        expiresAt: row.expires_at || null,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
        progress,
      };
    }

    return out;
  }

  // ───────────────── CREATE CREDIT ─────────────────
  const Num = z.union([z.number(), z.string().regex(/^\d+(\.\d+)?$/).transform(Number)]);

  const RequirementsSchema = z
    .object({
      depositUsdtMin: Num.optional().default(0).transform(Number),
      depositSource: z.enum(['any', 'coinsph', 'binance']).optional().default('any'),
      referralsMin: z
        .union([z.number().int(), z.string().regex(/^\d+$/).transform(Number)])
        .optional()
        .default(0),
    })
    .optional()
    .default({});

  const CreateSchema = z.object({
    userId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)]),
    amountUsdt: Num.refine((v) => Number.isFinite(v) && v > 0, 'amountUsdt must be > 0'),
    title: z.string().max(120).optional(),
    note: z.string().max(2000).optional(),
    requirements: RequirementsSchema,
    expiresAt: z.string().datetime().optional(),
  });

  async function handleCreate(req, res) {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'BAD_BODY', details: parsed.error.flatten() });
    }

    const adminId = req.admin?.id ?? req.adminId ?? null;
    if (!adminId) return res.status(401).json({ error: 'UNAUTHORIZED' });

    const { userId, amountUsdt, title, note, requirements, expiresAt } = parsed.data;

    const conditions = {
      deposit_usdt_min: Number(requirements.depositUsdtMin || 0),
      deposit_source: requirements.depositSource || 'any',
      referrals_min: Number(requirements.referralsMin || 0),
    };

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const [ins] = await conn.query(
        `
        INSERT INTO reward_credits
          (user_id, amount_usdt, title, note, conditions_json, status, created_by, expires_at)
        VALUES (?, ?, ?, ?, ?, 'locked', ?, ?)
        `,
        [
          userId,
          Number(amountUsdt),
          title ?? null,
          note ?? null,
          JSON.stringify(conditions),
          adminId,
          expiresAt ? new Date(expiresAt) : null,
        ]
      );

      try {
        await evaluateRewardCreditsForUser(conn, userId);
      } catch (e) {
        console.error('[admin reward credits] evaluate failed (non-fatal):', e?.message || e);
      }

      await conn.commit();

      // ✅ notify once (assigned/eligible/credited)
      notifyRewardCreditEmailsForUser(db, userId).catch((e) => {
        console.error('[reward credits] notify email failed (non-fatal):', e?.message || e);
      });

      return res.json({ ok: true, id: ins.insertId, creditId: ins.insertId });
    } catch (e) {
      await conn.rollback();
      console.error('admin create credit error:', e);
      return res.status(500).json({ error: 'SERVER_ERR' });
    } finally {
      conn.release();
    }
  }

  r.post('/', handleCreate);
  r.post('/credits', handleCreate);

  // ───────────────── LIST CREDITS ─────────────────
  r.get('/credits', async (req, res) => {
    const userId = Number(req.query.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ error: 'BAD_USER_ID' });
    }

    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const offset = Math.max(0, Number(req.query.offset || 0));

    try {
      const [rows] = await db.query(
        `
        SELECT *
          FROM reward_credits
         WHERE user_id=?
         ORDER BY id DESC
         LIMIT ? OFFSET ?
        `,
        [userId, limit, offset]
      );

      return res.json({
        credits: rows.map(normalizeCreditRow),
        userId,
        limit,
        offset,
      });
    } catch (e) {
      console.error('[admin reward credits] list error:', e);
      return res.status(500).json({ error: 'SERVER_ERR' });
    }
  });

  r.get('/users/:userId/credits', async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ error: 'BAD_USER_ID' });
    }

    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const offset = Math.max(0, Number(req.query.offset || 0));

    try {
      const [rows] = await db.query(
        `
        SELECT *
          FROM reward_credits
         WHERE user_id=?
         ORDER BY id DESC
         LIMIT ? OFFSET ?
        `,
        [userId, limit, offset]
      );

      return res.json({
        credits: rows.map(normalizeCreditRow),
        userId,
        limit,
        offset,
      });
    } catch (e) {
      console.error('[admin reward credits] list(user) error:', e);
      return res.status(500).json({ error: 'SERVER_ERR' });
    }
  });

  // ───────────────── RECHECK USER ─────────────────
  r.post('/users/:userId/recheck', async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ error: 'BAD_USER_ID' });
    }

    const conn = await db.getConnection();
    try {
      const out = await evaluateRewardCreditsForUser(conn, userId);

      // ✅ important: notify after recheck too (eligibility/credited can happen later)
      notifyRewardCreditEmailsForUser(db, userId).catch((e) => {
        console.error('[reward credits] notify email failed (non-fatal):', e?.message || e);
      });

      return res.json({ ok: true, ...out });
    } catch (e) {
      console.error('admin recheck error:', e);
      return res.status(500).json({ error: 'SERVER_ERR' });
    } finally {
      conn.release();
    }
  });

  // ───────────────── MONITORING (BATCH) ─────────────────
  r.post('/status-batch', async (req, res) => {
    const userIdsRaw = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
    const userIds = [...new Set(userIdsRaw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    const users = await buildStatusMap(userIds);

    return res.json({
      users,
      lastUpdated: new Date().toISOString(),
    });
  });

  // ───────────────── MONITORING (SINGLE) ─────────────────
  r.get('/users/:userId/status', async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ error: 'BAD_USER_ID' });
    }

    const users = await buildStatusMap([userId]);
    return res.json({
      userId,
      status:
        users[userId] || {
          counts: { pending: 0, eligible: 0, credited: 0, expired: 0 },
          latest: null,
        },
      lastUpdated: new Date().toISOString(),
    });
  });

  return r;
};
