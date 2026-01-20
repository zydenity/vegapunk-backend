// routes/referrals.js
const express = require('express');

const REF_CONVERSION_RATE = Number(process.env.REF_CONVERSION_RATE || 0.005); // 0.5%
const REF_STAKING_RATE    = Number(process.env.REF_STAKING_RATE || 0.10);    // 10%
const REF_BASE_URL        = process.env.REF_BASE_URL || 'https://Vegapunks.com';

// Company wallet user id (optional)
const REF_COMPANY_USER_ID = Number(process.env.REF_COMPANY_USER_ID || 0);

// Multi-level nominal shares (sum to 10)
const LVL1_SHARE    = 4.5; // 4.5%
const LVL2_SHARE    = 2.5; // 2.5%
const LVL3_SHARE    = 1.5; // 1.5%
const COMPANY_SHARE = 1.5; // 1.5%
const TOTAL_SHARE   = LVL1_SHARE + LVL2_SHARE + LVL3_SHARE + COMPANY_SHARE; // 10

function randCode() {
  // e.g. "PH1-ABCD12"
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `PH1-${s}`;
}

async function ensureRefCode(db, userId) {
  const [[u]] = await db.query('SELECT ref_code FROM users WHERE id=?', [userId]);
  if (u && u.ref_code) return u.ref_code;

  // generate unique
  let code;
  for (;;) {
    code = randCode();
    const [[x]] = await db.query('SELECT id FROM users WHERE ref_code=? LIMIT 1', [code]);
    if (!x) break;
  }
  await db.query('UPDATE users SET ref_code=? WHERE id=?', [code, userId]);
  return code;
}

/** Choose app base from request Origin (localhost in dev), fallback to REF_BASE_URL for prod */
function pickAppBase(req) {
  const origin = req.get('Origin') || req.get('Referer') || '';
  try {
    if (origin) {
      const u = new URL(origin);
      const host = (u.hostname || '').toLowerCase(); // "::1" for ipv6 loopback
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
        return `${u.protocol}//${u.host}`;
      }
    }
  } catch (_) { /* ignore parse issues */ }
  return REF_BASE_URL;
}

function isValidType(t) {
  return t === 'conversion' || t === 'staking_reward';
}

function isValidAsset(a) {
  return a === 'PHP' || a === 'USDT';
}

function parseMeta(input) {
  if (!input) return {};
  if (typeof input === 'object') return input;
  if (typeof input === 'string') {
    try { return JSON.parse(input); } catch { return { raw: input }; }
  }
  return {};
}

function levelWhereAndParams(level) {
  // meta might store level as number (1) or string ("1")
  if (!level || !['1', '2', '3', 'company'].includes(level)) return { sql: '', params: [] };

  if (level === 'company') {
    return { sql: ` AND e.meta LIKE ?`, params: [`%"level":"company"%`] };
  }

  return {
    sql: ` AND (e.meta LIKE ? OR e.meta LIKE ?)`,
    params: [`%"level":${level}%`, `%"level":"${level}"%`],
  };
}

function selectLevelSql() {
  // lightweight "extract" of level from meta; returns string: "1"|"2"|"3"|"company"|NULL
  return `
    CASE
      WHEN e.meta LIKE '%"level":"company"%' THEN 'company'
      WHEN (e.meta LIKE '%"level":1%' OR e.meta LIKE '%"level":"1"%') THEN '1'
      WHEN (e.meta LIKE '%"level":2%' OR e.meta LIKE '%"level":"2"%') THEN '2'
      WHEN (e.meta LIKE '%"level":3%' OR e.meta LIKE '%"level":"3"%') THEN '3'
      ELSE NULL
    END
  `;
}

/**
 * Core award helper
 * - 3 levels + company with roll-up
 * - idempotent per beneficiary: (referee_id, type, source_ref, referrer_id)
 */
