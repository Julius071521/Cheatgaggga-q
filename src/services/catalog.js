'use strict';
const env = require('../config/env');
const pool = require('../db/pool');
const { getClient, ensureProviderRows } = require('../providers');

const PLATFORM_KEYWORDS = [
  ['instagram', ['instagram', ' ig ', 'insta ']],
  ['tiktok', ['tiktok', 'tik tok', 'tik-tok']],
  ['facebook', ['facebook', ' fb ', 'fb page', 'fb post']],
  ['youtube', ['youtube', ' yt ', 'you tube']],
  ['twitter', ['twitter', 'x.com', ' x |', '(x)']],
  ['telegram', ['telegram']],
  ['spotify', ['spotify']],
  ['snapchat', ['snapchat']],
  ['twitch', ['twitch']],
  ['discord', ['discord']],
  ['linkedin', ['linkedin']],
  ['website', ['website traffic', 'web traffic', 'traffic', 'seo ', 'google review']],
];

function detectPlatform(category, name) {
  const haystack = ` ${String(category)} ${String(name)} `.toLowerCase();
  for (const [platform, keywords] of PLATFORM_KEYWORDS) {
    if (keywords.some((k) => haystack.includes(k))) return platform;
  }
  return 'other';
}

// ── Provider-brand privacy ──────────────────────────────────
// Upstream service names/categories often contain panel brand names — our own
// providers ("RKDpanel Official", "SMMWorld…") AND other panels they resell
// ("GAG Universal Hub - …"). Customers must never see any of those, so every
// imported name/category is scrubbed. Our-provider-branded PRODUCTS (child
// panels etc.) are additionally imported disabled. Extra words to hide can be
// added anytime via env BRAND_HIDE_WORDS (comma-separated, no code change).
const OUR_BRANDS = ['rkd panel', 'rkdpanel', 'rdk panel', 'rkd', 'rdk', 'smm world', 'smmworld'];
const THIRD_PARTY_BRANDS = ['gag universal hub', 'universal hub', 'gag'];

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function phraseRe(phrases) {
  // Each phrase matches with flexible whitespace between words, word-bounded.
  const parts = phrases.map((p) => `\\b${p.trim().split(/\s+/).map(escRe).join('\\s*')}\\b`);
  return new RegExp(parts.join('|'), 'gi');
}
function extraWords() {
  return String(env.BRAND_HIDE_WORDS || '').split(',').map((s) => s.trim()).filter((s) => s.length >= 3);
}
const OUR_RE = phraseRe(OUR_BRANDS);
function allBrandRe() { return phraseRe([...OUR_BRANDS, ...THIRD_PARTY_BRANDS, ...extraWords()]); }

