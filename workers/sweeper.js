// sweeper.js (CommonJS) — credit + sweep USDT (BEP-20) on BSC
require('dotenv').config();

const { HDNodeWallet, JsonRpcProvider, Contract, parseUnits } = require('ethers');
const mysql = require('mysql2/promise');

// ───────────────── config ─────────────────
const RPC = process.env.BSC_RPC;                         // https://bsc-dataseed.binance.org
const USDT = process.env.USDT_BSC;                       // BEP-20 USDT contract
const TREASURY = process.env.TREASURY_BSC;               // your treasury/safe address
const GAS_PK = process.env.GAS_PK || null;               // hot key to top up BNB (optional)
const GAS_TOPUP = process.env.GAS_TOPUP || '0.0003';     // max top-up per address
const MIN_DEPOSIT = process.env.MIN_DEPOSIT || '0';      // optional: ignore dust (USDT)

if (!RPC || !USDT || !TREASURY || !process.env.HD_MNEMONIC) {
  console.error('[FATAL] Missing one of: BSC_RPC, USDT_BSC, TREASURY_BSC, HD_MNEMONIC');
  process.exit(1);
}

// ───────────────── chain setup ─────────────────
const provider = new JsonRpcProvider(RPC);

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function estimateGas()' // placeholder; we use contract.estimateGas.transfer(...)
];

function walletForIndex(index) {
  const acct = Number(process.env.HD_ACCOUNT || 0);
  const path = `m/44'/60'/${acct}'/0/${index}`; // BIP44 EVM
  return HDNodeWallet.fromPhrase(process.env.HD_MNEMONIC, undefined, path).connect(provider);
}

function gasSender() {
  if (!GAS_PK) return null;
  return (new HDNodeWallet(GAS_PK)).connect(provider);
}

// ───────────────── helpers ─────────────────
async function ensureGasForTransfer(depositAddr, tokenContract, fromSigner, tokenAmount) {
  // estimate ERC-20 transfer gas
  const gasLimit = await tokenContract.connect(fromSigner).estimateGas.transfer(TREASURY, tokenAmount);
  const feeData = await provider.getFeeData(); // v6 returns BigInt gasPrice
  const gasPrice = feeData.gasPrice ?? (await provider.getGasPrice()); // fallback for some RPCs
  const neededWei = gasLimit * gasPrice;

  const bnbBal = await provider.getBalance(depositAddr);

  // buffer 20%
  const neededWithBuffer = neededWei + (neededWei / 5n);

  if (bnbBal >= neededWithBuffer) return true;

  // top-up if we have a gas hot wallet
  const topupper = gasSender();
  if (!topupper) {
    console.log(`  - gas insufficient for ${depositAddr}; no GAS_PK set. Will retry next run.`);
    return false;
  }

  // send the lesser of (missing amount) vs (GAS_TOPUP)
  const missing = neededWithBuffer - bnbBal;
  const maxTop = parseUnits(GAS_TOPUP, 18); // BNB is 18 decimals
  const toSend = missing > maxTop ? maxTop : missing;

  if (toSend <= 0n) return true;

  console.log(`  - topping up gas ${depositAddr} by ${toSend.toString()} wei`);
  const tx = await topupper.sendTransaction({ to: depositAddr, value: toSend });
  await tx.wait();
  return true;
}