async function awardReferral(db, { refereeId, type, asset, baseAmount, sourceRef, meta = null }) {
  // ── Validate input ───────────────────────────────────────────────
  const tRaw = String(type || '').trim();
  const aRaw = String(asset || 'USDT').trim().toUpperCase();
  const amt  = Number(baseAmount);

  const t = isValidType(tRaw) ? tRaw : null;
  const a = isValidAsset(aRaw) ? aRaw : 'USDT';

  if (!t || !Number.isFinite(amt) || amt <= 0) {
    return { ok: false, reason: 'BAD_INPUT' };
  }

  // ── Resolve 3-level upline chain ─────────────────────────────────
  // u0 = referee, u0.referrer_id = level 1
  const [rows] = await db.query(
    `SELECT
       u0.referrer_id AS lvl1_id,
       u1.referrer_id AS lvl2_id,
       u2.referrer_id AS lvl3_id
     FROM users u0
     LEFT JOIN users u1 ON u1.id = u0.referrer_id
     LEFT JOIN users u2 ON u2.id = u1.referrer_id
     WHERE u0.id = ?
     LIMIT 1`,
    [refereeId]
  );

  const chain = rows[0] || {};
  const lvl1Id = chain.lvl1_id || null;
  const lvl2Id = chain.lvl2_id || null;
  const lvl3Id = chain.lvl3_id || null;

  const companyId =
    Number.isFinite(REF_COMPANY_USER_ID) && REF_COMPANY_USER_ID > 0
      ? REF_COMPANY_USER_ID
      : null;

  if (!lvl1Id && !lvl2Id && !lvl3Id && !companyId) {
    return { ok: false, reason: 'NO_RECIPIENTS' };
  }

  // ── Total referral pool rate ─────────────────────────────────────
  const totalRate = (t === 'conversion') ? REF_CONVERSION_RATE : REF_STAKING_RATE;
  if (!Number.isFinite(totalRate) || totalRate <= 0) {
    return { ok: false, reason: 'NO_RATE' };
  }

  const pool = amt * totalRate;
  if (!Number.isFinite(pool) || pool <= 0) {
    return { ok: false, reason: 'NO_COMMISSION' };
  }

  // ── Normalize meta + build deterministic source_ref ──────────────
  const metaObj = parseMeta(meta);

  let src = (sourceRef ?? '').toString().trim();
  if (!src) {
    const det =
      metaObj.orderId || metaObj.order_id ||
      metaObj.txHash  || metaObj.tx_hash  ||
      metaObj.tx      || metaObj.reference || metaObj.ref;
    src = det ? `${t}:${String(det)}` : `${t}:${refereeId}:${Date.now()}`; // last resort
  }

  // ── Read existing beneficiary rows for this trigger ──────────────
  // (Do NOT early-return — we allow filling missing levels later)
  const [existing] = await db.query(
    `SELECT id, referrer_id
       FROM referral_events
      WHERE referee_id=? AND type=? AND source_ref=?`,
    [refereeId, t, src]
  );
  const existingSet = new Set(existing.map(r => Number(r.referrer_id)));
  const firstExistingId = existing[0]?.id || null;

  // ── Build effective weights (roll missing levels → company) ──────
  const weights = {};
  let totalEffectiveWeight = 0;

  if (lvl1Id) { weights.lvl1 = LVL1_SHARE; totalEffectiveWeight += LVL1_SHARE; }
  if (lvl2Id) { weights.lvl2 = LVL2_SHARE; totalEffectiveWeight += LVL2_SHARE; }
  if (lvl3Id) { weights.lvl3 = LVL3_SHARE; totalEffectiveWeight += LVL3_SHARE; }

  if (companyId) {
    let coW = COMPANY_SHARE;
    if (!lvl1Id) coW += LVL1_SHARE;
    if (!lvl2Id) coW += LVL2_SHARE;
    if (!lvl3Id) coW += LVL3_SHARE;

    weights.company = coW;
    totalEffectiveWeight += coW;
  }

  if (!totalEffectiveWeight || totalEffectiveWeight <= 0) {
    return { ok: false, reason: 'NO_EFFECTIVE_WEIGHTS' };
  }

  function calcShare(weight) {
    const raw = pool * (weight / totalEffectiveWeight);
    if (a === 'PHP') return Math.round(raw * 100) / 100;   // 2 dp
    return Math.round(raw * 1e8) / 1e8;                   // 8 dp
  }

  function buildMeta(levelLabel) {
    return JSON.stringify({ ...metaObj, level: levelLabel });
  }

  const events = [];

  // Level 1
  let lvl1Commission = 0;
  if (lvl1Id && weights.lvl1) {
    const c1 = calcShare(weights.lvl1);
    if (c1 > 0) {
      lvl1Commission = c1;
      events.push({ referrerId: lvl1Id, commission: c1, metaJson: buildMeta(1), level: 'lvl1' });
    }
  }

  // Level 2
  if (lvl2Id && weights.lvl2) {
    const c2 = calcShare(weights.lvl2);
    if (c2 > 0) {
      events.push({ referrerId: lvl2Id, commission: c2, metaJson: buildMeta(2), level: 'lvl2' });
    }
  }

  // Level 3
  if (lvl3Id && weights.lvl3) {
    const c3 = calcShare(weights.lvl3);
    if (c3 > 0) {
      events.push({ referrerId: lvl3Id, commission: c3, metaJson: buildMeta(3), level: 'lvl3' });
    }
  }

  // Company
  let companyCommission = 0;
  if (companyId && weights.company) {
    const cc = calcShare(weights.company);
    if (cc > 0) {
      companyCommission = cc;
      events.push({ referrerId: companyId, commission: cc, metaJson: buildMeta('company'), level: 'company' });
    }
  }

  if (!events.length) {
    return { ok: false, reason: 'NO_COMMISSION_EVENTS' };
  }

  // ── Insert events (idempotent per beneficiary) ───────────────────
  let firstId = null;
  let inserted = 0;

  for (const ev of events) {
    // skip if already exists for this beneficiary (fast path)
    if (existingSet.has(Number(ev.referrerId))) {
      if (!firstId) firstId = firstExistingId;
      continue;
    }

    const [ins] = await db.query(
      `INSERT IGNORE INTO referral_events
         (referee_id, referrer_id, type, asset, base_amount,
          commission_amount, status, source_ref, meta)
       VALUES (?,?,?,?,?,?, 'pending', ?, ?)`,
      [refereeId, ev.referrerId, t, a, amt, ev.commission, src, ev.metaJson]
    );

    if (ins.affectedRows === 1) {
      inserted++;
      if (!firstId && ins.insertId) firstId = ins.insertId;
    }
  }

  if (!firstId && firstExistingId) firstId = firstExistingId;

  return {
    ok: true,
    duplicate: inserted === 0 && existing.length > 0,
    id: firstId,
    commission: lvl1Commission, // backward compatibility
    asset: a,
    referrerId: lvl1Id || companyId || null,
    breakdown: {
      pool,
      weights: {
        lvl1: weights.lvl1 || 0,
        lvl2: weights.lvl2 || 0,
        lvl3: weights.lvl3 || 0,
        company: weights.company || 0,
        totalEffectiveWeight,
        nominalTotal: TOTAL_SHARE,
      },
      level1: lvl1Commission,
      level2: events.find(e => e.level === 'lvl2')?.commission || 0,
      level3: events.find(e => e.level === 'lvl3')?.commission || 0,
      company: companyCommission,
    },
  };
}

