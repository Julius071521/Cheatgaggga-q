'use strict';
const pool = require('../db/pool');
const pricing = require('./pricing');
const promos = require('./promos');
const { getClient } = require('../providers');
const { applyBalanceChange, toUnits, unitsToStr } = require('./wallet');

// Canonical statuses match the existing production data (capitalized).
const STATUS_MAP = {
  pending: 'Pending',
  'in progress': 'In progress', inprogress: 'In progress', 'in-progress': 'In progress',
  processing: 'Processing',
  completed: 'Completed', complete: 'Completed',
  partial: 'Partial',
  canceled: 'Canceled', cancelled: 'Canceled', refunded: 'Canceled',
  fail: 'Failed', failed: 'Failed', error: 'Failed',
};
const OPEN_STATUSES = ['Pending', 'In progress', 'Processing'];
const REFUNDABLE = ['Partial', 'Canceled'];

function mapProviderStatus(raw) {
  return STATUS_MAP[String(raw || '').trim().toLowerCase()] || null;
}

function newOrderCode() {
  return `APX-${Date.now()}-${Math.floor(Math.random() * 900 + 100)}`;
}

// Place an order: debit wallet + create the local order atomically, then send
// it to the provider. On provider failure the charge is auto-refunded.
async function placeOrder(user, service, link, quantity, promoCode) {
  const q = pricing.quote(service, quantity);
  const orderCode = newOrderCode();
  const providerName = service.provider_code === 'smmworld' ? 'SMMWorld' : 'RKDPanel';

  // Optional promo/coupon discount (validated up front; errors bubble to caller).
  let promo = null;
  let discount = 0;
  if (promoCode) {
    promo = await promos.findValid(promoCode);
    if (promo) discount = promos.computeDiscount(promo, q.sellingPrice);
  }
  const finalCharge = promos.round4(Math.max(0, q.sellingPrice - discount));
  const netProfit = promos.round4(finalCharge - q.apiCost);

  let orderId;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO orders
         (order_id, user_id, service_id, service_name, url, quantity, charge, status, currency,
          api_cost, selling_price, markup_percent, net_profit, roi_percent, profit_margin_percent,
          api_provider, original_charge, discount_amount, coupon_code, start_count, remains)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0', ?)`,
      [
        orderCode, user.id, String(service.provider_service_id), String(service.name).slice(0, 255),
        link, quantity, finalCharge.toFixed(4), (require('../config/env').SITE_CURRENCY || 'PHP'),
        q.apiCost.toFixed(4), q.sellingPrice.toFixed(4), q.markupPercent.toFixed(2),
        netProfit.toFixed(4), q.roiPercent.toFixed(2), q.profitMarginPercent.toFixed(2),
        providerName, q.sellingPrice.toFixed(4), discount.toFixed(4), promo ? promo.code : null, String(quantity),
      ]
    );
    orderId = result.insertId;
    await applyBalanceChange(conn, user.id, -finalCharge, 'order', `Order ${orderCode} — ${String(service.name).slice(0, 60)}`);
    if (promo) await promos.redeem(conn, promo, user.id, orderCode);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    conn.release();
    throw err;
  }
  conn.release();

  const client = getClient(service.provider_code);
  try {
    if (!client) throw new Error('Provider is not configured');
    const res = await client.addOrder({ service: service.provider_service_id, link, quantity });
    if (!res || res.order === undefined) throw new Error('Provider did not return an order id');
    await pool.query('UPDATE orders SET provider_order_id = ? WHERE id = ?', [String(res.order), orderId]);
    return { orderId, orderCode, charge: finalCharge, discount };
  } catch (err) {
    await refundOrder(orderId, `Provider error: ${err.message}`);
    const e = new Error('The order could not be sent to the provider. Your balance was refunded — please try again later.');
    e.orderId = orderId;
    throw e;
  }
}

// Full refund used when the provider add call fails.
async function refundOrder(orderId, errorMessage) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[order]] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    if (!order || order.status === 'Failed') { await conn.rollback(); return; }
    await applyBalanceChange(conn, order.user_id, Number(order.charge), 'refund', `Refund for failed order ${order.order_id}`);
    await conn.query(
      "UPDATE orders SET status = 'Failed', refund_amount = ?, refunded_at = NOW(), admin_notes = ? WHERE id = ?",
      [Number(order.charge).toFixed(4), String(errorMessage).slice(0, 500), orderId]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    console.error(`[orders] CRITICAL: refund for order ${orderId} failed:`, err.message);
    throw err;
  } finally {
    conn.release();
  }
}

