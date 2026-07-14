'use strict';
const env = require('../config/env');
const SmmClient = require('./smmClient');

const clients = {};

if (env.RKD_API_KEY && env.RKD_API_URL) {
  clients.rkd = new SmmClient({ code: 'rkd', name: 'RKD Panel', url: env.RKD_API_URL, key: env.RKD_API_KEY });
}
if (env.SMMWORLD_API_KEY && env.SMMWORLD_API_URL) {
  clients.smmworld = new SmmClient({ code: 'smmworld', name: 'SMM World', url: env.SMMWORLD_API_URL, key: env.SMMWORLD_API_KEY });
}

function getClient(code) {
  return clients[code] || null;
}

function allClients() {
  return Object.values(clients);
}

// Make sure a row exists in `providers` for every configured client; returns code -> id map.
async function ensureProviderRows(pool) {
  const map = {};
  for (const client of allClients()) {
    await pool.query(
      'INSERT INTO providers (code, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)',
      [client.code, client.name]
    );
  }
  const [rows] = await pool.query('SELECT id, code FROM providers');
  for (const row of rows) map[row.code] = row.id;
  return map;
}

module.exports = { getClient, allClients, ensureProviderRows };
