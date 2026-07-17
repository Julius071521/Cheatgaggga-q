'use strict';
require('dotenv').config();

function str(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v.trim();
}

function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${name} must be a number, got "${v}"`);
  return n;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

function list(name) {
  const v = process.env[name];
  if (!v) return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

const env = {
  NODE_ENV: str('NODE_ENV', 'production'),
  PORT: num('PORT', 3000),

  SITE_NAME: str('SITE_NAME', 'ApexBoost'),
  SITE_DOMAIN: str('SITE_DOMAIN', 'apexsmmboosting.com'),
  BASE_URL: str('BASE_URL', str('PUBLIC_SITE_URL', '')),

  // AI assistant (OpenAI-compatible router)
  AI_API_KEY: str('AI_API_KEY', ''),
  AI_MODEL: str('AI_MODEL', 'gpt-4o'),
  AI_BASE_URL: str('AI_BASE_URL', ''),

  // AI Autopilot (auto-triage tickets, sync orders, flag stuck ones)
  AUTOPILOT_ENABLED: bool('AUTOPILOT_ENABLED', true),
  AUTOPILOT_INTERVAL_MINUTES: num('AUTOPILOT_INTERVAL_MINUTES', 10),
  AUTOPILOT_STUCK_HOURS: num('AUTOPILOT_STUCK_HOURS', 48),
  AUTO_APPROVE_DEPOSITS_MAX_PHP: num('AUTO_APPROVE_DEPOSITS_MAX_PHP', 500),
  DAILY_DIGEST_HOUR: num('DAILY_DIGEST_HOUR', 8),
  // Open orders still not delivered after this many days are auto-refunded.
  AUTOPILOT_AUTOREFUND_DAYS: num('AUTOPILOT_AUTOREFUND_DAYS', 7),

  // Growth: deposit bonus tiers ("min:percent,...") + referral commission
  DEPOSIT_BONUS_TIERS: str('DEPOSIT_BONUS_TIERS', '500:5,1000:10,5000:50'),
  REFERRAL_COMMISSION_PERCENT: num('REFERRAL_COMMISSION_PERCENT', 5),
  MIN_PAYOUT_PHP: num('MIN_PAYOUT_PHP', 100),

  // Telegram security bot (attacker alerts + block/allow buttons)
  TELEGRAM_BOT_TOKEN: str('TELEGRAM_BOT_TOKEN', ''),
  TELEGRAM_ADMIN_CHAT_ID: str('TELEGRAM_ADMIN_CHAT_ID', ''),
  TELEGRAM_WEBHOOK_SECRET: str('TELEGRAM_WEBHOOK_SECRET', ''),

  // Threat Radar tuning
  SECURITY_ALERT_SCORE: num('SECURITY_ALERT_SCORE', 40),
  SECURITY_AUTOBLOCK_SCORE: num('SECURITY_AUTOBLOCK_SCORE', 120),
  SECURITY_ALERT_COOLDOWN_MIN: num('SECURITY_ALERT_COOLDOWN_MIN', 30),
  SECURITY_404_THRESHOLD: num('SECURITY_404_THRESHOLD', 15),
  SECURITY_FLOOD_THRESHOLD: num('SECURITY_FLOOD_THRESHOLD', 150),
  SECURITY_GEO_LOOKUP: bool('SECURITY_GEO_LOOKUP', true),
  // Site is fronted by Cloudflare → trust CF-Connecting-IP for the real visitor.
  TRUST_CF_CONNECTING_IP: bool('TRUST_CF_CONNECTING_IP', true),
  SECURITY_EVENT_RETENTION_DAYS: num('SECURITY_EVENT_RETENTION_DAYS', 30),

  // Cloudflare API (edge-level IP blocking + firewall event visibility).
  CLOUDFLARE_API_TOKEN: str('CLOUDFLARE_API_TOKEN', ''),
  CLOUDFLARE_ZONE_ID: str('CLOUDFLARE_ZONE_ID', ''),
  // "Under attack" mode: N distinct attacker IPs within the window trips it.
  SECURITY_UNDER_ATTACK_IPS: num('SECURITY_UNDER_ATTACK_IPS', 5),
  SECURITY_UNDER_ATTACK_WINDOW_MIN: num('SECURITY_UNDER_ATTACK_WINDOW_MIN', 5),

  // Upstream SMM providers (standard SMM panel API v2)
  RKD_API_KEY: str('RKD_API_KEY', ''),
  RKD_API_URL: str('RKD_API_URL', ''),
  SMMWORLD_API_KEY: str('SMMWORLD_API_KEY', ''),
  SMMWORLD_API_URL: str('SMMWORLD_API_URL', ''),
  SMMWORLD_IMPORT_SERVICE_IDS: list('SMMWORLD_IMPORT_SERVICE_IDS'),
  SMMWORLD_IMPORT_KEYWORDS: list('SMMWORLD_IMPORT_KEYWORDS'),

  // Pricing (var names match the existing production app)
  SERVICE_MARKUP_MULTIPLIER: num('SERVICE_PRICE_MULTIPLIER', num('SERVICE_MARKUP_MULTIPLIER', 2.5)),
  USD_TO_PHP_RATE: num('USD_TO_PHP_RATE', 60),
  MIN_ORDER_CHARGE_PHP: num('MIN_ORDER_CHARGE_PHP', 0.01),
  SITE_CURRENCY: str('SITE_CURRENCY', 'PHP'),
  SITE_CURRENCY_SYMBOL: str('SITE_CURRENCY_SYMBOL', '₱'),
  PROVIDER_LOW_BALANCE_THRESHOLD_PHP: num('PROVIDER_LOW_BALANCE_THRESHOLD_PHP', 500),
  PROVIDER_BLOCK_ORDERS_BELOW_THRESHOLD: bool('PROVIDER_BLOCK_ORDERS_BELOW_THRESHOLD', false),

  // Database
  DB_HOST: str('DB_HOST', 'localhost'),
  DB_PORT: num('DB_PORT', 3306),
  DB_USER: str('DB_USER', ''),
  DB_PASSWORD: str('DB_PASSWORD', ''),
  DB_NAME: str('DB_NAME', ''),

  // Email (SMTP)
  EMAIL_HOST: str('EMAIL_HOST', ''),
  EMAIL_PORT: num('EMAIL_PORT', 465),
  EMAIL_SECURE: bool('EMAIL_SECURE', true),
  EMAIL_TLS_SERVERNAME: str('EMAIL_TLS_SERVERNAME', ''),
  EMAIL_USER: str('EMAIL_USER', ''),
  EMAIL_PASS: str('EMAIL_PASS', ''),
  EMAIL_FROM_NAME: str('EMAIL_FROM_NAME', 'Support'),
  EMAIL_FROM: str('EMAIL_FROM', ''),
  SUPPORT_EMAIL: str('SUPPORT_EMAIL', ''),

  // Manual payment accounts
  GCASH_ACCOUNT_NUMBER: str('GCASH_ACCOUNT_NUMBER', ''),
  GCASH_ACCOUNT_NAME: str('GCASH_ACCOUNT_NAME', ''),
  MAYA_ACCOUNT_NUMBER: str('MAYA_ACCOUNT_NUMBER', ''),
  MAYA_ACCOUNT_NAME: str('MAYA_ACCOUNT_NAME', ''),
  BPI_ACCOUNT_NUMBER: str('BPI_ACCOUNT_NUMBER', ''),
  BPI_ACCOUNT_NAME: str('BPI_ACCOUNT_NAME', ''),
  BPI_ACCOUNT_TYPE: str('BPI_ACCOUNT_TYPE', 'Savings'),

  // Auth / security
  JWT_SECRET: str('JWT_SECRET', ''),
  SESSION_SECRET: str('SESSION_SECRET', ''),
  EMAIL_VERIFICATION_REQUIRED: bool('EMAIL_VERIFICATION_REQUIRED', true),
  TURNSTILE_REQUIRED: bool('TURNSTILE_REQUIRED', false),
  TURNSTILE_SITE_KEY: str('TURNSTILE_SITE_KEY', ''),
  TURNSTILE_SECRET_KEY: str('TURNSTILE_SECRET_KEY', ''),

  // Google OAuth
  GOOGLE_CLIENT_ID: str('GOOGLE_CLIENT_ID', ''),
  GOOGLE_CLIENT_SECRET: str('GOOGLE_CLIENT_SECRET', ''),
  GOOGLE_CALLBACK_URL: str('GOOGLE_CALLBACK_URL', ''),

  // Uploads
  UPLOAD_DIR: str('UPLOAD_DIR', ''),
};

// Derive BASE_URL from the Google callback URL when not set explicitly.
if (!env.BASE_URL && env.GOOGLE_CALLBACK_URL) {
  try {
    env.BASE_URL = new URL(env.GOOGLE_CALLBACK_URL).origin;
  } catch (_) { /* ignore malformed URL */ }
}
if (!env.BASE_URL) env.BASE_URL = `http://localhost:${env.PORT}`;

const required = ['SESSION_SECRET', 'DB_USER', 'DB_NAME'];
const missing = required.filter((k) => !env[k]);
if (missing.length) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')} (see .env.example)`);
}

const warnIfMissing = ['JWT_SECRET', 'EMAIL_HOST', 'RKD_API_KEY', 'SMMWORLD_API_KEY', 'AI_API_KEY'];
for (const k of warnIfMissing) {
  if (!env[k]) console.warn(`[env] Warning: ${k} is not set — related features will be disabled.`);
}
if (env.TURNSTILE_REQUIRED && (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY)) {
  console.warn('[env] Warning: TURNSTILE_REQUIRED=true but TURNSTILE_SITE_KEY/TURNSTILE_SECRET_KEY missing — Turnstile checks disabled.');
  env.TURNSTILE_REQUIRED = false;
}

module.exports = env;
