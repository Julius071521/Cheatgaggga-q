'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const env = require('../config/env');
const pool = require('../db/pool');
const pricing = require('../services/pricing');
const orderService = require('../services/orders');
const { requireAuth } = require('../middleware/auth');
const { randomToken, isValidHttpUrl, clampInt, PLATFORM_LABELS } = require('../utils/helpers');

const router = express.Router();
// Scope auth to this router's own prefixes so unrelated URLs still 404.
router.use(['/dashboard', '/order', '/orders', '/wallet', '/settings', '/receipt'], requireAuth);

function flash(req, type, message) {
  req.session.flash = { type, message };
}

// ── Uploads (payment receipts) ────────────────────────────
const uploadDir = env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads', 'receipts');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[file.mimetype] || '.bin';
      cb(null, `${Date.now()}-${randomToken(8)}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype));
  },
});

const MAGIC = [
  { ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { ext: 'webp', bytes: [0x52, 0x49, 0x46, 0x46] },
];

function looksLikeImage(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return MAGIC.some((m) => m.bytes.every((b, i) => buf[i] === b));
  } catch (_) {
    return false;
  }
}

// ── Overview ──────────────────────────────────────────────
router.get('/dashboard', async (req, res, next) => {
  try {
    const [[counts]] = await pool.query(
      `SELECT COUNT(*) AS orders,
              COALESCE(SUM(charge_php - refunded_php), 0) AS spent,
              SUM(status IN ('pending','in_progress','processing')) AS active
       FROM orders WHERE user_id = ?`, [req.user.id]);
    const [recentOrders] = await pool.query(
      `SELECT o.*, s.name AS service_name, s.platform FROM orders o
       JOIN services s ON s.id = o.service_id
       WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 5`, [req.user.id]);
    res.render('dashboard/index', { title: 'Dashboard', counts, recentOrders });
  } catch (err) { next(err); }
});

// ── New order ─────────────────────────────────────────────
router.get('/order/new', async (req, res, next) => {
  try {
    const [platforms] = await pool.query(
      "SELECT DISTINCT platform FROM services WHERE enabled = 1 AND deleted = 0 ORDER BY platform");
    const selectedService = clampInt(req.query.service, 1, 2147483647);
    let preselected = null;
    if (selectedService) {
      const [[svc]] = await pool.query(
        'SELECT * FROM services WHERE id = ? AND enabled = 1 AND deleted = 0', [selectedService]);
      if (svc) preselected = { ...svc, ratePhp: pricing.ratePhpPer1000(svc) };
    }
    res.render('dashboard/order-new', {
      title: 'New Order',
      platforms: platforms.map((r) => r.platform),
      preselected,
    });
  } catch (err) { next(err); }
});

// JSON: services for a platform (used by the order form).
router.get('/order/services.json', async (req, res, next) => {
  try {
    const platform = Object.prototype.hasOwnProperty.call(PLATFORM_LABELS, String(req.query.platform))
      ? String(req.query.platform) : null;
    if (!platform) return res.json([]);
    const [services] = await pool.query(
      'SELECT id, name, category, min_qty, max_qty, rate_usd, markup_override, refill FROM services WHERE platform = ? AND enabled = 1 AND deleted = 0 ORDER BY category, rate_usd LIMIT 1000',
      [platform]);
    res.json(services.map((s) => ({
      id: s.id, name: s.name, category: s.category,
      min: s.min_qty, max: s.max_qty, refill: !!s.refill,
      ratePhp: pricing.ratePhpPer1000(s),
    })));
  } catch (err) { next(err); }
});

router.post('/order/new', async (req, res, next) => {
  try {
    const serviceId = clampInt(req.body.service_id, 1, 2147483647);
    const link = String(req.body.link || '').trim().slice(0, 500);
    const quantity = clampInt(req.body.quantity, 1, 1000000000);

    if (!serviceId || !quantity) { flash(req, 'error', 'Please pick a service and quantity.'); return res.redirect('/order/new'); }
    if (!isValidHttpUrl(link)) { flash(req, 'error', 'Please enter a valid link (must start with http:// or https://).'); return res.redirect('/order/new'); }

    const [[service]] = await pool.query(
      `SELECT s.*, p.code AS provider_code FROM services s JOIN providers p ON p.id = s.provider_id
       WHERE s.id = ? AND s.enabled = 1 AND s.deleted = 0`, [serviceId]);
    if (!service) { flash(req, 'error', 'That service is no longer available.'); return res.redirect('/order/new'); }
    if (quantity < service.min_qty || quantity > service.max_qty) {
      flash(req, 'error', `Quantity must be between ${service.min_qty} and ${service.max_qty} for this service.`);
      return res.redirect(`/order/new?service=${service.id}`);
    }

    const { orderId, charge } = await orderService.placeOrder(req.user.id, service, link, quantity);
    flash(req, 'success', `Order #${orderId} placed — ₱${charge.toFixed(2)} was charged to your wallet.`);
    res.redirect('/orders');
  } catch (err) {
    if (err.message === 'Insufficient balance') {
      flash(req, 'error', 'Insufficient balance. Please add funds first.');
      return res.redirect('/wallet');
    }
    if (err.orderId) {
      flash(req, 'error', err.message);
      return res.redirect('/orders');
    }
    next(err);
  }
});

