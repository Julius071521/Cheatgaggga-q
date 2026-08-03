'use strict';
// Two-way support chat helpers. A ticket carries a thread of messages between
// the customer and staff (or the AI). Posting a message flips the other side's
// unread flag and fires an in-app notification so nobody misses a reply.
const pool = require('../db/pool');
const notifications = require('./notifications');

// Post a message to a ticket's thread. sender = 'customer' | 'staff' | 'system'.
// Returns the ticket row (for the caller) or null if the ticket is missing.
async function postMessage(ticketId, sender, body, { notify = true } = {}) {
  const text = String(body || '').trim().slice(0, 4000);
  if (!text) return null;
  const [[t]] = await pool.query('SELECT id, user_id, order_id, subject FROM tickets WHERE id = ?', [ticketId]);
  if (!t) return null;

  await pool.query('INSERT INTO ticket_messages (ticket_id, sender, body) VALUES (?, ?, ?)', [ticketId, sender, text]);

  if (sender === 'customer') {
    // Customer wrote → staff should see it, and the ticket reopens for a look.
    await pool.query(
      "UPDATE tickets SET staff_unread = 1, customer_unread = 0, status = IF(LOWER(status) IN ('resolved','closed'),'open',status) WHERE id = ?",
      [ticketId]);
  } else {
    // Staff/AI wrote → customer should see it.
    await pool.query('UPDATE tickets SET customer_unread = 1, staff_unread = 0 WHERE id = ?', [ticketId]);
    if (notify && t.user_id) {
      notifications.notifyUser(t.user_id, 'ticket', 'New reply on your concern 💬',
        text.length > 140 ? text.slice(0, 140) + '…' : text, { ticketId }).catch(() => {});
    }
  }
  return t;
}

// The full thread for a ticket, oldest first, with the original report prepended
// so the customer always sees where the conversation started.
async function thread(ticketId) {
  const [[t]] = await pool.query('SELECT * FROM tickets WHERE id = ?', [ticketId]);
  if (!t) return null;
  const [msgs] = await pool.query(
    'SELECT sender, body, created_at FROM ticket_messages WHERE ticket_id = ? ORDER BY id ASC', [ticketId]);
  const opening = { sender: 'customer', body: t.message || '(no message)', created_at: t.created_at };
  return { ticket: t, messages: [opening, ...msgs] };
}

// ── Concern action state ────────────────────────────────────
// A concern used to keep only the LAST action in a single column, so the panel
// showed every button forever — you could refund an order twice, or send a
// speed-up on a concern that was already resolved. Actions are recorded here
// instead, and the panel offers only the ones that still make sense.

const ACTIONS = ['refill', 'speedup', 'cancel', 'refund'];

async function recordAction(ticketId, action, { ok = true, detail = '', adminId = null } = {}) {
  if (!ACTIONS.includes(action)) return;
  await pool.query(
    'INSERT INTO ticket_actions (ticket_id, action, ok, detail, admin_id) VALUES (?, ?, ?, ?, ?)',
    [ticketId, action, ok ? 1 : 0, String(detail || '').slice(0, 500), adminId]);
}

// Successful actions per ticket → { ticketId: Set('refill', …) }. A failed
// attempt is deliberately not counted, so a button that errored comes back.
async function doneMap(ticketIds) {
  const ids = (ticketIds || []).filter((n) => Number.isInteger(Number(n)));
  const out = new Map();
  if (!ids.length) return out;
  const [rows] = await pool.query(
    `SELECT ticket_id, action FROM ticket_actions
      WHERE ok = 1 AND ticket_id IN (${ids.map(() => '?').join(',')})`, ids);
  for (const r of rows) {
    if (!out.has(r.ticket_id)) out.set(r.ticket_id, new Set());
    out.get(r.ticket_id).add(r.action);
  }
  return out;
}

// Which buttons this concern should still show, and why the others are gone.
// `order` may be null when nothing is linked.
function availableActions(ticket, order, done = new Set()) {
  const status = String(ticket.status || 'open').toLowerCase();
  const finished = ['resolved', 'closed'].includes(status);
  const orderStatus = String((order && order.status) || '').toLowerCase();
  const hasProviderOrder = Boolean(ticket.provider_order_id || (order && order.provider_order_id));
  const orderOver = ['completed', 'canceled', 'cancelled', 'refunded', 'failed', 'partial'].includes(orderStatus);
  const moneyBack = done.has('refund') || ['refunded', 'canceled', 'cancelled'].includes(orderStatus);

  // A closed concern, or one whose money is already back, is done — the status
  // dropdown stays so it can be reopened, but no action can still apply.
  if (finished || moneyBack) return { actions: [], closedReason: finished ? 'resolved' : 'refunded' };

  const actions = [];
  // Refill only makes sense on a delivered order, and only once.
  if (!done.has('refill') && hasProviderOrder && orderStatus !== 'canceled' && orderStatus !== 'refunded') {
    actions.push('refill');
  }
  // Speeding up a finished order is meaningless.
  if (!done.has('speedup') && !orderOver) actions.push('speedup');
  // Cancelling needs a live provider order that has not finished.
  if (!done.has('cancel') && hasProviderOrder && !orderOver) actions.push('cancel');
  // Refund stays until the money actually moves.
  if (order) actions.push('refund');

  return { actions, closedReason: null };
}

module.exports = {
  postMessage, thread, recordAction, doneMap, availableActions, ACTIONS,
};
