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
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

// ── Security headers ──────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://challenges.cloudflare.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameSrc: ['https://challenges.cloudflare.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'", 'https://accounts.google.com'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

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
    year: new Date().getFullYear(),
  };
  res.locals.h = helpers;
  res.locals.pricing = pricing;
  res.locals.path = req.path;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

// ── Routes ────────────────────────────────────────────────
app.use(require('./src/routes/api'));
app.use(require('./src/routes/ai'));
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

app.listen(env.PORT, () => {
  console.log(`[server] ${env.SITE_NAME} running on port ${env.PORT} (${env.BASE_URL})`);
});
