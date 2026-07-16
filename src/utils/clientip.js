'use strict';
const env = require('../config/env');

// Behind Cloudflare, req.ip is the CF edge IP — the REAL visitor is in the
// CF-Connecting-IP header (Cloudflare overwrites any client-supplied value,
// so it's trustworthy when the site is actually fronted by Cloudflare).
// Falls back to X-Real-IP, then Express's req.ip.
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]+$/;

function clientIp(req) {
  if (env.TRUST_CF_CONNECTING_IP) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf && IP_RE.test(String(cf).trim())) return String(cf).trim();
    const xr = req.headers['x-real-ip'];
    if (xr && IP_RE.test(String(xr).trim())) return String(xr).trim();
  }
  return req.ip;
}

// Express middleware: stamp req.clientIp once so everything agrees on the IP.
function attachClientIp(req, res, next) {
  req.clientIp = clientIp(req);
  next();
}

module.exports = { clientIp, attachClientIp };
