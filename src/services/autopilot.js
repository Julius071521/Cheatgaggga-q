'use strict';
// ── AI Autopilot ─────────────────────────────────────────────
// First responder for customer reports + stuck-order watchdog.
// Every action is written to autopilot_log and surfaced to the
// admin (in-app notification + /admin/autopilot panel). Anything
// it can't safely resolve is escalated as "needs_admin".
const pool = require('../db/pool');
const env = require('../config/env');
const orderService = require('./orders');
const notifications = require('./notifications');
const mailer = require('./mailer');
const { getClient } = require('../providers');
const { getSetting } = require('./stats');

const OPEN = ['Pending', 'In progress', 'Processing'];
const STUCK_HOURS = env.AUTOPILOT_STUCK_HOURS;

async function isOn() {
  return ['1', 'true', 'on', 'yes'].includes(String(await getSetting('autopilot', 'on')).toLowerCase());
}

// Write one audit row. Never throws — logging must not break the main flow.
async function log(entry) {
  try {
    const [res] = await pool.query(
      `INSERT INTO autopilot_log (ticket_id, order_ref, user_id, action, detail, outcome)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [entry.ticket_id || null, entry.order_ref || null, entry.user_id || null,
        String(entry.action).slice(0, 60), entry.detail ? String(entry.detail).slice(0, 2000) : null,
        entry.outcome || 'done']);
    return res.insertId;
  } catch (err) {
    console.warn('[autopilot] log failed:', err.message);
    return null;
  }
}

// In-app note to every admin account (+ optional email for escalations).
async function notifyAdmins(title, message, email = false) {
  try {
    const [admins] = await pool.query("SELECT id FROM users WHERE role IN ('admin', 'super_admin')");
    await Promise.all(admins.map((a) => notifications.notifyUser(a.id, 'autopilot', title, message)));
  } catch (err) {
    console.warn('[autopilot] notifyAdmins failed:', err.message);
  }
  if (email && env.SUPPORT_EMAIL) {
    mailer.send(env.SUPPORT_EMAIL, `[Autopilot] ${title}`, title,
      `<p>${String(message)}</p><p><a href="${env.BASE_URL}/admin/autopilot">Open the Autopilot panel</a></p>`)
      .catch(() => {});
  }
}

async function findOrderForTicket(ticket) {
  if (!ticket.order_id) return null;
  const [[order]] = await pool.query(
    'SELECT * FROM orders WHERE order_id = ? OR id = ? LIMIT 1',
    [ticket.order_id, /^\d+$/.test(String(ticket.order_id)) ? ticket.order_id : 0]);
  return order || null;
}

// Triage one ticket. Safe to call repeatedly — a ticket is only handled once.
async function handleTicket(ticketId) {
  if (!(await isOn())) return { skipped: 'autopilot off' };
  const [[ticket]] = await pool.query('SELECT * FROM tickets WHERE id = ?', [ticketId]);
  if (!ticket || ticket.ai_handled_at) return { skipped: 'missing or already handled' };
  if (['resolved', 'closed'].includes(String(ticket.status || '').toLowerCase())) return { skipped: 'closed' };

  const requestType = String(ticket.request_type || 'Other');
  const order = await findOrderForTicket(ticket);

  // Always pull a fresh provider status first so decisions use live data
  // (this alone resolves many "not completed" reports).
  let status = order ? order.status : null;
  if (order && OPEN.includes(order.status) && order.provider_order_id) {
    try { status = (await orderService.syncOrderById(order.id)) || order.status; } catch (_) { /* keep stale */ }
  }

  const client = order && order.provider_order_id
    ? getClient(order.api_provider === 'SMMWorld' ? 'smmworld' : 'rkd') : null;

  let action = 'escalated';
  let outcome = 'needs_admin';
  let ticketStatus = 'open'; // escalations stay in the open queue
  let detail = '';
  let userMsg = null;
  let providerAction = null;

  if (requestType === 'Refill' && client) {
    try {
      const resp = await client.refill(order.provider_order_id);
      action = 'refill_sent'; outcome = 'done'; ticketStatus = 'in_progress';
      providerAction = { status: 'refill_sent', response: JSON.stringify(resp).slice(0, 1000) };
      detail = `Refill sent to the provider for order ${order.order_id}.`;
      userMsg = `Good news! 🤖 A refill was requested for your order ${order.order_id}. Please allow some time for it to process — we'll keep an eye on it.`;
    } catch (err) {
      action = 'refill_failed'; detail = `Refill attempt failed for ${order.order_id}: ${err.message}`;
    }
  } else if (requestType === 'Cancel' && client) {
    try {
      const resp = await client.cancel(order.provider_order_id);
      action = 'cancel_sent'; outcome = 'done'; ticketStatus = 'in_progress';
      providerAction = { status: 'cancel_sent', response: JSON.stringify(resp).slice(0, 1000) };
      detail = `Cancel sent to the provider for order ${order.order_id}.`;
      userMsg = `Your cancel request for order ${order.order_id} was sent. 🤖 Once confirmed, the undelivered portion is refunded to your wallet automatically.`;
    } catch (err) {
      action = 'cancel_failed'; detail = `Cancel attempt failed for ${order.order_id}: ${err.message}`;
    }
  } else if (order && status === 'Completed') {
    action = 'auto_resolved'; outcome = 'done'; ticketStatus = 'resolved';
    detail = `Order ${order.order_id} now shows Completed at the provider — ticket auto-resolved.`;
    userMsg = `We checked order ${order.order_id} and it now shows ✅ Completed. If you still don't see the results after a few hours, just send another report and our team will review it personally.`;
  } else if (order && ['Partial', 'Canceled', 'Failed'].includes(status)) {
    action = 'auto_resolved'; outcome = 'done'; ticketStatus = 'resolved';
    detail = `Order ${order.order_id} ended as ${status}; the refundable portion was auto-refunded.`;
    userMsg = `Order ${order.order_id} ended as ${status}, and the undelivered portion was refunded to your wallet automatically. 💸 Thanks for your patience!`;
  } else {
    detail = order
      ? `Order ${order.order_id} is still "${status}" — "${requestType}" needs a human look.`
      : `No linked order — "${requestType}" needs a human look.`;
    userMsg = `Thanks for your report! 🤖 Our AI reviewed it and passed it to our team for personal attention. We'll update you here and by email.`;
  }

  const note = `[AI autopilot] ${detail}`;
  await pool.query(
    `UPDATE tickets SET ai_handled_at = NOW(), status = ?,
        internal_notes = CONCAT(COALESCE(internal_notes, ''), ?, '\n'),
        provider_action_status = COALESCE(?, provider_action_status),
        provider_action_response = COALESCE(?, provider_action_response)
      WHERE id = ?`,
    [ticketStatus, note, providerAction ? providerAction.status : null,
      providerAction ? providerAction.response : null, ticket.id]);

  await log({ ticket_id: ticket.id, order_ref: order ? order.order_id : ticket.order_id,
    user_id: ticket.user_id, action, detail, outcome });

  if (userMsg && ticket.user_id) {
    notifications.notifyUser(ticket.user_id, 'ticket', 'Update on your report 🤖', userMsg).catch(() => {});
  }
  if (outcome === 'needs_admin') {
    await notifyAdmins('Autopilot escalated a ticket',
      `Ticket #${ticket.id} (${requestType}): ${detail}`, true);
  } else {
    await notifyAdmins(`Autopilot: ${action.replace(/_/g, ' ')}`,
      `Ticket #${ticket.id} (${requestType}): ${detail}`);
  }
  return { action, outcome };
}

