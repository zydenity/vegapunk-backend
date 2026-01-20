
// server.js — Ph1taka backend (CommonJS) — UPDATED: MHV ⇄ VPK (MHV accepted as alias)
const fs = require('fs');
const path = require('path');

require('dotenv').config(); // ✅ move up

function bootlog(...a) {
  try {
    fs.appendFileSync(
      path.join(__dirname, 'runtime.log'),
      `[${new Date().toISOString()}] ${a.map(x => (x && x.stack) ? x.stack : String(x)).join(' ')}\n`
    );
  } catch (_) {}
  console.log(...a);
}

process.on('uncaughtException', (e) => bootlog('UNCAUGHT', e));
process.on('unhandledRejection', (e) => bootlog('UNHANDLED', e));

bootlog('BOOT OK');
bootlog('PORT', process.env.PORT);
bootlog('FIREBASE_ADMIN_B64 length', (process.env.FIREBASE_ADMIN_B64 || '').length);

require('dotenv').config();

// ✅ Guard: older Node may not support setDefaultResultOrder
try {
  require('dns').setDefaultResultOrder('ipv4first');
} catch (e) {
  console.warn('[BOOT] dns.setDefaultResultOrder not supported on this Node:', e?.message || e);
}

const nodeCrypto = require('crypto');

// ✅ Polyfill fetch for Node < 18 (only used if global fetch is missing)
if (typeof globalThis.fetch !== 'function') {
  globalThis.fetch = (...args) =>
    import('node-fetch').then((m) => m.default(...args));
  console.warn('[BOOT] global fetch polyfilled via node-fetch (install: npm i node-fetch)');
}

const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const admin = require('firebase-admin');
const { z } = require('zod');
const makeKycRoutes = require('./routes/kyc');

const makeAdminRouter = require('./routes/admin'); // 👈 NEW
const makeAdminRewardCreditsRouter = require('./routes/admin_reward_credits');
const makeRewardCreditsRouter = require('./routes/reward_credits');
const { evaluateRewardCreditsForUser } = require('./lib/reward_credits');

// ethers v6
const {
  HDNodeWallet,
  JsonRpcProvider,
  Wallet,
  Contract,
  parseUnits,
  formatUnits,
  isAddress,
} = require('ethers');

// Feature routers (some optional)
const makeDepositsMock = require('./routes/deposits_mock');
const makeStakingRoutes = require('./routes/staking');
const makeAuthEmailRouter = require('./routes/auth/email'); // PUBLIC email OTP

let makeReferralRoutes = null; // optional (wrap in try/catch below)
try { makeReferralRoutes = require('./routes/referrals'); } catch { /* ok in dev */ }

const USDT_PHP_RATE = Number(process.env.USDT_PHP_RATE || 58.0);
const DEPOSIT_WEBHOOK_URL = process.env.DEPOSIT_WEBHOOK_URL || '';
const DEPOSIT_WEBHOOK_SECRET = process.env.DEPOSIT_WEBHOOK_SECRET || '';

const USDT_CONTRACT = process.env.USDT_CONTRACT;
const USDT_DECIMALS = Number(process.env.USDT_DECIMALS || 18);
const HOT_WALLET_PK = process.env.HOT_WALLET_PK;      // 🔑 company hot wallet
const WITHDRAW_CONFS = Number(process.env.CONFIRMATIONS_REQUIRED || 1);

const DEPOSIT_SWEEP_ENABLED = process.env.DEPOSIT_SWEEP_ENABLED === '1';
const DEPOSIT_SWEEP_TO_ADDRESS = (process.env.DEPOSIT_SWEEP_TO_ADDRESS || '').trim();
const DEPOSIT_SWEEP_MIN_USDT = Number(process.env.DEPOSIT_SWEEP_MIN_USDT || 0);
const DEPOSIT_SWEEP_MAX_TOPUP_BNB = Number(process.env.DEPOSIT_SWEEP_MAX_TOPUP_BNB || 0.01);
const DEPOSIT_SWEEP_GAS_BUFFER_PCT = Number(process.env.DEPOSIT_SWEEP_GAS_BUFFER_PCT || 1.25);
const DEPOSIT_SWEEP_CONFS = Number(process.env.DEPOSIT_SWEEP_CONFS || WITHDRAW_CONFS || 1);

// ── Stake split recipients (USDT) ──
const SPLIT_REF_LEAD_ADDR = (process.env.SPLIT_REF_LEAD_ADDR || '').trim();
const SPLIT_LEADER_SUPPORT_ADDR = (process.env.SPLIT_LEADER_SUPPORT_ADDR || '').trim();
const SPLIT_SAVINGS_ADDR = (process.env.SPLIT_SAVINGS_ADDR || '').trim();
const SPLIT_REED_ADDR = (process.env.SPLIT_REED_ADDR || '').trim();
const SPLIT_NINO_ADDR = (process.env.SPLIT_NINO_ADDR || '').trim();

// How many confirmations to wait for split txs (keep low so staking isn't slow)
const SPLIT_WAIT_CONFS = Number(process.env.SPLIT_WAIT_CONFS || 1);

/* ───────────────────────── App / Config ───────────────────────── */
const app = express();
app.use(cors({ origin: true, credentials: true }));

// ✅ Increase body size for KYC base64 uploads (override via .env BODY_LIMIT=50mb)
const BODY_LIMIT = (process.env.BODY_LIMIT || '50mb').trim();
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

// ✅ Return clean errors for payload/json problems (helps Flutter show real reason)
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'BAD_JSON' });
  }
  return next(err);
});

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// Fee config (can override via .env later)
const BANK_CONVERSION_FEE_PCT = Number(process.env.BANK_CONVERSION_FEE_PCT || 0.005); // 0.5%
const BANK_SEND_FEE_USDT = Number(process.env.BANK_SEND_FEE_USDT || 1.0);   // flat 1 USDT

// Network gas fee bounds (USDT) and markup
const NETWORK_FEE_MARKUP = Number(process.env.NETWORK_FEE_MARKUP || 1.10);  // +10%
const MIN_NETWORK_FEE_USDT = Number(process.env.MIN_NETWORK_FEE_USDT || 0.15);
const MAX_NETWORK_FEE_USDT = Number(process.env.MAX_NETWORK_FEE_USDT || 1.0);

// BSC provider (for live gasPrice)
const bscProvider = new JsonRpcProvider(process.env.BSC_RPC);

app.get('/', (req, res) => res.status(200).send('OK'));
app.get('/health', (req, res) => res.json({ ok: true }));