// ───────────────── main ─────────────────
(async () => {
  const db = await mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'ph1taka',
    connectionLimit: 5,
  });

  const usdt = new Contract(USDT, ERC20_ABI, provider);
  const dec = await usdt.decimals();

  // 1) Pick deposits ready to credit/sweep
  //    - If not credited yet but already has enough confirmations, we will credit now (idempotent).
  //    - Then sweep if there is token balance.
  const [rows] = await db.query(
    `SELECT id, user_id, chain, asset, address, address_index,
            amount_received, confirmations, required_confirmations,
            status, tx_hash, COALESCE(swept,0) AS swept
       FROM crypto_deposits
      WHERE chain='BSC' AND asset='USDT'
        AND (status IN ('confirming','confirmed','credited') OR confirmations >= required_confirmations)
        AND COALESCE(swept,0) = 0
      ORDER BY id ASC
      LIMIT 20`
  );

  if (rows.length === 0) {
    console.log('nothing to process');
    process.exit(0);
  }

  for (const d of rows) {
    try {
      console.log(`#${d.id} addr_index=${d.address_index} status=${d.status} conf=${d.confirmations}/${d.required_confirmations}`);

      // 2) CREDIT (idempotent): if enough confs and not yet credited, credit wallet + ledger
      const enoughConfs = Number(d.confirmations) >= Number(d.required_confirmations);
      const amtNum = Number(d.amount_received || 0);
      const minOk = Number(MIN_DEPOSIT) <= 0 ? true : amtNum >= Number(MIN_DEPOSIT);

      if (enoughConfs && d.status !== 'credited' && minOk) {
        const [res] = await db.query(
          `UPDATE crypto_deposits
              SET status='credited'
            WHERE id=? AND status<>'credited'`,
          [d.id]
        );
        const changed = res.affectedRows > 0;

        if (changed) {
          // balance upsert
          await db.query(
            `INSERT INTO wallet_balances (user_id, asset, balance)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
            [d.user_id, d.asset, d.amount_received]
          );

          // ledger row
          await db.query(
            `INSERT INTO wallet_ledger (user_id, asset, chain, type, amount, ref_id, meta)
             VALUES (?, ?, ?, 'deposit', ?, ?, JSON_OBJECT('address', ?, 'credited', TRUE))`,
            [d.user_id, d.asset, d.chain, d.amount_received, d.id, d.address]
          );

          console.log(`  - credited user_id=${d.user_id} +${d.amount_received} ${d.asset}`);
          d.status = 'credited';
        }
      } else if (!enoughConfs) {
        console.log('  - not enough confirmations yet; skipping for now');
        continue; // don’t try to sweep until credited/confirmed
      } else if (!minOk) {
        console.log(`  - below MIN_DEPOSIT (${MIN_DEPOSIT}); skipping credit & sweep`);
        continue;
      }

      // 3) SWEEP (after credit). Derive signer for the deposit address.
      const signer = walletForIndex(d.address_index);
      const addr = await signer.getAddress();

      // sanity: derived addr should match stored address
      if (addr.toLowerCase() !== String(d.address).toLowerCase()) {
        console.warn(`  ! derived address mismatch. expected ${d.address}, got ${addr}. Skipping.`);
        continue;
      }

      // token balance
      const bal = await usdt.balanceOf(addr);
      if (bal === 0n) {
        console.log('  - 0 USDT on address; mark swept to avoid reprocessing');
        await db.query(`UPDATE crypto_deposits SET swept=1, status='swept' WHERE id=?`, [d.id]);
        continue;
      }

      // ensure gas
      const okGas = await ensureGasForTransfer(addr, usdt, signer, bal);
      if (!okGas) {
        console.log('  - gas not ready; will retry next run');
        continue;
      }

      // sweep all to treasury
      const usdtWithSigner = usdt.connect(signer);
      const tx = await usdtWithSigner.transfer(TREASURY, bal);
      console.log(`  - sweeping ${bal.toString()} raw units (dec=${dec}) → ${TREASURY}, tx=${tx.hash}`);

      await db.query(`UPDATE crypto_deposits SET status='sweeping', tx_hash=? WHERE id=?`, [tx.hash, d.id]);

      const rcpt = await tx.wait();
      if (rcpt.status !== 1) throw new Error('transfer reverted');

      await db.query(`UPDATE crypto_deposits SET status='swept', swept=1 WHERE id=?`, [d.id]);

      // optional: ledger entry for sweep (internal ops)
      // await db.query(
      //   `INSERT INTO ops_ledger (deposit_id, tx_hash, action) VALUES (?, ?, 'sweep')`,
      //   [d.id, tx.hash]
      // );

      console.log('  - swept ✔');

    } catch (e) {
      console.error(`sweep/credit failed for deposit ${d.id}`, e);
      // keep for retry; you could also set an error column with last_error
      // await db.query(`UPDATE crypto_deposits SET last_error=? WHERE id=?`, [String(e.message||e), d.id]);
    }
  }

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
