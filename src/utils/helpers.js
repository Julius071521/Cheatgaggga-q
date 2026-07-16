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

// Fold "fancy" Mathematical Alphanumeric Symbols (bold/italic letters) back
// to plain ASCII so text reads, searches, and truncates normally.
function foldFancyUnicode(str) {
  return Array.from(String(str)).map((ch) => {
    const cp = ch.codePointAt(0);
    if (cp >= 0x1d400 && cp <= 0x1d7cb) { // styled A-Z/a-z blocks (52 per style)
      const idx = (cp - 0x1d400) % 52;
      return String.fromCharCode(idx < 26 ? 65 + idx : 97 + (idx - 26));
    }
    if (cp >= 0x1d7ce && cp <= 0x1d7ff) { // styled digits (10 per style)
      return String.fromCharCode(48 + ((cp - 0x1d7ce) % 10));
    }
    return ch;
  }).join('');
}

// Code-point-safe truncation (a plain .slice can cut an emoji in half).
function sliceSafe(str, max) {
  return Array.from(String(str)).slice(0, max).join('');
}

// Providers decorate category names with dashes/emoji noise
// ("----FACEBOOK SERVICES AREA----"). Strip it and fix SHOUTING CAPS.
function tidyCategory(raw) {
  let c = foldFancyUnicode(String(raw || ''))
    .replace(/[\uFFFD\u0000-\u001F]/g, '') // broken/mojibake + control chars
    .replace(/\s*\|\s*/g, ' \u00b7 ')
    .replace(/^[\s\-\u2013\u2014=_~*#>|\u00b7.]+|[\s\-\u2013\u2014=_~*#>|\u00b7.]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!c) return 'General';
  if (c.length > 3 && c === c.toUpperCase()) {
    c = c.toLowerCase().replace(/(^|\s|\/|\[|\()([a-z])/g, (m, pre, ch) => pre + ch.toUpperCase());
  }
  return sliceSafe(c, 90);
}

// Some provider rows have junk names like "1" -- give them a sane label,
// and swap noisy " | " separators for a calmer " - ".
function tidyServiceName(raw, id) {
  let n = foldFancyUnicode(String(raw || ''))
    .replace(/[\uFFFD\u0000-\u001F]/g, '')
    .replace(/\s*\|\s*/g, ' \u00b7 ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (n.length < 4 || /^\d+$/.test(n)) n = `Service #${id}`;
  return n;
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
  tidyCategory, tidyServiceName,
};
