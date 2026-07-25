'use strict';
const rateLimit = require('express-rate-limit');
const env = require('../config/env');

// Behind Cloudflare the true visitor is in CF-Connecting-IP, which
// attachClientIp has already resolved into req.clientIp. Keying on it means
// every limiter counts the same visitor the rest of the app sees.
const byClientIp = (req) => req.clientIp || req.ip;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: byClientIp,
  message: 'Too many attempts. Please wait a few minutes and try again.',
});

const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.session && req.session.id) || req.clientIp || req.ip,
  message: { error: 'Chat limit reached for now. Please try again later.' },
});

// Must stay in step with the published limit on /api-docs — resellers build
// their retry/backoff against that number.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.API_RATE_LIMIT_PER_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: byClientIp,
  message: { error: 'Rate limit exceeded' },
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.RATE_LIMIT_PER_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: byClientIp,
  // Static assets are cached and make up most of a page load — counting them
  // would let ordinary browsing burn the page-request budget.
  skip: (req) => req.path.startsWith('/assets'),
});

module.exports = { authLimiter, aiLimiter, apiLimiter, generalLimiter };
