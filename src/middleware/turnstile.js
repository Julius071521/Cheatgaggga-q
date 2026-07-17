'use strict';
const env = require('../config/env');

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Server-side Cloudflare Turnstile verification for auth forms.
// Auto-disables unless FULLY configured (required + site key + secret key) —
// otherwise the widget can't render yet the server would still demand a token,
// which would lock everyone out of login/register.
async function verifyTurnstile(req, res, next) {
  if (!env.TURNSTILE_REQUIRED || !env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY) return next();
  try {
    const token = req.body['cf-turnstile-response'];
    if (!token) throw new Error('missing token');
    const body = new URLSearchParams({
      secret: env.TURNSTILE_SECRET_KEY,
      response: token,
      remoteip: req.clientIp || req.ip,
    });
    const result = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }).then((r) => r.json());

    if (result.success) return next();

    // A SERVER-side misconfiguration (wrong/blank secret) must not lock real
    // users out of login/register — fail open with a loud log so the admin can
    // fix it, instead of punishing every visitor for an admin config error.
    const codes = result['error-codes'] || [];
    const serverConfigError = codes.some((c) =>
      ['invalid-input-secret', 'missing-input-secret', 'bad-request', 'internal-error'].includes(c));
    if (serverConfigError) {
      console.warn(`[turnstile] captcha bypassed — server secret is misconfigured (${codes.join(', ')}). Fix TURNSTILE_SECRET_KEY or blank TURNSTILE_SITE_KEY.`);
      return next();
    }
    throw new Error('verification failed');
  } catch (_) {
    req.session.flash = { type: 'error', message: 'Captcha verification failed. Please try again.' };
    res.redirect(req.get('referer') || '/login');
  }
}

module.exports = verifyTurnstile;
