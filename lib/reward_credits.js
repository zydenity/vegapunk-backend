// /server/lib/reward_credits.js
// Evaluates reward credits based on deposits + referrals.
// - "counted referrals" = total referred accounts (referrer_id=userId)
// - "qualified referrals" = referred accounts whose USDT deposit >= refereeDepositMin (default 10)
// Claimable only when:
//   depositOk AND qualifiedCount >= referralsMin

function safeJson(v) {
  if (v == null) return {};
  if (typeof v === 'object') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    try {
      const j = JSON.parse(v);
      return (j && typeof j === 'object') ? j : {};
    } catch (_) {
      return {};
    }
  }
  return {};
}

// supports snake_case + camelCase keys
function pick(conditions, keys, fallback) {
  for (const k of keys) {
    if (conditions && Object.prototype.hasOwnProperty.call(conditions, k) && conditions[k] != null) {
      return conditions[k];
    }
  }
  return fallback;
}

async function getDepositTotals(conn, userId) {
  const [[anyRow]] = await conn.query(
    `
    SELECT COALESCE(SUM(amount),0) AS total
    FROM wallet_ledger
    WHERE user_id=? AND type='deposit' AND asset='USDT'
    `,
    [userId]
  );

  const [[coinsRow]] = await conn.query(
    `
    SELECT COALESCE(SUM(l.amount),0) AS total
    FROM wallet_ledger l
    JOIN crypto_deposits d ON d.id = l.ref_id
    WHERE l.user_id=? AND l.type='deposit' AND l.asset='USDT'
      AND d.source='coinsph'
    `,
    [userId]
  );

  const [[binanceRow]] = await conn.query(
    `
    SELECT COALESCE(SUM(l.amount),0) AS total
    FROM wallet_ledger l
    JOIN crypto_deposits d ON d.id = l.ref_id
    WHERE l.user_id=? AND l.type='deposit' AND l.asset='USDT'
      AND d.source='binance'
    `,
    [userId]
  );

  return {
    any: Number(anyRow?.total ?? 0),
    coinsph: Number(coinsRow?.total ?? 0),
    binance: Number(binanceRow?.total ?? 0),
  };
}

/**
 * Returns BOTH:
 * - total referrals (counted)
 * - eligibleCount (qualified)
 * - missing list (below minUsdt)
 */
async function getReferralDepositProgress(conn, userId, minUsdt, source = 'any') {
  const src = String(source || 'any').toLowerCase();
  const need = Number(minUsdt || 0);

  // IMPORTANT:
  // Use only columns that are very likely to exist.
  // If you want to show a referral code, change this safely based on your schema.
  const [rows] = await conn.query(
    `
    SELECT
      u.id AS user_id,
      COALESCE(u.email, u.id) AS referral_id,
      COALESCE(
        SUM(
          CASE
            WHEN l.type='deposit' AND l.asset='USDT'
             AND (?='any' OR d.source=?)
            THEN l.amount
            ELSE 0
          END
        ), 0
      ) AS deposited_usdt
    FROM users u
    LEFT JOIN wallet_ledger l
      ON l.user_id = u.id
    LEFT JOIN crypto_deposits d
      ON d.id = l.ref_id
    WHERE u.referrer_id = ?
    GROUP BY u.id
    ORDER BY u.id ASC
    `,
    [src, src, userId]
  );

  const details = (rows || []).map((r) => {
    const deposited = Number(r.deposited_usdt ?? 0);
    const eligible = deposited >= need;
    return {
      userId: Number(r.user_id),
      referralId: String(r.referral_id),
      depositedUsdt: deposited,
      eligible,
    };
  });

  const eligibleCount = details.filter((x) => x.eligible).length;

  const missing = details
    .filter((x) => !x.eligible)
    .map((x) => ({
      referral_id: x.referralId,
      deposited_usdt: x.depositedUsdt,
      required_usdt: need,
    }));

  return {
    total: details.length,       // counted
    eligibleCount,               // qualified
    missing,
  };
}

