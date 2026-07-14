'use strict';
const pool = require('../db/pool');
const pricing = require('./pricing');
const { getClient } = require('../providers');
const { applyBalanceChange } = require('./wallet');
const { toCents, centsToPhp } = require('../utils/helpers');

const STATUS_MAP = {
  pending: 'pending',
  'in progress': 'in_progress',
  inprogress: 'in_progress',
  processing: 'processing',
  completed: 'completed',
  complete: 'completed',
  partial: 'partial',
  canceled: 'canceled',
  cancelled: 'canceled',
  refunded: 'canceled',
  fail: 'failed',
  failed: 'failed',
};

function mapProviderStatus(raw) {
  return STATUS_MAP[String(raw || '').trim().toLowerCase()] || null;
}

// Place an order: debit wallet + create the local order atomically, then call the
// provider. If the provider call fails, the charge is refunded automatically.
async function placeOrder(userId, service, link, quantity) {
  const charge = pricing.chargePhp(service, quantity);
  const cost = pricing.costUsd(service, quantity);

  let orderId;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO orders (user_id, service_id, link, quantity, charge_php, cost_usd, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [userId, service.id, link, quantity, charge.toFixed(2), cost.toFixed(6)]
    );
    orderId = result.insertId;
    await applyBalanceChange(conn, userId, -charge, 'order', 'order', orderId,
      `Order #${orderId} — ${String(service.name).slice(0, 80)}`);
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
    const res = await client.addOrder({
      service: service.provider_service_id,
      link,
      quantity,
    });
    if (!res || res.order === undefined) throw new Error('Provider did not return an order id');
    await pool.query('UPDATE orders SET provider_order_id = ? WHERE id = ?', [String(res.order), orderId]);
    return { orderId, charge };
  } catch (err) {
    await refundOrder(orderId, charge, `Provider error: ${err.message}`);
    const e = new Error('The order could not be sent to the provider. Your balance was refunded — please try again later.');
    e.cause = err;
    e.orderId = orderId;
    throw e;
  }
}

// Full refund used when the provider add call fails.
async function refundOrder(orderId, amountPhp, errorMessage) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[order]] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    if (!order || order.status === 'failed') { await conn.rollback(); return; }
    await applyBalanceChange(conn, order.user_id, amountPhp, 'refund', 'order', orderId, `Refund for failed order #${orderId}`);
    await conn.query("UPDATE orders SET status = 'failed', refunded_php = ?, error = ? WHERE id = ?",
      [Number(amountPhp).toFixed(2), String(errorMessage).slice(0, 500), orderId]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    console.error(`[orders] CRITICAL: refund for order ${orderId} failed:`, err.message);
    throw err;
  } finally {
    conn.release();
  }
}

// Update one order from a provider status payload; issues partial/cancel refunds.
async function applyStatusUpdate(order, payload) {
  const status = mapProviderStatus(payload.status);
  if (!status) return order.status;

  const startCount = payload.start_count !== undefined && payload.start_count !== null
    ? parseInt(payload.start_count, 10) : null;
  const remains = payload.remains !== undefined && payload.remains !== null
    ? parseInt(payload.remains, 10) : null;

  await pool.query('UPDATE orders SET status = ?, start_count = COALESCE(?, start_count), remains = COALESCE(?, remains) WHERE id = ?',
    [status, Number.isNaN(startCount) ? null : startCount, Number.isNaN(remains) ? null : remains, order.id]);

  // Refund unspent remains once, when the order lands in a terminal refundable state.
  if ((status === 'partial' || status === 'canceled') && toCents(order.refunded_php) === 0) {
    let refundCents;
    if (status === 'canceled' && (remains === null || Number.isNaN(remains))) {
      refundCents = toCents(order.charge_php);
    } else {
      const safeRemains = Math.min(order.quantity, Math.max(0, remains || 0));
      refundCents = Math.round((toCents(order.charge_php) * safeRemains) / order.quantity);
    }
    if (refundCents > 0) {
      const refund = centsToPhp(refundCents);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [[fresh]] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [order.id]);
        if (toCents(fresh.refunded_php) === 0) {
          await applyBalanceChange(conn, order.user_id, refund, 'refund', 'order', order.id,
            `Refund (${status}) for order #${order.id}`);
          await conn.query('UPDATE orders SET refunded_php = ? WHERE id = ?', [refund, order.id]);
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
  const [[order]] = await pool.query(
    `SELECT o.*, p.code AS provider_code
     FROM orders o JOIN services s ON s.id = o.service_id JOIN providers p ON p.id = s.provider_id
     WHERE o.id = ?`, [orderId]);
  if (!order || !order.provider_order_id) return null;
  if (['completed', 'canceled', 'failed', 'partial'].includes(order.status)) return order.status;

  const client = getClient(order.provider_code);
  if (!client) return order.status;
  const payload = await client.orderStatus(order.provider_order_id);
  return applyStatusUpdate(order, payload);
}

// Batch sync of all open orders (used by the cron job and the admin panel).
async function syncOpenOrders(limit = 200) {
  const [orders] = await pool.query(
    `SELECT o.*, p.code AS provider_code
     FROM orders o JOIN services s ON s.id = o.service_id JOIN providers p ON p.id = s.provider_id
     WHERE o.provider_order_id IS NOT NULL
       AND o.status IN ('pending','in_progress','processing')
     ORDER BY o.updated_at ASC
     LIMIT ?`, [limit]);

  const byProvider = {};
  for (const o of orders) (byProvider[o.provider_code] ||= []).push(o);

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
          if (payload && !payload.error) {
            await applyStatusUpdate(order, payload);
            updated += 1;
          }
        }
      } catch (err) {
        console.warn(`[orders] Batch status for ${code} failed, falling back to singles: ${err.message}`);
        for (const order of chunk) {
          try {
            const payload = await client.orderStatus(order.provider_order_id);
            await applyStatusUpdate(order, payload);
            updated += 1;
          } catch (e) {
            console.warn(`[orders] Status for order ${order.id} failed: ${e.message}`);
          }
        }
      }
    }
  }
  return { checked: orders.length, updated };
}

module.exports = { placeOrder, refundOrder, syncOrderById, syncOpenOrders, mapProviderStatus };
