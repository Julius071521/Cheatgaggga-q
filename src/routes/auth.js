'use strict';
const express = require('express');
const env = require('../config/env');
const pool = require('../db/pool');
const mailer = require('../services/mailer');
const verifyTurnstile = require('../middleware/turnstile');
const { authLimiter } = require('../middleware/rateLimit');
const { randomToken, isValidEmail } = require('../utils/helpers');
const { hashSecret, verifySecret, sha256 } = require('../utils/password');

const router = express.Router();

function flash(req, type, message) {
  req.session.flash = { type, message };
}

async function getUserByIdentifier(identifier) {
  const clean = String(identifier || '').trim().toLowerCase();
  if (!clean) return null;
  const [[user]] = await pool.query(
    'SELECT * FROM users WHERE LOWER(email) = ? OR LOWER(username) = ? LIMIT 1',
    [clean, clean]
  );
  return user || null;
}

// Only ever redirect to a same-site absolute path — never to //evil.com,
// a full URL, or a backslash trick. Blocks open-redirect abuse after login.
function safeDest(dest, fallback) {
  if (typeof dest !== 'string') return fallback;
  if (!dest.startsWith('/') || dest.startsWith('//') || dest.startsWith('/\\')) return fallback;
  return dest;
}

function loginSession(req, user, res, fallback = '/dashboard') {
  req.session.regenerate((err) => {
    if (err) return res.status(500).render('errors/500');
    req.session.userId = user.id;
    const dest = safeDest(req.session.returnTo, fallback);
    delete req.session.returnTo;
    req.session.save(() => res.redirect(dest));
  });
}

async function sendVerifyEmail(user) {
  const token = randomToken(32);
  await pool.query(
    `UPDATE users SET email_verification_token_hash = ?,
       email_verification_expires_at = DATE_ADD(NOW(), INTERVAL 24 HOUR),
       last_verification_sent_at = NOW() WHERE id = ?`,
    [sha256(token), user.id]
  );
  await mailer.sendVerification(user.email, token);
}

// ── Register ──────────────────────────────────────────────
router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  // Remember the inviter's referral code across the whole signup flow
  // (also covers "Sign in with Google" after landing on ?ref=CODE).
  const ref = String(req.query.ref || '').trim().toUpperCase();
  if (/^[A-Z0-9]{4,20}$/.test(ref)) req.session.refCode = ref;
  res.render('auth/register', { title: 'Create account', refCode: req.session.refCode || '' });
});

router.post('/register', authLimiter, verifyTurnstile, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').toLowerCase().trim();
    const username = String(req.body.username || req.body.name || '').trim().slice(0, 100);
    const password = String(req.body.password || '');

    if (!isValidEmail(email)) { flash(req, 'error', 'Please enter a valid email address.'); return res.redirect('/register'); }
    if (username.length < 3) { flash(req, 'error', 'Username must be at least 3 characters.'); return res.redirect('/register'); }
    if (password.length < 8) { flash(req, 'error', 'Password must be at least 8 characters.'); return res.redirect('/register'); }

    const [[existing]] = await pool.query(
      'SELECT id FROM users WHERE LOWER(email) = ? OR LOWER(username) = ? LIMIT 1',
      [email, username.toLowerCase()]);
    if (existing) { flash(req, 'error', 'An account with that email or username already exists.'); return res.redirect('/login'); }

    // Referral attribution (from the signup form or a saved ?ref= link).
    let referredBy = null;
    const refCode = String(req.body.ref || req.session.refCode || '').trim();
    if (refCode) {
      const referrer = await require('../services/referrals').findReferrerByCode(refCode);
      if (referrer) referredBy = referrer.id;
    }

    const hash = await hashSecret(password);
    const verified = env.EMAIL_VERIFICATION_REQUIRED ? 0 : 1;
    const [result] = await pool.query(
      "INSERT INTO users (username, email, password, role, status, email_verified, balance, referred_by) VALUES (?, ?, ?, 'user', 'Active', ?, 0, ?)",
      [username, email, hash, verified, referredBy]
    );
    delete req.session.refCode;

    if (env.EMAIL_VERIFICATION_REQUIRED) {
      await sendVerifyEmail({ id: result.insertId, email });
      flash(req, 'success', 'Account created! Check your inbox for the verification link before signing in.');
      return res.redirect('/login');
    }
    mailer.sendWelcome(email, username).catch(() => {});
    flash(req, 'success', 'Account created! You can sign in now.');
    res.redirect('/login');
  } catch (err) { next(err); }
});