/* ───────────────────────── DB ───────────────────────── */
const db = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'ph1taka',
  connectionLimit: 10,
});

/* ───────────────────────── Asset normalization ─────────────────────────
   ✅ MHV is accepted as an alias of VPK for backward compatibility.
*/
function normAsset(a) {
  const x = String(a || '').trim().toUpperCase();
  if (x === 'MHV') return 'VPK';
  return x;
}

// Idempotent credit of a deposit + webhook (LIVE mode)
async function creditDepositAndWebhook({ depositId, amount, txHash, meta }) {
  const conn = await db.getConnection();
  let webhookPayload = null;

  try {
    await conn.beginTransaction();

    const [depRows] = await conn.query(
      `SELECT id, user_id, asset, chain, amount_received,
              confirmations, required_confirmations, tx_hash
         FROM crypto_deposits
        WHERE id = ?
        FOR UPDATE`,
      [depositId]
    );

    if (!depRows.length) throw new Error('deposit_not_found');

    const dep = depRows[0];
    const userId = dep.user_id;
    const asset = dep.asset;
    const chain = dep.chain;

    // Idempotency: if already in ledger, no-op
    const [exists] = await conn.query(
      `SELECT id
         FROM wallet_ledger
        WHERE type = 'deposit'
          AND ref_id = ?
        LIMIT 1`,
      [depositId]
    );

    if (exists.length) {
      await conn.commit();
      console.log('[DEPOSIT] already credited, skip', { depositId });
      return;
    }

    // Decide final amount (from argument or stored)
    const amtNum = Number(amount != null ? amount : dep.amount_received);

    if (!Number.isFinite(amtNum) || amtNum <= 0) {
      throw new Error('invalid_amount');
    }

    // Upsert wallet balance
    await conn.query(
      `INSERT INTO wallet_balances (user_id, asset, balance)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
      [userId, asset, amtNum]
    );

    // Insert ledger entry
    const ledgerMeta = Object.assign({}, meta || {}, { live: true });

    await conn.query(
      `INSERT INTO wallet_ledger
         (user_id, ts, asset, chain, type, amount, ref_id, meta)
       VALUES
         (?, NOW(), ?, ?, 'deposit', ?, ?, ?)`,
      [userId, asset, chain, amtNum, depositId, JSON.stringify(ledgerMeta)]
    );

    // Mark deposit as credited
    await conn.query(
      `UPDATE crypto_deposits
          SET status           = 'credited',
              amount_received  = COALESCE(amount_received, ?),
              confirmations    = GREATEST(COALESCE(confirmations,0), required_confirmations),
              tx_hash          = COALESCE(tx_hash, ?),
              updated_at       = NOW()
        WHERE id = ?`,
      [amtNum, txHash || dep.tx_hash || `MANUAL-${depositId}`, depositId]
    );

    await conn.commit();

    webhookPayload = {
      depositId,
      userId,
      asset,
      chain,
      amount: amtNum.toString(),
      tx_hash: txHash || dep.tx_hash || null,
      status: 'credited',
    };

    console.log('[DEPOSIT] credited', webhookPayload);

    triggerDepositSweep(depositId);
  } catch (err) {
    await conn.rollback();
    console.error('[DEPOSIT] creditDepositAndWebhook error', err);
    throw err;
  } finally {
    conn.release();
  }

  // Fire webhook OUTSIDE the transaction
  if (webhookPayload) {
    sendDepositWebhook(webhookPayload).catch((err) => {
      console.error('[WEBHOOK] deposit -> async error', err);
    });
  }
}

/* ───────────────────────── Firebase Admin init ─────────────────────────
   ✅ Hostinger-friendly: supports FIREBASE_ADMIN_B64 env var (base64 JSON)
   ✅ Local/VPS fallback: GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_ADMIN_KEY / ./serviceAccountKey.json
*/
/* ───────────────────────── Firebase Admin init ───────────────────────── */
let serviceAccount = null;

if (process.env.FIREBASE_ADMIN_B64) {
  serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_ADMIN_B64, 'base64').toString('utf8')
  );
} else {
  const keyPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.FIREBASE_ADMIN_KEY ||
    './serviceAccountKey.json';

  if (fs.existsSync(keyPath)) {
    serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  }
}

if (!serviceAccount) {
  console.error('[FATAL] Firebase Admin credentials missing. Set FIREBASE_ADMIN_B64.');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

/* ───────────────────────── Helpers ───────────────────────── */
function nowPlusMinutes(mins) {
  const d = new Date();
  d.setMinutes(d.getMinutes() + mins);
  return d;
}
const issueJwt = (user) => jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '30d' });

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

function requireAdmin(req, res, next) {
  // TODO: replace with real admin validation
  return requireAuth(req, res, next);
}

// ✅ Reward Credits routes (clean prefixes)
// build admin router once
const adminRouter = makeAdminRouter({
  db,
  JWT_SECRET,
  creditDepositAndWebhook,
});

// mount admin router
app.use('/admin', adminRouter);

// ✅ mount admin reward credits using the SAME admin guard/secret
app.use(
  '/admin/reward-credits',
  makeAdminRewardCreditsRouter({
    db,
    requireAdmin: adminRouter.requireAdmin,
  })
);

app.use('/v1/reward-credits', makeRewardCreditsRouter({ db, requireAuth }));
app.use('/v1/rewards',        makeRewardCreditsRouter({ db, requireAuth })); // ✅ Flutter uses this

function normSource(input) {
  const s = String(input || 'any').toLowerCase();
  return (s === 'coinsph' || s === 'binance' || s === 'any') ? s : 'any';
}

// Canonicalize PH numbers to E.164 (+63…)
function canonicalizePH(phoneInput) {
  const d = String(phoneInput || '').replace(/\D/g, '');
  if (!d) throw new Error('BAD_PHONE');
  if (d.length === 11 && d.startsWith('0')) return `+63${d.slice(1)}`;
  if (d.length === 10 && d.startsWith('9')) return `+63${d}`;
  if (d.length === 12 && d.startsWith('63')) return `+${d}`;
  if (String(phoneInput).startsWith('+63') && d.length === 12) return `+${d}`;
  throw new Error('BAD_PHONE_PH');
}

// ethers v6-safe derivation (derive in one call with full path)
function deriveEvmAddress(index) {
  const m = process.env.HD_MNEMONIC;
  if (!m) throw new Error('HD_MNEMONIC missing');
  const acct = Number(process.env.HD_ACCOUNT || 0);
  const path = `m/44'/60'/${acct}'/0/${index}`; // BIP44 EVM
  const wallet = HDNodeWallet.fromPhrase(m, undefined, path);
  return wallet.address; // checksummed 0x…
}

// Webhook sender
async function sendDepositWebhook(payload) {
  if (!DEPOSIT_WEBHOOK_URL) {
    console.log('[WEBHOOK] DEPOSIT_WEBHOOK_URL not set, skipping webhook');
    return;
  }

  const wrapper = {
    event: 'wallet.deposit.credited',
    ts: Date.now(),
    data: payload,
  };

  const body = JSON.stringify(wrapper);
  const headers = { 'content-type': 'application/json' };

  if (DEPOSIT_WEBHOOK_SECRET) {
    const sig = nodeCrypto
      .createHmac('sha256', DEPOSIT_WEBHOOK_SECRET)
      .update(body)
      .digest('hex');

    headers['x-ph1taka-signature'] = sig;
  }

  try {
    await fetch(DEPOSIT_WEBHOOK_URL, { method: 'POST', headers, body });
    console.log('[WEBHOOK] deposit -> sent', payload);
  } catch (err) {
    console.error('[WEBHOOK] deposit -> FAILED', err);
  }
}

/* ───────────────────────── Rates + Fee helpers ───────────────────────── */
/* ───────────────────────── USDT→PHP live rate helper ───────────────────────── */

const FALLBACK_USDT_PHP = USDT_PHP_RATE; // from .env, e.g. 58

let _usdtPhpCache = FALLBACK_USDT_PHP;
let _usdtPhpCacheTs = 0;
const USDT_PHP_TTL_MS = 60_000; // 1 minute cache

async function getUsdtPhpRate() {
  const now = Date.now();

  // Use cached value if still fresh
  if (now - _usdtPhpCacheTs < USDT_PHP_TTL_MS && _usdtPhpCache) {
    return _usdtPhpCache;
  }

  try {
    const resp = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=php'
    );

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const data = await resp.json();
    const rate = Number(data?.tether?.php);

    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error('Bad rate from API');
    }

    _usdtPhpCache = rate;
    _usdtPhpCacheTs = now;
    return rate;
  } catch (err) {
    console.error('[RATES] getUsdtPhpRate failed, using fallback:', err.message);
    return FALLBACK_USDT_PHP;
  }
}

