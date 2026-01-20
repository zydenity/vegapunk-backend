// /server/lib/notify_reward_credits.js (CommonJS)
const { sendMail } = require('./mailer');

const { buildRewardAssignedEmail } = require('./emails/reward_assigned');
const { buildRewardEligibleEmail } = require('./emails/reward_eligible');
const { buildRewardCreditedEmail } = require('./emails/reward_credited');

function pickFirstName(u) {
  // users table: full_name, email, phone
  if (u?.full_name) return String(u.full_name).trim().split(/\s+/)[0] || null;
  if (u?.email) return String(u.email).split('@')[0] || null;
  return null;
}

function envDefaults() {
  return {
    appName: process.env.APP_NAME || 'Vegapunk Wallet',
    webUrl: process.env.APP_WEB_URL || process.env.REF_BASE_URL || '',
    supportEmail: process.env.SUPPORT_EMAIL || process.env.SMTP_USER || '',
  };
}

/**
 * Sends email for status transitions:
 * - locked    -> assigned email (New Year signup reward)
 * - claimable -> eligible email
 * - claimed   -> credited email
 *
 * Anti-duplicate via *_notified_at columns.
 *
 * Spam-safe behavior for status jumps:
 * - If a credit jumps straight to claimed, we send ONLY "credited"
 *   and mark earlier stages as notified (without emailing them).
 * - If it jumps to claimable, we send ONLY "eligible"
 *   and mark assigned as notified (without emailing it).
 */
async function notifyRewardCreditEmailsForUser(db, userId, { limit = 200, debug = false } = {}) {
  if (!db) throw new Error('notifyRewardCreditEmailsForUser: db is required');
  if (!Number.isFinite(Number(userId)) || Number(userId) <= 0) return;

  const { appName, webUrl, supportEmail } = envDefaults();

  const [rows] = await db.query(
    `
    SELECT
      rc.id          AS credit_id,
      rc.user_id     AS user_id,
      rc.status      AS status,
      rc.amount_usdt AS amount_usdt,
      rc.title       AS title,
      rc.note        AS note,
      rc.assigned_notified_at AS assigned_notified_at,
      rc.eligible_notified_at AS eligible_notified_at,
      rc.credited_notified_at AS credited_notified_at,

      u.email        AS email,
      u.full_name    AS full_name,
      u.phone        AS phone
    FROM reward_credits rc
    JOIN users u ON u.id = rc.user_id
    WHERE rc.user_id = ?
      AND (
        (rc.status='locked'    AND rc.assigned_notified_at IS NULL)
        OR
        (rc.status='claimable' AND rc.eligible_notified_at IS NULL)
        OR
        (rc.status='claimed'   AND rc.credited_notified_at IS NULL)
      )
    ORDER BY rc.id ASC
    LIMIT ?
    `,
    [Number(userId), Number(limit)]
  );

  if (debug) {
    console.log('[reward-email] rows found:', rows.length, 'userId:', userId);
    if (rows[0]) {
      console.log('[reward-email] sample:', {
        creditId: rows[0].credit_id,
        status: rows[0].status,
        email: rows[0].email,
        full_name: rows[0].full_name,
      });
    }
  }

  for (const r of rows) {
    const email = (r.email || '').toString().trim();
    if (!email) continue;

    const status = String(r.status || '').toLowerCase();
    const ts = new Date().toISOString();

    let tpl = null;

    if (status === 'claimed') {
      tpl = buildRewardCreditedEmail({
        appName,
        webUrl,
        supportEmail,
        firstName: pickFirstName(r),
        email,
        creditId: r.credit_id,
        amountUsdt: r.amount_usdt,
        title: r.title,
        note: r.note,
        timestampIso: ts,
      });
    } else if (status === 'claimable') {
      tpl = buildRewardEligibleEmail({
        appName,
        webUrl,
        supportEmail,
        firstName: pickFirstName(r),
        email,
        creditId: r.credit_id,
        amountUsdt: r.amount_usdt,
        title: r.title,
        note: r.note,
        timestampIso: ts,
      });
    } else if (status === 'locked') {
      tpl = buildRewardAssignedEmail({
        appName,
        webUrl,
        supportEmail,
        firstName: pickFirstName(r),
        email,
        creditId: r.credit_id,
        amountUsdt: r.amount_usdt,
        title: r.title,
        note: r.note,
        timestampIso: ts,
      });
    } else {
      continue;
    }

    if (debug) {
      console.log('[reward-email] sending:', {
        to: email,
        status,
        creditId: r.credit_id,
        amount: Number(r.amount_usdt || 0),
      });
    }

    // Send email; if sending fails, do NOT mark notified (so it can retry later)
    await sendMail({
      to: email,
      subject: tpl.subject,
      text: tpl.text,
      html: tpl.html,
    });

    // Mark notified safely (avoid multiple emails if status jumps)
    if (status === 'claimed') {
      await db.query(
        `
        UPDATE reward_credits
           SET credited_notified_at = NOW(),
               eligible_notified_at = IFNULL(eligible_notified_at, NOW()),
               assigned_notified_at = IFNULL(assigned_notified_at, NOW())
         WHERE id = ?
        `,
        [Number(r.credit_id)]
      );
    } else if (status === 'claimable') {
      await db.query(
        `
        UPDATE reward_credits
           SET eligible_notified_at = NOW(),
               assigned_notified_at = IFNULL(assigned_notified_at, NOW())
         WHERE id = ?
        `,
        [Number(r.credit_id)]
      );
    } else if (status === 'locked') {
      await db.query(
        `UPDATE reward_credits SET assigned_notified_at = NOW() WHERE id = ?`,
        [Number(r.credit_id)]
      );
    }
  }
}

// Backward compatible export (if your route still imports old name)
async function notifyCreditedRewardCreditsForUser(db, userId, opts) {
  return notifyRewardCreditEmailsForUser(db, userId, opts);
}

module.exports = {
  notifyRewardCreditEmailsForUser,
  notifyCreditedRewardCreditsForUser,
};
