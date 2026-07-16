'use strict';
// Threat Radar — scores each request for attacker/scanner behavior, records
// events + per-IP reputation, and drives Telegram alerts / auto-blocking.
const pool = require('../db/pool');
const env = require('../config/env');
const telegram = require('./telegram');
const { invalidate: invalidateGate } = require('../middleware/gate');
const { getSetting } = require('./stats');

// ── Signatures ──────────────────────────────────────────────
// Paths that only scanners/bots ever request on an SMM panel.
const SCANNER_PATHS = [
  /\/wp-(admin|login|content|includes)/i, /\/xmlrpc\.php/i, /\/wordpress/i,
  /\/\.env(\.|$|\/)/i, /\/\.git(\/|$)/i, /\/\.aws/i, /\/\.ssh/i, /\/\.svn/i,
  /\/phpmyadmin/i, /\/pma\//i, /\/mysql/i, /\/adminer/i, /\/dbadmin/i,
  /\/vendor\//i, /\/composer\.(json|lock)/i, /\/\.docker/i, /\/config\.(php|json|yml)/i,
  /\/wp-config/i, /\/\.htpasswd/i, /\/server-status/i, /\/actuator/i, /\/solr/i,
  /\/cgi-bin/i, /\/shell/i, /\/backup(\.|\/|s)/i, /\/\.well-known\/(?!acme)/i,
  /\/administrator\//i, /\/joomla/i, /\/drupal/i, /\/telescope/i, /\/\.vscode/i,
  /\/owa\//i, /\/autodiscover/i, /\/eval-stdin\.php/i, /\/think\\?/i,
];
const SQLI = /(\bunion\b.+\bselect\b|\bselect\b.+\bfrom\b|\bor\b\s+1\s*=\s*1|'\s*or\s*'|--\s|\/\*|\bsleep\s*\(|\bbenchmark\s*\(|information_schema|\bconcat\s*\(|xp_cmdshell)/i;
const XSS = /(<script|javascript:|onerror\s*=|onload\s*=|<iframe|document\.cookie|\balert\s*\()/i;
const TRAVERSAL = /(\.\.\/|\.\.\\|%2e%2e[%2f5c]|\/etc\/passwd|\/proc\/self|boot\.ini|win\.ini)/i;
const CMDI = /(;|\|\||&&|`|\$\()\s*(cat|wget|curl|nc|bash|sh|python|perl|id|uname|whoami)\b/i;
const BAD_UA = /(sqlmap|nikto|nmap|masscan|zgrab|nuclei|acunetix|netsparker|wpscan|dirbuster|gobuster|fuzz|hydra|semrushbot|petalbot|censys|paloalto)/i;

const KIND_SCORE = { scanner: 40, sqli: 60, xss: 45, traversal: 55, cmdi: 60, bad_ua: 50, flood: 25, probe404: 12, brute: 30 };

// ── In-memory sliding windows (per IP) ──────────────────────
const WINDOW_MS = 60 * 1000;
const hits = new Map();   // ip -> [timestamps]
const notFound = new Map();

function bump(map, ip) {
  const now = Date.now();
  const arr = (map.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  map.set(ip, arr);
  return arr.length;
}
// Occasional cleanup so the maps can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const m of [hits, notFound]) {
    for (const [ip, arr] of m) {
      const keep = arr.filter((t) => now - t < WINDOW_MS);
      if (keep.length) m.set(ip, keep); else m.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref();

function isPrivateIp(ip) {
  if (!ip) return true;
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd|fe80)/i.test(ip) || ip === '::ffff:127.0.0.1';
}

async function isOn() {
  return ['1', 'true', 'on', 'yes'].includes(String(await getSetting('security_enabled', 'on')).toLowerCase());
}
async function autoBlockOn() {
  return ['1', 'true', 'on', 'yes'].includes(String(await getSetting('security_auto_block', 'off')).toLowerCase());
}

// Classify one request. Returns { kind, score, detail } or null.
function classify(req) {
  const path = String(req.originalUrl || req.url || '').slice(0, 500);
  const ua = String(req.get('user-agent') || '');
  // Reconstruct a haystack from path + query + a little body for payload checks.
  let body = '';
  try { body = req.body && typeof req.body === 'object' ? JSON.stringify(req.body).slice(0, 1000) : ''; } catch (_) {}
  const hay = decodeURIComponentSafe(path) + ' ' + decodeURIComponentSafe(body);

  if (!ua || ua.length < 4) return { kind: 'bad_ua', detail: 'empty/short user-agent' };
  if (BAD_UA.test(ua)) return { kind: 'bad_ua', detail: ua.slice(0, 80) };
  if (SCANNER_PATHS.some((re) => re.test(path))) return { kind: 'scanner', detail: path.slice(0, 90) };
  if (SQLI.test(hay)) return { kind: 'sqli', detail: 'SQL keywords in request' };
  if (TRAVERSAL.test(hay)) return { kind: 'traversal', detail: 'path traversal pattern' };
  if (CMDI.test(hay)) return { kind: 'cmdi', detail: 'command-injection pattern' };
  if (XSS.test(hay)) return { kind: 'xss', detail: 'script/HTML in request' };
  return null;
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(String(s)); } catch (_) { return String(s); }
}

// Record an event + roll it into the IP's reputation. Fires alert/auto-block
// when the running score crosses the configured thresholds.
async function record(ip, kind, req, detail) {
  const score = KIND_SCORE[kind] || 10;
  const path = String(req.originalUrl || req.url || '').slice(0, 255);
  const ua = String(req.get('user-agent') || '').slice(0, 255);
  const method = String(req.method || '').slice(0, 8);

  try {
    await pool.query(
      'INSERT INTO security_events (ip, kind, method, path, user_agent, detail, score) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [ip, kind, method, path, ua, (detail || '').slice(0, 255), score]);
    await pool.query(
      `INSERT INTO ip_reputation (ip, score, events_count, last_kind, last_path, user_agent)
       VALUES (?, ?, 1, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         score = LEAST(1000, score + VALUES(score)),
         events_count = events_count + 1,
         last_kind = VALUES(last_kind), last_path = VALUES(last_path),
         user_agent = VALUES(user_agent), last_seen = NOW()`,
      [ip, score, kind, path, ua]);
  } catch (err) {
    console.warn('[security] record failed:', err.message);
    return;
  }

  const [[rep]] = await pool.query('SELECT * FROM ip_reputation WHERE ip = ?', [ip]);
  if (!rep || rep.status === 'allowed' || rep.status === 'blocked') return;

  // Auto-block clear-cut attackers when enabled.
  if (rep.score >= env.SECURITY_AUTOBLOCK_SCORE && await autoBlockOn()) {
    await blockIp(ip, `Auto-blocked: ${kind} (score ${rep.score})`, null);
    await alert(rep, kind, detail, true);
    return;
  }
  // Otherwise alert once per cooldown window so you can decide.
  if (rep.score >= env.SECURITY_ALERT_SCORE) {
    const lastAlert = rep.alerted_at ? new Date(rep.alerted_at).getTime() : 0;
    if (Date.now() - lastAlert > env.SECURITY_ALERT_COOLDOWN_MIN * 60 * 1000) {
      await pool.query('UPDATE ip_reputation SET alerted_at = NOW() WHERE ip = ?', [ip]);
      await alert(rep, kind, detail, false);
    }
  }
}

// Rapid-fire / scanning behavior (many requests or many 404s in a minute).
async function noteRequest(ip, req, statusCode) {
  const total = bump(hits, ip);
  if (statusCode === 404) {
    const nf = bump(notFound, ip);
    if (nf === env.SECURITY_404_THRESHOLD) await record(ip, 'probe404', req, `${nf} not-found hits/min`);
    else if (nf > env.SECURITY_404_THRESHOLD && nf % 10 === 0) await record(ip, 'probe404', req, `${nf} not-found hits/min`);
  }
  if (total === env.SECURITY_FLOOD_THRESHOLD) await record(ip, 'flood', req, `${total} requests/min`);
}

// Send a Telegram alert with action buttons.
async function alert(rep, kind, detail, autoBlocked) {
  if (!telegram.enabled) return;
  const e = telegram.esc;
  const recent = await pool.query(
    'SELECT kind, path, created_at FROM security_events WHERE ip = ? ORDER BY id DESC LIMIT 4', [rep.ip]);
  const lines = recent[0].map((r) => `• <code>${e(r.kind)}</code> ${e(String(r.path).slice(0, 48))}`).join('\n');
  const head = autoBlocked ? '🛑 <b>Attacker auto-blocked</b>' : '🚨 <b>Suspicious activity detected</b>';
  const text =
    `${head}\n\n` +
    `<b>IP:</b> <code>${e(rep.ip)}</code>\n` +
    `<b>Threat:</b> ${e(kind)} — ${e(detail || '')}\n` +
    `<b>Score:</b> ${rep.score}  ·  <b>Events:</b> ${rep.events_count}\n` +
    `<b>Agent:</b> ${e(String(rep.user_agent || '').slice(0, 60))}\n\n` +
    `<b>Recent:</b>\n${lines}`;
  const rows = autoBlocked
    ? [[{ text: '✅ Unblock', data: `alw:${rep.ip}` }, { text: '👁 Watch', data: `wch:${rep.ip}` }],
       [{ text: 'ℹ️ Details', data: `inf:${rep.ip}` }]]
    : [[{ text: '🚫 Block', data: `blk:${rep.ip}` }, { text: '✅ Allow', data: `alw:${rep.ip}` }],
       [{ text: '👁 Watch', data: `wch:${rep.ip}` }, { text: 'ℹ️ Details', data: `inf:${rep.ip}` }]];
  await telegram.sendButtons(text, rows);
}

// ── IP actions (shared by Telegram buttons + the admin page) ──
async function blockIp(ip, reason, adminId) {
  await pool.query(
    'INSERT INTO blocked_ips (ip, reason, blocked_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE reason = VALUES(reason)',
    [ip, String(reason || 'Blocked').slice(0, 255), adminId]);
  await pool.query(
    `INSERT INTO ip_reputation (ip, status) VALUES (?, 'blocked')
     ON DUPLICATE KEY UPDATE status = 'blocked'`, [ip]);
  invalidateGate();
}

async function allowIp(ip) {
  await pool.query('DELETE FROM blocked_ips WHERE ip = ?', [ip]);
  await pool.query(
    `INSERT INTO ip_reputation (ip, status, score) VALUES (?, 'allowed', 0)
     ON DUPLICATE KEY UPDATE status = 'allowed', score = 0, alerted_at = NULL`, [ip]);
  invalidateGate();
}

async function watchIp(ip) {
  await pool.query(
    `INSERT INTO ip_reputation (ip, status) VALUES (?, 'watch')
     ON DUPLICATE KEY UPDATE status = 'watch'`, [ip]);
}

async function ipDetails(ip) {
  const [[rep]] = await pool.query('SELECT * FROM ip_reputation WHERE ip = ?', [ip]);
  const [events] = await pool.query(
    'SELECT kind, method, path, detail, created_at FROM security_events WHERE ip = ? ORDER BY id DESC LIMIT 10', [ip]);
  const [[blocked]] = await pool.query('SELECT id FROM blocked_ips WHERE ip = ?', [ip]);
  return { rep, events, blocked: !!blocked };
}

module.exports = {
  classify, record, noteRequest, isPrivateIp, isOn,
  blockIp, allowIp, watchIp, ipDetails,
};
