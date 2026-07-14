'use strict';
const pool = require('../db/pool');

// Loads the logged-in user from the session onto req.user / res.locals.user.
async function attachUser(req, res, next) {
  res.locals.user = null;
  req.user = null;
  if (req.session && req.session.userId) {
    try {
      const [[user]] = await pool.query(
        'SELECT id, email, name, role, balance, api_key, email_verified_at, banned_at, google_id, password_hash IS NOT NULL AS has_password FROM users WHERE id = ?',
        [req.session.userId]
      );
      if (user && !user.banned_at) {
        req.user = user;
        res.locals.user = user;
      } else if (user && user.banned_at) {
        req.session.destroy(() => {});
      }
    } catch (err) {
      console.warn('[auth] Could not load session user:', err.message);
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    req.session.flash = { type: 'error', message: 'Please sign in to continue.' };
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(404).render('errors/404');
  }
  next();
}

module.exports = { attachUser, requireAuth, requireAdmin };
