'use strict';
// Self-service refill and cancel.
//
// These used to be support tickets: the customer wrote a message, autopilot
// guessed the intent and forwarded it once, and a transient provider error
// ("Cancel unavailable. Try again later.") left the ticket open forever. Now
// the customer presses a button, the request is checked against the service's
// own capability flags and the provider's timing rules BEFORE it is sent, and
// anything that fails transiently is retried on a backoff until it succeeds or
// is given up on cleanly.
const pool = require('../db/pool');
const { getClient } = require('../providers');
const notifications = require('./notifications');

// The provider only accepts a refill once the order has been complete for a
// while; asking sooner is a guaranteed rejection.
const REFILL_WAIT_HOURS = 24;
const MAX_ATTEMPTS = 6;
// 2m, 8m, 30m, 2h, 8h — long enough to outlast a provider outage.
const BACKOFF_MINUTES = [2, 8, 30, 120, 480];

const OPEN_STATUSES = ['Pending', 'In progress', 'Processing'];

// Provider strings that mean "not now" rather than "never". Only these are
// worth retrying; a hard rejection should stop immediately.
const TRANSIENT = /(try again later|unavailable|timeout|timed out|temporarily|rate limit|too many requests|socket hang up|ECONNRESET|ETIMEDOUT|502|503|504)/i;
// Strings that mean the request will never succeed for this order.
const PERMANENT = /(refill is disabled|not completed|less than 24 hours|incorrect order|order not found|no refill)/i;

function classify(message) {
  const m = String(message || '');
  if (PERMANENT.test(m)) return 'permanent';
  if (TRANSIENT.test(m)) return 'transient';
  return 'transient'; // unknown errors get the benefit of a retry
}

// What the customer is allowed to do with this order right now, and why not.
// The service's own refill/cancelable flags come from the provider's services
// payload, so this matches what the upstream will actually accept.
async function eligibility(order) {
  const [[svc]] = await pool.query(
    `SELECT s.refill, s.cancelable FROM services s
       JOIN providers p ON p.id = s.provider_id
      WHERE CONVERT(s.provider_service_id USING utf8mb4) COLLATE utf8mb4_bin =
            CONVERT(? USING utf8mb4) COLLATE utf8mb4_bin
        AND p.code = ? LIMIT 1`,
    [String(order.service_id), order.provider_key || 'rkd']);

  const [[live]] = await pool.query(
    "SELECT kind, status FROM order_actions WHERE order_id = ? AND live_key IS NOT NULL LIMIT 1", [order.id]);

  const out = {
    canRefill: false, refillReason: '', refillAvailableAt: null,
    canCancel: false, cancelReason: '',
    pending: live ? live.kind : null,
  };

  if (!order.provider_order_id) {
    out.refillReason = 'This order has not reached our network yet.';
    out.cancelReason = out.refillReason;
    return out;
  }
  if (live) {
    const label = live.kind === 'refill' ? 'A refill' : 'A cancellation';
    out.refillReason = `${label} is already in progress for this order.`;
    out.cancelReason = out.refillReason;
    return out;
  }

  // ── Refill ──
  if (!svc || !svc.refill) {
    out.refillReason = 'This service does not offer refills.';
  } else if (String(order.status) !== 'Completed') {
    out.refillReason = 'Refills are available once the order is completed.';
  } else {
    const completedAt = order.completed_at ? new Date(order.completed_at) : null;
    if (completedAt) {
      const readyAt = new Date(completedAt.getTime() + REFILL_WAIT_HOURS * 3600 * 1000);
      if (readyAt > new Date()) {
        out.refillAvailableAt = readyAt;
        out.refillReason = `Refills open ${REFILL_WAIT_HOURS} hours after completion.`;
      } else {
        out.canRefill = true;
      }
    } else {
      out.canRefill = true; // completed before we started stamping the time
    }
  }

  // ── Cancel ──
  if (!svc || !svc.cancelable) {
    out.cancelReason = 'This service cannot be cancelled once submitted.';
  } else if (!OPEN_STATUSES.includes(String(order.status))) {
    out.cancelReason = 'Only orders that are still running can be cancelled.';
  } else {
    out.canCancel = true;
  }
  return out;
}

