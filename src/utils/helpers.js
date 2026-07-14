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

const STATUS_LABELS = {
  pending: 'Pending', in_progress: 'In Progress', processing: 'Processing',
  completed: 'Completed', partial: 'Partial', canceled: 'Canceled', failed: 'Failed',
  approved: 'Approved', rejected: 'Rejected',
};

function statusLabel(code) {
  return STATUS_LABELS[code] || code;
}

module.exports = {
  toCents, centsToPhp, money, moneyRate, randomToken, sha256,
  isValidEmail, isValidHttpUrl, clampInt, formatDate,
  platformLabel, statusLabel, PLATFORM_LABELS,
};
