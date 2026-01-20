// server/routes/auth/email.js  (CommonJS)
const express = require('express');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');

module.exports = function makeAuthEmailRouter(db) {
  const router = express.Router();

  const {
    SMTP_HOST = 'smtp.hostinger.com',
    SMTP_PORT = 465,
    SMTP_USER,
    SMTP_PASS,
    SMTP_FROM,
    JWT_SECRET = 'dev-secret-change-me',
  } = process.env;

  const mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  // Helpful during setup:
  // mailer.verify().then(() => console.log('SMTP OK')).catch(err => console.error('SMTP ERR', err));

  function sixDigit() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  // ✅ MUST be async if you use await
  async function sendOtpEmail(to, code) {
    await mailer.sendMail({
      from: SMTP_FROM || SMTP_USER,
      to,
      subject: 'Your Vegapunk verification code',
      text: `Your code is ${code}. It expires in 10 minutes.`,
      html: `<p>Your code is <b>${code}</b>. It expires in 10 minutes.</p>`,
    });
  }

  // POST /auth/email/request-otp
// POST /auth/email/request-otp
// POST /auth/email/verify-otp
// routes/auth/email.js
router.post('/email/request-otp', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'INVALID_EMAIL' });
    }

    const code = sixDigit();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await db.query(
      `INSERT INTO otp_email_codes (email, code, purpose, expires_at, used)
       VALUES (?, ?, 'login', ?, 0)`,
      [email.toLowerCase(), code, expiresAt]
    );

    // respond immediately so the Future completes
    res.json({ ok: true });

    // send email in background
    setImmediate(() => {
      sendOtpEmail(email, code)
        .then(() => console.log(`[OTP][email] sent to ${email}`))
        .catch(err => console.error('[OTP][email] send failed:', err));
    });
  } catch (e) {
    console.error('request-otp error', e);
    if (!res.headersSent) res.status(500).json({ error: 'OTP_SEND_FAILED' });
  }
});




  // POST /auth/email/verify-otp
  router.post('/email/verify-otp', async (req, res) => {
    try {
      const { email, code } = req.body || {};
      if (!email || !code) return res.status(400).json({ error: 'MISSING_FIELDS' });

      const [rows] = await db.query(
        `SELECT id, code, expires_at, used
           FROM otp_email_codes
          WHERE email=? AND purpose='login'
       ORDER BY id DESC LIMIT 1`,
        [email.toLowerCase()]
      );
      if (!rows.length) return res.status(400).json({ error: 'NO_CODE' });

      const row = rows[0];
      if (row.used) return res.status(400).json({ error: 'ALREADY_USED' });
      if (new Date(row.expires_at).getTime() < Date.now()) {
        return res.status(400).json({ error: 'EXPIRED' });
      }
      if (String(row.code) !== String(code)) {
        return res.status(400).json({ error: 'INVALID_CODE' });
      }

      await db.query(`UPDATE otp_email_codes SET used=1 WHERE id=?`, [row.id]);

      await db.query(
        `INSERT INTO users (email) VALUES (?)
         ON DUPLICATE KEY UPDATE email=email`,
        [email.toLowerCase()]
      );

      const [users] = await db.query(
        `SELECT id, email, full_name, pin_hash IS NOT NULL AS pin_set
           FROM users WHERE email=? LIMIT 1`,
        [email.toLowerCase()]
      );
      const user = users[0];

      const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '30d' });

      res.json({
        ok: true,
        user: { id: user.id, email: user.email, full_name: user.full_name, pin_set: !!user.pin_set },
        pin_set: !!user.pin_set,
        token,
      });
    } catch (e) {
      console.error('verify-otp error', e);
      res.status(500).json({ error: 'OTP_VERIFY_FAILED' });
    }
  });

  // GET /auth/email/exists
  router.get('/email/exists', async (req, res) => {
    try {
      const email = (req.query.email || '').toString().toLowerCase();
      if (!email) return res.json({ exists: false });
      const [rows] = await db.query(`SELECT 1 FROM users WHERE email=? LIMIT 1`, [email]);
      res.json({ exists: rows.length > 0 });
    } catch (e) {
      console.error('email/exists error', e);
      res.status(500).json({ exists: false });
    }
  });

  return router;
};
