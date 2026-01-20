// /server/lib/emails/reward_eligible.js (CommonJS)

function fmtAmount(n) {
  const x = Number(n || 0);
  const s = x.toFixed(2);
  return s.endsWith('.00') ? s.slice(0, -3) : s;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildRewardEligibleEmail({
  appName,
  webUrl,
  supportEmail,
  firstName,
  email,
  creditId,
  amountUsdt,
  title,
  note,
  timestampIso,
}) {
  const amount = fmtAmount(amountUsdt);
  const who = firstName || email || 'there';
  const brand = appName || 'Vegapunk Wallet';

  const cleanBase = (webUrl || '').trim().replace(/\/$/, '');
  const link = cleanBase ? `${cleanBase}/#/wallet` : null;

  const subject = `${brand} — Your reward is now claimable (+${amount} USDT)`;

  const label = title || 'Reward Credit';

  const text = [
    `Hi ${who},`,
    ``,
    `Good news! Your reward is now claimable.`,
    ``,
    `Reward: ${label}`,
    `Amount: +${amount} USDT`,
    `Reward Credit ID: ${creditId}`,
    note ? `Note: ${note}` : null,
    ``,
    link ? `Open your wallet to claim: ${link}` : null,
    ``,
    `Time: ${timestampIso}`,
    supportEmail ? `Support: ${supportEmail}` : null,
  ].filter(Boolean).join('\n');

  const html = `
  <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827;">
    <h2 style="margin:0 0 10px 0;">${escapeHtml(brand)}</h2>
    <p style="margin:0 0 12px 0;">Hi ${escapeHtml(who)},</p>

    <p style="margin:0 0 12px 0;">
      Good news! Your reward is now <b>claimable</b>.
    </p>

    <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px;margin:0 0 12px 0;">
      <div><b>Reward:</b> ${escapeHtml(label)}</div>
      <div><b>Amount:</b> +${escapeHtml(amount)} USDT</div>
      <div><b>Reward Credit ID:</b> ${escapeHtml(String(creditId))}</div>
      ${note ? `<div style="margin-top:6px;"><b>Note:</b> ${escapeHtml(note)}</div>` : ''}
      <div style="margin-top:6px;color:#6b7280;font-size:12px;">Time: ${escapeHtml(timestampIso)}</div>
    </div>

    ${link ? `
      <p style="margin:0 0 12px 0;">
        <a href="${link}" style="display:inline-block;padding:10px 14px;border-radius:10px;
           background:#111827;color:#ffffff;text-decoration:none;">
          Claim in Wallet
        </a>
      </p>
    ` : ''}

    ${supportEmail ? `
      <p style="margin:18px 0 0 0;color:#6b7280;font-size:12px;">
        Need help? ${escapeHtml(supportEmail)}
      </p>
    ` : ''}
  </div>
  `.trim();

  return { subject, text, html };
}

module.exports = { buildRewardEligibleEmail };
