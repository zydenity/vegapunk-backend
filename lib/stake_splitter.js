// server/lib/stake_splitter.js (CommonJS, ethers v6)
const { JsonRpcProvider, Wallet, Contract, parseUnits } = require('ethers');

const USDT_ABI = [
  'function transfer(address to, uint256 value) returns (bool)',
];

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

module.exports = function makeStakeSplitter({ db, stakeUnitUsdt = 9 }) {
  const provider = new JsonRpcProvider(mustEnv('BSC_RPC'));
  const hotWallet = new Wallet(mustEnv('HOT_WALLET_PK'), provider);
  const usdt = new Contract(mustEnv('USDT_CONTRACT'), USDT_ABI, hotWallet);

  const DECIMALS = Number(process.env.USDT_DECIMALS || 18);
  const UNIT_WEI = parseUnits(String(stakeUnitUsdt), DECIMALS); // BigInt

  // Your targets:
  // 10%, 10%, 16.66%, 16.66%, 16.66% (≈ 1/6 each), remainder stays in hot wallet
  const SPLITS = [
    { label: 'referral_leadership_com', toEnv: 'SPLIT_REF_LEAD_ADDR', num: 1n, den: 10n }, // 10%
    { label: 'leaders_support',         toEnv: 'SPLIT_LEADER_SUPPORT_ADDR', num: 1n, den: 10n }, // 10%
    { label: 'savings',                 toEnv: 'SPLIT_SAVINGS_ADDR', num: 1n, den: 6n  }, // 16.666..%
    { label: 'reed',                    toEnv: 'SPLIT_REED_ADDR', num: 1n, den: 6n  }, // 16.666..%
    { label: 'nino',                    toEnv: 'SPLIT_NINO_ADDR', num: 1n, den: 6n  }, // 16.666..%
  ].map(s => ({ ...s, to: mustEnv(s.toEnv) }));

  async function distributeStakeSplits({ positionId, userId, units }) {
    const u = BigInt(units);
    if (u <= 0n) return { ok: true, skipped: true };

    // Total USDT to split (in wei) based on stake units * 9 USDT
    const totalWei = u * UNIT_WEI;

    // Lock to prevent nonce collisions (esp. if you run multiple PM2 instances)
    const [[lk]] = await db.query(`SELECT GET_LOCK('hotwallet_usdt_split', 15) AS got`);
    if (!lk?.got) throw new Error('HOTWALLET_SPLIT_LOCK_TIMEOUT');

    try {
      // Pre-create rows (idempotency)
      for (const s of SPLITS) {
        const amtWei = (totalWei * s.num) / s.den; // floor division
        await db.query(
          `INSERT INTO stake_split_transfers
             (position_id, user_id, label, to_address, amount_wei, status)
           VALUES (?, ?, ?, ?, ?, 'pending')
           ON DUPLICATE KEY UPDATE
             to_address = VALUES(to_address),
             amount_wei = VALUES(amount_wei)`,
          [positionId, userId, s.label, s.to, amtWei.toString()]
        );
      }

      // Fetch pending/failed rows and send only those without tx_hash
      const [rows] = await db.query(
        `SELECT id, label, to_address, amount_wei, tx_hash, status
           FROM stake_split_transfers
          WHERE position_id=?
          ORDER BY id ASC`,
        [positionId]
      );

      const sent = [];
      for (const r of rows) {
        const alreadySent = r.tx_hash && r.status === 'sent';
        if (alreadySent) continue;

        const amt = BigInt(r.amount_wei || '0');
        if (amt <= 0n) {
          // mark as sent (nothing to do) so it doesn't keep retrying
          await db.query(
            `UPDATE stake_split_transfers SET status='sent', last_error=NULL WHERE id=?`,
            [r.id]
          );
          continue;
        }

        try {
          const tx = await usdt.transfer(r.to_address, amt); // returns hash immediately
          await db.query(
            `UPDATE stake_split_transfers
                SET tx_hash=?, status='sent', last_error=NULL
              WHERE id=?`,
            [tx.hash, r.id]
          );
          sent.push({ label: r.label, to: r.to_address, amountWei: amt.toString(), txHash: tx.hash });
        } catch (e) {
          await db.query(
            `UPDATE stake_split_transfers
                SET status='failed', last_error=?
              WHERE id=?`,
            [String(e?.message || e), r.id]
          );
          // don’t throw — we want stake to succeed even if split fails
        }
      }

      // Remainder (stays in hot wallet automatically)
      const sumWei = rows.reduce((acc, r) => acc + BigInt(r.amount_wei || '0'), 0n);
      const remainderWei = totalWei - sumWei;

      return { ok: true, totalWei: totalWei.toString(), remainderWei: remainderWei.toString(), sent };
    } finally {
      await db.query(`SELECT RELEASE_LOCK('hotwallet_usdt_split')`);
    }
  }

  return { distributeStakeSplits };
};
