'use strict';
const express = require('express');
const pool = require('../db/pool');
const wallet = require('../services/wallet');
const mailer = require('../services/mailer');
const catalog = require('../services/catalog');
const orderService = require('../services/orders');
const { allClients, getClient } = require('../providers');
const { setSetting, getSetting } = require('../services/stats');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { invalidate: invalidateGate } = require('../middleware/gate');
const { clampInt, isValidHttpUrl } = require('../utils/helpers');

const router = express.Router();
router.use('/admin', requireAuth, requireAdmin);

function flash(req, type, message) { req.session.flash = { type, message }; }

const ORDER_STATUSES = ['Pending', 'In progress', 'Processing', 'Completed', 'Partial', 'Canceled', 'Failed'];

// ── Dashboard KPIs ────────────────────────────────────────
router.get('/admin', async (req, res, next) => {
  try {
    const [[kpi]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS new_users,
        (SELECT COUNT(*) FROM orders) AS orders,
        (SELECT COUNT(*) FROM orders WHERE created_at >= CURDATE()) AS orders_today,
        (SELECT COALESCE(SUM(charge - COALESCE(refund_amount,0)),0) FROM orders WHERE status <> 'Failed') AS revenue,
        (SELECT COALESCE(SUM(net_profit),0) FROM orders WHERE status NOT IN ('Failed','Canceled')) AS profit,
        (SELECT COUNT(*) FROM deposits WHERE status = 'Pending') AS pending_deposits,
        (SELECT COALESCE(SUM(balance),0) FROM users) AS liabilities
    `);
    const [providers] = await pool.query('SELECT * FROM providers ORDER BY code');
    const announcement = await getSetting('announcement', '');
    const maintenance = ['1', 'true', 'on', 'yes'].includes(String(await getSetting('maintenance', 'off')).toLowerCase());
    let openTickets = 0;
    try { const [[t]] = await pool.query("SELECT COUNT(*) AS c FROM tickets WHERE LOWER(status) IN ('open','in_progress')"); openTickets = t.c; } catch (_) {}
    res.render('admin/index', { title: 'Admin · Overview', kpi, providers, announcement, maintenance, openTickets });
  } catch (err) { next(err); }
});

router.post('/admin/announcement', async (req, res, next) => {
  try {
    await setSetting('announcement', String(req.body.announcement || '').trim().slice(0, 300));
    flash(req, 'success', 'Announcement updated.');
    res.redirect('/admin');
  } catch (err) { next(err); }
});

// ── Maintenance mode ──────────────────────────────────────
router.post('/admin/maintenance', async (req, res, next) => {
  try {
    const on = req.body.maintenance === '1' || req.body.maintenance === 'on';
    await setSetting('maintenance', on ? 'on' : 'off');
    invalidateGate();
    flash(req, 'success', on
      ? 'Maintenance mode is ON — only admins can access the site; other users have been signed out.'
      : 'Maintenance mode is OFF — the site is live again.');
    res.redirect('/admin');
  } catch (err) { next(err); }
});

// ── Promo / coupon codes ──────────────────────────────────
router.get('/admin/promos', async (req, res, next) => {
  try {
    const [promos] = await pool.query('SELECT * FROM promos ORDER BY id DESC LIMIT 200');
    res.render('admin/promos', { title: 'Admin · Promo Codes', promos });
  } catch (err) { next(err); }
});

router.post('/admin/promos', async (req, res) => {
  try {
    const code = String(req.body.code || '').trim().toUpperCase().slice(0, 50);
    const type = req.body.type === 'fixed' ? 'fixed' : 'percentage';
    const value = Number(req.body.value);
    const maxUses = clampInt(req.body.max_uses, 0, 1000000000);
    const maxDiscount = req.body.max_discount === '' || req.body.max_discount == null ? null : Number(req.body.max_discount);
    const expiresAt = String(req.body.expires_at || '').trim() || null;

    if (!/^[A-Z0-9_-]{3,50}$/.test(code)) { flash(req, 'error', 'Code must be 3–50 characters (letters, numbers, - or _).'); return res.redirect('/admin/promos'); }
    if (!Number.isFinite(value) || value <= 0) { flash(req, 'error', 'Enter a valid discount value.'); return res.redirect('/admin/promos'); }
    if (type === 'percentage' && value > 100) { flash(req, 'error', 'Percentage discount cannot exceed 100.'); return res.redirect('/admin/promos'); }
    if (maxDiscount != null && (!Number.isFinite(maxDiscount) || maxDiscount < 0)) { flash(req, 'error', 'Max discount must be a positive number or blank.'); return res.redirect('/admin/promos'); }

    const [[dupe]] = await pool.query('SELECT id FROM promos WHERE UPPER(code) = ? LIMIT 1', [code]);
    if (dupe) { flash(req, 'error', 'A promo with that code already exists.'); return res.redirect('/admin/promos'); }

    await pool.query(
      `INSERT INTO promos (code, type, value, max_uses, uses, expires_at, max_discount_amount, active)
       VALUES (?, ?, ?, ?, 0, ?, ?, 1)`,
      [code, type, value.toFixed(2), maxUses || 0, expiresAt, maxDiscount == null ? null : maxDiscount.toFixed(2)]);
    flash(req, 'success', `Promo code ${code} created.`);
    res.redirect('/admin/promos');
  } catch (err) { flash(req, 'error', err.message); res.redirect('/admin/promos'); }
});

router.post('/admin/promos/:id/toggle', async (req, res, next) => {
  try {
    await pool.query('UPDATE promos SET active = 1 - COALESCE(active,1) WHERE id = ?', [clampInt(req.params.id, 1, 2147483647)]);
    flash(req, 'success', 'Promo status updated.');
    res.redirect('/admin/promos');
  } catch (err) { next(err); }
});

router.post('/admin/promos/:id/delete', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM promos WHERE id = ?', [clampInt(req.params.id, 1, 2147483647)]);
    flash(req, 'success', 'Promo code deleted.');
    res.redirect('/admin/promos');
  } catch (err) { next(err); }
});

// ── Customer concerns (tickets) + quick provider actions ──
router.get('/admin/tickets', async (req, res, next) => {
  try {
    const status = ['open', 'in_progress', 'resolved', 'closed'].includes(String(req.query.status || '').toLowerCase())
      ? String(req.query.status).toLowerCase() : '';
    const where = status ? 'WHERE LOWER(t.status) = ?' : '';
    const params = status ? [status] : [];
    const [tickets] = await pool.query(
      `SELECT t.*, u.username, u.email FROM tickets t LEFT JOIN users u ON u.id = t.user_id
       ${where} ORDER BY t.id DESC LIMIT 100`, params);
    res.render('admin/tickets', { title: 'Admin · Customer Concerns', tickets, status });
  } catch (err) { next(err); }
});

// Resolve the provider order id + provider code for a ticket (from the ticket
// itself, or by looking up its linked order).
async function resolveTicketProvider(ticket) {
  let providerOrderId = ticket.provider_order_id;
  let apiProvider = ticket.api_provider;
  if (!providerOrderId && ticket.order_id) {
    const [[order]] = await pool.query('SELECT provider_order_id, api_provider FROM orders WHERE order_id = ? OR id = ? LIMIT 1',
      [ticket.order_id, /^\d+$/.test(String(ticket.order_id)) ? ticket.order_id : 0]);
    if (order) { providerOrderId = order.provider_order_id; apiProvider = order.api_provider; }
  }
  const code = apiProvider === 'SMMWorld' ? 'smmworld' : 'rkd';
  return { providerOrderId, code };
}

router.post('/admin/tickets/:id/action', async (req, res) => {
  const action = String(req.body.action || '');
  try {
    const [[ticket]] = await pool.query('SELECT * FROM tickets WHERE id = ?', [clampInt(req.params.id, 1, 2147483647)]);
    if (!ticket) { flash(req, 'error', 'Ticket not found.'); return res.redirect('/admin/tickets'); }

    let statusText = '';
    let response = '';
    if (action === 'refill' || action === 'cancel') {
      const { providerOrderId, code } = await resolveTicketProvider(ticket);
      const client = getClient(code);
      if (!providerOrderId || !client) throw new Error('No provider order linked to this ticket.');
      const result = action === 'refill' ? await client.refill(providerOrderId) : await client.cancel(providerOrderId);
      statusText = `${action}_sent`;
      response = JSON.stringify(result).slice(0, 1000);
    } else if (action === 'speedup') {
      statusText = 'speedup_noted';
      response = 'Speed-up requested from provider (manual follow-up).';
    } else {
      flash(req, 'error', 'Unknown action.'); return res.redirect('/admin/tickets');
    }

    await pool.query(
      "UPDATE tickets SET provider_action_status = ?, provider_action_response = ?, status = 'in_progress', assigned_to = ? WHERE id = ?",
      [statusText, response, req.user.id, ticket.id]);
    flash(req, 'success', `Action "${action}" sent for ticket #${ticket.id}.`);
  } catch (err) {
    flash(req, 'error', `Action failed: ${err.message}`);
  }
  res.redirect('/admin/tickets');
});

router.post('/admin/tickets/:id/status', async (req, res, next) => {
  try {
    const status = ['open', 'in_progress', 'resolved', 'closed'].includes(req.body.status) ? req.body.status : 'open';
    const note = String(req.body.internal_notes || '').trim().slice(0, 1000) || null;
    await pool.query('UPDATE tickets SET status = ?, internal_notes = COALESCE(?, internal_notes), assigned_to = ? WHERE id = ?',
      [status, note, req.user.id, clampInt(req.params.id, 1, 2147483647)]);
    flash(req, 'success', 'Ticket updated.');
    res.redirect('/admin/tickets');
  } catch (err) { next(err); }
});

// ── IP blocklist ──────────────────────────────────────────
router.get('/admin/ips', async (req, res, next) => {
  try {
    const [ips] = await pool.query('SELECT * FROM blocked_ips ORDER BY id DESC LIMIT 200');
    res.render('admin/ips', { title: 'Admin · Blocked IPs', ips });
  } catch (err) { next(err); }
});

router.post('/admin/ips', async (req, res) => {
  try {
    const ip = String(req.body.ip || '').trim().slice(0, 45);
    const reason = String(req.body.reason || '').trim().slice(0, 255) || null;
    if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) { flash(req, 'error', 'Enter a valid IP address.'); return res.redirect('/admin/ips'); }
    await pool.query('INSERT INTO blocked_ips (ip, reason, blocked_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE reason = VALUES(reason)',
      [ip, reason, req.user.id]);
    invalidateGate();
    flash(req, 'success', `IP ${ip} blocked.`);
    res.redirect('/admin/ips');
  } catch (err) { flash(req, 'error', err.message); res.redirect('/admin/ips'); }
});

