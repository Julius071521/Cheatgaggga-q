'use strict';
const crypto = require('crypto');

// Simple double-submit CSRF: token stored in session, echoed in forms/headers.
// /api/v2 uses api-key auth; /telegram/webhook is authed by its URL secret.
const EXEMPT_PREFIXES = ['/api/v2', '/telegram/webhook'];

// Constant-time compare so a token can't be guessed by measuring response time.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch (_) { return false; }
}

function csrf(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (EXEMPT_PREFIXES.some((p) => req.path.startsWith(p))) return next();

  // multipart/form-data bodies are parsed later (multer), so those forms
  // send the token in the query string instead.
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || req.query._csrf;
  if (!sent || !safeEqual(String(sent), req.session.csrfToken)) {
    if (req.accepts('json') && !req.accepts('html')) {
      return res.status(403).json({ error: 'Invalid CSRF token' });
    }
    req.session.flash = { type: 'error', message: 'Your session expired. Please try again.' };
    return res.redirect(req.get('referer') || '/');
  }
  next();
}

module.exports = csrf;
