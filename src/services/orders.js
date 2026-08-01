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
async function placeOrder(user, service, link, quantity, promoCode, opts = {}) {
  const env0 = require('../config/env');
  // Optional drip-feed (only when the service supports it and both fields given).
  let runs = null;
  let interval = null;
  if (service.dripfeed && opts.runs && opts.interval) {
    runs = Math.min(100, Math.max(2, parseInt(opts.runs, 10) || 0));
    interval = Math.min(1440, Math.max(1, parseInt(opts.interval, 10) || 0));
    if (!runs || !interval) { runs = null; interval = null; }
  }
  // Optional guard: pause ordering on a provider whose upstream funds are
  // critically low (below threshold), instead of failing after the debit.
  if (env0.PROVIDER_BLOCK_ORDERS_BELOW_THRESHOLD && env0.PROVIDER_LOW_BALANCE_THRESHOLD_PHP > 0) {
    try {
      const [[prov]] = await pool.query('SELECT balance_usd FROM providers WHERE id = ?', [service.provider_id]);
      if (prov && prov.balance_usd !== null &&
          Number(prov.balance_usd) * env0.USD_TO_PHP_RATE < env0.PROVIDER_LOW_BALANCE_THRESHOLD_PHP) {
        throw new Error('Ordering for this service is temporarily paused while we top up capacity. Please try again shortly.');
      }
    } catch (err) {
      if (String(err.message).includes('temporarily paused')) throw err;
      // A lookup failure must never block ordering.
    }
  }

  const q = pricing.quote(service, quantity);
  const orderCode = newOrderCode();
  const providerName = service.provider_code === 'smmworld' ? 'SMMWorld' : 'RKDPanel';

  // Optional promo/coupon discount (validated up front; errors bubble to caller).
  let promo = null;
  let discount = 0;
  if (promoCode) {
    promo = await promos.findValid(promoCode);
    if (promo) {
      // One redemption per customer — check up front so they get a clear
      // message instead of a crash at the unique-key inside the transaction.
      const [[used]] = await pool.query(
        'SELECT 1 AS x FROM promo_redemptions WHERE user_id = ? AND code = ? LIMIT 1', [user.id, promo.code]);
      if (used) throw new Error('You have already used this promo code. Promo codes work once per account.');
      discount = promos.computeDiscount(promo, q.sellingPrice);
    }
  }
  const finalCharge = promos.round4(Math.max(0, q.sellingPrice - discount));
  const netProfit = promos.round4(finalCharge - q.apiCost);

  let orderId;
  let publicCode = '';
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const clientOrderId = opts.clientOrderId ? String(opts.clientOrderId).slice(0, 64) : null;
    const [result] = await conn.query(
      `INSERT INTO orders
         (order_id, user_id, service_id, service_name, url, quantity, charge, status, currency,
          api_cost, selling_price, markup_percent, net_profit, roi_percent, profit_margin_percent,
          api_provider, original_charge, discount_amount, coupon_code, start_count, remains, runs, interval_minutes, client_order_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0', ?, ?, ?, ?)`,
      [
        orderCode, user.id, String(service.provider_service_id), String(service.name).slice(0, 255),
        link, quantity, finalCharge.toFixed(4), (require('../config/env').SITE_CURRENCY || 'PHP'),
        q.apiCost.toFixed(4), q.sellingPrice.toFixed(4), q.markupPercent.toFixed(2),
        netProfit.toFixed(4), q.roiPercent.toFixed(2), q.profitMarginPercent.toFixed(2),
        providerName, q.sellingPrice.toFixed(4), discount.toFixed(4), promo ? promo.code : null, String(quantity),
        runs, interval, clientOrderId,
      ]
    );
    orderId = result.insertId;
    // The public code is derived from the row id, so it can only be set once
    // the insert has one. legacy_code keeps the old APX-<ts>-<rand> value so
    // older emails, notifications and ledger rows still resolve.
    publicCode = `APX-${String(orderId).padStart(6, '0')}`;
    await conn.query(
      'UPDATE orders SET public_code = ?, legacy_code = ?, provider_key = ? WHERE id = ?',
      [publicCode, orderCode, service.provider_code === 'smmworld' ? 'smmworld' : 'rkd', orderId]);
    await applyBalanceChange(conn, user.id, -finalCharge, 'order', `Order ${publicCode} — ${String(service.name).slice(0, 60)}`);
    if (promo) await promos.redeem(conn, promo, user.id, orderCode);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    conn.release();
    // Idempotency: a retried request with the same client_order_id hits the
    // unique key — return the ORIGINAL order instead of charging again.
    if (err.code === 'ER_DUP_ENTRY' && String(err.message).includes('uniq_client_order') && opts.clientOrderId) {
      const [[existing]] = await pool.query(
        'SELECT id, order_id, public_code, charge FROM orders WHERE user_id = ? AND client_order_id = ? LIMIT 1',
        [user.id, String(opts.clientOrderId).slice(0, 64)]);
      if (existing) return { orderId: existing.id, orderCode: existing.public_code || existing.order_id, publicCode: existing.public_code, charge: Number(existing.charge), discount: 0, duplicate: true };
    }
    // Two simultaneous orders racing the same promo hit the unique key —
    // surface it as the same friendly message (nothing was charged).
    if (err.code === 'ER_DUP_ENTRY' && String(err.message).includes('promo_redemption')) {
      throw new Error('You have already used this promo code. Promo codes work once per account.');
    }
    throw err;
  }
  conn.release();

  const client = getClient(service.provider_code);
  try {
    if (!client) throw new Error('Provider is not configured');
    const res = await client.addOrder({ service: service.provider_service_id, link, quantity, runs, interval });
    if (!res || res.order === undefined) throw new Error('Provider did not return an order id');
    try {
      await pool.query(
        'UPDATE orders SET provider_order_id = ?, last_synced_at = NOW() WHERE id = ?',
        [String(res.order), orderId]);
    } catch (bindErr) {
      // The composite unique key (provider_key, provider_order_id) rejected it:
      // this upstream order is already bound to a different local row, which
      // means the provider echoed an existing id — almost always a retry of a
      // request that already succeeded. Refunding is right; say so precisely so
      // it can be reconciled instead of looking like a generic failure.
      if (bindErr && bindErr.code === 'ER_DUP_ENTRY') {
        console.error(`[orders] provider ${service.provider_code} returned already-bound order id ${res.order} for local order ${orderId} — treating as duplicate submission`);
        throw new Error(`Provider returned an order id that is already in use (${res.order})`);
      }
      throw bindErr;
    }
    return { orderId, orderCode: publicCode, publicCode, legacyCode: orderCode, charge: finalCharge, discount };
  } catch (err) {
    const msg = String(err.message || '');
    await refundOrder(orderId, `Provider error: ${msg}`);
    // If the provider says the service no longer exists / is invalid, stop
    // selling it so customers don't keep hitting the same failure. Reversible:
    // re-syncing the provider re-enables valid services.
    if (isStaleServiceError(msg)) {
      await disableStaleService(service, msg).catch(() => {});
      const e = new Error('Sorry, this service is currently unavailable and has been removed from the catalog. Your balance was fully refunded — please choose another service.');
      e.orderId = orderId; e.staleService = true;
      throw e;
    }
    const e = new Error('The order could not be sent to the provider. Your balance was refunded — please try again later.');
    e.orderId = orderId;
    throw e;
  }
}