// Queue a request. Returns { ok, actionId, message }. The unique key on
// live_key is what makes a double-click harmless.
async function request(order, kind) {
  const elig = await eligibility(order);
  if (kind === 'refill' && !elig.canRefill) return { ok: false, message: elig.refillReason || 'Refill is not available for this order.' };
  if (kind === 'cancel' && !elig.canCancel) return { ok: false, message: elig.cancelReason || 'Cancellation is not available for this order.' };

  try {
    const [res] = await pool.query(
      `INSERT INTO order_actions (order_id, user_id, kind, status, next_attempt_at, live_key)
       VALUES (?, ?, ?, 'queued', NOW(), ?)`,
      [order.id, order.user_id, kind, `${order.id}:${kind}`]);
    // Try immediately so the customer usually sees a result on the next page.
    const outcome = await attempt(res.insertId);
    return { ok: true, actionId: res.insertId, ...outcome };
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return { ok: false, message: 'That request is already in progress for this order.' };
    }
    throw err;
  }
}

// Send one attempt to the provider and record the result.
async function attempt(actionId) {
  const [[a]] = await pool.query('SELECT * FROM order_actions WHERE id = ?', [actionId]);
  if (!a || !['queued', 'sent'].includes(a.status)) return { message: '' };

  const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ?', [a.order_id]);
  if (!order) return { message: '' };
  const client = getClient(order.provider_key === 'smmworld' ? 'smmworld' : 'rkd');
  if (!client) return { message: 'Provider is not configured.' };

  const attempts = a.attempts + 1;
  try {
    let resp; let refillId = null;
    if (a.kind === 'refill') {
      resp = await client.refill(order.provider_order_id);
      const raw = resp && resp.refill !== undefined ? resp.refill
        : (Array.isArray(resp) && resp[0] ? resp[0].refill : undefined);
      if (raw !== undefined && raw !== null) refillId = String(raw).slice(0, 64);
      // Some providers report failure inside a 200 body.
      if (resp && resp.error) throw new Error(String(resp.error));
    } else {
      resp = await client.cancel(order.provider_order_id);
      const first = Array.isArray(resp) ? resp[0] : resp;
      if (first && first.error) throw new Error(String(first.error));
    }

    await pool.query(
      `UPDATE order_actions SET status = 'sent', attempts = ?, provider_refill_id = COALESCE(?, provider_refill_id),
              provider_response = ?, last_error = NULL, next_attempt_at = NULL WHERE id = ?`,
      [attempts, refillId, JSON.stringify(resp).slice(0, 2000), actionId]);
    if (refillId) {
      await pool.query('UPDATE orders SET refill_id = ?, refill_status = ? WHERE id = ?',
        [refillId, 'Pending', order.id]);
    }
    return {
      message: a.kind === 'refill'
        ? 'Refill requested — we will keep checking and update you when the provider finishes it.'
        : 'Cancellation requested. If the order has not started, the charge is refunded automatically.',
    };
  } catch (err) {
    const kindOfError = classify(err.message);
    const giveUp = kindOfError === 'permanent' || attempts >= MAX_ATTEMPTS;
    if (giveUp) {
      // Record the attempt before closing out, or the history table claims we
      // never tried.
      await pool.query('UPDATE order_actions SET attempts = ? WHERE id = ?', [attempts, actionId]);
      await finish(actionId, kindOfError === 'permanent' ? 'rejected' : 'failed', err.message);
      return { message: friendlyFailure(a.kind, err.message) };
    }
    const wait = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];
    await pool.query(
      `UPDATE order_actions SET status = 'queued', attempts = ?, last_error = ?,
              next_attempt_at = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?`,
      [attempts, String(err.message).slice(0, 255), wait, actionId]);
    return {
      message: a.kind === 'refill'
        ? 'The provider is busy right now — your refill is queued and will be retried automatically.'
        : 'The provider is busy right now — your cancellation is queued and will be retried automatically.',
    };
  }
}

function friendlyFailure(kind, raw) {
  const m = String(raw || '');
  if (/refill is disabled/i.test(m)) return 'This service does not support refills.';
  if (/not completed/i.test(m)) return 'The order has to finish before a refill can be requested.';
  if (/less than 24 hours/i.test(m)) return 'A refill can only be requested 24 hours after the order completes.';
  return kind === 'refill'
    ? 'We could not get a refill through for this order. Our team has been notified.'
    : 'We could not cancel this order with the provider. Our team has been notified.';
}

