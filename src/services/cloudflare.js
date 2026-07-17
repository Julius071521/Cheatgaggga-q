'use strict';
// Cloudflare integration — block/unblock IPs at the edge (IP Access Rules) and
// read what Cloudflare's WAF is blocking (firewall events). All calls are
// best-effort: if the token is missing or the API errors, the app keeps working
// on its own blocklist. Configure with CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID.
const env = require('../config/env');

const API = 'https://api.cloudflare.com/client/v4';
const configured = Boolean(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ZONE_ID);

function cf(pathOrUrl, method, body) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API}${pathOrUrl}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  return fetch(url, {
    method: method || 'GET',
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: controller.signal,
  })
    .then((r) => r.json())
    .catch((err) => ({ success: false, errors: [{ message: err.message }] }))
    .finally(() => clearTimeout(timer));
}

// Verify the token/zone work (used by the setup check).
async function verify() {
  if (!configured) return { ok: false, reason: 'not configured' };
  const r = await cf(`/zones/${env.CLOUDFLARE_ZONE_ID}`);
  if (r && r.success) return { ok: true, name: r.result && r.result.name };
  return { ok: false, reason: (r.errors && r.errors[0] && r.errors[0].message) || 'unknown error' };
}

// Block an IP at the Cloudflare edge (zone-level IP Access Rule).
async function edgeBlock(ip, note) {
  if (!configured) return { ok: false, reason: 'not configured' };
  const r = await cf(`/zones/${env.CLOUDFLARE_ZONE_ID}/firewall/access_rules/rules`, 'POST', {
    mode: 'block',
    configuration: { target: 'ip', value: ip },
    notes: String(note || 'ApexBoost Threat Radar').slice(0, 200),
  });
  // "already exists" is fine — treat as success.
  if (r && r.success) return { ok: true };
  const msg = (r.errors && r.errors[0] && r.errors[0].message) || '';
  if (/already exists|duplicate/i.test(msg)) return { ok: true, already: true };
  return { ok: false, reason: msg || 'block failed' };
}

async function findRuleId(ip) {
  const r = await cf(`/zones/${env.CLOUDFLARE_ZONE_ID}/firewall/access_rules/rules?configuration.target=ip&configuration.value=${encodeURIComponent(ip)}`);
  if (r && r.success && r.result && r.result[0]) return r.result[0].id;
  return null;
}

async function edgeUnblock(ip) {
  if (!configured) return { ok: false, reason: 'not configured' };
  const id = await findRuleId(ip);
  if (!id) return { ok: true, already: true };
  const r = await cf(`/zones/${env.CLOUDFLARE_ZONE_ID}/firewall/access_rules/rules/${id}`, 'DELETE');
  return r && r.success ? { ok: true } : { ok: false, reason: 'unblock failed' };
}

// List the IPs currently blocked at the edge (for the admin panel).
async function listBlocked(limit = 50) {
  if (!configured) return [];
  const r = await cf(`/zones/${env.CLOUDFLARE_ZONE_ID}/firewall/access_rules/rules?mode=block&per_page=${limit}`);
  if (!r || !r.success || !Array.isArray(r.result)) return [];
  return r.result
    .filter((x) => x.configuration && x.configuration.target === 'ip')
    .map((x) => ({ ip: x.configuration.value, notes: x.notes || '', created_on: x.created_on }));
}

// What Cloudflare's WAF blocked recently (GraphQL firewall events).
// The free plan rejects a window of 1 day or wider, so cap under 24h.
async function recentThreats(hours = 23, limit = 20) {
  if (!configured) return [];
  const capped = Math.min(Math.max(1, hours), 23);
  const since = new Date(Date.now() - (capped * 3600 - 300) * 1000).toISOString();
  const query = `query($zone:String!,$since:Time!,$limit:Int!){
    viewer{ zones(filter:{zoneTag:$zone}){
      firewallEventsAdaptive(limit:$limit, filter:{ datetime_geq:$since, action:"block" }, orderBy:[datetime_DESC]){
        datetime action clientIP clientCountryName clientRequestPath clientRequestHTTPHost source ruleId
      } } } }`;
  const r = await cf('/graphql', 'POST', { query, variables: { zone: env.CLOUDFLARE_ZONE_ID, since, limit } });
  try {
    const events = r.data.viewer.zones[0].firewallEventsAdaptive;
    return Array.isArray(events) ? events : [];
  } catch (_) { return []; }
}

module.exports = { configured, verify, edgeBlock, edgeUnblock, listBlocked, recentThreats };