// cache Binance rates for 60s
let _ratesCache = null;
let _ratesCacheTs = 0;

async function getRates() {
  const now = Date.now();
  if (_ratesCache && now - _ratesCacheTs < 60_000) return _ratesCache;

  let bnbUsdt = 600; // sane fallback
  try {
    const resp = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT');
    if (resp.ok) {
      const j = await resp.json();
      bnbUsdt = parseFloat(j.price);
    }
  } catch (err) {
    console.error('[RATES] Failed to fetch BNB/USDT from Binance, using fallback 600', err);
  }

  // 🔥 live USDT→PHP instead of static .env
  const usdtPhp = await getUsdtPhpRate();

  _ratesCache = { BNB_USDT: bnbUsdt, USDT_PHP: usdtPhp };
  _ratesCacheTs = now;
  return _ratesCache;
}

// Approximate live gas (BSC) → USDT
async function quoteCryptoTransfer({ chain, amountUsdt }) {
  const chainNorm = (chain || 'BSC').toUpperCase();
  if (chainNorm !== 'BSC') throw new Error('UNSUPPORTED_CHAIN');

  let gasPriceWei;
  try {
    const feeData = await bscProvider.getFeeData();
    gasPriceWei =
      feeData.gasPrice ??
      feeData.maxFeePerGas ??
      BigInt(3_000_000_000); // 3 gwei fallback
  } catch (err) {
    console.error('[GAS] getFeeData failed, using fallback 3 gwei', err);
    gasPriceWei = BigInt(3_000_000_000);
  }

  const gasLimit = BigInt(80_000);
  const feeWei = gasPriceWei * gasLimit;

  const feeBnb = Number(feeWei) / 1e18;
  const rates = await getRates();
  const bnbUsdt = rates.BNB_USDT || 600;

  let networkFeeUsdt = feeBnb * bnbUsdt * NETWORK_FEE_MARKUP;

  networkFeeUsdt = Math.max(
    MIN_NETWORK_FEE_USDT,
    Math.min(MAX_NETWORK_FEE_USDT, networkFeeUsdt),
  );

  const totalDebitUsdt = amountUsdt + networkFeeUsdt;

  return {
    network_fee_usdt: networkFeeUsdt,
    conversion_fee_usdt: 0,
    send_fee_usdt: 0,
    total_debit_usdt: totalDebitUsdt,
    recv_amount_usdt: amountUsdt,
    recv_amount_php: null,
  };
}

async function quoteBankTransfer({ amountUsdt }) {
  const rates = await getRates();
  const usdtPhp = rates.USDT_PHP || USDT_PHP_RATE || 58.0;

  const conversionFeeUsdt = amountUsdt * BANK_CONVERSION_FEE_PCT;
  const sendFeeUsdt = BANK_SEND_FEE_USDT;
  const totalDebitUsdt = amountUsdt + conversionFeeUsdt + sendFeeUsdt;
  const recvPhp = amountUsdt * usdtPhp;

  return {
    network_fee_usdt: 0,
    conversion_fee_usdt: conversionFeeUsdt,
    send_fee_usdt: sendFeeUsdt,
    total_debit_usdt: totalDebitUsdt,
    recv_amount_usdt: null,
    recv_amount_php: recvPhp,
  };
}

/* ───────────────────────── On-chain USDT send helpers ───────────────────────── */

const ERC20_ABI = [
  "function transfer(address to, uint256 value) external returns (bool)",
  "function balanceOf(address owner) view returns (uint256)"
];

function getHotWallet() {
  if (!HOT_WALLET_PK) throw new Error('HOT_WALLET_PK missing in env');

  const pk = HOT_WALLET_PK.trim().replace(/^"|"$/g, '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error('HOT_WALLET_PK format invalid – must be 0x + 64 hex chars');
  }
  return new Wallet(pk, bscProvider);
}

function getUsdtContract(signerOrProvider) {
  if (!USDT_CONTRACT) throw new Error('USDT_CONTRACT missing in env');
  return new Contract(USDT_CONTRACT, ERC20_ABI, signerOrProvider);
}

// ───────────────────────── Stake → USDT split (hot wallet) ─────────────────────────
const STAKE_UNIT_USDT = 9.0;

function _mustAddr(label, addr) {
  if (!addr || !isAddress(addr)) throw new Error(`Missing/invalid ${label} address`);
  return addr;
}

