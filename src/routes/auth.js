'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const env = require('../config/env');
const pool = require('../db/pool');
const mailer = require('../services/mailer');
const verifyTurnstile = require('../middleware/turnstile');
const { authLimiter } = require('../middleware/rateLimit');
const { randomToken, sha256, isValidEmail } = require('../utils/helpers');

const router = express.Router();

function flash(req, type, message) {
  req.session.flash = { type, message };
}

async function createEmailToken(userId, purpose, ttlMs) {
  const token = randomToken(32);
  await pool.query('DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?', [userId, purpose]);
  await pool.query(
    'INSERT INTO email_tokens (user_id, token_hash, purpose, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))',
    [userId, sha256(token), purpose, Math.floor(ttlMs / 1000)]
  );
  return token;
}

async function consumeEmailToken(token, purpose) {
  const [[row]] = await pool.query(
    'SELECT * FROM email_tokens WHERE token_hash = ? AND purpose = ? AND expires_at > NOW()',
    [sha256(String(token)), purpose]
  );
  if (!row) return null;
  await pool.query('DELETE FROM email_tokens WHERE id = ?', [row.id]);
  return row;
}

function loginSession(req, user, res, fallback = '/dashboard') {
  req.session.regenerate((err) => {
    if (err) return res.status(500).render('errors/500');
    req.session.userId = user.id;
    const dest = req.session.returnTo || fallback;
    delete req.session.returnTo;
    req.session.save(() => res.redirect(dest));
  });
}

// ── Register ──────────────────────────────────────────────
router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('auth/register', { title: 'Create account' });
});

router.post('/register', authLimiter, verifyTurnstile, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').toLowerCase().trim();
    const name = String(req.body.name || '').trim().slice(0, 100);
    const password = String(req.body.password || '');

    if (!isValidEmail(email)) { flash(req, 'error', 'Please enter a valid email address.'); return res.redirect('/register'); }
    if (password.length < 8) { flash(req, 'error', 'Password must be at least 8 characters.'); return res.redirect('/register'); }

    const [[existing]] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) { flash(req, 'error', 'An account with that email already exists. Try signing in.'); return res.redirect('/login'); }

    const hash = await bcrypt.hash(password, 12);
    const verifiedAt = env.EMAIL_VERIFICATION_REQUIRED ? null : new Date();
    const [result] = await pool.query(
      'INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (?, ?, ?, ?)',
      [email, hash, name, verifiedAt]
    );

    if (env.EMAIL_VERIFICATION_REQUIRED) {
      const token = await createEmailToken(result.insertId, 'verify', 24 * 60 * 60 * 1000);
      await mailer.sendVerification(email, token);
      flash(req, 'success', 'Account created! Check your inbox for the verification link before signing in.');
      return res.redirect('/login');
    }
    flash(req, 'success', 'Account created! You can sign in now.');
    res.redirect('/login');
  } catch (err) { next(err); }
});

// ── Verify email ──────────────────────────────────────────
router.get('/verify/:token', async (req, res, next) => {
  try {
    const row = await consumeEmailToken(req.params.token, 'verify');
    if (!row) { flash(req, 'error', 'That verification link is invalid or expired. Sign in to request a new one.'); return res.redirect('/login'); }
    await pool.query('UPDATE users SET email_verified_at = NOW() WHERE id = ?', [row.user_id]);
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
    const email = String(req.body.email || '').toLowerCase().trim();
    const password = String(req.body.password || '');
    const [[user]] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);

    if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
      flash(req, 'error', 'Incorrect email or password.');
      return res.redirect('/login');
    }
    if (user.banned_at) { flash(req, 'error', 'This account has been suspended. Contact support.'); return res.redirect('/login'); }

    if (env.EMAIL_VERIFICATION_REQUIRED && !user.email_verified_at) {
      const token = await createEmailToken(user.id, 'verify', 24 * 60 * 60 * 1000);
      await mailer.sendVerification(user.email, token);
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
    const email = String(req.body.email || '').toLowerCase().trim();
    const [[user]] = await pool.query('SELECT id, email FROM users WHERE email = ?', [email]);
    if (user) {
      const token = await createEmailToken(user.id, 'reset', 60 * 60 * 1000);
      await mailer.sendPasswordReset(user.email, token);
    }
    flash(req, 'success', 'If that email is registered, a reset link is on its way.');
    res.redirect('/login');
  } catch (err) { next(err); }
});

router.get('/reset/:token', async (req, res) => {
  res.render('auth/reset', { title: 'Reset password', token: req.params.token });
});

router.post('/reset/:token', authLimiter, async (req, res, next) => {
  try {
    const password = String(req.body.password || '');
    if (password.length < 8) { flash(req, 'error', 'Password must be at least 8 characters.'); return res.redirect(`/reset/${req.params.token}`); }
    const row = await consumeEmailToken(req.params.token, 'reset');
    if (!row) { flash(req, 'error', 'That reset link is invalid or expired.'); return res.redirect('/forgot'); }
    const hash = await bcrypt.hash(password, 12);
    await pool.query('UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = ?', [hash, row.user_id]);
    flash(req, 'success', 'Password updated! You can sign in now.');
    res.redirect('/login');
  } catch (err) { next(err); }
});

// ── Google OAuth (authorization code flow) ────────────────
const googleEnabled = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CALLBACK_URL);

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

router.get('/auth/google/callback', async (req, res, next) => {
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
    let [[user]] = await pool.query('SELECT * FROM users WHERE google_id = ?', [profile.sub]);
    if (!user) {
      [[user]] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
      if (user) {
        await pool.query('UPDATE users SET google_id = ?, email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = ?', [profile.sub, user.id]);
      } else {
        const [result] = await pool.query(
          'INSERT INTO users (email, name, google_id, email_verified_at) VALUES (?, ?, ?, NOW())',
          [email, String(profile.name || '').slice(0, 100), profile.sub]
        );
        [[user]] = await pool.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
      }
    }
    if (user.banned_at) { flash(req, 'error', 'This account has been suspended. Contact support.'); return res.redirect('/login'); }
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
