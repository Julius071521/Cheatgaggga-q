'use strict';
// Who did what, when, from where. Two tables the old system used to fill and
// the rewrite stopped writing to — so for the last month there has been no
// record of who moved money.
//
// Every function here swallows its own errors on purpose. An audit write must
// never be the thing that fails a refund or blocks a login; a missing log line
// is bad, a failed payout is worse.
const pool = require('../db/pool');

function ipOf(req) {
  return String((req && (req.clientIp || req.ip)) || '').slice(0, 45) || null;
}
function uaOf(req) {
  return String((req && req.headers && req.headers['user-agent']) || '').slice(0, 500) || null;
}
function short(v, max = 4000) {
  if (v === undefined || v === null) return null;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// An admin changed something. `before`/`after` are stored verbatim so a dispute
// can be settled from the log alone rather than from memory.
async function adminAction(req, {
  action, module: mod, recordId = null, before = null, after = null,
}) {
  try {
    await pool.query(
      `INSERT INTO admin_audit_logs
         (admin_id, action, affected_module, affected_record_id, old_value, new_value, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [(req && req.user && req.user.id) || null, String(action).slice(0, 100), String(mod).slice(0, 100),
        recordId === null ? null : String(recordId).slice(0, 100),
        short(before), short(after), ipOf(req), uaOf(req)]);
  } catch (err) {
    console.warn('[audit] admin action not recorded:', err.message);
  }
}

// Every login attempt, successful or not. The failures are the half that shows
// an attack in progress, which is why user_id is nullable — a stuffing run
// mostly targets usernames that do not exist.
async function loginAttempt(req, {
  userId = null, outcome, usernameTried = null, detail = null,
}) {
  try {
    await pool.query(
      `INSERT INTO login_logs (user_id, ip_address, user_agent, outcome, username_tried, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, ipOf(req), String(uaOf(req) || '').slice(0, 255), String(outcome).slice(0, 16),
        usernameTried ? String(usernameTried).slice(0, 190) : null,
        detail ? String(detail).slice(0, 190) : null]);
  } catch (err) {
    console.warn('[audit] login attempt not recorded:', err.message);
  }
}

async function recentAdminActions({ limit = 100, module: mod = '', adminId = 0, q = '' } = {}) {
  const where = [];
  const params = [];
  if (mod) { where.push('a.affected_module = ?'); params.push(mod); }
  if (adminId) { where.push('a.admin_id = ?'); params.push(adminId); }
  if (q) {
    where.push('(a.action LIKE ? OR a.affected_record_id LIKE ? OR a.new_value LIKE ? OR u.username LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const [rows] = await pool.query(
    `SELECT a.*, u.username AS admin_username
       FROM admin_audit_logs a LEFT JOIN users u ON u.id = a.admin_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY a.id DESC LIMIT ?`, [...params, Number(limit) || 100]);
  return rows;
}

async function recentLogins({ limit = 100, outcome = '', userId = 0 } = {}) {
  const where = [];
  const params = [];
  if (outcome) { where.push('l.outcome = ?'); params.push(outcome); }
  if (userId) { where.push('l.user_id = ?'); params.push(userId); }
  const [rows] = await pool.query(
    `SELECT l.*, u.username, u.role
       FROM login_logs l LEFT JOIN users u ON u.id = l.user_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY l.id DESC LIMIT ?`, [...params, Number(limit) || 100]);
  return rows;
}

// Headline numbers for the panel: what has been happening in the last day.
async function stats() {
  const out = { actions24: 0, logins24: 0, failed24: 0, lockouts24: 0, distinctFailedIps24: 0 };
  try {
    const [[a]] = await pool.query(
      'SELECT COUNT(*) c FROM admin_audit_logs WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)');
    out.actions24 = Number(a.c || 0);
    const [[l]] = await pool.query(
      `SELECT
         SUM(outcome = 'success') AS ok,
         SUM(outcome IN ('bad_password','bad_2fa','unknown_user')) AS bad,
         SUM(outcome = 'locked') AS locked,
         COUNT(DISTINCT IF(outcome <> 'success', ip_address, NULL)) AS ips
       FROM login_logs WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`);
    out.logins24 = Number(l.ok || 0);
    out.failed24 = Number(l.bad || 0);
    out.lockouts24 = Number(l.locked || 0);
    out.distinctFailedIps24 = Number(l.ips || 0);
  } catch (_) { /* panel still renders with zeros */ }
  return out;
}

module.exports = { adminAction, loginAttempt, recentAdminActions, recentLogins, stats };