router.post('/admin/ips/:id/unblock', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM blocked_ips WHERE id = ?', [clampInt(req.params.id, 1, 2147483647)]);
    invalidateGate();
    flash(req, 'success', 'IP unblocked.');
    res.redirect('/admin/ips');
  } catch (err) { next(err); }
});

// ── Users ─────────────────────────────────────────────────
router.get('/admin/users', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const page = clampInt(req.query.page, 1, 100000) || 1;
    const perPage = 25;
    const where = q ? 'WHERE email LIKE ? OR username LIKE ?' : '';
    const params = q ? [`%${q}%`, `%${q}%`] : [];
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM users ${where}`, params);
    const pages = Math.max(1, Math.ceil(total / perPage));
    const current = Math.min(page, pages);
    const [users] = await pool.query(
      `SELECT id, username, email, role, balance, email_verified, status, created_at FROM users ${where}
       ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, perPage, (current - 1) * perPage]);
    res.render('admin/users', { title: 'Admin · Users', users, q, pagination: { current, pages, total } });
  } catch (err) { next(err); }
});

router.post('/admin/users/:id/adjust', async (req, res) => {
  try {
    const userId = clampInt(req.params.id, 1, 2147483647);
    const amount = Number(req.body.amount);
    const note = String(req.body.note || '').trim().slice(0, 200);
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1000000) {
      flash(req, 'error', 'Enter a non-zero adjustment amount (max ₱1,000,000).');
    } else {
      await wallet.adjustBalance(userId, amount, req.user.id, note || 'Admin adjustment');
      flash(req, 'success', `Balance adjusted by ₱${amount.toFixed(2)} for user #${userId}.`);
    }
  } catch (err) { flash(req, 'error', err.message); }
  res.redirect('/admin/users');
});