function scrubBrands(text) {
  return String(text || '')
    .replace(allBrandRe(), '')
    .replace(/\(\s*(official)?\s*\)/gi, '')   // leftover "( Official )" / "()"
    .replace(/^[?\s]+/, '')                    // mojibake "?? " left by lost emojis
    .replace(/^\s*[|\-–—/·:]+\s*/, '')         // leftover leading separators
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isProviderBranded(name, category) {
  const hay = `${name || ''} ${category || ''}`;
  OUR_RE.lastIndex = 0;
  const branded = OUR_RE.test(String(name || ''));
  return branded || /child\s*panel/i.test(hay);
}

// One-time cleanup for rows imported before scrubbing existed (safe to re-run).
async function scrubExistingBrands() {
  const words = [...OUR_BRANDS, ...THIRD_PARTY_BRANDS, ...extraWords()];
  const like = words.map((w) => {
    const v = pool.escape(`%${w}%`);
    return `name LIKE ${v} OR category LIKE ${v}`;
  }).join(' OR ');
  const [rows] = await pool.query(`SELECT id, name, category, enabled FROM services WHERE ${like}`);
  let changed = 0;
  for (const s of rows) {
    const branded = isProviderBranded(s.name, s.category);
    const newName = scrubBrands(s.name) || 'Boosting service';
    const newCat = scrubBrands(s.category) || 'General';
    if (newName === s.name && newCat === s.category && !branded) continue; // e.g. "Engagements" false-match
    await pool.query(
      `UPDATE services SET name = ?, category = ?${branded ? ', enabled = 0' : ''} WHERE id = ?`,
      [newName, newCat, s.id]);
    changed += 1;
  }
  // Order history copies the service name — scrub any old branded copies too.
  const ordLike = words.map((w) => `service_name LIKE ${pool.escape(`%${w}%`)}`).join(' OR ');
  const [ords] = await pool.query(`SELECT id, service_name FROM orders WHERE ${ordLike}`);
  let ordChanged = 0;
  for (const o of ords) {
    const clean = (scrubBrands(o.service_name) || 'Boosting service').slice(0, 255);
    if (clean === o.service_name) continue; // false-match (e.g. "Engagements")
    await pool.query('UPDATE orders SET service_name = ? WHERE id = ?', [clean, o.id]);
    ordChanged += 1;
  }
  if (changed || ordChanged) console.log(`[catalog] privacy scrub: cleaned ${changed} service row(s), ${ordChanged} order row(s)`);
  return changed + ordChanged;
}

function smmworldFilter(service) {
  const ids = env.SMMWORLD_IMPORT_SERVICE_IDS;
  const keywords = env.SMMWORLD_IMPORT_KEYWORDS;
  if (ids.length === 0 && keywords.length === 0) return true;
  if (ids.length && ids.includes(String(service.service))) return true;
  if (keywords.length) {
    const haystack = `${service.category || ''} ${service.name || ''}`.toLowerCase();
    if (keywords.some((k) => haystack.includes(k.toLowerCase()))) return true;
  }
  return false;
}

// Sync one provider's catalog into the local `services` table.
async function syncProvider(code) {
  const client = getClient(code);
  if (!client) throw new Error(`Provider "${code}" is not configured (missing API key/URL in .env)`);

  const providerIds = await ensureProviderRows(pool);
  const providerId = providerIds[code];
  const list = await client.services();
  if (!Array.isArray(list)) throw new Error(`Provider "${code}" returned an unexpected services payload`);

  // Count enabled/visible services before, to detect genuinely new ones after.
  const [[before]] = await pool.query('SELECT COUNT(*) AS c FROM services WHERE provider_id = ? AND deleted = 0', [providerId]);

  let imported = 0;
  let skipped = 0;
  const seenIds = [];

  for (const svc of list) {
    if (!svc || svc.service === undefined || svc.rate === undefined) continue;
    if (code === 'smmworld' && !smmworldFilter(svc)) continue;

    const rate = Number(svc.rate);
    if (Number.isNaN(rate) || rate < 0) continue;

    const providerServiceId = String(svc.service);
    const rawName = String(svc.name || 'Unnamed service').slice(0, 255);
    const rawCategory = String(svc.category || '').slice(0, 190);
    // Privacy: never let the provider's brand reach the public catalog.
    const branded = isProviderBranded(rawName, rawCategory);
    const name = (scrubBrands(rawName) || 'Boosting service').slice(0, 255);
    const category = (scrubBrands(rawCategory) || 'General').slice(0, 190);
    const platform = detectPlatform(category, name);
    // Clamp quantities to a safe BIGINT range (guards against absurd/overflow values).
    const CAP = 100000000000; // 100 billion
    const min = Math.min(CAP, Math.max(1, parseInt(svc.min, 10) || 1));
    const max = Math.min(CAP, Math.max(min, parseInt(svc.max, 10) || min));

    // One bad row must never abort the whole sync — skip it and keep going.
    try {
      await pool.query(
        `INSERT INTO services
           (provider_id, provider_service_id, platform, category, name, type, rate_usd,
            min_qty, max_qty, refill, cancelable, dripfeed, deleted, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON DUPLICATE KEY UPDATE
           platform = VALUES(platform), category = VALUES(category), name = VALUES(name),
           type = VALUES(type), rate_usd = VALUES(rate_usd), min_qty = VALUES(min_qty),
           max_qty = VALUES(max_qty), refill = VALUES(refill), cancelable = VALUES(cancelable),
           dripfeed = VALUES(dripfeed), deleted = 0,
           enabled = IF(VALUES(enabled) = 0, 0, enabled)`, // branded stays hidden; owner's toggles survive re-sync
        [
          providerId, providerServiceId, platform, category, name,
          String(svc.type || 'Default').slice(0, 64), rate.toFixed(6),
          min, max,
          svc.refill === true || svc.refill === 'true' ? 1 : 0,
          svc.cancel === true || svc.cancel === 'true' ? 1 : 0,
          svc.dripfeed === true || svc.dripfeed === 'true' ? 1 : 0,
          branded ? 0 : 1,
        ]
      );
      imported += 1;
      seenIds.push(providerServiceId);
    } catch (err) {
      skipped += 1;
      if (skipped <= 5) console.warn(`[catalog] skipped ${code} service ${providerServiceId}: ${err.message}`);
    }
  }
  if (skipped) console.warn(`[catalog] ${code}: skipped ${skipped} problematic service(s)`);

  // Anything the provider no longer offers gets soft-deleted (kept for order history).
  if (seenIds.length) {
    await pool.query(
      `UPDATE services SET deleted = 1
       WHERE provider_id = ? AND provider_service_id NOT IN (${seenIds.map(() => '?').join(',')})`,
      [providerId, ...seenIds]
    );
  }

  // Announce newly added services to all members (no provider identity exposed).
  try {
    const [[after]] = await pool.query('SELECT COUNT(*) AS c FROM services WHERE provider_id = ? AND deleted = 0', [providerId]);
    const added = Number(after.c) - Number(before.c);
    if (added > 0) {
      const notifications = require('./notifications');
      await notifications.postUpdate('service', `${added} new service${added > 1 ? 's' : ''} added ✨`,
        'Fresh boosting services are now available. Check them out!', '/services');
    }
  } catch (_) { /* non-fatal */ }

  // Refresh the provider's upstream balance while we're here (best effort).
  try {
    const bal = await client.balance();
    if (bal && bal.balance !== undefined) {
      await pool.query('UPDATE providers SET balance_usd = ?, currency = ?, synced_at = NOW() WHERE id = ?', [
        Number(bal.balance).toFixed(4), String(bal.currency || 'USD').slice(0, 8), providerId,
      ]);
    }
  } catch (err) {
    console.warn(`[catalog] Could not fetch ${code} balance: ${err.message}`);
    await pool.query('UPDATE providers SET synced_at = NOW() WHERE id = ?', [providerId]);
  }

  return { provider: code, imported, totalFromProvider: list.length };
}

// Un-sync: hide every service from a provider (soft-delete). Order history is
// kept intact, and a later syncProvider() brings them all back (deleted = 0).
// This is the reverse of syncProvider — nothing is permanently destroyed.
async function unsyncProvider(code) {
  const providerIds = await ensureProviderRows(pool);
  const providerId = providerIds[code];
  if (!providerId) throw new Error(`Unknown provider "${code}"`);
  const [r] = await pool.query('UPDATE services SET deleted = 1 WHERE provider_id = ? AND deleted = 0', [providerId]);
  return { provider: code, removed: r.affectedRows };
}

module.exports = { syncProvider, unsyncProvider, detectPlatform, scrubBrands, scrubExistingBrands };
