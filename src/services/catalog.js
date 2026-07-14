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

  let imported = 0;
  const seenIds = [];

  for (const svc of list) {
    if (!svc || svc.service === undefined || svc.rate === undefined) continue;
    if (code === 'smmworld' && !smmworldFilter(svc)) continue;

    const rate = Number(svc.rate);
    if (Number.isNaN(rate) || rate < 0) continue;

    const providerServiceId = String(svc.service);
    const name = String(svc.name || 'Unnamed service').slice(0, 255);
    const category = String(svc.category || '').slice(0, 190);
    const platform = detectPlatform(category, name);
    const min = Math.max(1, parseInt(svc.min, 10) || 1);
    const max = Math.max(min, parseInt(svc.max, 10) || min);

    await pool.query(
      `INSERT INTO services
         (provider_id, provider_service_id, platform, category, name, type, rate_usd,
          min_qty, max_qty, refill, cancelable, dripfeed, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE
         platform = VALUES(platform), category = VALUES(category), name = VALUES(name),
         type = VALUES(type), rate_usd = VALUES(rate_usd), min_qty = VALUES(min_qty),
         max_qty = VALUES(max_qty), refill = VALUES(refill), cancelable = VALUES(cancelable),
         dripfeed = VALUES(dripfeed), deleted = 0`,
      [
        providerId, providerServiceId, platform, category, name,
        String(svc.type || 'Default').slice(0, 64), rate.toFixed(6),
        min, max,
        svc.refill === true || svc.refill === 'true' ? 1 : 0,
        svc.cancel === true || svc.cancel === 'true' ? 1 : 0,
        svc.dripfeed === true || svc.dripfeed === 'true' ? 1 : 0,
      ]
    );
    imported += 1;
    seenIds.push(providerServiceId);
  }

  // Anything the provider no longer offers gets soft-deleted (kept for order history).
  if (seenIds.length) {
    await pool.query(
      `UPDATE services SET deleted = 1
       WHERE provider_id = ? AND provider_service_id NOT IN (${seenIds.map(() => '?').join(',')})`,
      [providerId, ...seenIds]
    );
  }

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

module.exports = { syncProvider, detectPlatform };
