'use strict';
const env = require('../config/env');

// Round to 4 decimals to match the DECIMAL(15,4) money columns.
function toMoney(n, decimals = 4) {
  const f = Math.pow(10, decimals);
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
}

function effectiveMarkup(service) {
  const override = service && service.markup_override;
  if (override !== null && override !== undefined && override !== '') {
    const n = Number(override);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return env.SERVICE_MARKUP_MULTIPLIER;
}

// Selling rate in PHP per 1000 units.
function ratePhpPer1000(service) {
  return toMoney(Number(service.rate_usd) * effectiveMarkup(service) * env.USD_TO_PHP_RATE);
}

// Provider cost in PHP per 1000 units.
function costPhpPer1000(service) {
  return toMoney(Number(service.rate_usd) * env.USD_TO_PHP_RATE);
}

// Full quote for a quantity — mirrors the existing app's profit analytics so
// the orders table's api_cost / selling_price / net_profit / *_percent columns
// stay consistent.
function quote(service, quantity) {
  const qtyFactor = Number.isFinite(quantity) && quantity > 0 ? quantity / 1000 : 0;
  const apiCost = toMoney(costPhpPer1000(service) * qtyFactor);
  const sellingPrice = toMoney(Math.max(ratePhpPer1000(service) * qtyFactor, env.MIN_ORDER_CHARGE_PHP));
  const netProfit = toMoney(sellingPrice - apiCost);
  const markupPercent = apiCost > 0 ? toMoney((netProfit / apiCost) * 100, 2) : 0;
  const roiPercent = markupPercent;
  const profitMarginPercent = sellingPrice > 0 ? toMoney((netProfit / sellingPrice) * 100, 2) : 0;
  return { charge: sellingPrice, apiCost, sellingPrice, netProfit, markupPercent, roiPercent, profitMarginPercent };
}

// Convenience: total PHP charge for a quantity.
function chargePhp(service, quantity) {
  return quote(service, quantity).charge;
}

module.exports = { toMoney, effectiveMarkup, ratePhpPer1000, costPhpPer1000, quote, chargePhp };
