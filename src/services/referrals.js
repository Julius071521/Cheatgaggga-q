'use strict';
const crypto = require('crypto');
const pool = require('../db/pool');
const env = require('../config/env');
const { toUnits, unitsToStr } = require('./wallet');

function generateCode() {
  // APX + 6 unambiguous chars (no 0/O/1/I) — easy to share out loud.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'APX';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) code += alphabet[bytes[i] % alphabet.length];
  return code;
}

// Get (or lazily create) the user's referral code — works for all existing members.
async function ensureCode(userId) {
  const [[user]] = await pool.query('SELECT referral_code FROM users WHERE id = ?', [userId]);
  if (!user) return null;
  if (user.referral_code) return user.referral_code;
  for (let i = 0; i < 8; i++) {
    const code = generateCode();
    try {
      await pool.query('UPDATE users SET referral_code = ? WHERE id = ? AND referral_code IS NULL', [code, userId]);
      const [[fresh]] = await pool.query('SELECT referral_code FROM users WHERE id = ?', [userId]);
      if (fresh && fresh.referral_code) return fresh.referral_code;
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') continue; // rare collision — try again
      throw err;
    }
  }
  throw new Error('Could not generate a referral code');
}

async function findReferrerByCode(code) {
  const clean = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,20}$/.test(clean)) return null;
  const [[user]] = await pool.query(
    "SELECT id FROM users WHERE referral_code = ? AND LOWER(COALESCE(status,'Active')) = 'active' LIMIT 1", [clean]);
  return user || null;
}

// Dashboard stats + the amount still withdrawable (earned − already requested,
// capped by the current wallet balance so held/spent funds can't go negative).
async function stats(user) {
  const [[invited]] = await pool.query('SELECT COUNT(*) AS c FROM users WHERE referred_by = ?', [user.id]);
  const [[earned]] = await pool.query(
    'SELECT COALESCE(SUM(amount), 0) AS s, COUNT(*) AS c FROM referral_commissions WHERE referrer_id = ?', [user.id]);
  const [[paidOut]] = await pool.query(
    "SELECT COALESCE(SUM(amount), 0) AS s FROM payout_requests WHERE user_id = ? AND status <> 'Rejected'", [user.id]);
  const [recent] = await pool.query(
    `SELECT rc.*, u.username AS referred_username FROM referral_commissions rc
     LEFT JOIN users u ON u.id = rc.referred_user_id
     WHERE rc.referrer_id = ? ORDER BY rc.id DESC LIMIT 15`, [user.id]);
  const [payouts] = await pool.query(
    'SELECT * FROM payout_requests WHERE user_id = ? ORDER BY id DESC LIMIT 10', [user.id]);

  const availableUnits = Math.max(0, Math.min(
    toUnits(user.balance),
    toUnits(earned.s) - toUnits(paidOut.s)
  ));
  return {
    invited: Number(invited.c),
    commissionCount: Number(earned.c),
    totalEarned: Number(earned.s),
    withdrawable: Number(unitsToStr(availableUnits)),
    commissionPercent: Number(env.REFERRAL_COMMISSION_PERCENT) || 0,
    minPayout: Number(env.MIN_PAYOUT_PHP) || 0,
    recent,
    payouts,
  };
}

module.exports = { ensureCode, findReferrerByCode, stats };