// Close an action out: clear live_key so a new request is allowed, tell the
// customer, and refund a cancelled order that never started.
async function finish(actionId, status, error = null) {
  const [[a]] = await pool.query('SELECT * FROM order_actions WHERE id = ?', [actionId]);
  if (!a) return;
  await pool.query(
    'UPDATE order_actions SET status = ?, last_error = ?, live_key = NULL, next_attempt_at = NULL WHERE id = ?',
    [status, error ? String(error).slice(0, 255) : null, actionId]);

  const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ?', [a.order_id]);
  if (!order) return;
  const code = order.public_code || order.order_id;

  if (a.kind === 'cancel' && status === 'completed') {
    // Provider confirmed the cancel. Refund whatever was not delivered.
    await require('./orders').adminRefund(order.id, `Cancelled at customer request (${code})`, null)
      .catch(() => {});
  }
  if (['failed', 'rejected'].includes(status)) {
    // A cancel that never reached the provider on an order that never started
    // still owes the customer their money.
    if (a.kind === 'cancel' && Number(order.start_count || 0) === 0
        && OPEN_STATUSES.includes(String(order.status))) {
      await require('./orders').adminRefund(order.id, `Auto-refund: cancel could not be completed (${code})`, null)
        .catch(() => {});
      await notifications.notifyUser(order.user_id, 'order', 'Order refunded ↩️',
        `We could not cancel ${code} with our network, and it had not started — so it has been refunded to your wallet in full.`).catch(() => {});
      return;
    }
    await notifications.notifyUser(order.user_id, 'order',
      a.kind === 'refill' ? 'Refill could not be completed' : 'Cancellation could not be completed',
      `${friendlyFailure(a.kind, error)} (order ${code})`).catch(() => {});
  }
}

// Retry everything that is due, then poll refills that are in flight.
// Bounded per pass so one tick cannot run long.
async function processQueue(limit = 25) {
  const [due] = await pool.query(
    `SELECT id FROM order_actions
      WHERE status = 'queued' AND next_attempt_at IS NOT NULL AND next_attempt_at <= NOW()
      ORDER BY next_attempt_at LIMIT ?`, [limit]);
  let retried = 0;
  for (const row of due) { await attempt(row.id); retried += 1; }

  // Refills the provider accepted — ask how they are doing.
  const [inFlight] = await pool.query(
    `SELECT a.id, a.provider_refill_id, o.provider_key, o.id AS order_id
       FROM order_actions a JOIN orders o ON o.id = a.order_id
      WHERE a.kind = 'refill' AND a.status = 'sent' AND a.provider_refill_id IS NOT NULL
      LIMIT ?`, [limit]);
  let resolved = 0;
  for (const r of inFlight) {
    const client = getClient(r.provider_key === 'smmworld' ? 'smmworld' : 'rkd');
    if (!client) continue;
    try {
      const resp = await client.refillStatus(r.provider_refill_id);
      const status = String((resp && (resp.status || resp.refill_status)) || '').trim();
      if (!status) continue;
      await pool.query('UPDATE orders SET refill_status = ? WHERE id = ?', [status.slice(0, 32), r.order_id]);
      if (/^completed$/i.test(status)) {
        await finish(r.id, 'completed');
        await notifications.notifyUser(
          (await pool.query('SELECT user_id FROM orders WHERE id = ?', [r.order_id]))[0][0].user_id,
          'order', 'Refill completed ✅', 'Your refill has been delivered.').catch(() => {});
        resolved += 1;
      } else if (/^(rejected|canceled|cancelled|error|fail)/i.test(status)) {
        await finish(r.id, 'rejected', `Provider refill status: ${status}`);
        resolved += 1;
      }
    } catch (_) { /* transient — try again next pass */ }
  }

  // Cancels the provider accepted: confirmed once the order stops running.
  const [sentCancels] = await pool.query(
    `SELECT a.id, o.status FROM order_actions a JOIN orders o ON o.id = a.order_id
      WHERE a.kind = 'cancel' AND a.status = 'sent' LIMIT ?`, [limit]);
  for (const c of sentCancels) {
    if (['Canceled', 'Cancelled', 'Partial'].includes(String(c.status))) {
      await finish(c.id, 'completed');
      resolved += 1;
    }
  }

  return { retried, resolved };
}

module.exports = {
  eligibility, request, attempt, processQueue, finish,
  REFILL_WAIT_HOURS, MAX_ATTEMPTS,
};
