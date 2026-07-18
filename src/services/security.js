'use strict';
// Threat Radar — scores each request for attacker/scanner behavior, records
// events + per-IP reputation, and drives Telegram alerts / auto-blocking.
const pool = require('../db/pool');
const env = require('../config/env');
const telegram = require('./telegram');
const { invalidate: invalidateGate } = require('../middleware/gate');
const { getSetting, setSetting } = require('./stats');

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

// Human labels for each threat type (shown in alerts / the panel).
const KIND_LABEL = {
  scanner: 'Scanning for hidden files/admin pages', sqli: 'SQL injection attempt',
  xss: 'Cross-site scripting attempt', traversal: 'Path-traversal attempt',
  cmdi: 'Command-injection attempt', bad_ua: 'Hacking tool / bad bot',
  flood: 'Request flood (possible DoS)', probe404: 'Probing many URLs',
  brute: 'Login brute-force attempt',
};

// Score → danger rating.
function threatLevel(score) {
  if (score >= 120) return { label: 'CRITICAL', emoji: '🔴' };
  if (score >= 80) return { label: 'HIGH', emoji: '🟠' };
  if (score >= 40) return { label: 'MEDIUM', emoji: '🟡' };
  return { label: 'LOW', emoji: '🟢' };
}

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

// Cloudflare's own edge IPs (published ranges). When the site is behind
// Cloudflare, req.ip is one of these — recording/blocking it would flag or ban
// Cloudflare itself (i.e. everyone). We NEVER treat these as attackers; the
// real visitor is in CF-Connecting-IP (see utils/clientip).
const CF_V4 = [
  ['173.245.48.0', 20], ['103.21.244.0', 22], ['103.22.200.0', 22], ['103.31.4.0', 22],
  ['141.101.64.0', 18], ['108.162.192.0', 18], ['190.93.240.0', 20], ['188.114.96.0', 20],
  ['197.234.240.0', 22], ['198.41.128.0', 17], ['162.158.0.0', 15], ['104.16.0.0', 13],
  ['104.24.0.0', 14], ['172.64.0.0', 13], ['131.0.72.0', 22],
];
const CF_V6_PREFIXES = ['2400:cb00', '2606:4700', '2803:f800', '2405:b500', '2405:8100', '2a06:98c', '2c0f:f248'];

function ip4ToInt(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  return ((+p[0] << 24) + (+p[1] << 16) + (+p[2] << 8) + (+p[3])) >>> 0;
}
function isCloudflareIp(ip) {
  if (!ip) return false;
  const s = String(ip).toLowerCase().replace(/^::ffff:/, '');
  if (s.includes(':')) return CF_V6_PREFIXES.some((pre) => s.startsWith(pre));
  const n = ip4ToInt(s);
  if (n === null) return false;
  return CF_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (ip4ToInt(base) & mask);
  });
}

// Any IP we must never flag/block: local, or our own front-end (Cloudflare).
function isSkippableIp(ip) {
  return isPrivateIp(ip) || isCloudflareIp(ip);
}

// ── Trusted-IP allowlist (admin's own IP, office, the VPS, etc.) ──
// Cached from ip_reputation.status = 'allowed' so the radar can check it
// synchronously on every request without a DB hit.
let _allow = { set: new Set(), at: 0 };
async function refreshAllowed(force) {
  if (!force && Date.now() - _allow.at < 20000) return;
  _allow.at = Date.now();
  try {
    const [rows] = await pool.query("SELECT ip FROM ip_reputation WHERE status = 'allowed'");
    _allow.set = new Set(rows.map((r) => r.ip));
  } catch (_) { /* keep last known set */ }
}
function isAllowedCached(ip) { return _allow.set.has(String(ip)); }

async function isOn() {
  return ['1', 'true', 'on', 'yes'].includes(String(await getSetting('security_enabled', 'on')).toLowerCase());
}
async function autoBlockOn() {
  return ['1', 'true', 'on', 'yes'].includes(String(await getSetting('security_auto_block', 'off')).toLowerCase());
}