router.post('/admin/users/:id/ban', async (req, res, next) => {
  try {
    const userId = clampInt(req.params.id, 1, 2147483647);
    if (userId === req.user.id) { flash(req, 'error', 'You cannot ban yourself.'); return res.redirect('/admin/users'); }
    const unban = req.body.unban === '1';
    await pool.query(
      "UPDATE users SET status = ? WHERE id = ? AND role NOT IN ('admin','super_admin')",
      [unban ? 'Active' : 'Banned', userId]);
    flash(req, 'success', unban ? `User #${userId} unbanned.` : `User #${userId} banned.`);
    res.redirect('/admin/users');
  } catch (err) { next(err); }
});

// ── Deposits queue ────────────────────────────────────────
router.get('/admin/deposits', async (req, res, next) => {
  try {
    const map = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected' };
    const status = map[String(req.query.status || 'pending').toLowerCase()] || 'Pending';
    const [deposits] = await pool.query(
      `SELECT d.*, u.email, u.username FROM deposits d JOIN users u ON u.id = d.user_id
       WHERE d.status = ? ORDER BY d.id ${status === 'Pending' ? 'ASC' : 'DESC'} LIMIT 100`, [status]);
    res.render('admin/deposits', { title: 'Admin · Deposits', deposits, status: status.toLowerCase() });
  } catch (err) { next(err); }
});

