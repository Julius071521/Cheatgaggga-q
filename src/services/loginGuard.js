'use strict';
// Per-ACCOUNT brute-force protection.
//
// The existing rate limiter counts per IP, which is the wrong axis for
// credential stuffing: an attacker with a thousand addresses makes one attempt
// from each and never trips it. This counts against the account being attacked,
// no matter where the attempts come from.
//
// Two rules keep it from becoming a denial-of-service against the customer:
//   · the lock is temporary and it backs off — it does not disable the account
//   · a correct password clears the counter immediately
const pool = require('../db/pool');
const env = require('../config/env');

// Attempt 5 → 5 min, 6 → 15, 7 → 30, 8 → 60, 9+ → 120. Long enough to make
// guessing pointless, short enough that a customer who forgot their password
// is not locked out for the day.
const LOCK_MINUTES = [5, 15, 30, 60, 120];

function lockMinutesFor(failCount) {
  const idx = Math.min(LOCK_MINUTES.length - 1, Math.max(0, failCount - env.LOGIN_MAX_ATTEMPTS));
  return LOCK_MINUTES[idx];
}

async function enabled() {
  try {
    const [[row]] = await pool.query("SELECT v FROM settings WHERE k = 'login_lockout_enabled'");
    return row ? ['1', 'true', 'on', 'yes'].includes(String(row.v).toLowerCase()) : true;
  } catch (_) {
    return true;
  }
}

// Is this account currently locked? Returns null when it is free to try.
async function lockState(user) {
  if (!user || !user.locked_until) return null;
  const until = new Date(user.locked_until);
  if (Number.isNaN(until.getTime()) || until <= new Date()) return null;
  const seconds = Math.ceil((until - new Date()) / 1000);
  return {
    until,
    seconds,
    minutes: Math.max(1, Math.ceil(seconds / 60)),
  };
}

// A wrong password. Returns the lock that resulted, or null if still under the
// threshold. The counter is aged out: attempts from days ago should not add up.
async function recordFailure(user) {
  if (!user || !(await enabled())) return null;
  try {
    await pool.query(
      `UPDATE users
          SET failed_logins = IF(
                last_failed_login_at IS NULL
                OR last_failed_login_at < DATE_SUB(NOW(), INTERVAL ? MINUTE),
                1, failed_logins + 1),
              last_failed_login_at = NOW()
        WHERE id = ?`,
      [env.LOGIN_ATTEMPT_WINDOW_MIN, user.id]);

    const [[fresh]] = await pool.query('SELECT failed_logins FROM users WHERE id = ?', [user.id]);
    const fails = Number((fresh && fresh.failed_logins) || 0);
    if (fails < env.LOGIN_MAX_ATTEMPTS) return null;

    const minutes = lockMinutesFor(fails);
    await pool.query('UPDATE users SET locked_until = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?',
      [minutes, user.id]);
    return { minutes, fails };
  } catch (err) {
    // A failure here must not turn into a free pass or a 500 — the password was
    // already wrong, so the caller rejects the login either way.
    console.warn('[loginGuard] could not record a failed attempt:', err.message);
    return null;
  }
}

async function clear(userId) {
  try {
    await pool.query(
      'UPDATE users SET failed_logins = 0, last_failed_login_at = NULL, locked_until = NULL WHERE id = ?',
      [userId]);
  } catch (_) { /* best effort */ }
}

// An admin unlocking someone who got themselves locked out.
async function unlock(userId) {
  await pool.query(
    'UPDATE users SET failed_logins = 0, last_failed_login_at = NULL, locked_until = NULL WHERE id = ?',
    [userId]);
}

async function lockedAccounts(limit = 50) {
  const [rows] = await pool.query(
    `SELECT id, username, email, role, failed_logins, locked_until
       FROM users WHERE locked_until IS NOT NULL AND locked_until > NOW()
      ORDER BY locked_until DESC LIMIT ?`, [Number(limit) || 50]);
  return rows;
}

// One account being tried from many different addresses is the signature of a
// stuffing run, and is worth waking someone up for.
async function spreadAttack(windowMinutes = 30, minIps = 8) {
  try {
    const [rows] = await pool.query(
      `SELECT username_tried, COUNT(DISTINCT ip_address) AS ips, COUNT(*) AS tries
         FROM login_logs
        WHERE outcome IN ('bad_password', 'unknown_user', 'locked')
          AND created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
          AND username_tried IS NOT NULL
        GROUP BY username_tried
       HAVING ips >= ?
        ORDER BY ips DESC LIMIT 10`, [windowMinutes, minIps]);
    return rows;
  } catch (_) {
    return [];
  }
}

module.exports = { lockState, recordFailure, clear, unlock, lockedAccounts, spreadAttack, enabled, LOCK_MINUTES };