const _SPLITS = [
  { label: 'referral_leadership_com', to: () => _mustAddr('SPLIT_REF_LEAD_ADDR', SPLIT_REF_LEAD_ADDR), num: 1n, den: 10n },
  { label: 'leaders_support',         to: () => _mustAddr('SPLIT_LEADER_SUPPORT_ADDR', SPLIT_LEADER_SUPPORT_ADDR), num: 1n, den: 10n },
  { label: 'savings',                 to: () => _mustAddr('SPLIT_SAVINGS_ADDR', SPLIT_SAVINGS_ADDR), num: 1n, den: 6n  },
  { label: 'reed',                    to: () => _mustAddr('SPLIT_REED_ADDR', SPLIT_REED_ADDR), num: 1n, den: 6n  },
  { label: 'nino',                    to: () => _mustAddr('SPLIT_NINO_ADDR', SPLIT_NINO_ADDR), num: 1n, den: 6n  },
];

async function distributeStakeSplits({ positionId, userId, units }) {
  const u = BigInt(Math.floor(Number(units || 0)));
  if (u <= 0n) return { ok: true, skipped: true };

  const unitWei = parseUnits(String(STAKE_UNIT_USDT), USDT_DECIMALS);
  const totalWei = u * unitWei;

  const [[lk]] = await db.query(`SELECT GET_LOCK('hotwallet_usdt_split', 15) AS got`);
  if (!lk?.got) throw new Error('HOTWALLET_SPLIT_LOCK_TIMEOUT');

  try {
    for (const s of _SPLITS) {
      const to = s.to();
      const amtWei = (totalWei * s.num) / s.den;

      await db.query(
        `INSERT INTO stake_split_transfers
           (position_id, user_id, label, to_address, amount_wei, status)
         VALUES (?, ?, ?, ?, ?, 'pending')
         ON DUPLICATE KEY UPDATE
           to_address=VALUES(to_address),
           amount_wei=VALUES(amount_wei)`,
        [positionId, userId, s.label, to, amtWei.toString()]
      );
    }

    const [rows] = await db.query(
      `SELECT id, label, to_address, amount_wei, tx_hash, status
         FROM stake_split_transfers
        WHERE position_id=?
        ORDER BY id ASC`,
      [positionId]
    );

    const wallet = getHotWallet();
    const usdt = getUsdtContract(wallet);

    const sent = [];
    for (const r of rows) {
      if (r.status === 'sent' && r.tx_hash) continue;

      const amt = BigInt(r.amount_wei || '0');
      if (amt <= 0n) {
        await db.query(
          `UPDATE stake_split_transfers SET status='sent', last_error=NULL WHERE id=?`,
          [r.id]
        );
        continue;
      }

      try {
        const tx = await usdt.transfer(r.to_address, amt);

        await db.query(
          `UPDATE stake_split_transfers
              SET tx_hash=?, status='sent', last_error=NULL
            WHERE id=?`,
          [tx.hash, r.id]
        );

        if (SPLIT_WAIT_CONFS > 0) await tx.wait(SPLIT_WAIT_CONFS);

        sent.push({ label: r.label, to: r.to_address, txHash: tx.hash });
      } catch (e) {
        await db.query(
          `UPDATE stake_split_transfers
              SET status='failed', last_error=?
            WHERE id=?`,
          [String(e?.message || e), r.id]
        );
      }
    }

    const sumWei = rows.reduce((acc, r) => acc + BigInt(r.amount_wei || '0'), 0n);
    const remainderWei = totalWei - sumWei;

    return { ok: true, totalWei: totalWei.toString(), remainderWei: remainderWei.toString(), sent };
  } finally {
    await db.query(`SELECT RELEASE_LOCK('hotwallet_usdt_split')`);
  }
}

async function sendUsdtFromHotWallet({ to, amountUsdt }) {
  if (!to || !to.startsWith('0x') || to.length !== 42) throw new Error('BAD_TO_ADDRESS');

  const wallet = getHotWallet();
  const usdt = getUsdtContract(wallet);
  const amountWei = parseUnits(amountUsdt.toString(), USDT_DECIMALS);

  console.log('[WITHDRAW] sending', amountUsdt, 'USDT ->', to);

  const tx = await usdt.transfer(to, amountWei);
  console.log('[WITHDRAW] broadcasted', tx.hash);

  const receipt = await tx.wait(WITHDRAW_CONFS);
  console.log('[WITHDRAW] confirmed', {
    hash: tx.hash,
    blockNumber: receipt.blockNumber,
    status: receipt.status ?? 'unknown',
  });

  return { txHash: tx.hash, blockNumber: receipt.blockNumber };
}

/* ───────────────────────── Deposit sweep helpers ───────────────────────── */

function getSweepToAddress() {
  if (DEPOSIT_SWEEP_TO_ADDRESS) return DEPOSIT_SWEEP_TO_ADDRESS;
  return getHotWallet().address;
}

function deriveEvmWallet(index) {
  const m = process.env.HD_MNEMONIC;
  if (!m) throw new Error('HD_MNEMONIC missing');

  const acct = Number(process.env.HD_ACCOUNT || 0);
  const path = `m/44'/60'/${acct}'/0/${index}`;
  const w = HDNodeWallet.fromPhrase(m, undefined, path);
  return w.connect(bscProvider);
}

function _bnbToWei(bnb) {
  return BigInt(Math.floor(Number(bnb) * 1e18));
}

async function ensureDepositHasGas({ depositSigner }) {
  let gasPriceWei;
  try {
    const feeData = await bscProvider.getFeeData();
    gasPriceWei =
      feeData.gasPrice ??
      feeData.maxFeePerGas ??
      BigInt(3_000_000_000);
  } catch {
    gasPriceWei = BigInt(3_000_000_000);
  }

  const gasLimit = BigInt(80_000);

  const bufferBps = BigInt(Math.max(10000, Math.round(DEPOSIT_SWEEP_GAS_BUFFER_PCT * 10000)));
  const neededWei = (gasPriceWei * gasLimit * bufferBps) / BigInt(10000);

  const bnbBalWei = await bscProvider.getBalance(depositSigner.address);
  if (bnbBalWei >= neededWei) return { toppedUp: false, neededWei, bnbBalWei };

  const diffWei = neededWei - bnbBalWei;

  const maxTopupWei = _bnbToWei(DEPOSIT_SWEEP_MAX_TOPUP_BNB);
  if (diffWei > maxTopupWei) {
    throw new Error(`NEEDS_MANUAL_GAS_TOPUP (required>${DEPOSIT_SWEEP_MAX_TOPUP_BNB} BNB cap)`);
  }

  const hot = getHotWallet();
  const tx = await hot.sendTransaction({ to: depositSigner.address, value: diffWei });
  await tx.wait(1);

  return { toppedUp: true, neededWei, bnbBalWei, topupTxHash: tx.hash };
}

