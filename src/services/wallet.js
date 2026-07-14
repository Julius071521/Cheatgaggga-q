'use strict';
const pool = require('../db/pool');
const { toCents, centsToPhp } = require('../utils/helpers');

// Apply a signed amount to a user's balance inside an existing transaction connection.
// Returns the new balance as a string. Throws if the debit would go negative.
async function applyBalanceChange(conn, userId, amountPhp, type, refType, refId, note) {
  const [[user]] = await conn.query('SELECT id, balance FROM users WHERE id = ? FOR UPDATE', [userId]);
  if (!user) throw new Error('User not found');

  const newCents = toCents(user.balance) + toCents(amountPhp);
  if (newCents < 0) throw new Error('Insufficient balance');
  const newBalance = centsToPhp(newCents);

  await conn.query('UPDATE users SET balance = ? WHERE id = ?', [newBalance, userId]);
  await conn.query(
    'INSERT INTO transactions (user_id, type, amount_php, balance_after, ref_type, ref_id, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, type, Number(amountPhp).toFixed(2), newBalance, refType, refId, note ? String(note).slice(0, 255) : null]
  );
  return newBalance;
}

async function approveDeposit(depositId, adminId, note) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[deposit]] = await conn.query('SELECT * FROM deposits WHERE id = ? FOR UPDATE', [depositId]);
    if (!deposit) throw new Error('Deposit not found');
    if (deposit.status !== 'pending') throw new Error('Deposit was already reviewed');

    await applyBalanceChange(conn, deposit.user_id, deposit.amount_php, 'deposit', 'deposit', deposit.id,
      `${deposit.method.toUpperCase()} deposit approved`);
    await conn.query(
      "UPDATE deposits SET status = 'approved', admin_note = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?",
      [note ? String(note).slice(0, 500) : null, adminId, depositId]
    );
    await conn.commit();
    return deposit;
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
    if (deposit.status !== 'pending') throw new Error('Deposit was already reviewed');

    await conn.query(
      "UPDATE deposits SET status = 'rejected', admin_note = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?",
      [note ? String(note).slice(0, 500) : null, adminId, depositId]
    );
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
    const newBalance = await applyBalanceChange(conn, userId, amountPhp, 'adjustment', 'admin', adminId,
      note || 'Manual balance adjustment');
    await conn.commit();
    return newBalance;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { applyBalanceChange, approveDeposit, rejectDeposit, adjustBalance };
