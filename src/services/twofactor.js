'use strict';
// 2FA support: recovery codes, and the rule that decides who must have 2FA on.
//
// Enforcing 2FA without recovery codes is how an operator locks themselves out
// of their own panel the day their phone dies. Codes are shown exactly once at
// generation, stored only as hashes, and each one works a single time.
const crypto = require('crypto');
const pool = require('../db/pool');

const CODE_COUNT = 10;

function hash(code) {
  return crypto.createHash('sha256').update(String(code).replace(/[\s-]/g, '').toLowerCase()).digest('hex');
}

// Human-friendly to read off paper: no vowels (so no accidental words), no
// characters that look like each other (0/O, 1/l/I).
const ALPHABET = 'bcdfghjkmnpqrstvwxyz23456789';
function makeCode() {
  const pick = () => ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  const block = () => Array.from({ length: 5 }, pick).join('');
  return `${block()}-${block()}`;
}

// Replaces any existing codes. Returns the plaintext ONCE — it is never
// retrievable afterwards, by us or by anyone with database access.
async function generate(userId) {
  const codes = [];
  const seen = new Set();
  while (codes.length < CODE_COUNT) {
    const c = makeCode();
    if (seen.has(c)) continue;
    seen.add(c);
    codes.push(c);
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM totp_recovery_codes WHERE user_id = ?', [userId]);
    for (const c of codes) {
      await conn.query('INSERT INTO totp_recovery_codes (user_id, code_hash) VALUES (?, ?)', [userId, hash(c)]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return codes;
}

// Spend a recovery code. The UPDATE is what claims it, so two simultaneous
// attempts with the same code cannot both succeed.
async function consume(userId, code) {
  const h = hash(code);
  const [res] = await pool.query(
    'UPDATE totp_recovery_codes SET used_at = NOW() WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
    [userId, h]);
  return res.affectedRows === 1;
}

async function remaining(userId) {
  try {
    const [[row]] = await pool.query(
      'SELECT COUNT(*) c FROM totp_recovery_codes WHERE user_id = ? AND used_at IS NULL', [userId]);
    return Number(row.c || 0);
  } catch (_) { return 0; }
}

async function required() {
  try {
    const [[row]] = await pool.query("SELECT v FROM settings WHERE k = 'require_admin_2fa'");
    return row ? ['1', 'true', 'on', 'yes'].includes(String(row.v).toLowerCase()) : true;
  } catch (_) {
    // Unreadable settings must not lock an admin out of the panel.
    return false;
  }
}

// Admins without 2FA are sent to set it up. Everything an admin can reach is a
// path to somebody's money, so this covers the whole /admin surface.
async function mustEnrol(user) {
  if (!user || !user.isAdmin) return false;
  if (user.totp_enabled) return false;
  return required();
}

module.exports = { generate, consume, remaining, required, mustEnrol, hash, CODE_COUNT };