async function sweepDepositToHotWallet(depositId) {
  const [rows] = await db.query(
    `SELECT id, chain, asset, address, address_index, amount_received, status,
            sweep_status, sweep_tx_hash
       FROM crypto_deposits
      WHERE id=? LIMIT 1`,
    [depositId]
  );
  const d = rows[0];
  if (!d) throw new Error('deposit_not_found');
  if (d.status !== 'credited') return { skipped: true, reason: 'not_credited' };

  const chain = String(d.chain || '').toUpperCase();
  const asset = String(d.asset || '').toUpperCase();
  if (chain !== 'BSC' || asset !== 'USDT') return { skipped: true, reason: 'unsupported_chain_or_asset' };

  if (d.sweep_status === 'swept' && d.sweep_tx_hash) {
    return { skipped: true, reason: 'already_swept', sweep_tx_hash: d.sweep_tx_hash };
  }

  await db.query(
    `UPDATE crypto_deposits
        SET sweep_status='queued', sweep_error=NULL
      WHERE id=? AND (sweep_status IS NULL OR sweep_status IN ('failed','queued'))`,
    [depositId]
  );

  const to = getSweepToAddress();
  const depositSigner = deriveEvmWallet(Number(d.address_index || 0));

  if (String(d.address || '').toLowerCase() !== depositSigner.address.toLowerCase()) {
    throw new Error(`DERIVED_ADDRESS_MISMATCH db=${d.address} derived=${depositSigner.address}`);
  }

  const usdtRead = getUsdtContract(bscProvider);
  const balWei = await usdtRead.balanceOf(depositSigner.address);

  if (balWei <= 0n) throw new Error('NO_USDT_ONCHAIN');

  const minWei = (DEPOSIT_SWEEP_MIN_USDT > 0)
    ? parseUnits(String(DEPOSIT_SWEEP_MIN_USDT), USDT_DECIMALS)
    : 0n;

  if (balWei < minWei) {
    return { skipped: true, reason: 'below_min_onchain', balance_usdt: formatUnits(balWei, USDT_DECIMALS) };
  }

  await db.query(`UPDATE crypto_deposits SET sweep_status='topping_up' WHERE id=?`, [depositId]);
  const gasInfo = await ensureDepositHasGas({ depositSigner });

  await db.query(`UPDATE crypto_deposits SET sweep_status='sweeping' WHERE id=?`, [depositId]);

  const usdtWrite = getUsdtContract(depositSigner);
  const tx = await usdtWrite.transfer(to, balWei);
  const receipt = await tx.wait(DEPOSIT_SWEEP_CONFS);

  await db.query(
    `UPDATE crypto_deposits
        SET sweep_status='swept',
            sweep_tx_hash=?,
            swept_at=NOW(),
            sweep_error=NULL
      WHERE id=?`,
    [tx.hash, depositId]
  );

  return {
    ok: true,
    depositId,
    from: depositSigner.address,
    to,
    swept_usdt: formatUnits(balWei, USDT_DECIMALS),
    sweep_tx_hash: tx.hash,
    blockNumber: receipt.blockNumber,
    gas_topup: gasInfo,
  };
}

async function triggerDepositSweep(depositId) {
  if (!DEPOSIT_SWEEP_ENABLED) return;
  try {
    const out = await sweepDepositToHotWallet(depositId);
    console.log('[SWEEP] done', out);
  } catch (err) {
    console.error('[SWEEP] failed', depositId, err?.message || err);
    try {
      await db.query(
        `UPDATE crypto_deposits
            SET sweep_status='failed', sweep_error=LEFT(?,255)
          WHERE id=?`,
        [String(err?.message || err), depositId]
      );
    } catch (_) {}
  }
}

/* ───────────────────────── User helpers ───────────────────────── */

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
  const [rows] = await db.query('SELECT * FROM users WHERE id=?', [res.insertId]);
  return rows[0];
}

/* ───────────────────────── PUBLIC email OTP router (no auth) ───────────────────────── */
app.use('/auth', makeAuthEmailRouter(db));