// ── Order history ─────────────────────────────────────────
router.get('/orders', async (req, res, next) => {
  try {
    const page = clampInt(req.query.page, 1, 10000) || 1;
    const perPage = 20;
    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM orders WHERE user_id = ?', [req.user.id]);
    const pages = Math.max(1, Math.ceil(total / perPage));
    const current = Math.min(page, pages);
    const [orders] = await pool.query(
      `SELECT o.*, s.name AS service_name, s.platform FROM orders o
       JOIN services s ON s.id = o.service_id
       WHERE o.user_id = ? ORDER BY o.id DESC LIMIT ? OFFSET ?`,
      [req.user.id, perPage, (current - 1) * perPage]);
    res.render('dashboard/orders', { title: 'My Orders', orders, pagination: { current, pages, total } });
  } catch (err) { next(err); }
});

router.post('/orders/:id/refresh', async (req, res, next) => {
  try {
    const orderId = clampInt(req.params.id, 1, 2147483647);
    const [[order]] = await pool.query('SELECT id, user_id FROM orders WHERE id = ?', [orderId]);
    if (!order || order.user_id !== req.user.id) return res.status(404).render('errors/404');
    await orderService.syncOrderById(orderId);
    flash(req, 'success', `Order #${orderId} status refreshed.`);
    res.redirect('/orders');
  } catch (err) {
    flash(req, 'error', 'Could not refresh the order status right now. Please try again shortly.');
    res.redirect('/orders');
  }
});

// ── Wallet / add funds ────────────────────────────────────
router.get('/wallet', async (req, res, next) => {
  try {
    const [deposits] = await pool.query(
      'SELECT * FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT 20', [req.user.id]);
    const [transactions] = await pool.query(
      'SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 30', [req.user.id]);
    const methods = [];
    if (env.GCASH_ACCOUNT_NUMBER) methods.push({ code: 'gcash', label: 'GCash', number: env.GCASH_ACCOUNT_NUMBER, name: env.GCASH_ACCOUNT_NAME, extra: '' });
    if (env.MAYA_ACCOUNT_NUMBER) methods.push({ code: 'maya', label: 'Maya', number: env.MAYA_ACCOUNT_NUMBER, name: env.MAYA_ACCOUNT_NAME, extra: '' });
    if (env.BPI_ACCOUNT_NUMBER) methods.push({ code: 'bpi', label: 'BPI', number: env.BPI_ACCOUNT_NUMBER, name: env.BPI_ACCOUNT_NAME, extra: env.BPI_ACCOUNT_TYPE });
    res.render('dashboard/wallet', { title: 'Wallet & Add Funds', deposits, transactions, methods });
  } catch (err) { next(err); }
});

