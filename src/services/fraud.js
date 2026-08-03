'use strict';
// Multi-account detection.
//
// The deposit bonus reaches +50% and referrals pay 5%, which is the exact
// combination people farm with twenty accounts and one GCash number. This does
// not block anyone by itself — it records the links and scores them, so the
// abuse is visible in the panel instead of invisible in the balance sheet.
const pool = require('../db/pool');

const REASON_LABEL = {
  signup_ip: 'Signed up from the same IP',
  device: 'Same browser/device fingerprint',
  login_ip: 'Logs in from the same IP',
  payment_ref: 'Same payment account used',
};

// A device string is the raw user-agent, which is far from unique on its own —
// two people on the same phone model match. It only counts as a signal when it
// lines up with another one, which is what scoring below does.
function deviceOf(req) {
  return String((req && req.headers && req.headers['user-agent']) || '').slice(0, 255) || null;
}

async function enabled() {
  try {
    const [[row]] = await pool.query("SELECT v FROM settings WHERE k = 'fraud_link_detection'");
    return row ? ['1', 'true', 'on', 'yes'].includes(String(row.v).toLowerCase()) : true;
  } catch (_) { return false; }
}

async function link(userId, otherId, reason, detail) {
  if (!userId || !otherId || userId === otherId) return;
  // Stored both ways so either account shows the relationship.
  for (const [a, b] of [[userId, otherId], [otherId, userId]]) {
    await pool.query(
      `INSERT INTO account_links (user_id, other_user_id, reason, detail) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE detail = VALUES(detail)`,
      [a, b, reason, String(detail || '').slice(0, 190)]).catch(() => {});
  }
}

// Called right after a signup. Finds accounts that share this one's IP or
// device and records the links.
async function onSignup(userId, req) {
  if (!(await enabled())) return { links: 0 };
  const ip = String((req && (req.clientIp || req.ip)) || '').slice(0, 45) || null;
  const device = deviceOf(req);
  try {
    await pool.query('UPDATE users SET signup_ip = ?, signup_device = ? WHERE id = ?', [ip, device, userId]);
  } catch (_) { /* fingerprints are a nice-to-have, not a blocker on signup */ }

  let links = 0;
  const touched = new Set([userId]);
  try {
    if (ip) {
      const [same] = await pool.query(
        'SELECT id FROM users WHERE signup_ip = ? AND id <> ? LIMIT 25', [ip, userId]);
      for (const u of same) { await link(userId, u.id, 'signup_ip', ip); touched.add(u.id); links += 1; }
    }
    if (device && links < 25) {
      const [same] = await pool.query(
        'SELECT id FROM users WHERE signup_device = ? AND signup_ip <> ? AND id <> ? LIMIT 25',
        [device, ip || '', userId]);
      for (const u of same) { await link(userId, u.id, 'device', device); touched.add(u.id); links += 1; }
    }
  } catch (err) {
    console.warn('[fraud] signup link pass failed:', err.message);
  }
  // Both ends of a new link change: the account that was already there now has
  // one more relation too. Rescoring only the newcomer left the older account
  // sitting at zero and invisible in the flagged list.
  for (const id of touched) await rescore(id).catch(() => {});
  return { links };
}

// The same payment RECEIPT uploaded by a second account: one payment, two
// logins claiming it. Note this deliberately keys on the receipt hash, not the
// reference number — deposits.reference_id is already globally unique, so a
// reused reference is rejected at insert and could never reach this function.
async function onDeposit(userId, receiptHash) {
  if (!receiptHash || !(await enabled())) return { links: 0 };
  let links = 0;
  const touched = new Set([userId]);
  try {
    const [same] = await pool.query(
      'SELECT DISTINCT user_id FROM deposits WHERE receipt_hash = ? AND user_id <> ? LIMIT 25',
      [String(receiptHash), userId]);
    for (const d of same) {
      await link(userId, d.user_id, 'payment_ref', `receipt ${String(receiptHash).slice(0, 16)}…`);
      touched.add(d.user_id);
      links += 1;
    }
  } catch (err) {
    console.warn('[fraud] deposit link pass failed:', err.message);
  }
  for (const id of touched) await rescore(id).catch(() => {});
  return { links };
}