async function evaluateRewardCreditsForUser(conn, userId) {
  // ✅ FIX: re-evaluate both locked + claimable
  // This also fixes old wrong "claimable" status.
  const [credits] = await conn.query(
    `
    SELECT *
    FROM reward_credits
    WHERE user_id=?
      AND status IN ('locked','claimable')
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY id DESC
    `,
    [userId]
  );

  if (!credits.length) return { updated: 0, demoted: 0 };

  const depTotals = await getDepositTotals(conn, userId);

  // cache referral computations per (minUsdt + source)
  const refCache = new Map();

  let updated = 0;
  let demoted = 0;

  for (const c of credits) {
    const conditions = safeJson(c.conditions_json);

    // ✅ support camelCase + snake_case
    const depositMin = Number(pick(conditions, ['deposit_usdt_min', 'depositUsdtMin'], 0));
    const depositSource = String(
      pick(conditions, ['deposit_source', 'depositSource'], 'any')
    ).toLowerCase(); // any|coinsph|binance

    const referralsMin = Number(pick(conditions, ['referrals_min', 'referralsMin'], 0));

    // ✅ referee qualification (default 10)
    const refereeDepositMin = Number(
      pick(
        conditions,
        [
          'referee_deposit_usdt_min',
          'refereeDepositUsdtMin',
          'referral_deposit_usdt_min',
          'referralDepositUsdtMin',
        ],
        10
      )
    );

    const refereeDepositSource = String(
      pick(conditions, ['referee_deposit_source', 'refereeDepositSource'], 'any')
    ).toLowerCase();

    let depositTotal = depTotals.any;
    if (depositSource === 'coinsph') depositTotal = depTotals.coinsph;
    else if (depositSource === 'binance') depositTotal = depTotals.binance;

    // --- referral progress ---
    // counted = total, qualified = eligibleCount
    let refProg = { total: 0, eligibleCount: 0, missing: [] };
    if (referralsMin > 0) {
      const key = `${refereeDepositSource}:${refereeDepositMin}`;
      if (!refCache.has(key)) {
        refCache.set(
          key,
          await getReferralDepositProgress(conn, userId, refereeDepositMin, refereeDepositSource)
        );
      }
      refProg = refCache.get(key);
    }

    const progress = {
      // deposit progress (owner)
      deposit_usdt_total: depositTotal,
      deposit_any_total: depTotals.any,
      deposit_coinsph_total: depTotals.coinsph,
      deposit_binance_total: depTotals.binance,
      deposit_source: depositSource,

      // referrals (counted vs qualified)
      referrals_total: Number(refProg.total ?? 0),                // counted
      referrals_counted: Number(refProg.total ?? 0),              // alias
      referrals_done: Number(refProg.eligibleCount ?? 0),         // qualified (Flutter expects this)
      referrals_qualified_done: Number(refProg.eligibleCount ?? 0),// alias
      referrals_required_min: referralsMin,

      referee_deposit_usdt_min: refereeDepositMin,
      referee_deposit_source: refereeDepositSource,
      referrals_missing: Array.isArray(refProg.missing) ? refProg.missing : [],

      updated_at: new Date().toISOString(),
    };

    const depositOk = depositMin <= 0 ? true : depositTotal >= depositMin;

    // ✅ IMPORTANT: claimable depends on QUALIFIED count, not total counted
    const qualified = Number(progress.referrals_done ?? 0);
    const refOk = referralsMin <= 0 ? true : qualified >= referralsMin;

    if (depositOk && refOk) {
      // if locked -> claimable
      if (c.status !== 'claimable') {
        await conn.query(
          `
          UPDATE reward_credits
          SET status='claimable', claimable_at=NOW(), progress_json=?
          WHERE id=? AND status IN ('locked','claimable')
          `,
          [JSON.stringify(progress), c.id]
        );
        updated++;
      } else {
        // already claimable: just refresh progress_json
        await conn.query(
          `UPDATE reward_credits SET progress_json=? WHERE id=? AND status='claimable'`,
          [JSON.stringify(progress), c.id]
        );
      }
    } else {
      // keep locked + update progress
      if (c.status === 'claimable') {
        // ✅ FIX old wrong claimable: demote back to locked
        await conn.query(
          `
          UPDATE reward_credits
          SET status='locked', claimable_at=NULL, progress_json=?
          WHERE id=? AND status='claimable'
          `,
          [JSON.stringify(progress), c.id]
        );
        demoted++;
      } else {
        await conn.query(
          `UPDATE reward_credits SET progress_json=? WHERE id=? AND status='locked'`,
          [JSON.stringify(progress), c.id]
        );
      }
    }
  }

  return { updated, demoted };
}

module.exports = { evaluateRewardCreditsForUser };
