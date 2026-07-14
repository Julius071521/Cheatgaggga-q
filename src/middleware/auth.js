'use strict';
const pool = require('../db/pool');
const { isAdminRole } = require('../utils/helpers');

// Loads the logged-in user (existing production `users` schema) onto req.user.
async function attachUser(req, res, next) {
  res.locals.user = null;
  req.user = null;
  if (req.session && req.session.userId) {
    try {
      const [[user]] = await pool.query(
        `SELECT id, username, email, balance, role, status, google_id, avatar, api_key,
                email_verified, (password IS NOT NULL AND password <> '') AS has_password
         FROM users WHERE id = ?`,
        [req.session.userId]
      );
      if (user && String(user.status || 'Active').toLowerCase() === 'active') {
        user.isAdmin = isAdminRole(user.role);
        user.name = user.username; // views use `name` for the display label
        req.user = user;
        res.locals.user = user;
      } else if (user) {
        // suspended/banned — drop the session
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
  if (!req.user || !req.user.isAdmin) {
    return res.status(404).render('errors/404');
  }
  next();
}

module.exports = { attachUser, requireAuth, requireAdmin };