router.post('/admin/deposits/:id/approve', async (req, res) => {
  try {
    const deposit = await wallet.approveDeposit(clampInt(req.params.id, 1, 2147483647), req.user.id, String(req.body.note || '').trim());
    const [[user]] = await pool.query('SELECT email FROM users WHERE id = ?', [deposit.user_id]);
    if (user) mailer.sendDepositResult(user.email, deposit, true);
    flash(req, 'success', `Deposit #${deposit.id} approved — ₱${Number(deposit.amount).toFixed(2)} credited.`);
  } catch (err) { flash(req, 'error', err.message); }
  res.redirect('/admin/deposits');
});

router.post('/admin/deposits/:id/reject', async (req, res) => {
  try {
    const note = String(req.body.note || '').trim();
    const deposit = await wallet.rejectDeposit(clampInt(req.params.id, 1, 2147483647), req.user.id, note);
    const [[user]] = await pool.query('SELECT email FROM users WHERE id = ?', [deposit.user_id]);
    if (user) mailer.sendDepositResult(user.email, { ...deposit, admin_note: note }, false);
    flash(req, 'success', `Deposit #${deposit.id} rejected.`);
  } catch (err) { flash(req, 'error', err.message); }
  res.redirect('/admin/deposits');
});

// ── Orders ────────────────────────────────────────────────
router.get('/admin/orders', async (req, res, next) => {
  try {
    const page = clampInt(req.query.page, 1, 100000) || 1;
    const perPage = 30;
    const status = ORDER_STATUSES.includes(req.query.status) ? req.query.status : '';
    const where = status ? 'WHERE o.status = ?' : '';
    const params = status ? [status] : [];
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM orders o ${where}`, params);
    const pages = Math.max(1, Math.ceil(total / perPage));
    const current = Math.min(page, pages);
    const [orders] = await pool.query(
      `SELECT o.*, u.email, u.username FROM orders o JOIN users u ON u.id = o.user_id
       ${where} ORDER BY o.id DESC LIMIT ? OFFSET ?`, [...params, perPage, (current - 1) * perPage]);
    res.render('admin/orders', { title: 'Admin · Orders', orders, status, pagination: { current, pages, total }, orderStatuses: ORDER_STATUSES });
  } catch (err) { next(err); }
});

router.post('/admin/orders/sync', async (req, res) => {
  try {
    const result = await orderService.syncOpenOrders();
    flash(req, 'success', `Order sync done — checked ${result.checked}, updated ${result.updated}.`);
  } catch (err) { flash(req, 'error', `Order sync failed: ${err.message}`); }
  res.redirect('/admin/orders');
});

router.post('/admin/orders/:id/refresh', async (req, res) => {
  try { await orderService.syncOrderById(clampInt(req.params.id, 1, 2147483647)); flash(req, 'success', 'Order refreshed.'); }
  catch (err) { flash(req, 'error', `Refresh failed: ${err.message}`); }
  res.redirect('/admin/orders');
});

// ── Services ──────────────────────────────────────────────
router.get('/admin/services', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const page = clampInt(req.query.page, 1, 100000) || 1;
    const perPage = 50;
    const where = ['s.deleted = 0'];
    const params = [];
    if (q) { where.push('(s.name LIKE ? OR s.category LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM services s WHERE ${where.join(' AND ')}`, params);
    const pages = Math.max(1, Math.ceil(total / perPage));
    const current = Math.min(page, pages);
    const [services] = await pool.query(
      `SELECT s.*, p.code AS provider_code FROM services s JOIN providers p ON p.id = s.provider_id
       WHERE ${where.join(' AND ')} ORDER BY s.platform, s.category, s.rate_usd LIMIT ? OFFSET ?`,
      [...params, perPage, (current - 1) * perPage]);
    res.render('admin/services', {
      title: 'Admin · Services', services, q,
      providers: allClients().map((c) => c.code), pagination: { current, pages, total },
    });
  } catch (err) { next(err); }
});

