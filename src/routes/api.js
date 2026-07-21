'use strict';
// Reseller API — mirrors the standard SMM panel API v2 so other panels can
// plug this site in as a provider. Auth is via the per-user api_key.
const express = require('express');
const pool = require('../db/pool');
const pricing = require('../services/pricing');
const orderService = require('../services/orders');
const { apiLimiter } = require('../middleware/rateLimit');
const { isValidHttpUrl } = require('../utils/helpers');

const router = express.Router();

router.post('/api/v2', apiLimiter, express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 200 }), async (req, res) => {
  try {
    // Accept the key from the standard `key` field OR an Authorization: Bearer
    // header (the latter keeps it out of request-body logs).
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.get('authorization') || ''));
    const key = String((bearer && bearer[1]) || req.body.key || '').trim();
    if (!key || key.length !== 64) return res.json({ error: 'Invalid API key' });
    const [[user]] = await pool.query('SELECT * FROM users WHERE api_key = ? LIMIT 1', [key]);
    if (!user || String(user.status || 'Active').toLowerCase() !== 'active') return res.json({ error: 'Invalid API key' });

    const action = String(req.body.action || '');

    if (action === 'balance') {
      return res.json({ balance: Number(user.balance).toFixed(2), currency: 'PHP' });
    }

    if (action === 'services') {
      const [services] = await pool.query('SELECT * FROM services WHERE enabled = 1 AND deleted = 0 ORDER BY platform, category');
      return res.json(services.map((s) => ({
        service: s.id, name: s.name, type: s.type,
        category: `${s.platform} — ${s.category}`.slice(0, 190),
        rate: pricing.ratePhpPer1000(s).toFixed(4),
        min: s.min_qty, max: s.max_qty, refill: !!s.refill, cancel: !!s.cancelable, currency: 'PHP',
      })));
    }

    if (action === 'add') {
      const serviceId = parseInt(req.body.service, 10);
      const link = String(req.body.link || '').trim().slice(0, 2000);
      const quantity = parseInt(req.body.quantity, 10);
      if (!serviceId || !quantity || quantity < 1) return res.json({ error: 'Invalid service or quantity' });
      if (!isValidHttpUrl(link)) return res.json({ error: 'Invalid link' });

      const [[service]] = await pool.query(
        `SELECT s.*, p.code AS provider_code FROM services s JOIN providers p ON p.id = s.provider_id
         WHERE s.id = ? AND s.enabled = 1 AND s.deleted = 0`, [serviceId]);
      if (!service) return res.json({ error: 'Service not found' });
      if (quantity < service.min_qty || quantity > service.max_qty) return res.json({ error: `Quantity must be between ${service.min_qty} and ${service.max_qty}` });

      // Idempotency: if the caller sends a client_order_id they've used before,
      // return the original order instead of placing (and charging) a new one.
      const clientOrderId = String(req.body.client_order_id || '').trim().slice(0, 64) || null;
      if (clientOrderId) {
        const [[prev]] = await pool.query(
          'SELECT id FROM orders WHERE user_id = ? AND client_order_id = ? LIMIT 1', [user.id, clientOrderId]);
        if (prev) return res.json({ order: prev.id });
      }

      try {
        const { orderId } = await orderService.placeOrder(user, service, link, quantity, null, { clientOrderId });
        return res.json({ order: orderId });
      } catch (err) {
        if (err.message === 'Insufficient balance') return res.json({ error: 'Not enough funds in your balance' });
        return res.json({ error: 'Order could not be placed. Your balance was not charged.' });
      }
    }

    if (action === 'status') {
      const single = req.body.order ? [String(req.body.order)] : null;
      const multi = req.body.orders ? String(req.body.orders).split(',').map((s) => s.trim()).slice(0, 100) : null;
      const ids = single || multi;
      if (!ids || !ids.length) return res.json({ error: 'Missing order id' });

      const results = {};
      for (const id of ids) {
        const orderId = parseInt(id, 10);
        const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ? AND user_id = ?', [orderId, user.id]);
        results[id] = order
          ? { charge: Number(order.charge).toFixed(4), start_count: order.start_count, status: order.status, remains: order.remains, currency: order.currency || 'PHP' }
          : { error: 'Incorrect order ID' };
      }
      return res.json(single ? results[single[0]] : results);
    }

    return res.json({ error: 'Incorrect action' });
  } catch (err) {
    console.error('[api] Error:', err.message);
    res.json({ error: 'Internal error' });
  }
});

module.exports = router;
