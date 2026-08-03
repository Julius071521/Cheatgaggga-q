'use strict';
// Admins must have two-factor on. Everything behind /admin is a path to
// somebody's money, so a single leaked password cannot be the only thing
// standing in the way.
//
// The enrolment page itself and sign-out stay reachable, otherwise this would
// lock an admin out of the very screen that fixes it.
const twofactor = require('../services/twofactor');

// The 2FA controls live on /settings, so that whole page has to stay open —
// sending an admin to a page this middleware itself blocks would be a loop.
const ALLOW = [
  /^\/settings/,
  /^\/logout/,
  /^\/login/,
  /^\/assets/,
];

async function require2fa(req, res, next) {
  if (!req.user || !req.user.isAdmin) return next();
  if (ALLOW.some((re) => re.test(req.path))) return next();
  // Only guard the admin surface — an admin browsing the shop as a customer is
  // not doing anything privileged.
  if (!req.path.startsWith('/admin')) return next();

  let must = false;
  try { must = await twofactor.mustEnrol(req.user); } catch (_) { return next(); }
  if (!must) return next();

  req.session.flash = {
    type: 'error',
    message: 'Two-factor authentication is required for admin accounts. Set it up now — it takes a minute, '
      + 'and you will get recovery codes in case you lose your phone.',
  };
  return res.redirect('/settings#twofa');
}

module.exports = require2fa;
