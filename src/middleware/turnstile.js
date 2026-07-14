'use strict';
const env = require('../config/env');

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Server-side Cloudflare Turnstile verification for auth forms.
async function verifyTurnstile(req, res, next) {
  if (!env.TURNSTILE_REQUIRED) return next();
  try {
    const token = req.body['cf-turnstile-response'];
    if (!token) throw new Error('missing token');
    const body = new URLSearchParams({
      secret: env.TURNSTILE_SECRET_KEY,
      response: token,
      remoteip: req.ip,
    });
    const result = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }).then((r) => r.json());
    if (!result.success) throw new Error('verification failed');
    next();
  } catch (_) {
    req.session.flash = { type: 'error', message: 'Captcha verification failed. Please try again.' };
    res.redirect(req.get('referer') || '/login');
  }
}

module.exports = verifyTurnstile;
