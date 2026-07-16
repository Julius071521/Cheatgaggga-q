'use strict';
const express = require('express');
const pool = require('../db/pool');
const ai = require('../services/ai');
const notifications = require('../services/notifications');
const { aiLimiter } = require('../middleware/rateLimit');
const { clampInt } = require('../utils/helpers');

const router = express.Router();

// Chat completion.
router.post('/ai/chat', aiLimiter, express.json({ limit: '8kb' }), async (req, res) => {
  const message = String((req.body && req.body.message) || '').trim().slice(0, 1000);
  if (!message) return res.status(400).json({ error: 'Empty message' });

  if (!req.session.aiHistory) req.session.aiHistory = [];
  const history = req.session.aiHistory;
  const reply = await ai.chat(req.session.id, req.user ? req.user.id : null, history, message);
  history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
  req.session.aiHistory = history.slice(-12);
  res.json({ reply });
});

// Context for the report flow: is the user logged in + their recent orders.
router.get('/ai/context', async (req, res) => {
  if (!req.user) return res.json({ loggedIn: false, orders: [] });
  try {
    const [orders] = await pool.query(
      'SELECT id, order_id, service_name, status FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 20', [req.user.id]);
    res.json({
      loggedIn: true,
      orders: orders.map((o) => ({
        id: o.id, code: o.order_id,
        label: `${o.order_id} — ${String(o.service_name).slice(0, 40)} (${o.status})`,
      })),
    });
  } catch (_) { res.json({ loggedIn: true, orders: [] }); }
});

// Submit a report/concern from the chat widget → creates an admin ticket.
router.post('/ai/report', aiLimiter, express.json({ limit: '8kb' }), async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Please sign in to submit a report.' });
  try {
    const allowed = ['Refill', 'Speed up', 'Cancel', 'Not completed', 'Stuck', 'Other'];
    const requestType = allowed.includes(req.body && req.body.request_type) ? req.body.request_type : 'Other';
    const message = String((req.body && req.body.message) || '').trim().slice(0, 2000);
    const orderId = clampInt(req.body && req.body.order_id, 1, 2147483647);
    if (message.length < 3) return res.status(400).json({ error: 'Please describe your concern (a few words).' });

    let order = null;
    if (orderId) {
      const [[o]] = await pool.query('SELECT * FROM orders WHERE id = ? AND user_id = ?', [orderId, req.user.id]);
      order = o || null;
    }

    const [tRes] = await pool.query(
      `INSERT INTO tickets (user_id, subject, order_id, request_type, message, status, priority, provider_order_id, api_provider)
       VALUES (?, ?, ?, ?, ?, 'open', 'normal', ?, ?)`,
      [req.user.id, `Order concern: ${requestType}`, order ? order.order_id : null, requestType, message,
        order ? order.provider_order_id : null, order ? order.api_provider : null]);

    // AI autopilot triages the new report right away (fire-and-forget).
    require('../services/autopilot').handleTicket(tRes.insertId).catch(() => {});

    notifications.notifyUser(req.user.id, 'ticket', 'Report submitted ✅',
      `We received your "${requestType}" report${order ? ' for ' + order.order_id : ''}. Our team will take a look shortly.`).catch(() => {});

    res.json({ ok: true, message: `✅ Your "${requestType}" report has been sent to our team${order ? ' for order ' + order.order_id : ''}. We'll update you here and by email. Thank you!` });
  } catch (err) {
    console.error('[ai] report failed:', err.message);
    res.status(500).json({ error: 'Could not submit your report right now. Please try again.' });
  }
});

module.exports = router;
