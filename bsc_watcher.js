// bsc_watcher.js — watches BSC USDT deposits via RPC logs (no BscScan)
require('dotenv').config();
require('dns').setDefaultResultOrder('ipv4first');

const mysql = require('mysql2/promise');
const crypto = require('crypto');
const { JsonRpcProvider, formatUnits } = require('ethers');

// ───────────────────── Config ─────────────────────
const BSC_RPC = process.env.BSC_RPC || 'https://bsc-dataseed.binance.org/';
const USDT_CONTRACT = (process.env.USDT_CONTRACT || '').toLowerCase();
const USDT_DECIMALS = Number(process.env.USDT_DECIMALS || 18);
const CONFIRMATIONS_REQUIRED = Number(process.env.CONFIRMATIONS_REQUIRED || 12);
const LOG_LOOKBACK_BLOCKS = Number(process.env.LOG_LOOKBACK_BLOCKS || 200); // <- smaller window
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 30000);      // 30s between scans
const SCAN_BATCH_SIZE = Number(process.env.SCAN_BATCH_SIZE || 32);          // max addrs per RPC call
const { evaluateRewardCreditsForUser } = require('./lib/reward_credits');

// ERC-20 Transfer topic
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

if (!USDT_CONTRACT) {
  console.error('[WATCHER] Missing USDT_CONTRACT in .env');
  process.exit(1);
}

// ───────────────────── DB pool ─────────────────────
const db = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'ph1taka',
  connectionLimit: 10,
});

// ───────────────────── Provider ─────────────────────
const provider = new JsonRpcProvider(BSC_RPC, undefined, {
  batchMaxCount: 1,   // avoid JSON-RPC batching (helps with some providers)
});

// ───────────────────── Webhook helper ─────────────────────
const DEPOSIT_WEBHOOK_URL = process.env.DEPOSIT_WEBHOOK_URL || '';
const DEPOSIT_WEBHOOK_SECRET = process.env.DEPOSIT_WEBHOOK_SECRET || '';

async function sendDepositWebhook(payload) {
  if (!DEPOSIT_WEBHOOK_URL) {
    console.log('[WEBHOOK] DEPOSIT_WEBHOOK_URL not set, skipping');
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
    const sig = crypto
      .createHmac('sha256', DEPOSIT_WEBHOOK_SECRET)
      .update(body)
      .digest('hex');
    headers['x-ph1taka-signature'] = sig;
  }

  try {
    await fetch(DEPOSIT_WEBHOOK_URL, {
      method: 'POST',
      headers,
      body,
    });
    console.log('[WEBHOOK] deposit -> sent', payload);
  } catch (err) {
    console.error('[WEBHOOK] deposit -> FAILED', err);
  }
}

// ───────────────────── Credit helper (same logic as server.js) ─────────────────────
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

    // Ledger
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
      [amtNum, txHash || dep.tx_hash || `BSC-${depositId}`, depositId]
    );
    await evaluateRewardCreditsForUser(conn, userId);
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
  } catch (err) {
    await conn.rollback();
    console.error('[DEPOSIT] creditDepositAndWebhook error', err);
    throw err;
  } finally {
    conn.release();
  }

  if (webhookPayload) {
    sendDepositWebhook(webhookPayload).catch((err) => {
      console.error('[WEBHOOK] deposit -> async error', err);
    });
  }
}

// ───────────────────── Batch scan via logs ─────────────────────

// Small helper: pad address to topic[2]
function addrToTopic(addr) {
  const clean = (addr || '').toLowerCase().replace(/^0x/, '');
  return '0x' + clean.padStart(64, '0');
}

let scanCursor = 0; // to rotate through deposits if there are many