/* ───────────────────────── Phone OTP (legacy) ───────────────────────── */
app.post('/otp/send', async (req, res) => {
  try {
    const phone = canonicalizePH(req.body?.phone);
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = nowPlusMinutes(5);
    await db.query(
      `INSERT INTO otp_codes (phone, code, expires_at, attempts)
       VALUES (?,?,?,0)
       ON DUPLICATE KEY UPDATE code=VALUES(code), expires_at=VALUES(expires_at), attempts=0`,
      [phone, code, expiresAt]
    );
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

    let fbUser;
    try {
      fbUser = await admin.auth().getUserByPhoneNumber(phone);
    } catch {
      fbUser = await admin.auth().createUser({ uid: `ph_${phone}`, phoneNumber: phone });
    }

    const customToken = await admin.auth().createCustomToken(fbUser.uid, {});
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

/* ───────────────────────── PIN login (email OR phone) ───────────────────────── */
app.post('/auth/pin-login', async (req, res) => {
  try {
    const body = req.body || {};
    const pin = String(body.pin || '');
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'BAD_PIN_FORMAT' });

    const rawEmail = (body.email || '').toString().trim();
    const rawPhone = (body.phone || '').toString().trim();
    if (!rawEmail && !rawPhone) return res.status(400).json({ error: 'MISSING_IDENTITY' });

    let phone = null;
    if (rawPhone) {
      try { phone = canonicalizePH(rawPhone); } catch { return res.status(400).json({ error: 'BAD_PHONE' }); }
    }

    const isEmail = !!rawEmail;
    const idField = isEmail ? 'email' : 'phone';
    const idValue = isEmail ? rawEmail.toLowerCase() : phone;

    const [rows] = await db.query(
      `SELECT id, email, phone, full_name, pin_hash FROM users WHERE ${idField}=? LIMIT 1`,
      [idValue]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'NO_USER' });
    if (!user.pin_hash) return res.status(400).json({ error: 'NO_PIN' });

    const ok = await bcrypt.compare(pin, user.pin_hash);
    if (!ok) return res.status(401).json({ error: 'BAD_PIN' });

    const token = issueJwt(user);
    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
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

/* ───────────────────────── Firebase login (issues app JWT) ───────────────────────── */
app.post('/auth/firebase-login', async (req, res) => {
  const parse = z.object({ idToken: z.string().min(10) }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'BAD_BODY' });
  try {
    const decoded = await admin.auth().verifyIdToken(parse.data.idToken);
    let firebaseUid = decoded.uid;
    let phone = decoded.phone_number || null;

    if (!phone) {
      try { const ur = await admin.auth().getUser(firebaseUid); phone = ur.phoneNumber || phone; } catch {}
      if (!phone && firebaseUid.startsWith('ph_')) phone = firebaseUid.slice(3);
    }

    if (!phone) return res.status(400).json({ error: 'PHONE_REQUIRED' });
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

/* ───────────────────────── Profile & Me ───────────────────────── */
app.patch('/me/setup', requireAuth, async (req, res) => {
  const parse = z.object({
    full_name: z.string().min(1).max(100),
    pin: z.string().regex(/^\d{4}$/),
  }).safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'BAD_BODY' });

  const hash = await bcrypt.hash(parse.data.pin, 10);
  await db.query('UPDATE users SET full_name=?, pin_hash=? WHERE id=?', [
    parse.data.full_name, hash, req.userId,
  ]);
  const [rows] = await db.query('SELECT id, phone, full_name FROM users WHERE id=?', [req.userId]);
  res.json({ ok: true, user: rows[0] });
});

app.get('/me', requireAuth, async (req, res) => {
  const [rows] = await db.query(
    'SELECT id, phone, full_name, pin_hash IS NOT NULL AS pin_set FROM users WHERE id=?',
    [req.userId]
  );
  res.json(rows[0]);
});

/* ───────────────────────── Feature routers (AUTH) ───────────────────────── */

// 1) Referrals (optional, but if present we expose its award helper)
let referralsRouter = null;
let awardReferral = null;

if (makeReferralRoutes) {
  referralsRouter = makeReferralRoutes({ db, requireAuth, USDT_PHP_RATE });
  awardReferral = referralsRouter._award;
  app.use('/v1/referrals', referralsRouter);
  console.log('[ROUTE] /v1/referrals enabled');
} else {
  console.warn('[ROUTE] /v1/referrals NOT enabled (require failed)');
}

// 2) Staking + KYC
app.use('/v1/staking', makeStakingRoutes({ db, requireAuth, awardReferral, distributeStakeSplits }));
app.use(makeKycRoutes(db, requireAuth));

setInterval(async () => {
  try {
    const [rows] = await db.query(`
      SELECT DISTINCT position_id
      FROM stake_split_transfers
      WHERE status IN ('failed','pending')
        AND created_at < (NOW() - INTERVAL 30 SECOND)
      ORDER BY position_id ASC
      LIMIT 50
    `);

    for (const r of rows) {
      const [[pos]] = await db.query(
        `SELECT id, user_id, units FROM staking_positions WHERE id=?`,
        [r.position_id]
      );
      if (!pos) continue;

      await distributeStakeSplits({
        positionId: pos.id,
        userId: pos.user_id,
        units: Number(pos.units || 0),
      });
    }
  } catch (e) {
    console.error('[split-retry] error', e);
  }
}, 60_000);

/* ───────────────────────── Deposits ───────────────────────── */
if (process.env.MOCK_DEPOSITS === '1') {
  app.use(makeDepositsMock(requireAuth, db));
  console.log('[DEV] MOCK_DEPOSITS enabled');
} else {
  app.post('/v1/deposits/crypto', requireAuth, async (req, res) => {
    try {
      if (!process.env.HD_MNEMONIC) {
        return res.status(500).json({ error: 'HD_MNEMONIC missing on server' });
      }
      const asset = (req.body?.asset || 'USDT').toUpperCase();
      const chain = (req.body?.chain || 'BSC').toUpperCase();
      const safeSource = normSource(req.body?.source);

      const requiredConfs = chain === 'POLY' ? 64 : 12;

      const [[row]] = await db.query(
        'SELECT IFNULL(MAX(address_index), -1) + 1 AS nextIdx FROM crypto_deposits WHERE chain=?',
        [chain]
      );
      const idx = Number(row.nextIdx || 0);

      const address = deriveEvmAddress(idx);

      const [ins] = await db.query(
        `INSERT INTO crypto_deposits
         (user_id, chain, asset, source, network_symbol, address, address_index,
          amount_expected, required_confirmations, status)
         VALUES (?,?,?,?,?,?,?,?,?, 'pending')`,
        [req.userId, chain, asset, safeSource, chain, address, idx, null, requiredConfs]
      );

      res.json({
        id: ins.insertId,
        chain,
        asset,
        address,
        address_index: idx,
        qr: `ethereum:${address}`,
        note: `Send only ${asset} on ${chain}. Wrong network = lost funds.`,
      });
    } catch (e) {
      console.error('create deposit', e);
      res.status(500).json({ error: 'SERVER_ERR' });
    }
  });

  app.get('/v1/deposits/status/:id', requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [rows] = await db.query(
        `SELECT id, user_id, chain, asset, address, tx_hash, amount_received,
                confirmations, required_confirmations, status
           FROM crypto_deposits
          WHERE id=? LIMIT 1`,
        [id]
      );
      const d = rows[0];
      if (!d) return res.status(404).json({ error: 'NOT_FOUND' });
      if (d.user_id !== req.userId) return res.status(403).json({ error: 'FORBIDDEN' });
      res.json(d);
    } catch (e) {
      console.error('status', e);
      res.status(500).json({ error: 'SERVER_ERR' });
    }
  });

  app.post('/dev/deposits/:id/credit', requireAuth, async (req, res) => {
    try {
      const depositId = Number(req.params.id);
      const body = req.body || {};
      const amount = body.amount;
      const txHash = body.tx_hash;

      await creditDepositAndWebhook({
        depositId,
        amount,
        txHash,
        meta: { source: 'manual' },
      });

      res.json({ ok: true, depositId });
    } catch (e) {
      console.error('dev credit deposit', e);
      res.status(500).json({
        error: 'CREDIT_FAILED',
        detail: String(e.message || e),
      });
    }
  });
}

/* ───────────────────────── Wallet ───────────────────────── */

app.get('/v1/wallet/balances', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT asset, COALESCE(SUM(balance),0) AS balance
         FROM wallet_balances
        WHERE user_id = ?
        GROUP BY asset`,
      [req.userId]
    );

    const balances = rows.map((r) => ({
      asset: r.asset,
      balance: (r.balance ?? 0).toString(),
    }));

    const usdt = Number(rows.find((r) => normAsset(r.asset) === 'USDT')?.balance || 0);
    const vpk = Number(rows.find((r) => normAsset(r.asset) === 'VPK')?.balance || 0);

    const vpkAsUsdt = vpk * 0.01;
    const totalUsdt = usdt + vpkAsUsdt;

    const usdtPhp = await getUsdtPhpRate();

    res.json({
      balances,
      totals: {
        USDT: totalUsdt,
        PHP: totalUsdt * usdtPhp,
        breakdown: {
          USDT: usdt,
          VPK: vpk,
          MHV: vpk,
        },
      },
      rates: { USDT_PHP: usdtPhp },
    });
  } catch (e) {
    console.error('balances', e);
    res.status(500).json({ error: 'SERVER_ERR' });
  }
});

app.get('/v1/wallet/ledger', requireAuth, async (req, res) => {
  try {
    const pageSize = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const beforeId = Number(req.query.before || 0);

    let sql = `SELECT id, ts, asset, chain, type, amount, ref_id, meta
                 FROM wallet_ledger
                WHERE user_id = ?`;
    const args = [req.userId];

    if (beforeId > 0) { sql += ' AND id < ?'; args.push(beforeId); }

    sql += ' ORDER BY id DESC LIMIT ?';
    args.push(pageSize + 1);

    const [rows] = await db.query(sql, args);
    const hasMore = rows.length > pageSize;
    const data = rows.slice(0, pageSize);

    res.json({
      items: data.map(r => ({
        id: r.id,
        ts: r.ts,
        asset: r.asset,
        chain: r.chain,
        type: r.type,
        amount: (r.amount ?? 0).toString(),
        ref_id: r.ref_id,
        meta: r.meta ? (typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta) : null,
      })),
      next_before: hasMore ? data[data.length - 1].id : null,
    });
  } catch (e) {
    console.error('ledger', e);
    res.status(500).json({ error: 'SERVER_ERR' });
  }
});

/* ───────────────────────── Wallet swap (USDT ⇄ VPK) ───────────────────────── */
app.post('/v1/wallet/swap', requireAuth, async (req, res) => {
  const userId = req.userId;
  const body = req.body || {};

  const fromAsset = normAsset(body.from_asset);
  const toAsset = normAsset(body.to_asset);
  const fromAmount = Number(body.amount);

  if (!Number.isFinite(fromAmount) || fromAmount <= 0) {
    return res.status(400).json({ error: 'BAD_AMOUNT' });
  }

  const RATE_USDT_TO_VPK = 100;
  const RATE_VPK_TO_USDT = 1 / RATE_USDT_TO_VPK;

  let creditAmount;
  let amountUsdt = 0;
  let amountVpk = 0;

  if (fromAsset === 'USDT' && toAsset === 'VPK') {
    const vpkOut = fromAmount * RATE_USDT_TO_VPK;
    creditAmount = vpkOut;
    amountUsdt = fromAmount;
    amountVpk = vpkOut;
  } else if (fromAsset === 'VPK' && toAsset === 'USDT') {
    const usdtOut = fromAmount * RATE_VPK_TO_USDT;
    creditAmount = usdtOut;
    amountUsdt = usdtOut;
    amountVpk = fromAmount;
  } else {
    return res.status(400).json({ error: 'PAIR_NOT_SUPPORTED' });
  }

  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    const [rows] = await conn.query(
      'SELECT balance FROM wallet_balances WHERE user_id=? AND asset=? FOR UPDATE',
      [userId, fromAsset]
    );
    const currentBal = Number(rows[0]?.balance || 0);

    if (currentBal + 1e-9 < fromAmount) {
      await conn.rollback();
      conn.release();
      return res.status(400).json({ error: 'INSUFFICIENT_FUNDS', balance: currentBal });
    }

    await conn.query(
      `INSERT INTO wallet_balances (user_id, asset, balance)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
      [userId, fromAsset, -fromAmount]
    );

    await conn.query(
      `INSERT INTO wallet_balances (user_id, asset, balance)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
      [userId, toAsset, creditAmount]
    );

    const meta = {
      pair: `${fromAsset}->${toAsset}`,
      rate_usdt_to_vpk: RATE_USDT_TO_VPK,
      rate_vpk_to_usdt: RATE_VPK_TO_USDT,
      amount_usdt: amountUsdt,
      amount_vpk: amountVpk,
      rate_usdt_to_mhv: RATE_USDT_TO_VPK,
      rate_mhv_to_usdt: RATE_VPK_TO_USDT,
      amount_mhv: amountVpk,
    };
    const metaJson = JSON.stringify(meta);

    await conn.query(
      `INSERT INTO wallet_ledger
         (user_id, ts, asset, chain, type, amount, ref_id, meta)
       VALUES (?, NOW(), ?, ?, 'swap_out', ?, NULL, ?)`,
      [userId, fromAsset, 'BSC', fromAmount, metaJson]
    );

    await conn.query(
      `INSERT INTO wallet_ledger
         (user_id, ts, asset, chain, type, amount, ref_id, meta)
       VALUES (?, NOW(), ?, ?, 'swap_in', ?, NULL, ?)`,
      [userId, toAsset, 'BSC', creditAmount, metaJson]
    );

    await conn.commit();
    conn.release();

    return res.json({
      ok: true,
      from_asset: fromAsset,
      to_asset: toAsset,
      from_amount: fromAmount,
      to_amount: creditAmount,
      rate_usdt_to_vpk: RATE_USDT_TO_VPK,
      rate_vpk_to_usdt: RATE_VPK_TO_USDT,
    });
  } catch (e) {
    try { await conn.rollback(); conn.release(); } catch (_) {}
    console.error('wallet/swap', e);
    return res.status(500).json({ error: 'SWAP_FAILED' });
  }
});

/* ───────────────────────── Wallet transfer quote ───────────────────────── */
app.post('/v1/wallet/transfer/quote', requireAuth, async (req, res) => {
  try {
    const parsed = z.object({
      kind: z.enum(['crypto', 'bank']),
      asset: z.string().default('USDT'),
      chain: z.string().optional(),
      amount: z.number().positive(),
      to_address: z.string().optional(),
    }).safeParse(req.body);

    if (!parsed.success) return res.status(400).json({ error: 'BAD_BODY' });

    const { kind, asset, chain, amount } = parsed.data;
    const assetNorm = normAsset(asset);
    if (assetNorm !== 'USDT') return res.status(400).json({ error: 'ONLY_USDT_SUPPORTED' });

    let quote;
    if (kind === 'crypto') quote = await quoteCryptoTransfer({ chain, amountUsdt: amount });
    else quote = await quoteBankTransfer({ amountUsdt: amount });

    return res.json(quote);
  } catch (e) {
    console.error('transfer/quote', e);
    res.status(500).json({ error: 'SERVER_ERR' });
  }
});

/* ───────────────────────── Wallet transfer submit ───────────────────────── */
app.post('/v1/wallet/transfer', requireAuth, async (req, res) => {
  const schema = z.object({
    kind: z.enum(['crypto', 'bank']),
    asset: z.string().default('USDT'),
    chain: z.string().optional(),
    amount: z.number().positive(),
    quote: z.object({
      network_fee_usdt: z.number().nullable().optional(),
      conversion_fee_usdt: z.number().nullable().optional(),
      send_fee_usdt: z.number().nullable().optional(),
      total_debit_usdt: z.number().nullable().optional(),
      recv_amount_usdt: z.number().nullable().optional(),
      recv_amount_php: z.number().nullable().optional(),
    }).optional(),
    to_address: z.string().optional(),
    bank_name: z.string().optional(),
    account_name: z.string().optional(),
    account_number: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'BAD_BODY' });

  const body = parsed.data;
  const userId = req.userId;
  const assetNorm = normAsset(body.asset);
  const chainNorm = (body.chain || 'BSC').toUpperCase();

  if (assetNorm !== 'USDT') return res.status(400).json({ error: 'ONLY_USDT_SUPPORTED' });

  try {
    let quote;
    if (body.kind === 'crypto') {
      if (!body.to_address || body.to_address.length < 25) {
        return res.status(400).json({ error: 'BAD_ADDRESS' });
      }
      quote = await quoteCryptoTransfer({ chain: chainNorm, amountUsdt: body.amount });
    } else {
      if (!body.bank_name || !body.account_name || !body.account_number) {
        return res.status(400).json({ error: 'BANK_DETAILS_INCOMPLETE' });
      }
      quote = await quoteBankTransfer({ amountUsdt: body.amount });
    }

    const totalDebit = quote.total_debit_usdt;
    if (!Number.isFinite(totalDebit) || totalDebit <= 0) {
      return res.status(400).json({ error: 'BAD_QUOTE' });
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const [rows] = await conn.query(
        'SELECT balance FROM wallet_balances WHERE user_id=? AND asset=? FOR UPDATE',
        [userId, assetNorm]
      );
      const currentBal = Number(rows[0]?.balance || 0);

      if (currentBal < totalDebit) {
        await conn.rollback();
        conn.release();
        return res.status(400).json({
          error: 'INSUFFICIENT_FUNDS',
          needed: totalDebit,
          balance: currentBal,
        });
      }

      await conn.query(
        `INSERT INTO wallet_balances (user_id, asset, balance)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
        [userId, assetNorm, -totalDebit]
      );

      const meta = {
        kind: body.kind,
        chain: chainNorm,
        amount_usdt: body.amount,
        network_fee_usdt: quote.network_fee_usdt,
        conversion_fee_usdt: quote.conversion_fee_usdt,
        send_fee_usdt: quote.send_fee_usdt,
        recv_amount_usdt: quote.recv_amount_usdt,
        recv_amount_php: quote.recv_amount_php,
        to_address: body.to_address || null,
        bank_name: body.bank_name || null,
        account_name: body.account_name || null,
        account_number: body.account_number || null,
      };

      const ledgerType = body.kind === 'crypto' ? 'transfer_out' : 'withdraw';

      const [ledgerRes] = await conn.query(
        `INSERT INTO wallet_ledger
           (user_id, ts, asset, chain, type, amount, ref_id, meta)
         VALUES (?, NOW(), ?, ?, ?, ?, NULL, ?)`,
        [
          userId,
          assetNorm,
          chainNorm,
          ledgerType,
          -totalDebit,
          JSON.stringify(meta),
        ]
      );
      const ledgerId = ledgerRes.insertId;

      await evaluateRewardCreditsForUser(conn, userId);

      await conn.commit();
      conn.release();

      let txInfo = null;
      if (body.kind === 'crypto') {
        try {
          txInfo = await sendUsdtFromHotWallet({ to: body.to_address, amountUsdt: body.amount });
          meta.tx_hash = txInfo.txHash;

          await db.query('UPDATE wallet_ledger SET meta=? WHERE id=?', [
            JSON.stringify(meta),
            ledgerId,
          ]);
        } catch (err) {
          console.error('[WITHDRAW] on-chain transfer failed', err);
        }
      }

      return res.json({
        ok: true,
        message: body.kind === 'crypto' ? 'Crypto transfer created' : 'Bank transfer created',
        quote,
        tx_hash: txInfo?.txHash || null,
      });
    } catch (err) {
      try { await conn.rollback(); conn.release(); } catch {}
      console.error('wallet/transfer', err);
      return res.status(500).json({ error: 'TRANSFER_FAILED' });
    }
  } catch (err) {
    console.error('wallet/transfer (outer)', err);
    return res.status(500).json({ error: 'SERVER_ERR' });
  }
});

