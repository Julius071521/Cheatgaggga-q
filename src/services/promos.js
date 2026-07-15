'use strict';
const pool = require('../db/pool');

function round4(n) {
  return Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
}

// Look up a usable promo by code. Returns the row or throws a user-facing error.
async function findValid(code) {
  const clean = String(code || '').trim();
  if (!clean) return null;
  const [[promo]] = await pool.query('SELECT * FROM promos WHERE UPPER(code) = UPPER(?) LIMIT 1', [clean]);
  if (!promo) throw new Error('That promo code does not exist.');
  if (promo.active !== undefined && Number(promo.active) === 0) throw new Error('That promo code is no longer active.');
  if (promo.expires_at && new Date(promo.expires_at).getTime() < Date.now()) throw new Error('That promo code has expired.');
  const maxUses = Number(promo.max_uses) || 0; // 0 = unlimited
  if (maxUses > 0 && Number(promo.uses) >= maxUses) throw new Error('That promo code has reached its usage limit.');
  return promo;
}

// Discount (PHP) for a given base charge. Percentage promos are capped by
// max_discount_amount; a discount never exceeds the charge itself.
function computeDiscount(promo, baseCharge) {
  const base = Number(baseCharge);
  const type = String(promo.type || 'percentage').toLowerCase();
  let discount;
  if (type === 'fixed' || type === 'amount') {
    discount = Number(promo.value);
  } else {
    discount = base * (Number(promo.value) / 100);
  }
  if (promo.max_discount_amount != null && Number(promo.max_discount_amount) > 0) {
    discount = Math.min(discount, Number(promo.max_discount_amount));
  }
  discount = Math.min(discount, base);
  return round4(Math.max(0, discount));
}

// Called inside the order transaction: bump usage + record the redemption.
async function redeem(conn, promo, userId, orderCode) {
  await conn.query('UPDATE promos SET uses = COALESCE(uses,0) + 1 WHERE id = ?', [promo.id]);
  await conn.query(
    'INSERT INTO promo_redemptions (user_id, code, order_id) VALUES (?, ?, ?)',
    [userId, promo.code, orderCode]
  );
}

module.exports = { findValid, computeDiscount, redeem, round4 };
