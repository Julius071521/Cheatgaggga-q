'use strict';
// Enforces the Network Guard policy. Everything risky about this middleware is
// deliberately one-directional: any doubt, any error, any timeout — the visitor
// gets through. The only way to be stopped is a positive identification.
const crypto = require('crypto');
const pool = require('../db/pool');
const env = require('../config/env');
const ipintel = require('../services/ipintel');
const security = require('../services/security');

// Never inspected: static assets, webhooks, health checks, and the block page
// itself (otherwise a blocked visitor cannot even be told why).
const SKIP = /^\/(assets|telegram|internal|favicon\.ico|robots\.txt|sitemap\.xml|lang\/)/;

// The reseller API is called from the customer's own server, which is a
// datacenter IP by definition. A request carrying a valid key is authenticated
// far more strongly than by its network, so it is exempt.
const API = /^\/api\//;

// In `guard` mode only these are defended — the money paths. Browsing, signing
// in and reading orders stay open, so a customer on a VPN is inconvenienced
// only where fraud actually happens.
const SENSITIVE = [
  { method: 'POST', re: /^\/register/ },
  { method: 'POST', re: /^\/wallet/ },
  { method: 'POST', re: /^\/order/ },
];

let cfg = { mode: 'off', hosting: true, vpn: true, proxy: true, tor: true, at: 0 };
// How long a policy change takes to reach every worker process. Lower it if you
// want the admin toggles to apply almost instantly at the cost of more queries.
const TTL_MS = Math.max(0, Number(env.NETGUARD_SETTINGS_TTL_MS) || 20000);
const ON = (v) => ['1', 'true', 'on', 'yes'].includes(String(v).toLowerCase());

async function settings() {
  if (Date.now() - cfg.at < TTL_MS) return cfg;
  cfg.at = Date.now();
  try {
    const [rows] = await pool.query(
      "SELECT k, v FROM settings WHERE k IN ('netguard_mode','netguard_hosting','netguard_vpn','netguard_proxy','netguard_tor')");
    const map = Object.fromEntries(rows.map((r) => [r.k, r.v]));
    const mode = String(map.netguard_mode || env.NETGUARD_MODE).toLowerCase();
    cfg.mode = ['off', 'monitor', 'guard', 'block'].includes(mode) ? mode : 'monitor';
    cfg.hosting = map.netguard_hosting === undefined ? true : ON(map.netguard_hosting);
    cfg.vpn = map.netguard_vpn === undefined ? true : ON(map.netguard_vpn);
    cfg.proxy = map.netguard_proxy === undefined ? true : ON(map.netguard_proxy);
    cfg.tor = map.netguard_tor === undefined ? true : ON(map.netguard_tor);
  } catch (_) {
    // Settings unreadable (migration not run yet, DB blip) — stay in the
    // configured default rather than inventing a stricter policy.
    cfg.mode = String(env.NETGUARD_MODE || 'monitor').toLowerCase();
  }
  return cfg;
}

function invalidate() { cfg.at = 0; }

function isSensitive(req) {
  return SENSITIVE.some((s) => s.method === req.method && s.re.test(req.path));
}

// Short, readable, unique — quoted by the visitor when they contact support so
// the exact refusal can be found in the log.
function reference() {
  return crypto.randomBytes(6).toString('hex');
}

// ── Runaway alarm ───────────────────────────────────────────────────────────
// Blocking whole networks is a blunt instrument: if the intelligence source
// starts calling a Philippine mobile carrier a "proxy", this middleware would
// quietly turn away most of the paying customers and nothing else would notice.
// The last N decisions are kept in memory; when the refusal share crosses the
// line an alert goes out. It does NOT change the policy on its own — that is
// the operator's call — it just makes sure they hear about it within minutes.
const WINDOW = 200;
const MIN_REFUSALS = 25;
const SHARE = 0.4;
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const decisions = [];
let lastAlarm = 0;

