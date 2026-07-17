'use strict';
// Per-request attacker/scanner detection. Cheap synchronous classification;
// all DB writes + alerts happen fire-and-forget so responses are never delayed.
const security = require('../services/security');

let onCache = { value: true, at: 0 };
async function enabled() {
  if (Date.now() - onCache.at > 30000) {
    onCache = { value: await security.isOn().catch(() => true), at: Date.now() };
  }
  return onCache.value;
}

const SKIP = /^\/(assets|telegram|favicon\.ico|robots\.txt)/;

function threatRadar(req, res, next) {
  const ip = req.clientIp || req.ip;
  // Skip assets/webhooks, local IPs, and our own Cloudflare front-end. If the
  // resolved IP is still a Cloudflare edge IP, CF-Connecting-IP wasn't present
  // — analysing it would just flag Cloudflare, so we skip it entirely.
  if (SKIP.test(req.path) || security.isSkippableIp(ip)) return next();

  enabled().then((on) => {
    if (!on) return;
    // For signed-in customers, only trust unambiguous signals (scanner paths,
    // hacking-tool user-agents) — never scan their request bodies/queries, so a
    // customer typing "union select" or "<script>" in chat/tickets is never
    // flagged. Anonymous visitors get the full payload inspection.
    const authed = !!req.user;
    const hit = security.classify(req, { scanPayload: !authed });
    if (hit) security.record(ip, hit.kind, req, hit.detail, { authed }).catch(() => {});
    res.on('finish', () => { security.noteRequest(ip, req, res.statusCode).catch(() => {}); });
  }).catch(() => {});

  next();
}

module.exports = threatRadar;
