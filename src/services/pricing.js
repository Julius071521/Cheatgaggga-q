'use strict';
const env = require('../config/env');

function effectiveMarkup(service) {
  const override = service.markup_override;
  if (override !== null && override !== undefined && override !== '') {
    const n = Number(override);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return env.SERVICE_MARKUP_MULTIPLIER;
}

// Selling rate in PHP per 1000 units (unrounded; format at display time).
function ratePhpPer1000(service) {
  return Number(service.rate_usd) * effectiveMarkup(service) * env.USD_TO_PHP_RATE;
}

// Total charge in PHP for a quantity, rounded UP to the centavo (min 0.01).
function chargePhp(service, quantity) {
  const raw = (ratePhpPer1000(service) * quantity) / 1000;
  return Math.max(0.01, Math.ceil(raw * 100) / 100);
}

// Upstream cost in USD (informational, for profit reporting).
function costUsd(service, quantity) {
  return (Number(service.rate_usd) * quantity) / 1000;
}

module.exports = { effectiveMarkup, ratePhpPer1000, chargePhp, costUsd };