/* ───────────────────────── Sweep loop ───────────────────────── */
if (DEPOSIT_SWEEP_ENABLED) {
  console.log('[SWEEP] enabled -> to', getSweepToAddress());

  setInterval(async () => {
    try {
      const [rows] = await db.query(
        `SELECT id
           FROM crypto_deposits
          WHERE status='credited'
            AND (sweep_status IS NULL OR sweep_status IN ('failed'))
          ORDER BY id ASC
          LIMIT 20`
      );

      for (const r of rows) {
        try {
          const out = await sweepDepositToHotWallet(Number(r.id));
          if (!out?.skipped) console.log('[SWEEP] loop swept', out);
        } catch (e) {
          console.error('[SWEEP] loop item failed', r.id, e?.message || e);
        }
      }
    } catch (e) {
      console.error('[SWEEP] loop error', e?.message || e);
    }
  }, 15_000);
}

/* ───────────────────────── Global error handler ─────────────────────────
   ✅ So Flutter always gets JSON back instead of “Failed to submit”
*/
app.use((err, req, res, next) => {
  console.error('[UNHANDLED_ERROR]', err);
  const debug = process.env.DEBUG_ERRORS === '1';
  return res.status(500).json({
    error: 'SERVER_ERR',
    message: debug ? (err?.message || String(err)) : undefined,
  });
});

/* ───────────────────────── Start ───────────────────────── */
app.listen(PORT, "0.0.0.0", () => console.log(`Vegapunk server listening on :${PORT}`));
