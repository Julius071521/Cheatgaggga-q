'use strict';
const crypto = require('crypto');

// Simple double-submit CSRF: token stored in session, echoed in forms/headers.
const EXEMPT_PREFIXES = ['/api/v2'];

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
  if (!sent || sent !== req.session.csrfToken) {
    if (req.accepts('json') && !req.accepts('html')) {
      return res.status(403).json({ error: 'Invalid CSRF token' });
    }
    req.session.flash = { type: 'error', message: 'Your session expired. Please try again.' };
    return res.redirect(req.get('referer') || '/');
  }
  next();
}

module.exports = csrf;