// Self-referral: the inviter and the invitee are the same person wearing two
// accounts. Returns the reason when the commission should not be paid.
async function selfReferral(inviterId, inviteeId) {
  if (!inviterId || !inviteeId) return null;
  if (inviterId === inviteeId) return 'An account cannot refer itself.';
  try {
    const [[l]] = await pool.query(
      'SELECT reason FROM account_links WHERE user_id = ? AND other_user_id = ? LIMIT 1',
      [inviterId, inviteeId]);
    if (l) return REASON_LABEL[l.reason] || 'These accounts are linked.';
    const [[pair]] = await pool.query(
      `SELECT a.signup_ip AS ip_a, b.signup_ip AS ip_b, a.signup_device AS d_a, b.signup_device AS d_b
         FROM users a, users b WHERE a.id = ? AND b.id = ?`, [inviterId, inviteeId]);
    if (pair && pair.ip_a && pair.ip_a === pair.ip_b) return REASON_LABEL.signup_ip;
    if (pair && pair.d_a && pair.d_a === pair.d_b && pair.ip_a === pair.ip_b) return REASON_LABEL.device;
  } catch (_) { /* if the check itself fails, do not accuse anyone */ }
  return null;
}

// Score = how much this account looks like part of a farm. Weighted so that a
// shared payment reference dominates: an IP can be a household or an office,
// a wallet number is a person.
async function rescore(userId) {
  try {
    const [rows] = await pool.query(
      'SELECT reason, COUNT(*) c FROM account_links WHERE user_id = ? GROUP BY reason', [userId]);
    const by = Object.fromEntries(rows.map((r) => [r.reason, Number(r.c)]));
    const score = Math.min(100,
      (by.payment_ref || 0) * 40
      + (by.signup_ip || 0) * 12
      + (by.device || 0) * 8
      + (by.login_ip || 0) * 4);
    const flags = Object.keys(by).sort().join(',').slice(0, 255) || null;
    await pool.query('UPDATE users SET fraud_score = ?, fraud_flags = ? WHERE id = ?', [score, flags, userId]);
    return score;
  } catch (_) { return 0; }
}

async function linksFor(userId) {
  const [rows] = await pool.query(
    `SELECT l.reason, l.detail, l.created_at, u.id, u.username, u.email, u.balance, u.status, u.created_at AS joined
       FROM account_links l JOIN users u ON u.id = l.other_user_id
      WHERE l.user_id = ? ORDER BY l.reason, u.id LIMIT 50`, [userId]);
  return rows.map((r) => ({ ...r, reasonLabel: REASON_LABEL[r.reason] || r.reason }));
}

// The accounts worth a human look, most suspicious first.
async function flagged(limit = 40) {
  const [rows] = await pool.query(
    `SELECT u.id, u.username, u.email, u.balance, u.status, u.fraud_score, u.fraud_flags,
            u.signup_ip, u.created_at,
            (SELECT COUNT(*) FROM account_links l WHERE l.user_id = u.id) AS link_count
       FROM users u WHERE u.fraud_score > 0
      ORDER BY u.fraud_score DESC, link_count DESC LIMIT ?`, [Number(limit) || 40]);
  return rows;
}

// One-off pass over accounts that signed up before this shipped, so the panel
// is not empty on day one. Safe to re-run.
async function backfill(limit = 500) {
  if (!(await enabled())) return { scanned: 0, linked: 0 };
  const [users] = await pool.query(
    `SELECT id, last_ip FROM users
      WHERE signup_ip IS NULL AND last_ip IS NOT NULL ORDER BY id DESC LIMIT ?`, [limit]);
  let linked = 0;
  for (const u of users) {
    // last_ip is the closest thing we have for an account that predates the
    // signup fingerprint, and it is recorded as login_ip, not signup_ip, so the
    // weaker evidence is scored as the weaker signal.
    const [same] = await pool.query(
      'SELECT id FROM users WHERE last_ip = ? AND id <> ? LIMIT 25', [u.last_ip, u.id]);
    for (const o of same) { await link(u.id, o.id, 'login_ip', u.last_ip); await rescore(o.id).catch(() => {}); linked += 1; }
    await rescore(u.id).catch(() => {});
  }
  return { scanned: users.length, linked };
}

module.exports = {
  onSignup, onDeposit, selfReferral, rescore, linksFor, flagged, backfill, link, deviceOf, enabled, REASON_LABEL,
};
