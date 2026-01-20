// /server/lib/emails/reward_credited.js (CommonJS)

function fmtAmount(n) {
  const x = Number(n || 0);
  // Show up to 2 decimals, trim trailing .00
  const s = x.toFixed(2);
  return s.endsWith('.00') ? s.slice(0, -3) : s;
}

function buildRewardCreditedEmail({
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
  const link = webUrl ? `${webUrl.replace(/\/$/, '')}/#/wallet` : null;

  const subject = `${brand} — Reward credited: +${amount} USDT`;

  const textLines = [
    `Hi ${who},`,
    ``,
    `Good news! We’ve credited +${amount} USDT to your reward balance.`,
    `Reward Credit ID: ${creditId}`,
    title ? `Title: ${title}` : null,
    note ? `Note: ${note}` : null,
    link ? `` : null,
    link ? `Open your wallet: ${link}` : null,
    ``,
    `Time: ${timestampIso}`,
    supportEmail ? `Support: ${supportEmail}` : null,
  ].filter(Boolean);

  const text = textLines.join('\n');

  const html = `
  <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827;">
    <h2 style="margin:0 0 10px 0;">${brand}</h2>
    <p style="margin:0 0 12px 0;">Hi ${escapeHtml(who)},</p>

    <p style="margin:0 0 12px 0;">
      Good news! We’ve credited <b>+${escapeHtml(amount)} USDT</b> to your reward balance.
    </p>

    <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px;margin:0 0 12px 0;">
      <div><b>Reward Credit ID:</b> ${escapeHtml(String(creditId))}</div>
      ${title ? `<div><b>Title:</b> ${escapeHtml(title)}</div>` : ''}
      ${note ? `<div style="margin-top:6px;"><b>Note:</b> ${escapeHtml(note)}</div>` : ''}
      <div style="margin-top:6px;color:#6b7280;font-size:12px;">Time: ${escapeHtml(timestampIso)}</div>
    </div>

    ${link ? `
      <p style="margin:0 0 12px 0;">
        <a href="${link}" style="display:inline-block;padding:10px 14px;border-radius:10px;
           background:#111827;color:#ffffff;text-decoration:none;">
          Open Wallet
        </a>
      </p>
    ` : ''}

    ${supportEmail ? `
      <p style="margin:18px 0 0 0;color:#6b7280;font-size:12px;">
        If you didn’t expect this, contact support: ${escapeHtml(supportEmail)}
      </p>
    ` : ''}
  </div>
  `.trim();

  return { subject, text, html };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { buildRewardCreditedEmail };
