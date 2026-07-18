'use strict';
// Per-request attacker/scanner detection. Cheap synchronous classification;
// all DB writes + alerts happen fire-and-forget so responses are never delayed.
const security = require('../services/security');

let onCache = { value: true, at: 0 };
async function radarOn() {
  if (Date.now() - onCache.at > 30000) {
    onCache = { value: await security.isOn().catch(() => true), at: Date.now() };
  }
  await security.refreshAllowed(); // keep the trusted-IP allowlist warm
  return onCache.value;
}

const SKIP = /^\/(assets|telegram|favicon\.ico|robots\.txt)/;

function threatRadar(req, res, next) {
  const ip = req.clientIp || req.ip;
  // Never analyse assets/webhooks, local IPs, or our own Cloudflare front-end.
  if (SKIP.test(req.path) || security.isSkippableIp(ip)) return next();

  radarOn().then((on) => {
    if (!on) return;
    // Signed-in admins and explicitly trusted IPs are never flagged/blocked.
    const trusted = (req.user && req.user.isAdmin) || security.isAllowedCached(ip);
    if (trusted) return;

    const authed = !!req.user;
    const hit = security.classify(req, { scanPayload: !authed });
    if (hit) security.record(ip, hit.kind, req, hit.detail, { authed }).catch(() => {});
    res.on('finish', () => {
      if ((req.user && req.user.isAdmin) || security.isAllowedCached(ip)) return;
      security.noteRequest(ip, req, res.statusCode).catch(() => {});
    });
  }).catch(() => {});

  next();
}

module.exports = threatRadar;
