'use strict';
const crypto = require('crypto');

// Simple double-submit CSRF: token stored in session, echoed in forms/headers.
// /api/v2 uses api-key auth; /telegram/webhook is authed by its URL secret.
// /wallet/deposit is multipart (file upload) so its body is parsed by multer
// AFTER this middleware — it is verified inside that route via verifyToken(),
// which lets the token stay in a hidden field instead of the URL.
const EXEMPT_PREFIXES = ['/api/v2', '/telegram/webhook', '/wallet/deposit'];

// Constant-time compare so a token can't be guessed by measuring response time.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch (_) { return false; }
}

// Valid CSRF token present? Reads the body field or header only — never the
// query string, so tokens can't leak through logs/referrers.
function verifyToken(req) {
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token');
  return !!sent && safeEqual(String(sent), req.session && req.session.csrfToken);
}

function csrf(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (EXEMPT_PREFIXES.some((p) => req.path.startsWith(p))) return next();

  if (!verifyToken(req)) {
    if (req.accepts('json') && !req.accepts('html')) {
      return res.status(403).json({ error: 'Invalid CSRF token' });
    }
    req.session.flash = { type: 'error', message: 'Your session expired. Please try again.' };
    return res.redirect(req.get('referer') || '/');
  }
  next();
}

module.exports = csrf;
module.exports.verifyToken = verifyToken;
