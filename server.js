'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const helmet = require('helmet');

const env = require('./src/config/env');
const { attachUser } = require('./src/middleware/auth');
const csrf = require('./src/middleware/csrf');
const { generalLimiter } = require('./src/middleware/rateLimit');
const helpers = require('./src/utils/helpers');
const pricing = require('./src/services/pricing');
const ai = require('./src/services/ai');

const app = express();
// Changes on every boot/deploy so browsers always fetch fresh CSS/JS after a
// Restart (cache-busting for the versioned ?v= asset URLs).
const ASSET_VERSION = Date.now().toString(36);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
// Resolve the REAL visitor IP (Cloudflare CF-Connecting-IP) into req.clientIp
// before any middleware reads it — otherwise everything sees the CF edge IP.
app.use(require('./src/utils/clientip').attachClientIp);

// ── Security headers ──────────────────────────────────────
const isHttps = String(env.BASE_URL || '').startsWith('https');
const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", 'https://challenges.cloudflare.com'],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  fontSrc: ["'self'", 'https://fonts.gstatic.com'],
  imgSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
  frameSrc: ['https://challenges.cloudflare.com'],
  frameAncestors: ["'none'"], // clickjacking: nobody may embed our pages
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'", 'https://accounts.google.com'],
  // Force any stray http:// asset/link up to https in production (downgrade guard).
  ...(isHttps ? { upgradeInsecureRequests: [] } : {}),
};
app.use(helmet({
  contentSecurityPolicy: { directives: cspDirectives },
  crossOriginEmbedderPolicy: false,
  frameguard: { action: 'deny' }, // no framing at all (matches CSP frame-ancestors 'none')
  hsts: isHttps ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// Headers helmet doesn't set: lock down powerful browser features + isolate origin.
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy',
    'geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=(), interest-cohort=()');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  next();
});

app.use(generalLimiter);
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use('/assets', express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

// ── Sessions (stored in MySQL so they survive restarts) ───
const sessionStore = new MySQLStore({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  createDatabaseTable: true,
  clearExpired: true,
  checkExpirationInterval: 15 * 60 * 1000,
});

app.use(session({
  name: 'apex.sid',
  secret: env.SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production' && env.BASE_URL.startsWith('https'),
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

app.use(attachUser);
app.use(csrf);

// ── View locals ───────────────────────────────────────────
app.use((req, res, next) => {
  res.locals.site = {
    name: env.SITE_NAME,
    domain: env.SITE_DOMAIN,
    supportEmail: env.SUPPORT_EMAIL,
    turnstileSiteKey: env.TURNSTILE_REQUIRED ? env.TURNSTILE_SITE_KEY : '',
    googleEnabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CALLBACK_URL),
    aiEnabled: ai.enabled,
    blockMessage: env.SECURITY_BLOCK_MESSAGE,
    year: new Date().getFullYear(),
  };
  res.locals.h = helpers;
  res.locals.pricing = pricing;
  res.locals.assetVersion = ASSET_VERSION;
  res.locals.path = req.path;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

// Notification badge count for the signed-in user (skip static/asset paths).
const notifications = require('./src/services/notifications');
app.use(async (req, res, next) => {
  res.locals.notifCount = 0;
  res.locals.supportUnread = 0;
  if (req.user && req.method === 'GET' && !req.path.startsWith('/assets')) {
    try { res.locals.notifCount = await notifications.unreadCount(req.user); } catch (_) {}
    try {
      const [[s]] = await require('./src/db/pool').query(
        'SELECT COUNT(*) AS c FROM tickets WHERE user_id = ? AND customer_unread = 1', [req.user.id]);
      res.locals.supportUnread = s ? s.c : 0;
    } catch (_) {}
  }
  next();
});

// Never let browsers/proxies cache authenticated or private pages
// (balance, orders, admin, API) — prevents stale/leaked data on shared devices.
const PRIVATE_PATH = /^\/(dashboard|order|orders|wallet|settings|receipt|admin|notifications|api|ai)\b/;
app.use((req, res, next) => {
  if (req.user || PRIVATE_PATH.test(req.path)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
});

// Threat Radar: watch every request for scanner/attacker behavior (fires
// Telegram alerts + optional auto-block). Runs before the gate so a freshly
// blocked IP is caught on its next request.
app.use(require('./src/middleware/threatRadar'));

// Maintenance-mode + IP-block gate runs after view locals so the
// maintenance/blocked pages render with full context.
app.use(require('./src/middleware/gate').gate);

// ── Routes ────────────────────────────────────────────────
app.use(require('./src/routes/telegram'));
app.use(require('./src/routes/internal'));
app.use(require('./src/routes/api'));
app.use(require('./src/routes/ai'));
app.use(require('./src/routes/notifications'));
app.use(require('./src/routes/public'));
app.use(require('./src/routes/auth'));
app.use(require('./src/routes/dashboard'));
app.use(require('./src/routes/admin'));

// ── Errors ────────────────────────────────────────────────
app.use((req, res) => res.status(404).render('errors/404'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[server] Unhandled error:', err.stack || err.message);
  if (res.headersSent) return;
  res.status(500).render('errors/500');
});

// Run pending DB migrations on boot (idempotent + additive) so a cPanel
// deploy is self-provisioning — no separate terminal step required.
const { runMigrations } = require('./src/db/migrate');
runMigrations()
  .then((applied) => {
    if (applied.length) console.log(`[server] Applied migrations: ${applied.join(', ')}`);
  })
  .catch((err) => console.error('[server] Auto-migration failed (continuing):', err.message))
  .finally(() => {
    app.listen(env.PORT, () => {
      console.log(`[server] ${env.SITE_NAME} running on port ${env.PORT} (${env.BASE_URL})`);
      // AI Autopilot: background triage of reports + stuck-order watchdog.
      try { require('./src/services/autopilot').startScheduler(); }
      catch (err) { console.warn('[server] autopilot failed to start:', err.message); }

      // One-time cleanup of any Cloudflare/local IPs wrongly recorded by an
      // older version (so past mistakes clear on upgrade).
      try { require('./src/services/security').cleanInfraIps(); }
      catch (err) { console.warn('[server] infra-ip cleanup failed:', err.message); }

      // Privacy: scrub any provider brand names that reached the catalog
      // before sanitizing existed (safe to re-run; usually a no-op).
      try {
        require('./src/services/catalog').scrubExistingBrands()
          .catch((err) => console.warn('[server] brand scrub failed:', err.message));
      } catch (err) { console.warn('[server] brand scrub failed:', err.message); }

      // Telegram security bot: register the webhook so button presses reach us.
      try {
        const telegram = require('./src/services/telegram');
        if (telegram.enabled && env.BASE_URL.startsWith('https') && env.TELEGRAM_WEBHOOK_SECRET) {
          telegram.setWebhook(env.BASE_URL)
            .then((r) => { if (r && r.ok) console.log('[telegram] webhook registered'); })
            .catch(() => {});
          telegram.send('🟢 <b>ApexBoost security is online.</b> You will get alerts here when scanners or attackers hit the site.').catch(() => {});
        }
      } catch (err) { console.warn('[server] telegram init failed:', err.message); }
    });
  });