async function scanBatch(deps, currentBlock) {
  const addrTopics = [];
  const topicToDep = new Map();

  for (const dep of deps) {
    const addr = (dep.address || '').toLowerCase();
    if (!addr) continue;
    const topic = addrToTopic(addr);
    addrTopics.push(topic);
    topicToDep.set(topic, dep);
  }

  if (!addrTopics.length) return;

  const fromBlock = Math.max(0, currentBlock - LOG_LOOKBACK_BLOCKS);
  const toBlock = currentBlock;

  let logs;
  try {
    logs = await provider.getLogs({
      address: USDT_CONTRACT,
      fromBlock,
      toBlock,
      topics: [TRANSFER_TOPIC, null, addrTopics],
    });
  } catch (err) {
    console.error(
      `[SCAN] batch getLogs error from=${fromBlock} to=${toBlock} addrs=${addrTopics.length}`,
      err
    );
    return;
  }

  if (!logs.length) {
    console.log(
      `[SCAN] no logs for ${addrTopics.length} addresses in [${fromBlock}, ${toBlock}]`
    );
    return;
  }

  console.log(
    `[SCAN] got ${logs.length} logs for ${addrTopics.length} addresses in [${fromBlock}, ${toBlock}]`
  );

  // sort logs oldest → newest
  logs.sort((a, b) => {
    if (a.blockNumber === b.blockNumber) {
      return (a.logIndex || 0) - (b.logIndex || 0);
    }
    return a.blockNumber - b.blockNumber;
  });

  for (const log of logs) {
    const toTopic = (log.topics[2] || '').toLowerCase();
    const dep = topicToDep.get(toTopic);
    if (!dep) continue;

    const depositId = dep.id;
    const requiredConfs =
      dep.required_confirmations || CONFIRMATIONS_REQUIRED;

    const confirmations =
      Number(currentBlock) - Number(log.blockNumber) + 1;

    const humanAmount = Number(formatUnits(log.data, USDT_DECIMALS));
    const txHash = log.transactionHash;

    console.log(
      `[SCAN] dep ${depositId} addr ${(dep.address || '').toLowerCase()} -> tx=${txHash} amount=${humanAmount} conf=${confirmations}/${requiredConfs}`
    );

    if (!Number.isFinite(humanAmount) || humanAmount <= 0) {
      console.log(`[SCAN] dep ${depositId} -> invalid amount from log, skip`);
      continue;
    }

    // Update deposit progress
    await db.query(
      `UPDATE crypto_deposits
          SET tx_hash        = COALESCE(tx_hash, ?),
              confirmations  = ?,
              amount_received= COALESCE(amount_received, ?),
              status         = CASE
                                  WHEN ? >= required_confirmations THEN 'confirming'
                                  ELSE 'confirming'
                               END,
              updated_at     = NOW()
        WHERE id = ?`,
      [txHash, confirmations, humanAmount, confirmations, depositId]
    );

    if (confirmations >= requiredConfs) {
      console.log(
        `[WATCHER] CONFIRMED deposit ${depositId} amount=${humanAmount} tx=${txHash}`
      );
      await creditDepositAndWebhook({
        depositId,
        amount: humanAmount,
        txHash,
        meta: { source: 'bsc_logs' },
      });
    }
  }
}

async function scanOnce() {
  const currentBlock = await provider.getBlockNumber();

  const [deps] = await db.query(
    `SELECT id, address, required_confirmations
       FROM crypto_deposits
      WHERE chain = 'BSC'
        AND asset = 'USDT'
        AND status IN ('pending','seen','confirming')
      ORDER BY id ASC`
  );

  console.log(
    `[WATCHER] scanning ${deps.length} BSC deposit intents via RPC logs (block=${currentBlock})`
  );

  if (!deps.length) return;

  // Rotate through deposits if there are more than SCAN_BATCH_SIZE
  const batch = [];
  const n = Math.min(SCAN_BATCH_SIZE, deps.length);

  for (let i = 0; i < n; i++) {
    const dep = deps[(scanCursor + i) % deps.length];
    batch.push(dep);
  }
  scanCursor = (scanCursor + n) % deps.length;

  await scanBatch(batch, currentBlock);
}

// ───────────────────── Main loop ─────────────────────
async function main() {
  console.log(
    '[WATCHER] Starting BSC USDT watcher (BSC RPC logs-based, batched)...'
  );

  while (true) {
    try {
      await scanOnce();
    } catch (e) {
      console.error('[WATCHER] scanOnce error', e);
    }
    await new Promise((resolve) => setTimeout(resolve, SCAN_INTERVAL_MS));
  }
}

main().catch((e) => {
  console.error('[WATCHER] fatal', e);
  process.exit(1);
});
