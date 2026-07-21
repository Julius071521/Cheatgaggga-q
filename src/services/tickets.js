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

module.exports = { postMessage, thread };