router.post('/wallet/deposit', (req, res, next) => {
  upload.single('receipt')(req, res, (err) => {
    if (err) {
      flash(req, 'error', err.code === 'LIMIT_FILE_SIZE' ? 'Receipt image must be 5MB or smaller.' : 'Receipt upload failed. JPG, PNG or WEBP only.');
      return res.redirect('/wallet');
    }
    next();
  });
}, async (req, res, next) => {
  try {
    const method = ['gcash', 'maya', 'bpi'].includes(req.body.method) ? req.body.method : null;
    const amount = Number(req.body.amount);
    const reference = String(req.body.reference || '').trim().slice(0, 100);

    const fail = (msg) => {
      if (req.file) fs.unlink(req.file.path, () => {});
      flash(req, 'error', msg);
      res.redirect('/wallet');
    };

    if (!method) return fail('Please choose a payment method.');
    if (!Number.isFinite(amount) || amount < 50 || amount > 1000000) return fail('Amount must be between ₱50 and ₱1,000,000.');
    if (reference.length < 4) return fail('Please enter the payment reference number.');
    if (req.file && !looksLikeImage(req.file.path)) return fail('That file is not a valid image.');

    const [[dupe]] = await pool.query(
      "SELECT id FROM deposits WHERE user_id = ? AND reference_no = ? AND status != 'rejected'",
      [req.user.id, reference]);
    if (dupe) return fail('You already submitted a deposit with that reference number.');

    await pool.query(
      'INSERT INTO deposits (user_id, method, amount_php, reference_no, receipt_path) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, method, amount.toFixed(2), reference, req.file ? path.basename(req.file.path) : null]);

    flash(req, 'success', 'Deposit submitted! We will verify your payment and credit your wallet shortly.');
    res.redirect('/wallet');
  } catch (err) { next(err); }
});

// Receipts are private: only the owner or an admin can view them.
router.get('/receipt/:id', async (req, res, next) => {
  try {
    const depositId = clampInt(req.params.id, 1, 2147483647);
    const [[deposit]] = await pool.query('SELECT user_id, receipt_path FROM deposits WHERE id = ?', [depositId]);
    if (!deposit || !deposit.receipt_path) return res.status(404).render('errors/404');
    if (deposit.user_id !== req.user.id && req.user.role !== 'admin') return res.status(404).render('errors/404');
    const filePath = path.join(uploadDir, path.basename(deposit.receipt_path));
    if (!fs.existsSync(filePath)) return res.status(404).render('errors/404');
    res.sendFile(filePath);
  } catch (err) { next(err); }
});

// ── Settings ──────────────────────────────────────────────
router.get('/settings', (req, res) => {
  res.render('dashboard/settings', { title: 'Account Settings' });
});

router.post('/settings/profile', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 100);
    await pool.query('UPDATE users SET name = ? WHERE id = ?', [name, req.user.id]);
    flash(req, 'success', 'Profile updated.');
    res.redirect('/settings');
  } catch (err) { next(err); }
});

router.post('/settings/password', async (req, res, next) => {
  try {
    const current = String(req.body.current_password || '');
    const nextPass = String(req.body.new_password || '');
    if (nextPass.length < 8) { flash(req, 'error', 'New password must be at least 8 characters.'); return res.redirect('/settings'); }

    const [[user]] = await pool.query('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    if (user.password_hash && !(await bcrypt.compare(current, user.password_hash))) {
      flash(req, 'error', 'Current password is incorrect.');
      return res.redirect('/settings');
    }
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(nextPass, 12), req.user.id]);
    flash(req, 'success', 'Password updated.');
    res.redirect('/settings');
  } catch (err) { next(err); }
});

router.post('/settings/api-key', async (req, res, next) => {
  try {
    const key = randomToken(32);
    await pool.query('UPDATE users SET api_key = ? WHERE id = ?', [key, req.user.id]);
    flash(req, 'success', 'New API key generated. The old key stops working immediately.');
    res.redirect('/settings');
  } catch (err) { next(err); }
});

module.exports = router;
