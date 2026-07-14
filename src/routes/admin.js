'use strict';
const express = require('express');
const pool = require('../db/pool');
const wallet = require('../services/wallet');
const mailer = require('../services/mailer');
const catalog = require('../services/catalog');
const orderService = require('../services/orders');
const { allClients } = require('../providers');
const { setSetting, getSetting } = require('../services/stats');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { clampInt } = require('../utils/helpers');

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
    res.render('admin/index', { title: 'Admin · Overview', kpi, providers, announcement });
  } catch (err) { next(err); }
});

router.post('/admin/announcement', async (req, res, next) => {
  try {
    await setSetting('announcement', String(req.body.announcement || '').trim().slice(0, 300));
    flash(req, 'success', 'Announcement updated.');
    res.redirect('/admin');
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