module.exports = function makeReferralRoutes({ db, requireAuth, USDT_PHP_RATE }) {
  const router = express.Router();

  // Disable caching for ALL referral endpoints (important for Flutter Web)
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
    next();
  });

  // Attach code once (cannot self-refer; cannot overwrite)
  router.post('/use-code', requireAuth, async (req, res) => {
    try {
      const code = String(req.body?.code || '').trim().toUpperCase();
      if (!code || !code.startsWith('PH1-')) return res.status(400).json({ error: 'BAD_CODE' });

      const [[me]] = await db.query('SELECT id, referrer_id FROM users WHERE id=?', [req.userId]);
      if (!me) return res.status(404).json({ error: 'NO_USER' });
      if (me.referrer_id) return res.status(409).json({ error: 'ALREADY_ATTACHED' });

      const [[ref]] = await db.query('SELECT id FROM users WHERE ref_code=?', [code]);
      if (!ref) return res.status(404).json({ error: 'CODE_NOT_FOUND' });
      if (ref.id === req.userId) return res.status(400).json({ error: 'SELF_REFERRAL' });

      await db.query('UPDATE users SET referrer_id=? WHERE id=?', [ref.id, req.userId]);
      res.json({ ok: true });
    } catch (e) {
      console.error('use-code', e);
      res.status(500).json({ error: 'SERVER_ERR' });
    }
  });

  // List my referral network up to 3 levels deep (NO reward totals)
  router.get('/network', requireAuth, async (req, res) => {
    try {
      const userId = req.userId;

      // LEVEL 1
      const [l1] = await db.query(
        `SELECT id, ref_code, created_at,
                (pin_hash IS NOT NULL) AS active
           FROM users
          WHERE referrer_id=?`,
        [userId]
      );
      const l1Ids = l1.map(r => r.id);

      let l2 = [];
      let l3 = [];

      // LEVEL 2
      if (l1Ids.length) {
        const [rows2] = await db.query(
          `SELECT id, ref_code, created_at,
                  (pin_hash IS NOT NULL) AS active
             FROM users
            WHERE referrer_id IN (?)`,
          [l1Ids]
        );
        l2 = rows2;
      }

      const l2Ids = l2.map(r => r.id);

      // LEVEL 3
      if (l2Ids.length) {
        const [rows3] = await db.query(
          `SELECT id, ref_code, created_at,
                  (pin_hash IS NOT NULL) AS active
             FROM users
            WHERE referrer_id IN (?)`,
          [l2Ids]
        );
        l3 = rows3;
      }

      const mapUser = (u) => ({
        id: u.id,
        referralCode: u.ref_code || null,
        active: !!u.active,
        joinedAt: u.created_at,
      });

      res.json({
        level1: l1.map(mapUser),
        level2: l2.map(mapUser),
        level3: l3.map(mapUser),
      });
    } catch (e) {
      console.error('network', e);
      res.status(500).json({ error: 'SERVER_ERR' });
    }
  });

  // Alias: invites grouped by level (same as /network)
  router.get('/invites', requireAuth, async (req, res) => {
    try {
      const userId = req.userId;

      const [l1] = await db.query(
        `SELECT id, ref_code, created_at,
                (pin_hash IS NOT NULL) AS active
           FROM users
          WHERE referrer_id=?`,
        [userId]
      );
      const l1Ids = l1.map(r => r.id);

      let l2 = [];
      let l3 = [];

      if (l1Ids.length) {
        const [rows2] = await db.query(
          `SELECT id, ref_code, created_at,
                  (pin_hash IS NOT NULL) AS active
             FROM users
            WHERE referrer_id IN (?)`,
          [l1Ids]
        );
        l2 = rows2;
      }

      const l2Ids = l2.map(r => r.id);

      if (l2Ids.length) {
        const [rows3] = await db.query(
          `SELECT id, ref_code, created_at,
                  (pin_hash IS NOT NULL) AS active
             FROM users
            WHERE referrer_id IN (?)`,
          [l2Ids]
        );
        l3 = rows3;
      }

      const mapUser = (u) => ({
        id: u.id,
        referralCode: u.ref_code || null,
        active: !!u.active,
        joinedAt: u.created_at,
      });

      res.json({
        level1: l1.map(mapUser),
        level2: l2.map(mapUser),
        level3: l3.map(mapUser),
      });
    } catch (e) {
      console.error('invites', e);
      res.status(500).json({ error: 'SERVER_ERR' });
    }
  });

  // Referral snapshot/summary
  router.get('/summary', requireAuth, async (req, res) => {
    try {
      const code = await ensureRefCode(db, req.userId);

      const [[counts]] = await db.query(
        `SELECT COUNT(*) AS total_events
           FROM referral_events
          WHERE referrer_id=?`,
        [req.userId]
      );

      const [[agg]] = await db.query(
        `SELECT
           COALESCE(SUM(CASE WHEN status='pending'  AND asset='PHP'  THEN commission_amount END),0) AS pending_php,
           COALESCE(SUM(CASE WHEN status='pending'  AND asset='USDT' THEN commission_amount END),0) AS pending_usdt,
           COALESCE(SUM(CASE WHEN status='credited' AND asset='PHP'  THEN commission_amount END),0) AS lifetime_php,
           COALESCE(SUM(CASE WHEN status='credited' AND asset='USDT' THEN commission_amount END),0) AS lifetime_usdt
         FROM referral_events
         WHERE referrer_id=?`,
        [req.userId]
      );

      // active/total referred users
      const [[totals]] = await db.query(
        `SELECT
           COUNT(*) AS total_referred,
           SUM(CASE WHEN u2.pin_hash IS NOT NULL THEN 1 ELSE 0 END) AS active_referred
         FROM users u1
         JOIN users u2 ON u2.referrer_id = u1.id
         WHERE u1.id=?`,
        [req.userId]
      );

      const appBase = pickAppBase(req);

      res.json({
        code,
        link: `${appBase}/r?code=${code}`,
        totalReferred: Number(totals?.total_referred || 0),
        activeReferred: Number(totals?.active_referred || 0),

        pendingRewardsPHP: Number(agg.pending_php || 0),
        pendingRewardsUSDT: Number(agg.pending_usdt || 0),
        lifetimeRewardsPHP: Number(agg.lifetime_php || 0),
        lifetimeRewardsUSDT: Number(agg.lifetime_usdt || 0),

        conversionRate: REF_CONVERSION_RATE,
        stakingBonusRate: REF_STAKING_RATE,

        estPendingPHPIncludingUSDT:
          Number(agg.pending_php || 0) + Number(agg.pending_usdt || 0) * USDT_PHP_RATE,
        usdtPhpRate: USDT_PHP_RATE,

        totalEvents: Number(counts?.total_events || 0),

        levels: {
          isMultiLevel: true,
          structure: '3-level + company',
          level1Share: 0.045,
          level2Share: 0.025,
          level3Share: 0.015,
          companyShare: 0.015,
          totalShare: 0.10,
          appliesTo: ['conversion', 'staking_reward'],
        },
      });
    } catch (e) {
      console.error('summary', e);
      res.status(500).json({ error: 'SERVER_ERR' });
    }
  });

  // History (reward rows from referral_events)
  // GET /v1/referrals/history?limit=50&offset=0&type=conversion&status=pending&level=1
  router.get('/history', requireAuth, async (req, res) => {
    try {
      const limit  = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
      const offset = Math.max(0, Number(req.query.offset || 0));

      const type   = String(req.query.type || '').trim();     // conversion | staking_reward
      const status = String(req.query.status || '').trim();   // pending | credited
      const level  = String(req.query.level || '').trim();    // 1 | 2 | 3 | company

      const params = [req.userId];
      let where = `e.referrer_id=?`;

      if (type && isValidType(type)) {
        where += ` AND e.type=?`;
        params.push(type);
      }

      if (status && (status === 'pending' || status === 'credited')) {
        where += ` AND e.status=?`;
        params.push(status);
      }

      const lvl = levelWhereAndParams(level);
      where += lvl.sql;
      params.push(...lvl.params);

      params.push(limit, offset);

      const [rows] = await db.query(
        `
        SELECT
          e.id,
          e.ts,
          e.type,
          e.asset,
          e.base_amount,
          e.commission_amount,
          e.status,
          e.claim_id,
          e.claimed_at,
          e.source_ref,
          e.meta,
          (${selectLevelSql()}) AS level,
          u.ref_code AS referee_code
        FROM referral_events e
        LEFT JOIN users u ON u.id = e.referee_id
        WHERE ${where}
        ORDER BY e.ts DESC, e.id DESC
        LIMIT ? OFFSET ?
        `,
        params
      );

      res.json(rows);
    } catch (e) {
      console.error('history', e);
      res.status(500).json({ error: 'SERVER_ERR' });
    }
  });

  // Rewards list (same as history; kept for compatibility)
  // GET /v1/referrals/rewards?limit=50&offset=0&type=...&status=...&level=...&referee_id=123
  router.get('/rewards', requireAuth, async (req, res) => {
    try {
      const limit  = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
      const offset = Math.max(0, Number(req.query.offset || 0));

      const type   = String(req.query.type || '').trim();
      const status = String(req.query.status || '').trim();
      const level  = String(req.query.level || '').trim();
      const refereeId = req.query.referee_id ? Number(req.query.referee_id) : null;

      const params = [req.userId];
      let where = `e.referrer_id=?`;

      if (type && isValidType(type)) {
        where += ` AND e.type=?`;
        params.push(type);
      }

      if (status && (status === 'pending' || status === 'credited')) {
        where += ` AND e.status=?`;
        params.push(status);
      }

      if (Number.isFinite(refereeId) && refereeId > 0) {
        where += ` AND e.referee_id=?`;
        params.push(refereeId);
      }

      const lvl = levelWhereAndParams(level);
      where += lvl.sql;
      params.push(...lvl.params);

      params.push(limit, offset);

      const [rows] = await db.query(
        `
        SELECT
          e.id,
          e.ts,
          e.type,
          e.asset,
          e.base_amount,
          e.commission_amount,
          e.status,
          e.claim_id,
          e.claimed_at,
          e.source_ref,
          e.meta,
          e.referee_id,
          u.ref_code AS referee_code,
          (${selectLevelSql()}) AS level
        FROM referral_events e
        LEFT JOIN users u ON u.id = e.referee_id
        WHERE ${where}
        ORDER BY e.ts DESC, e.id DESC
        LIMIT ? OFFSET ?
        `,
        params
      );

      res.json(rows);
    } catch (e) {
      console.error('rewards', e);
      res.status(500).json({ error: 'SERVER_ERR' });
    }
  });

  // Claim all pending (credits wallet; PHP → convert to USDT at current rate)
  router.post('/claim', requireAuth, async (req, res) => {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      // Lock rows & get IDs of the events we're about to claim
      const [evRows] = await conn.query(
        `SELECT id, asset, commission_amount
           FROM referral_events
          WHERE referrer_id=? AND status='pending'
          FOR UPDATE`,
        [req.userId]
      );

      const [[agg]] = await conn.query(
        `SELECT
           COALESCE(SUM(CASE WHEN status='pending' AND asset='PHP'  THEN commission_amount END),0) AS pending_php,
           COALESCE(SUM(CASE WHEN status='pending' AND asset='USDT' THEN commission_amount END),0) AS pending_usdt
         FROM referral_events
         WHERE referrer_id=? FOR UPDATE`,
        [req.userId]
      );

      const pendingPHP  = Number(agg.pending_php || 0);
      const pendingUSDT = Number(agg.pending_usdt || 0);
      const minPHP  = Number(process.env.REF_MIN_PHP  || 50);
      const minUSDT = Number(process.env.REF_MIN_USDT || 1);

      if (pendingPHP < minPHP && pendingUSDT < minUSDT) {
        await conn.rollback();
        return res.status(400).json({ error: 'MIN_NOT_MET', minPHP, minUSDT });
      }

      const addUsdt = pendingUSDT + (pendingPHP > 0 ? (pendingPHP / USDT_PHP_RATE) : 0);

      const [claimIns] = await conn.query(
        `INSERT INTO referral_claims (referrer_id, asset, amount, status, meta)
         VALUES (?,?,?,?, JSON_OBJECT('pendingPHP', ?, 'pendingUSDT', ?, 'event_ids', ?))`,
        [req.userId, 'USDT', addUsdt, 'paid', pendingPHP, pendingUSDT, JSON.stringify(evRows.map(r => r.id))]
      );
      const claimId = claimIns.insertId;

      await conn.query(
        `UPDATE referral_events
            SET status='credited', claim_id=?, claimed_at=NOW()
          WHERE referrer_id=? AND status='pending'`,
        [claimId, req.userId]
      );

      await conn.query(
        `INSERT INTO wallet_balances (user_id, asset, balance)
             VALUES (?,?,?)
             ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
        [req.userId, 'USDT', addUsdt]
      );

      await conn.query(
        `INSERT INTO wallet_ledger (user_id, ts, asset, chain, type, amount, ref_id, meta)
         VALUES (?, NOW(), 'USDT', NULL, 'referral_bonus', ?, ?, JSON_OBJECT('from_php', ?, 'rate', ?, 'events', ?))`,
        [req.userId, addUsdt, claimId, pendingPHP, USDT_PHP_RATE, JSON.stringify(evRows.map(r => r.id))]
      );

      await conn.commit();
      res.json({ ok: true, claimId, creditedUSDT: addUsdt, eventsClaimed: evRows.length });
    } catch (e) {
      try { await conn.rollback(); } catch {}
      console.error('claim', e);
      res.status(500).json({ error: 'SERVER_ERR' });
    } finally {
      conn.release();
    }
  });

  // Export helper so other routers can call it
  router._award = (payload) => awardReferral(db, payload);

  return router;
};
