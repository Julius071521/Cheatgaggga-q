'use strict';
const pool = require('../db/pool');

// Small cached view of the maintenance flag + IP blocklist so we don't hit the
// DB on every request. Refreshed every 20 seconds.
let cache = { maintenance: false, blocked: new Set(), at: 0 };
const TTL_MS = 20 * 1000;

async function refresh() {
  const now = Date.now();
  if (now - cache.at < TTL_MS) return;
  cache.at = now;
  try {
    const [[m]] = await pool.query("SELECT v FROM settings WHERE k = 'maintenance'");
    cache.maintenance = m ? ['1', 'true', 'on', 'yes'].includes(String(m.v).toLowerCase()) : false;
  } catch (_) { /* settings table may not exist yet */ }
  try {
    const [rows] = await pool.query('SELECT ip FROM blocked_ips');
    cache.blocked = new Set(rows.map((r) => r.ip));
  } catch (_) { cache.blocked = cache.blocked || new Set(); }
}

function invalidate() { cache.at = 0; }

// Paths that must stay reachable even during maintenance / for everyone,
// so an admin can still sign in and assets keep loading. NOTE: /ai/chat is
// intentionally NOT here — maintenance must fully lock the site (no AI abuse).
const ALWAYS_ALLOW = [/^\/login/, /^\/logout/, /^\/forgot/, /^\/reset/, /^\/auth\/google/, /^\/assets/, /^\/internal\//];

async function gate(req, res, next) {
  await refresh();

  const isAdmin = req.user && req.user.isAdmin;

  // IP blocklist (admins are never blocked). Use the real visitor IP.
  if (!isAdmin && cache.blocked.has(req.clientIp || req.ip)) {
    return res.status(403).render('errors/blocked', { clientIp: req.clientIp || req.ip });
  }

  if (cache.maintenance && !isAdmin) {
    if (ALWAYS_ALLOW.some((re) => re.test(req.path))) return next();
    // Log out any non-admin who still holds a session.
    if (req.user && req.session) {
      return req.session.destroy(() => res.status(503).render('maintenance'));
    }
    return res.status(503).render('maintenance');
  }
  next();
}

module.exports = { gate, invalidate };