// Triage any tickets that arrived while the app was asleep/off.
// Only recent tickets — old/stale ones stay untouched for manual handling
// (never auto-fire provider actions for months-old reports).
async function processPendingTickets(limit = 10) {
  const [rows] = await pool.query(
    `SELECT id FROM tickets WHERE ai_handled_at IS NULL
       AND LOWER(COALESCE(status, 'open')) IN ('open', 'pending')
       AND created_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)
     ORDER BY id ASC LIMIT ?`, [limit]);
  let handled = 0;
  for (const row of rows) {
    try { await handleTicket(row.id); handled += 1; }
    catch (err) { console.warn(`[autopilot] ticket ${row.id} triage failed:`, err.message); }
  }
  return handled;
}

// Flag open orders that have gone quiet for too long (once per order).
async function flagStuckOrders() {
  const [stuck] = await pool.query(
    `SELECT o.* FROM orders o
      WHERE o.status IN ('Pending', 'In progress', 'Processing')
        AND o.created_at < DATE_SUB(NOW(), INTERVAL ? HOUR)
        AND NOT EXISTS (SELECT 1 FROM autopilot_log l
                        WHERE l.order_ref = o.order_id AND l.action = 'stuck_flagged')
      ORDER BY o.id ASC LIMIT 20`, [STUCK_HOURS]);

  for (const o of stuck) {
    await log({ order_ref: o.order_id, user_id: o.user_id, action: 'stuck_flagged', outcome: 'needs_admin',
      detail: `Order ${o.order_id} (${String(o.service_name).slice(0, 80)}) still "${o.status}" after ${STUCK_HOURS}h.` });
    notifications.notifyUser(o.user_id, 'order', "We're watching your order 👀",
      `Your order ${o.order_id} is taking longer than usual, so our AI flagged it to the team. Some services take 5 days up to 1 month — but we're on it.`).catch(() => {});
  }
  if (stuck.length) {
    await notifyAdmins('⚠️ Stuck orders flagged',
      `${stuck.length} order(s) have been open for more than ${STUCK_HOURS}h. Check the Autopilot panel.`, true);
  }
  return stuck.length;
}

// ── In-process scheduler (no cPanel cron needed) ────────────
let running = false;
let lastWatchdogAt = 0;

async function tick() {
  if (running) return null;
  running = true;
  const result = { synced: null, tickets: 0, flagged: 0 };
  try {
    if (!(await isOn())) return result;
    try { result.synced = await orderService.syncOpenOrders(150); }
    catch (err) { console.warn('[autopilot] order sync failed:', err.message); }
    result.tickets = await processPendingTickets();
    if (Date.now() - lastWatchdogAt > 60 * 60 * 1000) {
      lastWatchdogAt = Date.now();
      result.flagged = await flagStuckOrders();
    }
  } catch (err) {
    console.warn('[autopilot] tick failed:', err.message);
  } finally {
    running = false;
  }
  return result;
}

function startScheduler() {
  if (!env.AUTOPILOT_ENABLED) { console.log('[autopilot] disabled via AUTOPILOT_ENABLED'); return; }
  const everyMs = Math.max(2, env.AUTOPILOT_INTERVAL_MINUTES) * 60 * 1000;
  setInterval(tick, everyMs).unref();
  setTimeout(tick, 20 * 1000).unref(); // first pass shortly after boot
  console.log(`[autopilot] scheduler on — every ${Math.max(2, env.AUTOPILOT_INTERVAL_MINUTES)} min (stuck threshold ${STUCK_HOURS}h)`);
}

module.exports = { isOn, handleTicket, processPendingTickets, flagStuckOrders, tick, startScheduler };
