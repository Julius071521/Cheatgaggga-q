'use strict';
const pool = require('../db/pool');

let cache = null;
let cachedAt = 0;
const TTL_MS = 60 * 1000;

async function siteStats() {
  const now = Date.now();
  if (cache && now - cachedAt < TTL_MS) return cache;
  try {
    const [[row]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM orders) AS orders,
        (SELECT COUNT(*) FROM orders WHERE status = 'Completed') AS completed,
        (SELECT COUNT(*) FROM services WHERE enabled = 1 AND deleted = 0) AS services
    `);
    cache = {
      users: Number(row.users), orders: Number(row.orders),
      completed: Number(row.completed), services: Number(row.services),
    };
    cachedAt = now;
  } catch (err) {
    console.warn('[stats] Could not load site stats:', err.message);
    cache = cache || { users: 0, orders: 0, completed: 0, services: 0 };
  }
  return cache;
}

// Cheapest enabled service per platform, for the landing showcase.
let showcaseCache = null;
let showcaseAt = 0;

async function popularServices() {
  const now = Date.now();
  if (showcaseCache && now - showcaseAt < TTL_MS * 5) return showcaseCache;
  try {
    const [rows] = await pool.query(`
      SELECT s.* FROM services s
      JOIN (
        SELECT platform, MIN(rate_usd) AS min_rate
        FROM services WHERE enabled = 1 AND deleted = 0 AND rate_usd > 0
          AND platform IN ('instagram','tiktok','facebook','youtube','twitter','telegram','spotify','snapchat')
        GROUP BY platform
      ) m ON m.platform = s.platform AND m.min_rate = s.rate_usd
      WHERE s.enabled = 1 AND s.deleted = 0
      GROUP BY s.platform
      ORDER BY FIELD(s.platform,'instagram','tiktok','facebook','youtube','twitter','telegram','spotify','snapchat')
    `);
    showcaseCache = rows;
    showcaseAt = now;
  } catch (err) {
    console.warn('[stats] Could not load showcase services:', err.message);
    showcaseCache = showcaseCache || [];
  }
  return showcaseCache;
}

async function getSetting(key, fallback = '') {
  try {
    const [[row]] = await pool.query('SELECT v FROM settings WHERE k = ?', [key]);
    return row ? row.v : fallback;
  } catch (_) {
    return fallback;
  }
}

async function setSetting(key, value) {
  await pool.query('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [key, String(value)]);
}

module.exports = { siteStats, popularServices, getSetting, setSetting };
