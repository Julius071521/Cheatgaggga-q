'use strict';
// Network Guard — decides whether a visitor is on a normal home/mobile
// connection or behind a VPN, proxy, Tor exit or a rented server (VPS).
//
// Three rules govern everything here:
//   1. It fails OPEN. A lookup that errors, times out or returns nothing means
//      "allow". A fraud filter must never be the reason the site goes down.
//   2. It never blocks the request path on a network call. The shipped range
//      list answers instantly; anything unknown is allowed and looked up in the
//      background, so the decision is ready the next time that IP appears.
//   3. Admins, trusted IPs and the site's own infrastructure are never touched.
const pool = require('../db/pool');
const env = require('../config/env');
const RANGES = require('./data/datacenterRanges');

const KIND_LABEL = {
  hosting: 'Datacenter / VPS',
  vpn: 'VPN',
  proxy: 'Proxy',
  tor: 'Tor exit node',
  residential: 'Home / mobile',
  unknown: 'Unknown',
};

// ── CIDR matching ───────────────────────────────────────────────────────────
function ip4ToInt(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

// Compiled once at boot: [startInt, endInt, org], sorted so a match is a
// binary search rather than a walk over every range on every request.
const TABLE = RANGES.map(([cidr, org]) => {
  const [base, bitsRaw] = cidr.split('/');
  const start = ip4ToInt(base);
  const bits = Number(bitsRaw);
  if (start === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const size = 2 ** (32 - bits);
  return [start, start + size - 1, org];
}).filter(Boolean).sort((a, b) => a[0] - b[0]);

function matchRange(ip) {
  const n = ip4ToInt(ip);
  if (n === null) return null;
  let lo = 0; let hi = TABLE.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e, org] = TABLE[mid];
    if (n < s) hi = mid - 1;
    else if (n > e) lo = mid + 1;
    else return org;
  }
  return null;
}

// ── Cache ───────────────────────────────────────────────────────────────────
// Small in-process cache in front of the DB so a burst from one visitor is a
// single query. Bounded, because an attacker can otherwise grow it forever.
const MEM_MAX = 5000;
const mem = new Map();
function memGet(ip) {
  const hit = mem.get(ip);
  if (!hit) return null;
  if (Date.now() > hit.expires) { mem.delete(ip); return null; }
  return hit.value;
}
function memSet(ip, value) {
  if (mem.size >= MEM_MAX) mem.delete(mem.keys().next().value);
  mem.set(ip, { value, expires: Date.now() + 10 * 60 * 1000 });
}

function verdictFrom(row) {
  return {
    ip: row.ip,
    kind: row.kind || 'unknown',
    label: KIND_LABEL[row.kind] || 'Unknown',
    org: row.org || null,
    countryCode: row.country_code || null,
    isHosting: !!row.is_hosting,
    isVpn: !!row.is_vpn,
    isProxy: !!row.is_proxy,
    isTor: !!row.is_tor,
    source: row.source || 'remote',
  };
}

async function cached(ip) {
  const m = memGet(ip);
  if (m) return m;
  try {
    const [[row]] = await pool.query(
      `SELECT * FROM ip_intel
        WHERE ip = ?
          AND (source = 'manual' OR checked_at > (NOW() - INTERVAL ? DAY))`,
      [ip, env.NETGUARD_CACHE_DAYS]);
    if (!row) return null;
    const v = verdictFrom(row);
    memSet(ip, v);
    return v;
  } catch (_) { return null; }
}

async function store(v) {
  try {
    await pool.query(
      `INSERT INTO ip_intel (ip, kind, org, asn, country_code, is_hosting, is_vpn, is_proxy, is_tor, source, checked_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         -- An admin's decision outranks anything a later lookup reports, and
         -- only another admin decision can replace it. NOTE: MySQL evaluates
         -- these assignments in order and later ones see already-updated
         -- columns, so \`source\` — which every other test reads — must be
         -- assigned LAST.
         kind = IF(source = 'manual' AND VALUES(source) <> 'manual', kind, VALUES(kind)),
         org = IF(source = 'manual' AND VALUES(source) <> 'manual', org, VALUES(org)),
         asn = IF(source = 'manual' AND VALUES(source) <> 'manual', asn, VALUES(asn)),
         country_code = IF(source = 'manual' AND VALUES(source) <> 'manual', country_code, VALUES(country_code)),
         is_hosting = IF(source = 'manual' AND VALUES(source) <> 'manual', is_hosting, VALUES(is_hosting)),
         is_vpn = IF(source = 'manual' AND VALUES(source) <> 'manual', is_vpn, VALUES(is_vpn)),
         is_proxy = IF(source = 'manual' AND VALUES(source) <> 'manual', is_proxy, VALUES(is_proxy)),
         is_tor = IF(source = 'manual' AND VALUES(source) <> 'manual', is_tor, VALUES(is_tor)),
         checked_at = IF(source = 'manual' AND VALUES(source) <> 'manual', checked_at, NOW()),
         source = IF(source = 'manual' AND VALUES(source) <> 'manual', source, VALUES(source))`,
      [v.ip, v.kind, v.org, v.asn || null, v.countryCode, v.isHosting ? 1 : 0,
        v.isVpn ? 1 : 0, v.isProxy ? 1 : 0, v.isTor ? 1 : 0, v.source]);
  } catch (_) { /* cache write failures must not affect the request */ }
  memSet(v.ip, v);
}

