'use strict';
// Safe-to-re-run repair passes for data written before the current rules
// existed. Every pass is idempotent and reports what it changed.
//
//   node src/db/repair.js            → report only, changes nothing
//   node src/db/repair.js --apply    → apply the fixes
const pool = require('./pool');
const { isJunkService } = require('../services/catalog');

// 1) Provider category dividers imported as sellable services.
// e.g. "-----------------------FACEBOOK SERIVCES AREA ---------------------"
// The importer rejects these now, but rows imported before that still sell.
async function junkServices(apply) {
  const [rows] = await pool.query(
    'SELECT id, name, rate_usd FROM services WHERE deleted = 0 AND enabled = 1');
  const junk = rows.filter((r) => isJunkService(r.name));
  if (apply && junk.length) {
    await pool.query(
      `UPDATE services SET enabled = 0 WHERE id IN (${junk.map(() => '?').join(',')})`,
      junk.map((j) => j.id));
  }
  return {
    pass: 'junk services',
    found: junk.length,
    applied: apply ? junk.length : 0,
    sample: junk.slice(0, 5).map((j) => ({ id: j.id, name: String(j.name).slice(0, 60) })),
  };
}

// 2) Orders missing the canonical identity columns (rows created between the
// migration and a deploy, or by an older build).
async function orderIdentity(apply) {
  const [[missing]] = await pool.query(
    "SELECT COUNT(*) AS c FROM orders WHERE public_code IS NULL OR public_code = ''");
  if (apply && missing.c) {
    await pool.query(
      "UPDATE orders SET public_code = CONCAT('APX-', LPAD(id, 6, '0')) WHERE public_code IS NULL OR public_code = ''");
    await pool.query('UPDATE orders SET legacy_code = order_id WHERE legacy_code IS NULL');
    await pool.query(`UPDATE orders SET provider_key = CASE
        WHEN api_provider = 'SMMWorld' THEN 'smmworld'
        WHEN api_provider = 'RKDPanel' THEN 'rkd'
        ELSE LOWER(COALESCE(api_provider, '')) END
      WHERE provider_key IS NULL OR provider_key = ''`);
  }
  return { pass: 'order identity', found: Number(missing.c), applied: apply ? Number(missing.c) : 0 };
}

// 3) Wallet ledger integrity. Every balance mutation runs inside a locked
// transaction that records previous/new balance, so the ledger should replay
// exactly to the stored balance. Rows written by older builds may not.
// This reports drift and can rewrite the running balance from the deltas.
async function ledgerIntegrity(apply) {
  const [users] = await pool.query(
    `SELECT u.id, u.balance, COUNT(t.id) AS txns
       FROM users u JOIN transactions t ON t.user_id = u.id
      GROUP BY u.id HAVING txns > 0`);

  const drifted = [];
  for (const u of users) {
    const [txns] = await pool.query(
      'SELECT id, amount, previous_balance, new_balance FROM transactions WHERE user_id = ? ORDER BY id', [u.id]);
    // Replay: each row's new_balance must equal the previous row's new_balance
    // plus this row's amount.
    let running = null;
    const bad = [];
    for (const t of txns) {
      const prev = running === null ? Number(t.previous_balance) : running;
      const expected = Math.round((prev + Number(t.amount)) * 10000) / 10000;
      if (Math.abs(expected - Number(t.new_balance)) > 0.0001) {
        bad.push({ txn: t.id, stored: Number(t.new_balance), expected });
      }
      running = expected;
    }
    const finalDrift = Math.abs(running - Number(u.balance)) > 0.0001;
    if (bad.length || finalDrift) {
      drifted.push({
        userId: u.id, badRows: bad.length, sample: bad.slice(0, 3),
        replayedBalance: running, storedBalance: Number(u.balance),
        // Safe to auto-fix only when no money is unaccounted for.
        repairable: !finalDrift,
        needsHumanReview: finalDrift,
      });
      // Only rewrite when the replay lands exactly on the stored balance. If it
      // does not, rows are MISSING from the ledger — the snapshots are a
      // symptom, not the cause, and rewriting them would paper over the real
      // gap. Those cases are reported for a human to look at instead.
      if (apply && !finalDrift) {
        let run = null;
        for (const t of txns) {
          const prev = run === null ? Number(t.previous_balance) : run;
          const next = Math.round((prev + Number(t.amount)) * 10000) / 10000;
          await pool.query(
            'UPDATE transactions SET previous_balance = ?, new_balance = ? WHERE id = ?',
            [prev.toFixed(4), next.toFixed(4), t.id]);
          run = next;
        }
      }
    }
  }
  return {
    pass: 'ledger integrity',
    usersChecked: users.length,
    found: drifted.length,
    repairable: drifted.filter((d) => d.repairable).length,
    needsHumanReview: drifted.filter((d) => d.needsHumanReview).length,
    applied: apply ? drifted.filter((d) => d.repairable).length : 0,
    sample: drifted.slice(0, 5),
    note: 'users.balance is never modified. Accounts where the replay does not reach the stored balance are reported, not rewritten — that means ledger rows are missing.',
  };
}

async function run(apply) {
  const results = [];
  results.push(await junkServices(apply));
  results.push(await orderIdentity(apply));
  results.push(await ledgerIntegrity(apply));
  return results;
}

module.exports = { run, junkServices, orderIdentity, ledgerIntegrity };

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  run(apply)
    .then((results) => {
      console.log(apply ? '[repair] APPLIED\n' : '[repair] DRY RUN — pass --apply to write\n');
      for (const r of results) console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    })
    .catch((err) => { console.error('[repair] failed:', err.message); process.exit(1); });
}
