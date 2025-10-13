// Node backend for Ph1taka (CommonJS)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const fs = require('fs');
const admin = require('firebase-admin');
const { z } = require('zod');

// --- Firebase Admin init ---
const keyPath =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  process.env.FIREBASE_ADMIN_KEY ||
  './serviceAccountKey.json';

if (!fs.existsSync(keyPath)) {
  console.error(`\n[FATAL] Firebase Admin key not found at: ${keyPath}\n`);
  process.exit(1);
}
const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

// --- App ---
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// --- Config ---
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

const db = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'ph1taka',
  connectionLimit: 10,
});

// --- Helpers ---
function nowPlusMinutes(mins) {
  const d = new Date();
  d.setMinutes(d.getMinutes() + mins);
  return d;
}
const issueJwt = (user) =>
  jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '30d' });

async function findUserByFirebaseOrPhone(firebaseUid, phone) {
  const [rows] = await db.query(
    'SELECT * FROM users WHERE firebase_uid=? OR phone=? LIMIT 1',
    [firebaseUid, phone]
  );
  return rows[0] || null;
}
async function createUser(firebaseUid, phone) {
  const [res] = await db.query(
    'INSERT INTO users (firebase_uid, phone) VALUES (?, ?)',
    [firebaseUid, phone]
  );
  const [rows] = await db.query('SELECT * FROM users WHERE id=?', [
    res.insertId,
  ]);
  return rows[0];
}

// JWT guard
function requireAuth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'NO_TOKEN' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: 'BAD_TOKEN' });
  }
}

// Canonicalize PH numbers to E.164 (+63…)
function canonicalizePH(phoneInput) {
  const d = String(phoneInput || '').replace(/\D/g, '');
  if (!d) throw new Error('BAD_PHONE');

  // 09XXXXXXXXX -> +63XXXXXXXXX
  if (d.length === 11 && d.startsWith('0')) return `+63${d.slice(1)}`;

  // 9XXXXXXXXX -> +639XXXXXXXXX
  if (d.length === 10 && d.startsWith('9')) return `+63${d}`;

  // 639XXXXXXXXX -> +639XXXXXXXXX
  if (d.length === 12 && d.startsWith('63')) return `+${d}`;

  // already +639XXXXXXXXX
  if (String(phoneInput).startsWith('+63') && d.length === 12) return `+${d}`;

  throw new Error('BAD_PHONE_PH');
}

// --- OTP: send (server-side OTP; no reCAPTCHA needed on web) ---
app.post('/otp/send', async (req, res) => {
  try {
    const phone = canonicalizePH(req.body?.phone);

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = nowPlusMinutes(5); // 5 minutes

    await db.query(
      `INSERT INTO otp_codes (phone, code, expires_at, attempts)
       VALUES (?,?,?,0)
       ON DUPLICATE KEY UPDATE code=VALUES(code), expires_at=VALUES(expires_at), attempts=0`,
      [phone, code, expiresAt]
    );

    // TODO: Integrate SMS (Twilio/MSG91/etc.)
    console.log(`[OTP] ${phone} -> ${code}`);

    res.json({ ok: true });
  } catch (e) {
    if (String(e.message || '').includes('BAD_PHONE')) {
      return res.status(400).json({ error: 'BAD_PHONE' });
    }
    console.error('otp/send', e);
    res.status(500).json({ error: 'SERVER_ERR' });
  }
});
// PIN login: phone + 4/6-digit pin -> JWT
// --- PIN login: phone + 4-digit pin -> issue app JWT ---
app.post('/auth/pin-login', async (req, res) => {
  try {
    const parse = z.object({
      phone: z.string().min(6),
      pin: z.string().regex(/^\d{4}$/),
    }).safeParse(req.body);

    if (!parse.success) return res.status(400).json({ error: 'BAD_BODY' });

    let phone;
    try { phone = canonicalizePH(parse.data.phone); }
    catch { return res.status(400).json({ error: 'BAD_PHONE' }); }

    const [rows] = await db.query('SELECT * FROM users WHERE phone=? LIMIT 1', [phone]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'NO_USER' });
    if (!user.pin_hash) return res.status(400).json({ error: 'NO_PIN' });

    const ok = await bcrypt.compare(parse.data.pin, user.pin_hash);
    if (!ok) return res.status(401).json({ error: 'BAD_PIN' });

    const token = issueJwt(user);
    return res.json({
      token,
      user: {
        id: user.id,
        phone: user.phone,
        full_name: user.full_name,
        pin_set: !!user.pin_hash,
      },
    });
  } catch (e) {
    console.error('pin-login', e);
    res.status(500).json({ error: 'SERVER_ERR' });
  }
});