function recordDecision(refused) {
  decisions.push(refused ? 1 : 0);
  if (decisions.length > WINDOW) decisions.shift();
  if (decisions.length < WINDOW) return;
  const refusals = decisions.reduce((a, b) => a + b, 0);
  if (refusals < MIN_REFUSALS || refusals / decisions.length < SHARE) return;
  if (Date.now() - lastAlarm < ALERT_COOLDOWN_MS) return;
  lastAlarm = Date.now();
  const pct = Math.round((refusals / decisions.length) * 100);
  const msg = `⚠️ <b>Network Guard is refusing ${pct}% of visitors</b>\n`
    + `${refusals} of the last ${decisions.length} requests were turned away as VPN/proxy/VPS.\n`
    + 'If that looks wrong, open <b>Admin → Security</b> and switch the mode to '
    + '<b>Monitor</b> or <b>Guard</b>. Real customers may be getting blocked.';
  console.warn(`[netguard] refusing ${pct}% of recent requests — check the policy`);
  try { require('../services/telegram').send(msg).catch(() => {}); } catch (_) { /* alerting is best-effort */ }
}

async function deny(req, res, verdict, why, ref) {
  const ip = req.clientIp || req.ip;
  ipintel.noteHit(ip, true).catch(() => {});
  pool.query(
    'INSERT INTO security_events (ip, kind, method, path, user_agent, detail, score) VALUES (?, ?, ?, ?, ?, ?, 0)',
    [ip, 'netguard', req.method, String(req.path).slice(0, 255),
      String(req.headers['user-agent'] || '').slice(0, 255),
      `${why}:${verdict.org || verdict.kind} ref=${ref}`.slice(0, 255)]).catch(() => {});

  if (API.test(req.path) || req.xhr || String(req.headers.accept || '').includes('application/json')) {
    return res.status(403).json({ error: 'Access from this network is not allowed.', reference: ref });
  }
  return res.status(403).render('errors/restricted', {
    clientIp: ip,
    reference: ref,
    reason: verdict.label || 'Restricted network',
  });
}

async function networkGuard(req, res, next) {
  const ip = req.clientIp || req.ip;
  if (SKIP.test(req.path)) return next();
  // Local/private addresses and our own Cloudflare front-end are not visitors.
  if (!ip || security.isSkippableIp(ip)) return next();

  let conf;
  try { conf = await settings(); } catch (_) { return next(); }
  if (conf.mode === 'off') return next();

  // Admins and IPs an operator has explicitly trusted are never stopped —
  // checked before any lookup so an admin can always reach the panel to turn
  // this off, even if the intelligence source is misbehaving.
  if (req.user && req.user.isAdmin) return next();
  try { if (security.isAllowedCached(ip)) return next(); } catch (_) { /* fall through */ }

  // A signed API request proves who it is; its network is irrelevant.
  if (API.test(req.path) && (req.headers.authorization || req.body?.key || req.query?.key)) return next();

  const sensitive = isSensitive(req);
  let verdict = null;
  try {
    verdict = sensitive ? await ipintel.classifyNow(ip) : await ipintel.classify(ip);
  } catch (_) {
    return next(); // fail open
  }
  if (!verdict) { recordDecision(false); return next(); } // unknown — allow, decide next time

  ipintel.noteHit(ip, false).catch(() => {});
  const why = ipintel.shouldStop(verdict, conf);
  if (!why) { recordDecision(false); return next(); }

  // monitor: record only. guard: money paths only. block: everything.
  if (conf.mode === 'monitor') { recordDecision(false); res.locals.netguard = { flagged: why, verdict }; return next(); }
  if (conf.mode === 'guard' && !sensitive) { recordDecision(false); res.locals.netguard = { flagged: why, verdict }; return next(); }

  recordDecision(true);
  return deny(req, res, verdict, why, reference());
}

module.exports = { networkGuard, invalidate, isSensitive, SENSITIVE };
