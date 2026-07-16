'use strict';
const pool = require('../db/pool');
const env = require('../config/env');

// Money is DECIMAL(15,4); do integer math in ten-thousandths to avoid float drift.
function toUnits(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10000);
}
function unitsToStr(units) {
  return (units / 10000).toFixed(4);
}

// Apply a signed amount to a user's balance inside an existing transaction.
// Writes a row into the existing `transactions` table (type/amount/
// previous_balance/new_balance/description). Returns the new balance string.
async function applyBalanceChange(conn, userId, amountPhp, type, description) {
  const [[user]] = await conn.query('SELECT id, balance FROM users WHERE id = ? FOR UPDATE', [userId]);
  if (!user) throw new Error('User not found');

  const prevUnits = toUnits(user.balance);
  const newUnits = prevUnits + toUnits(amountPhp);
  if (newUnits < 0) throw new Error('Insufficient balance');

  const previousBalance = unitsToStr(prevUnits);
  const newBalance = unitsToStr(newUnits);

  await conn.query('UPDATE users SET balance = ? WHERE id = ?', [newBalance, userId]);
  await conn.query(
    'INSERT INTO transactions (user_id, type, amount, previous_balance, new_balance, description) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, type, Number(amountPhp).toFixed(4), previousBalance, newBalance, description ? String(description).slice(0, 255) : null]
  );
  return newBalance;
}

// Bonus tiers from env ("min:percent,..."), sorted highest-min first so the
// biggest qualifying tier wins (e.g. ₱5000 gets 50%, not 5%).
function bonusTiers() {
  return String(env.DEPOSIT_BONUS_TIERS || '')
    .split(',')
    .map((pair) => {
      const [min, pct] = pair.split(':').map((s) => Number(String(s).trim()));
      return Number.isFinite(min) && min > 0 && Number.isFinite(pct) && pct > 0 ? { min, pct } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.min - a.min);
}

function bonusFor(amountPhp) {
  const amount = Number(amountPhp);
  for (const tier of bonusTiers()) {
    if (amount >= tier.min) {
      return { pct: tier.pct, amount: Math.round(amount * tier.pct) / 100 };
    }
  }
  return { pct: 0, amount: 0 };
}

// Approve a deposit: credit the amount, the tier bonus, and the referrer's
// commission — all inside one transaction. `adminId` is NULL for auto-approval.
// Returns { deposit, bonus, bonusPct, commission, referrerId }.
async function approveDeposit(depositId, adminId, note, { auto = false } = {}) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[deposit]] = await conn.query('SELECT * FROM deposits WHERE id = ? FOR UPDATE', [depositId]);
    if (!deposit) throw new Error('Deposit not found');
    if (String(deposit.status).toLowerCase() !== 'pending') throw new Error('Deposit was already reviewed');

    await applyBalanceChange(conn, deposit.user_id, deposit.amount, 'deposit',
      `${String(deposit.payment_method).toUpperCase()} deposit approved`);

    // Tier bonus (e.g. ₱1000 → +10%).
    const bonus = bonusFor(deposit.amount);
    if (bonus.amount > 0) {
      await applyBalanceChange(conn, deposit.user_id, bonus.amount, 'bonus',
        `+${bonus.pct}% deposit bonus (₱${Number(deposit.amount).toFixed(2)} top-up)`);
    }

    // Referral commission for whoever invited this customer (once per deposit,
    // enforced by the unique key on referral_commissions.deposit_id).
    let commission = 0;
    let referrerId = null;
    const pct = Number(env.REFERRAL_COMMISSION_PERCENT) || 0;
    if (pct > 0) {
      const [[depositor]] = await conn.query('SELECT referred_by FROM users WHERE id = ?', [deposit.user_id]);
      if (depositor && depositor.referred_by && depositor.referred_by !== deposit.user_id) {
        const [[referrer]] = await conn.query(
          "SELECT id FROM users WHERE id = ? AND LOWER(COALESCE(status,'Active')) = 'active'", [depositor.referred_by]);
        if (referrer) {
          commission = Math.round(Number(deposit.amount) * pct) / 100;
          if (commission > 0) {
            try {
              await conn.query(
                `INSERT INTO referral_commissions (referrer_id, referred_user_id, deposit_id, deposit_amount, amount)
                 VALUES (?, ?, ?, ?, ?)`,
                [referrer.id, deposit.user_id, deposit.id, Number(deposit.amount).toFixed(4), commission.toFixed(4)]);
              await applyBalanceChange(conn, referrer.id, commission, 'commission',
                `${pct}% referral commission — invited member topped up ₱${Number(deposit.amount).toFixed(2)}`);
              referrerId = referrer.id;
            } catch (err) {
              if (err && err.code === 'ER_DUP_ENTRY') { commission = 0; } // already paid for this deposit
              else throw err;
            }
          }
        }
      }
    }

    await conn.query(
      "UPDATE deposits SET status = 'Approved', admin_note = ?, reviewed_by = ?, reviewed_at = NOW(), bonus_amount = ?, auto_approved = ? WHERE id = ?",
      [note ? String(note).slice(0, 500) : null, adminId || null,
        bonus.amount > 0 ? bonus.amount.toFixed(4) : null, auto ? 1 : 0, depositId]);
    await conn.commit();
    return { deposit, bonus: bonus.amount, bonusPct: bonus.pct, commission, referrerId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function rejectDeposit(depositId, adminId, note) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[deposit]] = await conn.query('SELECT * FROM deposits WHERE id = ? FOR UPDATE', [depositId]);
    if (!deposit) throw new Error('Deposit not found');
    if (String(deposit.status).toLowerCase() !== 'pending') throw new Error('Deposit was already reviewed');

    await conn.query(
      "UPDATE deposits SET status = 'Rejected', admin_note = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?",
      [note ? String(note).slice(0, 500) : null, adminId, depositId]);
    await conn.commit();
    return deposit;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function adjustBalance(userId, amountPhp, adminId, note) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const newBalance = await applyBalanceChange(conn, userId, amountPhp, 'adjustment',
      note ? `Admin adjustment: ${note}` : 'Admin balance adjustment');
    await conn.commit();
    return newBalance;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ── Referral payout requests (withdraw earnings to GCash/Maya) ──