// ── Intelligence API ────────────────────────────────────────────────────────
// ipwho.is is free and needs no key. Its `security` block reports proxy / vpn /
// tor / hosting. Any failure returns null, which the caller reads as "allow".
const inFlight = new Map();
async function remote(ip) {
  if (!env.NETGUARD_LOOKUP) return null;
  if (inFlight.has(ip)) return inFlight.get(ip);
  const p = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), env.NETGUARD_TIMEOUT_MS);
      const r = await fetch(
        `https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country_code,connection,security`,
        { signal: controller.signal }).then((x) => x.json()).finally(() => clearTimeout(timer));
      if (!r || r.success === false) return null;
      const conn = r.connection || {};
      const sec = r.security || {};
      const isTor = !!sec.tor;
      const isVpn = !!sec.vpn;
      const isProxy = !!(sec.proxy || sec.anonymous);
      const isHosting = !!sec.hosting;
      let kind = 'residential';
      if (isTor) kind = 'tor';
      else if (isVpn) kind = 'vpn';
      else if (isProxy) kind = 'proxy';
      else if (isHosting) kind = 'hosting';
      const v = {
        ip,
        kind,
        label: KIND_LABEL[kind],
        org: conn.isp || conn.org || null,
        asn: conn.asn ? String(conn.asn).slice(0, 24) : null,
        countryCode: r.country_code ? String(r.country_code).slice(0, 4) : null,
        isHosting, isVpn, isProxy, isTor,
        source: 'remote',
      };
      await store(v);
      return v;
    } catch (_) {
      return null;
    } finally {
      inFlight.delete(ip);
    }
  })();
  inFlight.set(ip, p);
  return p;
}

// ── Public API ──────────────────────────────────────────────────────────────
// Answers immediately. `null` means "nothing known yet" — always treated as
// allow — and schedules a background lookup so the next visit is decided.
async function classify(ip) {
  if (!ip) return null;
  const hit = await cached(ip);
  if (hit) return hit;

  const org = matchRange(ip);
  if (org) {
    const v = {
      ip, kind: 'hosting', label: KIND_LABEL.hosting, org, asn: null, countryCode: null,
      isHosting: true, isVpn: false, isProxy: false, isTor: false, source: 'local',
    };
    store(v).catch(() => {});
    return v;
  }

  remote(ip).catch(() => {});
  return null;
}

// Same answer, but waits for the lookup (bounded) instead of deferring it. Used
// where one wrong decision is expensive — signup, deposit, placing an order.
async function classifyNow(ip) {
  if (!ip) return null;
  const quick = await classify(ip);
  if (quick) return quick;
  try {
    return await Promise.race([
      remote(ip),
      new Promise((resolve) => setTimeout(() => resolve(null), env.NETGUARD_TIMEOUT_MS + 200)),
    ]);
  } catch (_) { return null; }
}

// Which kinds the operator currently wants stopped.
function shouldStop(verdict, toggles) {
  if (!verdict) return null;
  if (verdict.source === 'manual' && verdict.kind === 'residential') return null;
  if (verdict.isTor && toggles.tor) return 'tor';
  if (verdict.isVpn && toggles.vpn) return 'vpn';
  if (verdict.isProxy && toggles.proxy) return 'proxy';
  if (verdict.isHosting && toggles.hosting) return 'hosting';
  return null;
}

async function noteHit(ip, blocked) {
  try {
    await pool.query(
      'UPDATE ip_intel SET hits = hits + 1, blocked_hits = blocked_hits + ?, last_seen = NOW() WHERE ip = ?',
      [blocked ? 1 : 0, ip]);
  } catch (_) { /* stats only */ }
}

// Admin override: mark an IP as a normal connection so it is never stopped.
async function markResidential(ip) {
  await store({
    ip, kind: 'residential', org: 'Cleared by admin', asn: null, countryCode: null,
    isHosting: false, isVpn: false, isProxy: false, isTor: false, source: 'manual',
  });
  mem.delete(ip);
  memSet(ip, verdictFrom({
    ip, kind: 'residential', org: 'Cleared by admin', source: 'manual',
    is_hosting: 0, is_vpn: 0, is_proxy: 0, is_tor: 0,
  }));
}

async function recent(limit = 60) {
  const [rows] = await pool.query(
    `SELECT * FROM ip_intel
      WHERE kind <> 'residential' AND last_seen IS NOT NULL
      ORDER BY last_seen DESC LIMIT ?`, [Number(limit) || 60]);
  return rows.map((r) => Object.assign(verdictFrom(r), {
    hits: r.hits, blockedHits: r.blocked_hits, lastSeen: r.last_seen,
  }));
}

async function stats() {
  try {
    const [[row]] = await pool.query(
      `SELECT
         SUM(kind = 'hosting') AS hosting,
         SUM(kind = 'vpn') AS vpn,
         SUM(kind = 'proxy') AS proxy,
         SUM(kind = 'tor') AS tor,
         SUM(kind = 'residential') AS residential,
         SUM(blocked_hits) AS blocked_hits
       FROM ip_intel`);
    return {
      hosting: Number(row.hosting || 0),
      vpn: Number(row.vpn || 0),
      proxy: Number(row.proxy || 0),
      tor: Number(row.tor || 0),
      residential: Number(row.residential || 0),
      blockedHits: Number(row.blocked_hits || 0),
    };
  } catch (_) {
    return { hosting: 0, vpn: 0, proxy: 0, tor: 0, residential: 0, blockedHits: 0 };
  }
}

module.exports = {
  classify, classifyNow, shouldStop, noteHit, markResidential, recent, stats,
  matchRange, KIND_LABEL, rangeCount: TABLE.length,
};