// ── Verify email ──────────────────────────────────────────
router.get('/verify/:token', async (req, res, next) => {
  try {
    const [[user]] = await pool.query(
      `SELECT id FROM users WHERE email_verification_token_hash = ?
         AND email_verification_expires_at > NOW() LIMIT 1`,
      [sha256(String(req.params.token))]
    );
    if (!user) { flash(req, 'error', 'That verification link is invalid or expired. Sign in to request a new one.'); return res.redirect('/login'); }
    await pool.query(
      'UPDATE users SET email_verified = 1, email_verification_token_hash = NULL, email_verification_expires_at = NULL WHERE id = ?',
      [user.id]);
    const [[vu]] = await pool.query('SELECT email, username FROM users WHERE id = ?', [user.id]);
    if (vu) mailer.sendWelcome(vu.email, vu.username).catch(() => {});
    flash(req, 'success', 'Email verified! You can sign in now.');
    res.redirect('/login');
  } catch (err) { next(err); }
});

// ── Login ─────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('auth/login', { title: 'Sign in' });
});

router.post('/login', authLimiter, verifyTurnstile, async (req, res, next) => {
  try {
    const identifier = req.body.usernameOrEmail || req.body.email || req.body.username;
    const password = String(req.body.password || '');
    const user = await getUserByIdentifier(identifier);

    if (!user || !(await verifySecret(password, user.password))) {
      // Feed failed logins to the Threat Radar (brute-force scoring).
      try { require('../services/security').record(req.clientIp || req.ip, 'brute', req, 'failed login'); } catch (_) {}
      flash(req, 'error', 'Incorrect username/email or password.');
      return res.redirect('/login');
    }
    if (String(user.status || 'Active').toLowerCase() !== 'active') {
      flash(req, 'error', 'This account has been suspended. Contact support.');
      return res.redirect('/login');
    }
    if (env.EMAIL_VERIFICATION_REQUIRED && !user.email_verified && !user.google_id) {
      await sendVerifyEmail(user);
      flash(req, 'error', 'Please verify your email first — we just sent you a fresh link.');
      return res.redirect('/login');
    }
    loginSession(req, user, res);
  } catch (err) { next(err); }
});

// ── Forgot / reset password ───────────────────────────────
router.get('/forgot', (req, res) => res.render('auth/forgot', { title: 'Forgot password' }));

router.post('/forgot', authLimiter, verifyTurnstile, async (req, res, next) => {
  try {
    const user = await getUserByIdentifier(req.body.email || req.body.usernameOrEmail);
    if (user) {
      const token = randomToken(32);
      await pool.query('DELETE FROM password_reset_tokens WHERE user_id = ?', [user.id]);
      await pool.query(
        'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, used) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR), 0)',
        [user.id, sha256(token)]);
      await mailer.sendPasswordReset(user.email, token);
    }
    flash(req, 'success', 'If that account exists, a reset link is on its way.');
    res.redirect('/login');
  } catch (err) { next(err); }
});

router.get('/reset/:token', (req, res) => {
  res.render('auth/reset', { title: 'Reset password', token: req.params.token });
});

