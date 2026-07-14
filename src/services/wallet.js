'use strict';
const pool = require('../db/pool');

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

async function approveDeposit(depositId, adminId, note) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[deposit]] = await conn.query('SELECT * FROM deposits WHERE id = ? FOR UPDATE', [depositId]);
    if (!deposit) throw new Error('Deposit not found');
    if (String(deposit.status).toLowerCase() !== 'pending') throw new Error('Deposit was already reviewed');

    await applyBalanceChange(conn, deposit.user_id, deposit.amount, 'deposit',
      `${String(deposit.payment_method).toUpperCase()} deposit approved`);
    await conn.query(
      "UPDATE deposits SET status = 'Approved', admin_note = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?",
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

module.exports = { applyBalanceChange, approveDeposit, rejectDeposit, adjustBalance, toUnits, unitsToStr };