router.post('/admin/services/sync/:code', async (req, res) => {
  try {
    const result = await catalog.syncProvider(String(req.params.code));
    flash(req, 'success', `Synced ${result.provider}: ${result.imported} services imported (provider lists ${result.totalFromProvider}).`);
  } catch (err) { flash(req, 'error', `Sync failed: ${err.message}`); }
  res.redirect('/admin/services');
});

router.post('/admin/services/:id/toggle', async (req, res, next) => {
  try {
    await pool.query('UPDATE services SET enabled = 1 - enabled WHERE id = ?', [clampInt(req.params.id, 1, 2147483647)]);
    flash(req, 'success', 'Service visibility toggled.');
    res.redirect(req.get('referer') || '/admin/services');
  } catch (err) { next(err); }
});

router.post('/admin/services/:id/markup', async (req, res, next) => {
  try {
    const raw = String(req.body.markup || '').trim();
    let value = null;
    if (raw !== '') {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 1 || n > 100) { flash(req, 'error', 'Markup must be between 1 and 100 (or blank for default).'); return res.redirect(req.get('referer') || '/admin/services'); }
      value = n.toFixed(3);
    }
    await pool.query('UPDATE services SET markup_override = ? WHERE id = ?', [value, clampInt(req.params.id, 1, 2147483647)]);
    flash(req, 'success', value ? `Markup override set to ×${value}.` : 'Markup override cleared.');
    res.redirect(req.get('referer') || '/admin/services');
  } catch (err) { next(err); }
});

module.exports = router;