router.post('/reset/:token', authLimiter, async (req, res, next) => {
  try {
    const password = String(req.body.password || '');
    if (password.length < 8) { flash(req, 'error', 'Password must be at least 8 characters.'); return res.redirect(`/reset/${req.params.token}`); }
    const [[row]] = await pool.query(
      'SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used = 0 AND expires_at > NOW() LIMIT 1',
      [sha256(String(req.params.token))]);
    if (!row) { flash(req, 'error', 'That reset link is invalid or expired.'); return res.redirect('/forgot'); }
    await pool.query('UPDATE users SET password = ?, email_verified = 1 WHERE id = ?', [await hashSecret(password), row.user_id]);
    await pool.query('UPDATE password_reset_tokens SET used = 1 WHERE id = ?', [row.id]);
    flash(req, 'success', 'Password updated! You can sign in now.');
    res.redirect('/login');
  } catch (err) { next(err); }
});

// ── Google OAuth (authorization code flow) ────────────────
const googleEnabled = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CALLBACK_URL);

async function uniqueUsername(base) {
  let candidate = String(base || 'user').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'user';
  for (let i = 0; i < 50; i++) {
    const tryName = i === 0 ? candidate : `${candidate}${i}`;
    const [[hit]] = await pool.query('SELECT id FROM users WHERE username = ? LIMIT 1', [tryName]);
    if (!hit) return tryName;
  }
  return `${candidate}${Date.now().toString().slice(-5)}`;
}

router.get('/auth/google', (req, res) => {
  if (!googleEnabled) { flash(req, 'error', 'Google sign-in is not available right now.'); return res.redirect('/login'); }
  const state = randomToken(16);
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_CALLBACK_URL,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/auth/google/callback', async (req, res) => {
  try {
    if (!googleEnabled) return res.redirect('/login');
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.oauthState) {
      flash(req, 'error', 'Google sign-in failed. Please try again.');
      return res.redirect('/login');
    }
    delete req.session.oauthState;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: env.GOOGLE_CALLBACK_URL,
        grant_type: 'authorization_code',
      }).toString(),
    }).then((r) => r.json());
    if (!tokenRes.access_token) throw new Error('No access token from Google');

    const profile = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokenRes.access_token}` },
    }).then((r) => r.json());
    if (!profile.sub || !profile.email) throw new Error('Incomplete Google profile');

    const email = String(profile.email).toLowerCase();
    let [[user]] = await pool.query('SELECT * FROM users WHERE google_id = ? LIMIT 1', [profile.sub]);
    if (!user) {
      [[user]] = await pool.query('SELECT * FROM users WHERE LOWER(email) = ? LIMIT 1', [email]);
      if (user) {
        await pool.query('UPDATE users SET google_id = ?, email_verified = 1, avatar = COALESCE(avatar, ?) WHERE id = ?',
          [profile.sub, profile.picture || null, user.id]);
      } else {
        // Referral attribution survives the OAuth round-trip via the session.
        let referredBy = null;
        if (req.session.refCode) {
          const referrer = await require('../services/referrals').findReferrerByCode(req.session.refCode);
          if (referrer) referredBy = referrer.id;
        }
        const username = await uniqueUsername(profile.name || email.split('@')[0]);
        const [result] = await pool.query(
          "INSERT INTO users (username, email, google_id, avatar, role, status, email_verified, balance, referred_by) VALUES (?, ?, ?, ?, 'user', 'Active', 1, 0, ?)",
          [username, email, profile.sub, profile.picture || null, referredBy]);
        [[user]] = await pool.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
        delete req.session.refCode;
      }
    }
    if (String(user.status || 'Active').toLowerCase() !== 'active') {
      flash(req, 'error', 'This account has been suspended. Contact support.');
      return res.redirect('/login');
    }
    loginSession(req, user, res);
  } catch (err) {
    console.warn('[auth] Google OAuth failed:', err.message);
    flash(req, 'error', 'Google sign-in failed. Please try again.');
    res.redirect('/login');
  }
});

// ── Logout ────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
