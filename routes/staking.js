// server/routes/staking.js
// 1 unit = 9 USDT reference value, but staking locks VPK
const STAKE_UNIT_USDT = 9.0;                  // reference value per unit (for caps & rewards)
const STAKE_UNIT      = STAKE_UNIT_USDT;      // backward-compat alias
const DEFAULT_MULT    = 3.0;

// VPK staking config
const VPK_PER_USDT    = 100.0;                // 1 USDT = 100 VPK (must match app & swap)
const STAKE_UNIT_VPK  = STAKE_UNIT_USDT * VPK_PER_USDT; // 900 VPK locked per unit

const express = require('express');
const { z } = require('zod');
const crypto = require('crypto');

// Airdrop policy…
const AIRDROP_TRIGGER_UNITS = 60;
const AIRDROP_REWARD_UNITS  = 6;
const OLD_PICK = 6;
const NEW_PICK = 4;

// UI cooldown: hide brand-new stakes from /meta progress for N minutes
const META_COOLDOWN_MINUTES = Number(process.env.STAKING_META_COOLDOWN_MINUTES || 5);

// ⬇⬇ factory
module.exports = function makeStakingRoutes({ db, requireAuth, awardReferral, distributeStakeSplits }) {
  const router = express.Router();
  router.use(requireAuth);

  const _award = (typeof awardReferral === 'function') ? awardReferral : null;

  /* ───────────────────────── helpers ───────────────────────── */

  function randi(max) {
    return crypto.randomInt(0, max); // unbiased [0, max)
  }

  function pickWithoutReplacement(arr, k) {
    if (k <= 0 || arr.length === 0) return [];
    if (k >= arr.length) return arr.slice();
    const bag = arr.slice();
    const out = [];
    for (let i = 0; i < k; i++) {
      const idx = randi(bag.length);
      out.push(bag[idx]);
      bag.splice(idx, 1);
    }
    return out;
  }

  /**
   * Build OLD/NEW ticket pools using **per-initial-unit** tickets that are still unconsumed.
   */
  async function buildCohortsConsumed(conn, prevUnits) {
    const nextUnitsUpper = prevUnits + AIRDROP_TRIGGER_UNITS;

    const [rows] = await conn.query(
      `SELECT id, user_id, units, cap_usdt, credited_usdt,
              unit_amount_usdt, cap_multiplier, status, created_at
         FROM staking_positions
       ORDER BY created_at ASC, id ASC`
    );

    const oldTickets = [];
    const newTickets = [];
    let globalIdx = 0;

    for (const r of rows) {
      const units = Number(r.units || 0);
      if (!Number.isFinite(units) || units <= 0) continue;

      const start = globalIdx + 1;
      const end   = globalIdx + units;
      globalIdx   = end;

      const active     = (r.status === 'active');
      const cap        = Number(r.cap_usdt || 0);
      const cred       = Number(r.credited_usdt || 0);
      const unitAmt    = Number(r.unit_amount_usdt || STAKE_UNIT);
      const mult       = Number(r.cap_multiplier   || DEFAULT_MULT);
      const perUnitCap = unitAmt * mult;

      if (!active) continue;

      const unconsumedUnits = Math.max(
        0,
        Math.min(units, Math.floor((cap - cred) / perUnitCap))
      );
      if (unconsumedUnits <= 0) continue;

      const oldOverlap =
        Math.max(0, Math.min(end, prevUnits) - start + 1);
      const newOverlap =
        Math.max(0, Math.min(end, nextUnitsUpper) - Math.max(start, prevUnits + 1) + 1);

      if (oldOverlap + newOverlap <= 0) continue;

      const oldShare = Math.min(oldOverlap, unconsumedUnits);
      const newShare = Math.min(newOverlap, unconsumedUnits - oldShare);

      for (let i = 0; i < oldShare; i++) oldTickets.push({ position_id: r.id, user_id: r.user_id });
      for (let i = 0; i < newShare; i++) newTickets.push({ position_id: r.id, user_id: r.user_id });
    }

    return { oldTickets, newTickets };
  }

  /**
   * Trigger airdrop rounds …
   * baseAmount (for referral) = 9 USDT * total_reward_units_per_user
   */
  async function triggerAirdropsIfNeeded(pool) {
    const conn = await pool.getConnection();

    const rewardStatsByUser = new Map();

    try {
      const [[lock]] = await conn.query(`SELECT GET_LOCK('staking_airdrop_lock', 5) AS got`);
      if (!lock || !lock.got) { conn.release(); return; }

      await conn.beginTransaction();

      const [[u]] = await conn.query(
        `SELECT COALESCE(SUM(units),0) AS total_units FROM staking_positions`
      );
      const totalUnitsEver = Number(u?.total_units || 0);

      const [[a]] = await conn.query(
        `SELECT COUNT(*) AS rounds_done FROM staking_airdrops`
      );
      let roundsDone = Number(a?.rounds_done || 0);

      const targetRounds = Math.floor(totalUnitsEver / AIRDROP_TRIGGER_UNITS);
      if (roundsDone >= targetRounds) {
        await conn.commit();
        await conn.query(`SELECT RELEASE_LOCK('staking_airdrop_lock')`);
        conn.release();
        return;
      }

      const roundsPending = targetRounds - roundsDone;

      for (let p = 1; p <= roundsPending; p++) {
        const newEnd    = totalUnitsEver - (roundsPending - p) * AIRDROP_TRIGGER_UNITS;
        const prevUnits = Math.max(0, newEnd - AIRDROP_TRIGGER_UNITS);

        const [ins] = await conn.query(
          `INSERT INTO staking_airdrops (round, trigger_units, airdrop_units, created_at)
           VALUES (?, ?, ?, NOW())`,
          [roundsDone + 1, newEnd, AIRDROP_REWARD_UNITS]
        );
        const airdropId = ins.insertId;

        const { oldTickets, newTickets } = await buildCohortsConsumed(conn, prevUnits);

        const maxWinners = AIRDROP_REWARD_UNITS;

        const newPick = Math.min(NEW_PICK, maxWinners, newTickets.length);
        const newWinners = newPick > 0 ? pickWithoutReplacement(newTickets, newPick) : [];

        const newWinnerUserIds = new Set(newWinners.map(w => w.user_id));
        const oldFiltered = newWinnerUserIds.size
          ? oldTickets.filter(t => !newWinnerUserIds.has(t.user_id))
          : oldTickets;

        const remaining = Math.max(0, maxWinners - newWinners.length);
        const oldPick = Math.min(OLD_PICK, remaining, oldFiltered.length);
        const oldWinners = oldPick > 0 ? pickWithoutReplacement(oldFiltered, oldPick) : [];

        const winners = oldWinners.concat(newWinners);

        if (winners.length > 0) {
          const ensured = new Set();

          for (const w of winners) {
            if (!ensured.has(w.user_id)) {
              await conn.query(
                `INSERT INTO wallet_balances (user_id, asset, balance)
                 VALUES (?, 'USDT', 0)
                 ON DUPLICATE KEY UPDATE balance = balance`,
                [w.user_id]
              );
              ensured.add(w.user_id);
            }

            const [[pos]] = await conn.query(
              `SELECT cap_usdt, credited_usdt, status, unit_amount_usdt, cap_multiplier
                 FROM staking_positions
                WHERE id=? FOR UPDATE`,
              [w.position_id]
            );
            if (!pos || pos.status !== 'active') continue;

            const capLeft = Math.max(0, Number(pos.cap_usdt) - Number(pos.credited_usdt));
            const unitAmt = Number(pos.unit_amount_usdt || STAKE_UNIT);
            const mult    = Number(pos.cap_multiplier   || DEFAULT_MULT);
            const perWin  = unitAmt * mult;
            const creditAmt = Math.min(perWin, capLeft);

            if (creditAmt <= 0) continue;

            await conn.query(
              `UPDATE wallet_balances
                  SET balance = balance + ?
                WHERE user_id=? AND asset='USDT'`,
              [creditAmt, w.user_id]
            );

            const [ri] = await conn.query(
              `INSERT INTO staking_airdrop_recipients
                 (airdrop_id, user_id, position_id, amount_usdt, created_at)
               VALUES (?, ?, ?, ?, NOW())`,
              [airdropId, w.user_id, w.position_id, creditAmt]
            );
            const recipientId = ri.insertId;

            await conn.query(
              `INSERT INTO wallet_ledger
                 (user_id, ts, asset, chain, type, amount, ref_id, meta)
               VALUES (?, NOW(), 'USDT', NULL, 'transfer_in', ?, ?, ?)`,
              [
                w.user_id,
                creditAmt,
                recipientId,
                JSON.stringify({
                  kind: 'airdrop_reward',
                  airdrop_id: airdropId,
                  recipient_id: recipientId,
                  consumed_units: 1,
                  per_unit_amount: unitAmt,
                  per_unit_multiplier: mult,
                  payout_usdt: creditAmt,
                  cohort: oldWinners.includes(w) ? 'old' : `new${AIRDROP_TRIGGER_UNITS}`,
                }),
              ]
            );

            let stat = rewardStatsByUser.get(w.user_id);
            if (!stat) {
              stat = { units: 0, airdropIds: new Set() };
              rewardStatsByUser.set(w.user_id, stat);
            }
            stat.units += 1;
            stat.airdropIds.add(airdropId);

            await conn.query(
              `UPDATE staking_positions
                  SET credited_usdt = LEAST(cap_usdt, credited_usdt + ?),
                      status = CASE WHEN credited_usdt + ? >= cap_usdt THEN 'completed' ELSE 'active' END,
                      updated_at = NOW()
                WHERE id=?`,
              [creditAmt, creditAmt, w.position_id]
            );
          }
        }

        roundsDone++;
      }

      await conn.commit();
      await conn.query(`SELECT RELEASE_LOCK('staking_airdrop_lock')`);
    } catch (e) {
      try { await conn.rollback(); } catch {}
      try { await conn.query(`SELECT RELEASE_LOCK('staking_airdrop_lock')`); } catch {}
      throw e;
    } finally {
      conn.release();
    }

    if (_award && rewardStatsByUser.size > 0) {
      for (const [refereeId, stat] of rewardStatsByUser.entries()) {
        const unitsRewarded = stat.units;
        const baseAmount    = unitsRewarded * STAKE_UNIT;

        try {
          await _award({
            refereeId,
            type: 'staking_reward',
            asset: 'USDT',
            baseAmount,
            sourceRef: `airdrop:${Array.from(stat.airdropIds).join(',')}`,
            meta: {
              reward_units: unitsRewarded,
              unit_amount_usdt: STAKE_UNIT,
              base_for_referral_usdt: baseAmount,
              airdrop_ids: Array.from(stat.airdropIds),
            },
          });
        } catch (e) {
          console.error('awardReferral(airdrop_reward)', e);
        }
      }
    }
  }

  /* ───────────────────────── routes ───────────────────────── */

  router.get('/pool', async (req, res, next) => {
    try {
      const [[r]] = await db.query(
        `SELECT COALESCE(SUM(amount_usdt),0) AS pool_usdt
           FROM staking_positions
          WHERE status='active'`
      );
      res.json({ pool_usdt: Number(r?.pool_usdt || 0) });
    } catch (e) { next(e); }
  });

  router.get('/meta', async (req, res, next) => {
    try {
      const [[uReal]] = await db.query(
        `SELECT COALESCE(SUM(units),0) AS total_units
           FROM staking_positions`
      );
      const totalUnitsReal = Number(uReal?.total_units || 0);

      const [[uUi]] = await db.query(
        `SELECT COALESCE(SUM(units),0) AS total_units
           FROM staking_positions
          WHERE created_at < (NOW() - INTERVAL ? MINUTE)`,
        [META_COOLDOWN_MINUTES]
      );
      const totalUnitsUi = Number(uUi?.total_units || 0);

      const [[r]] = await db.query(
        `SELECT COUNT(*) AS rounds_done,
                COALESCE(SUM(airdrop_units),0) AS total_airdrops
           FROM staking_airdrops`
      );
      const roundsDone    = Number(r?.rounds_done || 0);
      const totalAirdrops = Number(r?.total_airdrops || 0);

      const triggerSize = AIRDROP_TRIGGER_UNITS;
      const unitsUsed   = roundsDone * triggerSize;

      let unitsIntoCurrent = totalUnitsUi - unitsUsed;
      if (!Number.isFinite(unitsIntoCurrent) || unitsIntoCurrent < 0) {
        unitsIntoCurrent = 0;
      }

      const progress = triggerSize > 0
        ? Math.max(0, Math.min(1, unitsIntoCurrent / triggerSize))
        : 0;

      const unitsRemaining = Math.max(0, triggerSize - unitsIntoCurrent);

      res.json({
        trigger_units: triggerSize,
        reward_units: AIRDROP_REWARD_UNITS,
        total_units: totalUnitsUi,
        total_units_real: totalUnitsReal,
        rounds_done: roundsDone,
        total_airdrops: totalAirdrops,
        progress_to_next: progress,
        units_into_current: unitsIntoCurrent,
        units_remaining: unitsRemaining,
        cooldown_minutes: META_COOLDOWN_MINUTES,
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/positions', async (req, res, next) => {
    try {
      const [rows] = await db.query(
        `SELECT id, user_id, program, units, unit_amount_usdt, amount_usdt,
                cap_multiplier, cap_usdt, credited_usdt, status, created_at, updated_at
           FROM staking_positions
          WHERE user_id=?
          ORDER BY created_at DESC, id DESC`,
        [req.userId]
      );
      const items = rows.map(r => ({
        id: r.id,
        program: r.program,
        units: Number(r.units),
        unit_amount_usdt: Number(r.unit_amount_usdt),
        amount_usdt: Number(r.amount_usdt),
        cap_multiplier: Number(r.cap_multiplier),
        cap_usdt: Number(r.cap_usdt),
        credited_usdt: Number(r.credited_usdt),
        remaining_usdt: Math.max(0, Number(r.cap_usdt) - Number(r.credited_usdt)),
        status: r.status,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));
      res.json({ positions: items, items });
    } catch (e) { next(e); }
  });

  // Staking locks VPK (900 VPK per unit ≈ 9 USDT); rewards/caps are still in USDT.
  router.post('/positions', async (req, res, next) => {
    const schema = z.object({
      amount: z.union([z.number(), z.string()]).optional(),   // optional: amount in VPK
      units:  z.union([z.number(), z.string()]).optional(),
      program: z.string().max(64).optional(),
      cap_multiplier: z.union([z.number(), z.string()]).optional(),
    }).refine(d => d.amount != null || d.units != null, {
      message: 'AMOUNT_OR_UNITS_REQUIRED',
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'BAD_BODY' });
    }

    const body    = parsed.data;
    const program = body.program || 'mining_airdrop_v1';
    const mult    = Number(body.cap_multiplier ?? DEFAULT_MULT);

    let units = 0;
    if (body.units != null) {
      units = Math.floor(Number(body.units));
    } else {
      const amtVpk = Number(body.amount);
      if (!Number.isFinite(amtVpk)) {
        return res.status(400).json({ error: 'BAD_BODY' });
      }
      units = Math.floor(amtVpk / STAKE_UNIT_VPK);
    }

    if (!Number.isFinite(units) || units < 1) {
      return res.status(400).json({ error: 'MIN_900_VPK' });
    }

    const unitAmtUsdt  = STAKE_UNIT_USDT;
    const stakeUsdtVal = units * unitAmtUsdt;
    const stakeVpk     = units * STAKE_UNIT_VPK;
    const capTotalUsdt = stakeUsdtVal * mult;

    const conn = await db.getConnection();
    let posId;

    try {
      await conn.beginTransaction();

      await conn.query(
        `INSERT INTO wallet_balances (user_id, asset, balance)
         VALUES (?, 'VPK', 0)
         ON DUPLICATE KEY UPDATE balance = balance`,
        [req.userId]
      );

      const [[bal]] = await conn.query(
        `SELECT balance
           FROM wallet_balances
          WHERE user_id=? AND asset='VPK' FOR UPDATE`,
        [req.userId]
      );
      const currentVpk = Number(bal?.balance || 0);

      if (currentVpk < stakeVpk) {
        await conn.rollback();
        return res.status(400).json({
          error: 'INSUFFICIENT_FUNDS',
          asset: 'VPK',
          need: stakeVpk,
          have: currentVpk,
        });
      }

      await conn.query(
        `UPDATE wallet_balances
            SET balance = balance - ?
          WHERE user_id=? AND asset='VPK'`,
        [stakeVpk, req.userId]
      );

      const [ins] = await conn.query(
        `INSERT INTO staking_positions
           (user_id, program, units, unit_amount_usdt, amount_usdt,
            cap_multiplier, cap_usdt, credited_usdt, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,0,'active',NOW(),NOW())`,
        [req.userId, program, units, unitAmtUsdt, stakeUsdtVal, mult, capTotalUsdt]
      );
      posId = ins.insertId;

      // IMPORTANT: amount must be POSITIVE; wallet.js signs by type
      await conn.query(
        `INSERT INTO wallet_ledger
           (user_id, ts, asset, chain, type, amount, ref_id, meta)
         VALUES (?, NOW(), 'VPK', NULL, 'stake_lock', ?, ?, ?)`,
        [
          req.userId,
          stakeVpk,
          posId,
          JSON.stringify({
            kind: 'stake_lock',
            position_id: posId,
            units,
            stake_vpk: stakeVpk,
            unit_vpk: STAKE_UNIT_VPK,
            stake_usdt_value: stakeUsdtVal,
            unit_usdt_value: unitAmtUsdt,
            cap_multiplier: mult,
          }),
        ]
      );

      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch {}
      return next(e);
    } finally {
      conn.release();
    }

    if (typeof distributeStakeSplits === 'function') {
      try {
        await distributeStakeSplits({ positionId: posId, userId: req.userId, units });
      } catch (e) {
        console.error('distributeStakeSplits error', e);
      }
    }

    try {
      await triggerAirdropsIfNeeded(db);
    } catch (e) {
      console.error('triggerAirdropsIfNeeded error', e);
    }

    res.json({
      ok: true,
      position: {
        id: posId,
        program,
        units,
        unit_amount_usdt: unitAmtUsdt,
        amount_usdt: stakeUsdtVal,
        cap_multiplier: mult,
        cap_usdt: capTotalUsdt,
        credited_usdt: 0,
        remaining_usdt: capTotalUsdt,
        status: 'active',
      },
    });
  });

  router.post('/airdrop/run', async (_req, res, next) => {
    try {
      await triggerAirdropsIfNeeded(db);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return router;
};