// --- OTP: verify -> Firebase Custom Token ---
app.post('/otp/verify', async (req, res) => {
  try {
    const phone = canonicalizePH(req.body?.phone);
    const code = String(req.body?.code || '').trim();
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'BAD_CODE' });

    const [rows] = await db.query('SELECT * FROM otp_codes WHERE phone=? LIMIT 1', [phone]);
    const row = rows[0];
    if (!row) return res.status(400).json({ error: 'NO_OTP' });
    if (row.attempts >= 5) return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS' });
    if (new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'EXPIRED' });

    if (row.code !== code) {
      await db.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id=?', [row.id]);
      return res.status(400).json({ error: 'WRONG_CODE' });
    }

    // Ensure a Firebase user exists
    let fbUser;
    try {
      fbUser = await admin.auth().getUserByPhoneNumber(phone);
    } catch {
      fbUser = await admin.auth().createUser({ uid: `ph_${phone}`, phoneNumber: phone });
    }

    const customToken = await admin.auth().createCustomToken(fbUser.uid, {});

    // Clear OTP row (optional)
    await db.query('DELETE FROM otp_codes WHERE id=?', [row.id]);

    res.json({ ok: true, customToken });
  } catch (e) {
    if (String(e.message || '').includes('BAD_PHONE')) {
      return res.status(400).json({ error: 'BAD_PHONE' });
    }
    console.error('otp/verify', e);
    res.status(500).json({ error: 'SERVER_ERR' });
  }
});

// --- Auth: accept Firebase ID token; auto-create user; return app JWT ---
app.post('/auth/firebase-login', async (req, res) => {
  const parse = z.object({ idToken: z.string().min(10) }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'BAD_BODY' });
  try {
    const decoded = await admin.auth().verifyIdToken(parse.data.idToken);
    let firebaseUid = decoded.uid;
    let phone = decoded.phone_number || null;

    if (!phone) {
      // fetch user record
      try {
        const ur = await admin.auth().getUser(firebaseUid);
        phone = ur.phoneNumber || phone;
      } catch {}
      // fallback: uid like "ph_+63917..."
      if (!phone && firebaseUid.startsWith('ph_')) {
        phone = firebaseUid.slice(3);
      }
    }

    if (!phone) return res.status(400).json({ error: 'PHONE_REQUIRED' });

    // normalize here too (safety)
    try { phone = canonicalizePH(phone); } catch { return res.status(400).json({ error: 'PHONE_REQUIRED' }); }

    let user = await findUserByFirebaseOrPhone(firebaseUid, phone);
    if (!user) user = await createUser(firebaseUid, phone);

    const token = issueJwt(user);
    res.json({
      token,
      user: {
        id: user.id,
        phone: user.phone,
        full_name: user.full_name,
        pin_set: !!user.pin_hash,
      },
    });
  } catch (e) {
    console.error('firebase-login', e);
    res.status(401).json({ error: 'FIREBASE_TOKEN_INVALID' });
  }
});

// --- Profile setup (Full name + 4-digit PIN) ---
app.patch('/me/setup', requireAuth, async (req, res) => {
  const parse = z
    .object({
      full_name: z.string().min(1).max(100),
      pin: z.string().regex(/^\d{4}$/),
    })
    .safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'BAD_BODY' });

  const hash = await bcrypt.hash(parse.data.pin, 10);
  await db.query('UPDATE users SET full_name=?, pin_hash=? WHERE id=?', [
    parse.data.full_name,
    hash,
    req.userId,
  ]);
  const [rows] = await db.query(
    'SELECT id, phone, full_name FROM users WHERE id=?',
    [req.userId]
  );
  res.json({ ok: true, user: rows[0] });
});

// --- Me ---
app.get('/me', requireAuth, async (req, res) => {
  const [rows] = await db.query(
    'SELECT id, phone, full_name, pin_hash IS NOT NULL AS pin_set FROM users WHERE id=?',
    [req.userId]
  );
  res.json(rows[0]);
});
// index.js (Express)
app.get('/auth/phone-exists', async (req, res) => {
  const phone = (req.query.phone || '').trim();
  if (!phone) return res.status(400).json({ error: 'phone required' });

  const [rows] = await db.query('SELECT id FROM users WHERE phone = ? LIMIT 1', [phone]);
  res.json({ exists: rows.length > 0 });
});

// --- Start ---
app.listen(PORT, () => console.log(`Ph1taka server listening on :${PORT}`));