// Provider errors that mean the service ID is wrong/gone (not a transient glitch).
function isStaleServiceError(msg) {
  return /incorrect service id|service not found|invalid service|no such service|service (is )?(inactive|disabled|not exist)|unknown service/i.test(String(msg));
}

// Disable a service the provider rejected, and alert the admin once (deduped by
// the service's enabled flag — we only alert when it was still enabled).
async function disableStaleService(service, msg) {
  if (!service || !service.id) return;
  const [r] = await pool.query('UPDATE services SET enabled = 0 WHERE id = ? AND enabled = 1', [service.id]);
  if (!r.affectedRows) return; // already disabled — don't re-alert
  const name = String(service.name || `service #${service.id}`).slice(0, 80);
  const title = 'Service auto-disabled ⚠️';
  const body = `"${name}" was auto-disabled — the provider rejected it (${msg.slice(0, 80)}). It stopped selling so customers don't keep failing. Re-sync the provider to refresh IDs, then re-enable if it's back.`;
  try {
    const notifications = require('./notifications');
    const [admins] = await pool.query("SELECT id FROM users WHERE role IN ('admin','super_admin')");
    await Promise.all(admins.map((a) => notifications.notifyUser(a.id, 'autopilot', title, body)));
  } catch (_) { /* best effort */ }
  try {
    const telegram = require('./telegram');
    if (telegram.enabled) telegram.send(`⚠️ <b>${telegram.esc(title)}</b>\n${telegram.esc(body)}`).catch(() => {});
  } catch (_) { /* telegram optional */ }
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

// Admin/watchdog refund: returns the still-unrefunded portion of an order's
// charge to the wallet, marks it Canceled, and best-effort cancels it upstream.
// Idempotent — a fully-refunded order is left untouched. Returns the refunded
// amount (0 if nothing was owed).
async function adminRefund(orderId, reason, adminId = null, markStuck = false) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[order]] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    if (!order) { await conn.rollback(); return { refunded: 0, skipped: 'not found' }; }
    const charge = toUnits(order.charge);
    const already = toUnits(order.refund_amount || 0);
    const owed = Math.max(0, charge - already);
    if (owed <= 0) { await conn.rollback(); return { refunded: 0, skipped: 'already refunded' }; }

    await applyBalanceChange(conn, order.user_id, Number(unitsToStr(owed)), 'refund',
      `Refund for order ${order.order_id}${reason ? ' — ' + String(reason).slice(0, 80) : ''}`);
    await conn.query(
      `UPDATE orders SET status = 'Canceled', refund_amount = ?, refunded_at = NOW(),
         ${markStuck ? 'stuck_refunded_at = NOW(),' : ''} admin_notes = ? WHERE id = ?`,
      [unitsToStr(charge), String(reason || 'Refunded by admin').slice(0, 500), orderId]);
    await conn.commit();

    // Best-effort upstream cancel so we don't keep paying the provider for it.
    if (order.provider_order_id) {
      const code = order.api_provider === 'SMMWorld' ? 'smmworld' : 'rkd';
      const client = getClient(code);
      if (client) { try { await client.cancel(order.provider_order_id); } catch (_) { /* non-fatal */ } }
    }
    return { refunded: Number(unitsToStr(owed)), orderCode: order.order_id, userId: order.user_id };
  } catch (err) {
    await conn.rollback();
    console.error(`[orders] adminRefund for ${orderId} failed:`, err.message);
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

  // completed_at is what the refill eligibility rule reads (providers only
  // accept a refill some hours after completion), so stamp it on the
  // transition and never move it once set.
  await pool.query(
    `UPDATE orders SET status = ?, start_count = ?, remains = ?, last_synced_at = NOW(),
            completed_at = IF(? = 'Completed' AND completed_at IS NULL, NOW(), completed_at)
      WHERE id = ?`,
    [status, startCount, remainsStr, status, order.id]);

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

module.exports = { placeOrder, refundOrder, adminRefund, applyStatusUpdate, syncOrderById, syncOpenOrders, mapProviderStatus, isStaleServiceError, disableStaleService, OPEN_STATUSES };
