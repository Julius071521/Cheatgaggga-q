'use strict';
const crypto = require('crypto');

function toCents(value) {
  return Math.round(Number(value) * 100);
}

function centsToPhp(cents) {
  return (cents / 100).toFixed(2);
}

function money(value) {
  return Number(value).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Rate-per-1000 display: show more precision for very cheap services.
function moneyRate(value) {
  const n = Number(value);
  const decimals = n > 0 && n < 1 ? 4 : 2;
  return n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: decimals });
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email);
}

function isValidHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function clampInt(value, min, max) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function formatDate(d) {
  if (!d) return '—';
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleString('en-PH', {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

const PLATFORM_LABELS = {
  instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook', youtube: 'YouTube',
  twitter: 'Twitter / X', telegram: 'Telegram', spotify: 'Spotify', snapchat: 'Snapchat',
  twitch: 'Twitch', discord: 'Discord', linkedin: 'LinkedIn', website: 'Website Traffic', other: 'Other',
};

function platformLabel(code) {
  return PLATFORM_LABELS[code] || 'Other';
}

// Detect a platform code from free text (service name/category) — used for
// existing orders that have no platform column.
const PLATFORM_TEXT_KEYWORDS = [
  ['instagram', ['instagram', ' ig ', 'insta']],
  ['tiktok', ['tiktok', 'tik tok', 'tik-tok']],
  ['facebook', ['facebook', ' fb ', 'fb ', 'fb.', 'meta ']],
  ['youtube', ['youtube', ' yt ', 'you tube']],
  ['twitter', ['twitter', 'x.com']],
  ['telegram', ['telegram', 'tg ']],
  ['spotify', ['spotify']],
  ['snapchat', ['snapchat', 'snap ']],
  ['twitch', ['twitch']],
  ['discord', ['discord']],
  ['linkedin', ['linkedin']],
  ['website', ['website traffic', 'web traffic', 'traffic', 'google review']],
];
function platformFromText(text) {
  const hay = ` ${String(text || '').toLowerCase()} `;
  for (const [platform, kws] of PLATFORM_TEXT_KEYWORDS) {
    if (kws.some((k) => hay.includes(k))) return platform;
  }
  return 'other';
}

// Statuses are stored in the DB already human-readable (e.g. "In progress").
function statusLabel(code) {
  return code ? String(code) : '—';
}

// CSS-safe slug for badge classes: "In progress" -> "in_progress".
function statusSlug(code) {
  return String(code || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function isAdminRole(role) {
  return role === 'admin' || role === 'super_admin';
}

module.exports = {
  toCents, centsToPhp, money, moneyRate, randomToken, sha256,
  isValidEmail, isValidHttpUrl, clampInt, formatDate,
  platformLabel, platformFromText, statusLabel, statusSlug, isAdminRole, PLATFORM_LABELS,
};