// Classify one request. Returns { kind, score, detail } or null.
// opts.scanPayload=false → only path + user-agent are inspected (used for
// signed-in customers, so their chat/ticket/link content is never flagged).
function classify(req, opts) {
  const scanPayload = !opts || opts.scanPayload !== false;
  const path = String(req.originalUrl || req.url || '').slice(0, 500);
  const ua = String(req.get('user-agent') || '');

  if (!ua || ua.length < 4) return { kind: 'bad_ua', detail: 'empty/short user-agent' };
  if (BAD_UA.test(ua)) return { kind: 'bad_ua', detail: ua.slice(0, 80) };
  if (SCANNER_PATHS.some((re) => re.test(path))) return { kind: 'scanner', detail: path.slice(0, 90) };
  if (!scanPayload) return null; // trusted user — stop at path/UA signals

  let body = '';
  try { body = req.body && typeof req.body === 'object' ? JSON.stringify(req.body).slice(0, 1000) : ''; } catch (_) {}
  const hay = decodeURIComponentSafe(path) + ' ' + decodeURIComponentSafe(body);
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
async function record(ip, kind, req, detail, opts) {
  // Never record our own front-end (Cloudflare), local, or trusted/allowlisted IPs.
  if (isSkippableIp(ip)) return;
  await refreshAllowed();
  if (isAllowedCached(ip)) return;
  const authed = !!(opts && opts.authed);
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

  // Feed the coordinated-attack detector (real attack kinds only, not soft signals).
  if (!['probe404', 'flood'].includes(kind)) noteAttackForSurge(ip).catch(() => {});

  // Auto-block clear-cut attackers when enabled — but NEVER auto-block a
  // signed-in customer (a human account is not an anonymous attacker).
  if (!authed && rep.score >= env.SECURITY_AUTOBLOCK_SCORE && await autoBlockOn()) {
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

// ── Geolocation (free, https, no key; cached once per IP) ───
async function geolocate(ip, rep) {
  if (!env.SECURITY_GEO_LOOKUP) return rep || {};
  if (rep && rep.geo_done) return rep;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const geo = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country,country_code,city,connection,security`,
      { signal: controller.signal }).then((r) => r.json()).finally(() => clearTimeout(timer));
    const conn = geo && geo.connection ? geo.connection : {};
    const sec = geo && geo.security ? geo.security : {};
    const data = {
      country: geo && geo.country ? String(geo.country).slice(0, 64) : null,
      country_code: geo && geo.country_code ? String(geo.country_code).slice(0, 4) : null,
      city: geo && geo.city ? String(geo.city).slice(0, 96) : null,
      isp: conn.isp || conn.org ? String(conn.isp || conn.org).slice(0, 128) : null,
      is_proxy: sec.proxy || sec.vpn || sec.tor ? 1 : 0,
    };
    await pool.query(
      'UPDATE ip_reputation SET country = ?, country_code = ?, city = ?, isp = ?, is_proxy = ?, geo_done = 1 WHERE ip = ?',
      [data.country, data.country_code, data.city, data.isp, data.is_proxy, ip]);
    return Object.assign({}, rep, data, { geo_done: 1 });
  } catch (_) {
    await pool.query('UPDATE ip_reputation SET geo_done = 1 WHERE ip = ?', [ip]).catch(() => {});
    return rep || {};
  }
}

function flagEmoji(cc) {
  if (!cc || cc.length !== 2) return '';
  return String.fromCodePoint(...cc.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

// ── "Under attack" detection (many distinct attacker IPs, fast) ─
const attackWindow = []; // [{ ip, at }]
async function noteAttackForSurge(ip) {
  const now = Date.now();
  const winMs = env.SECURITY_UNDER_ATTACK_WINDOW_MIN * 60 * 1000;
  while (attackWindow.length && now - attackWindow[0].at > winMs) attackWindow.shift();
  attackWindow.push({ ip, at: now });
  const distinct = new Set(attackWindow.map((a) => a.ip)).size;
  if (distinct < env.SECURITY_UNDER_ATTACK_IPS) return;

  // Trip under-attack mode; alert once per window.
  const lastRaw = await getSetting('under_attack_at', '0');
  const last = Number(lastRaw) || 0;
  await setSetting('under_attack_at', String(now));
  if (now - last < winMs) return; // already alerted this window
  const events = attackWindow.length;
  await telegram.send(
    `🔴🔴 <b>WEBSITE UNDER ATTACK</b> 🔴🔴\n\n` +
    `<b>${distinct} different IPs</b> attacked in the last ${env.SECURITY_UNDER_ATTACK_WINDOW_MIN} min (${events} events).\n\n` +
    `Open <b>Admin → Security</b> to review and block them. Turn on <b>auto-block</b> to have the site ban clear-cut attackers for you.`,
  ).catch(() => {});
}

// Send a Telegram alert with action buttons + geo + threat level.
async function alert(repIn, kind, detail, autoBlocked) {
  if (!telegram.enabled) return;
  const e = telegram.esc;
  const rep = await geolocate(repIn.ip, repIn);
  const lvl = threatLevel(rep.score);
  const recent = await pool.query(
    'SELECT DISTINCT kind, path FROM security_events WHERE ip = ? ORDER BY id DESC LIMIT 5', [rep.ip]);
  const lines = recent[0].map((r) =>
    `• <b>${e(KIND_LABEL[r.kind] || r.kind)}</b>\n   <code>${e(String(r.path || '').slice(0, 52))}</code>`).join('\n') || '—';
  const loc = [rep.city, rep.country].filter(Boolean).join(', ') || 'Unknown location';
  const flag = flagEmoji(rep.country_code);
  const head = autoBlocked ? '🛑 <b>ATTACKER AUTO-BLOCKED</b>' : `${lvl.emoji} <b>${lvl.label} THREAT — action needed</b>`;
  let text =
    `${head}\n\n` +
    `<b>IP:</b> <code>${e(rep.ip)}</code>\n` +
    `<b>Location:</b> ${flag} ${e(loc)}${rep.is_proxy ? '  ⚠️ <i>VPN/Proxy</i>' : ''}\n` +
    `<b>Network:</b> ${e(String(rep.isp || 'Unknown').slice(0, 50))}\n` +
    `<b>Danger:</b> ${lvl.emoji} ${lvl.label}  (score ${rep.score})\n` +
    `<b>Device:</b> ${e(String(rep.user_agent || 'unknown').slice(0, 55))}\n\n` +
    `<b>What they did (${rep.events_count} events):</b>\n${lines}`;

  // Smart layer: let the AI analyst weigh in (best-effort; skipped if AI is off
  // or the provider is unavailable — the rule-based alert always still sends).
  try {
    const ai = require('./ai');
    if (ai.enabled) {
      const verdict = await ai.analyzeThreat({
        ip: rep.ip, location: loc, isp: rep.isp, ua: rep.user_agent, score: rep.score,
        events: recent[0].map((r) => `- ${r.kind} ${String(r.path || '').slice(0, 60)}`).join('\n'),
      });
      if (verdict) {
        const riskEmoji = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' }[verdict.risk] || '🤖';
        text += `\n\n🤖 <b>AI analyst:</b> ${riskEmoji} ${e(verdict.risk.toUpperCase())}`
          + (verdict.type ? ` · ${e(verdict.type)}` : '')
          + (verdict.reason ? `\n<i>${e(verdict.reason)}</i>` : '')
          + (verdict.action ? `\n<b>Suggests:</b> ${e(verdict.action)}` : '');
      }
    }
  } catch (_) { /* AI is optional — never block the alert */ }

  const rows = autoBlocked
    ? [[{ text: '✅ Unblock', data: `alw:${rep.ip}` }, { text: '👁 Watch', data: `wch:${rep.ip}` }],
       [{ text: 'ℹ️ Full details', data: `inf:${rep.ip}` }]]
    : [[{ text: '🚫 Block now', data: `blk:${rep.ip}` }, { text: '✅ Allow', data: `alw:${rep.ip}` }],
       [{ text: '👁 Watch', data: `wch:${rep.ip}` }, { text: 'ℹ️ Full details', data: `inf:${rep.ip}` }]];
  await telegram.sendButtons(text, rows);
}

// ── IP actions (shared by Telegram buttons + the admin page) ──
// Blocks apply both locally (the app gate) AND at the Cloudflare edge when the
// CF API is configured — so attackers are stopped before they reach the server.
async function blockIp(ip, reason, adminId) {
  // Refuse to block Cloudflare/local IPs — that would ban our own front-end.
  if (isSkippableIp(ip)) { console.warn(`[security] refused to block infrastructure IP ${ip}`); return { skipped: 'infrastructure ip' }; }
  await pool.query(
    'INSERT INTO blocked_ips (ip, reason, blocked_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE reason = VALUES(reason)',
    [ip, String(reason || 'Blocked').slice(0, 255), adminId]);
  await pool.query(
    `INSERT INTO ip_reputation (ip, status) VALUES (?, 'blocked')
     ON DUPLICATE KEY UPDATE status = 'blocked'`, [ip]);
  invalidateGate();
  const cf = require('./cloudflare');
  if (cf.configured) cf.edgeBlock(ip, reason).catch(() => {});
}

async function allowIp(ip) {
  await pool.query('DELETE FROM blocked_ips WHERE ip = ?', [ip]);
  await pool.query(
    `INSERT INTO ip_reputation (ip, status, score) VALUES (?, 'allowed', 0)
     ON DUPLICATE KEY UPDATE status = 'allowed', score = 0, alerted_at = NULL`, [ip]);
  invalidateGate();
  await refreshAllowed(true); // trusted immediately
  const cf = require('./cloudflare');
  if (cf.configured) cf.edgeUnblock(ip).catch(() => {});
}

// Remove an IP from the trusted allowlist (back to normal monitoring).
async function untrustIp(ip) {
  await pool.query("DELETE FROM ip_reputation WHERE ip = ? AND status = 'allowed'", [ip]);
  await refreshAllowed(true);
}

// The IPs currently on the trusted allowlist (for the admin panel).
async function listAllowed() {
  const [rows] = await pool.query(
    "SELECT ip, last_seen FROM ip_reputation WHERE status = 'allowed' ORDER BY last_seen DESC LIMIT 100");
  return rows;
}

async function watchIp(ip) {
  await pool.query(
    `INSERT INTO ip_reputation (ip, status) VALUES (?, 'watch')
     ON DUPLICATE KEY UPDATE status = 'watch'`, [ip]);
}

async function ipDetails(ip) {
  let [[rep]] = await pool.query('SELECT * FROM ip_reputation WHERE ip = ?', [ip]);
  if (rep && !rep.geo_done) rep = await geolocate(ip, rep);
  const [events] = await pool.query(
    'SELECT kind, method, path, detail, created_at FROM security_events WHERE ip = ? ORDER BY id DESC LIMIT 10', [ip]);
  const [[blocked]] = await pool.query('SELECT id FROM blocked_ips WHERE ip = ?', [ip]);
  return { rep, events, blocked: !!blocked };
}

// Housekeeping: drop old events + stale reputation so the tables stay small.
async function purgeOld() {
  const days = Math.max(1, env.SECURITY_EVENT_RETENTION_DAYS);
  try {
    await pool.query('DELETE FROM security_events WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)', [days]);
    // Forget flagged (non-blocked, non-allowed) IPs we haven't seen in a while.
    await pool.query(
      `DELETE FROM ip_reputation WHERE (status IS NULL OR status = 'watch')
         AND last_seen < DATE_SUB(NOW(), INTERVAL ? DAY)`, [days]);
    await cleanInfraIps();
  } catch (err) { console.warn('[security] purge failed:', err.message); }
}

// Remove any Cloudflare/local IPs that an older version wrongly recorded or
// blocked — so past mistakes clear themselves after upgrading.
async function cleanInfraIps() {
  try {
    const [reps] = await pool.query('SELECT ip FROM ip_reputation');
    const bad = reps.map((r) => r.ip).filter(isSkippableIp);
    for (const ip of bad) {
      await pool.query('DELETE FROM ip_reputation WHERE ip = ?', [ip]);
      await pool.query('DELETE FROM security_events WHERE ip = ?', [ip]);
    }
    const [blk] = await pool.query('SELECT ip FROM blocked_ips');
    const badBlk = blk.map((r) => r.ip).filter(isSkippableIp);
    for (const ip of badBlk) await pool.query('DELETE FROM blocked_ips WHERE ip = ?', [ip]);
    if (bad.length || badBlk.length) {
      console.log(`[security] cleaned ${bad.length} flagged + ${badBlk.length} blocked infrastructure IP(s)`);
      require('../middleware/gate').invalidate();
    }
  } catch (err) { console.warn('[security] cleanInfraIps failed:', err.message); }
}

// Is the site currently under a coordinated attack? (for the admin banner)
async function underAttack() {
  const at = Number(await getSetting('under_attack_at', '0')) || 0;
  const winMs = env.SECURITY_UNDER_ATTACK_WINDOW_MIN * 60 * 1000;
  return at > 0 && (Date.now() - at) < Math.max(winMs, 10 * 60 * 1000);
}

module.exports = {
  classify, record, noteRequest, isPrivateIp, isCloudflareIp, isSkippableIp, isOn,
  blockIp, allowIp, untrustIp, listAllowed, refreshAllowed, isAllowedCached,
  watchIp, ipDetails, underAttack, purgeOld, cleanInfraIps,
  threatLevel, geolocate, flagEmoji, KIND_LABEL,
};