// Apply a provider status payload to one order; issues partial/cancel refunds once.
async function applyStatusUpdate(order, payload) {
  const status = mapProviderStatus(payload.status);
  if (!status) return order.status;

  const startCount = payload.start_count !== undefined && payload.start_count !== null ? String(payload.start_count) : order.start_count;
  const remainsRaw = payload.remains !== undefined && payload.remains !== null ? parseInt(payload.remains, 10) : null;
  const remainsStr = remainsRaw !== null && !Number.isNaN(remainsRaw) ? String(remainsRaw) : order.remains;

  await pool.query('UPDATE orders SET status = ?, start_count = ?, remains = ? WHERE id = ?',
    [status, startCount, remainsStr, order.id]);

  const alreadyRefunded = toUnits(order.refund_amount || 0) > 0;
  if (REFUNDABLE.includes(status) && !alreadyRefunded) {
    const qty = Number(order.quantity) || 0;
    let refundUnits;
    if (status === 'Canceled' && (remainsRaw === null || Number.isNaN(remainsRaw))) {
      refundUnits = toUnits(order.charge);
    } else {
      const safeRemains = Math.min(qty, Math.max(0, remainsRaw || 0));
      refundUnits = qty > 0 ? Math.round((toUnits(order.charge) * safeRemains) / qty) : 0;
    }
    if (refundUnits > 0) {
      const refund = unitsToStr(refundUnits);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [[fresh]] = await conn.query('SELECT refund_amount, user_id FROM orders WHERE id = ? FOR UPDATE', [order.id]);
        if (toUnits(fresh.refund_amount || 0) === 0) {
          await applyBalanceChange(conn, fresh.user_id, Number(refund), 'refund', `Refund (${status}) for order ${order.order_id}`);
          await conn.query('UPDATE orders SET refund_amount = ?, refunded_at = NOW() WHERE id = ?', [refund, order.id]);
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        console.error(`[orders] Refund on ${status} failed for order ${order.id}:`, err.message);
      } finally {
        conn.release();
      }
    }
  }
  return status;
}

async function syncOrderById(orderId) {
  const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order || !order.provider_order_id) return null;
  if (!OPEN_STATUSES.includes(order.status)) return order.status;
  const code = order.api_provider === 'SMMWorld' ? 'smmworld' : 'rkd';
  const client = getClient(code);
  if (!client) return order.status;
  const payload = await client.orderStatus(order.provider_order_id);
  return applyStatusUpdate(order, payload);
}

// Batch sync of all open orders (cron + admin button).
async function syncOpenOrders(limit = 200) {
  const [orders] = await pool.query(
    `SELECT * FROM orders WHERE provider_order_id IS NOT NULL AND status IN ('Pending','In progress','Processing')
     ORDER BY id ASC LIMIT ?`, [limit]);

  const byProvider = {};
  for (const o of orders) {
    const code = o.api_provider === 'SMMWorld' ? 'smmworld' : 'rkd';
    (byProvider[code] ||= []).push(o);
  }

  let updated = 0;
  for (const [code, group] of Object.entries(byProvider)) {
    const client = getClient(code);
    if (!client) continue;
    for (let i = 0; i < group.length; i += 100) {
      const chunk = group.slice(i, i + 100);
      try {
        const res = await client.multiStatus(chunk.map((o) => o.provider_order_id));
        for (const order of chunk) {
          const payload = res && res[order.provider_order_id];
          if (payload && !payload.error) { await applyStatusUpdate(order, payload); updated += 1; }
        }
      } catch (err) {
        for (const order of chunk) {
          try { await applyStatusUpdate(order, await client.orderStatus(order.provider_order_id)); updated += 1; }
          catch (e) { console.warn(`[orders] status for ${order.id} failed: ${e.message}`); }
        }
      }
    }
  }
  return { checked: orders.length, updated };
}

module.exports = { placeOrder, refundOrder, applyStatusUpdate, syncOrderById, syncOpenOrders, mapProviderStatus, OPEN_STATUSES };
