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
  const ip = req.ip;
  if (SKIP.test(req.path) || security.isPrivateIp(ip)) return next();

  enabled().then((on) => {
    if (!on) return;
    // Signature match on the request itself.
    const hit = security.classify(req);
    if (hit) security.record(ip, hit.kind, req, hit.detail).catch(() => {});
    // Rate/scan behavior is judged once the response status is known.
    res.on('finish', () => { security.noteRequest(ip, req, res.statusCode).catch(() => {}); });
  }).catch(() => {});

  next();
}

module.exports = threatRadar;