// The amount is held (deducted) immediately so it can't be spent twice;
// a rejected request refunds it in full.
async function createPayoutRequest(userId, amountPhp, method, accountNumber, accountName) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await applyBalanceChange(conn, userId, -Number(amountPhp), 'payout_hold',
      `Referral payout request via ${String(method).toUpperCase()}`);
    const [res] = await conn.query(
      `INSERT INTO payout_requests (user_id, amount, method, account_number, account_name, status)
       VALUES (?, ?, ?, ?, ?, 'Pending')`,
      [userId, Number(amountPhp).toFixed(4), method, accountNumber, accountName]);
    await conn.commit();
    return res.insertId;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Admin marks a payout Paid (money already held) or Rejected (refund the hold).
async function resolvePayout(payoutId, adminId, approve, note) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[p]] = await conn.query('SELECT * FROM payout_requests WHERE id = ? FOR UPDATE', [payoutId]);
    if (!p) throw new Error('Payout request not found');
    if (p.status !== 'Pending') throw new Error('Payout was already processed');
    if (!approve) {
      await applyBalanceChange(conn, p.user_id, Number(p.amount), 'payout_refund',
        'Payout request rejected — amount returned to wallet');
    }
    await conn.query(
      'UPDATE payout_requests SET status = ?, admin_note = ?, processed_by = ?, processed_at = NOW() WHERE id = ?',
      [approve ? 'Paid' : 'Rejected', note ? String(note).slice(0, 500) : null, adminId, payoutId]);
    await conn.commit();
    return p;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  applyBalanceChange, approveDeposit, rejectDeposit, adjustBalance, toUnits, unitsToStr,
  bonusTiers, bonusFor, createPayoutRequest, resolvePayout,
};
