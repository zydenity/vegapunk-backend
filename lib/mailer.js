// /server/lib/mailer.js (CommonJS)
const nodemailer = require('nodemailer');

function boolEnv(v, def = false) {
  if (v == null) return def;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return def;
}

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);

  // Port 465 = SSL, Port 587 = STARTTLS (secure:false is correct)
  const secure = process.env.SMTP_SECURE
    ? boolEnv(process.env.SMTP_SECURE, false)
    : port === 465;

  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) return null;

  transporter = nodemailer.createTransport({
    host,
    port,
    secure, // ✅ use computed value
    auth: { user, pass },

    // For 587, STARTTLS is negotiated after connect
    requireTLS: port === 587 ? true : undefined,

    // TLS hints
    tls: {
      servername: host,
    },
  });

  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  const smtpUser = process.env.SMTP_USER || 'no-reply@example.com';
  const appName = process.env.APP_NAME || 'Vegapunk Wallet';
  const from = process.env.SMTP_FROM || `"${appName}" <${smtpUser}>`;

  const tx = getTransporter();
  if (!tx) {
    console.log('[mailer:SKIP_NO_SMTP]', {
      to,
      subject,
      hasHost: !!process.env.SMTP_HOST,
      hasUser: !!process.env.SMTP_USER,
      hasPass: !!process.env.SMTP_PASS,
      from,
    });
    return { skipped: true };
  }

  // ✅ Debug: show sender + recipient
  console.log('[mailer:SENDING]', { from, to, subject });

  const info = await tx.sendMail({ from, to, subject, text, html });

  // ✅ This is the MOST important part
  console.log('[mailer:SENT]', {
    accepted: info.accepted,
    rejected: info.rejected,
    response: info.response,
    messageId: info.messageId,
    envelope: info.envelope,
  });

  return info;
}

module.exports = { sendMail };
