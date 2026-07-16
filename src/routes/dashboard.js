'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const env = require('../config/env');
const pool = require('../db/pool');
const pricing = require('../services/pricing');
const orderService = require('../services/orders');
const wallet = require('../services/wallet');
const mailer = require('../services/mailer');
const notifications = require('../services/notifications');
const { requireAuth } = require('../middleware/auth');
const { randomToken, isValidHttpUrl, clampInt, PLATFORM_LABELS } = require('../utils/helpers');
const { hashSecret, verifySecret } = require('../utils/password');

const router = express.Router();
router.use(['/dashboard', '/order', '/orders', '/wallet', '/settings', '/receipt', '/referrals'], requireAuth);

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
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)),
});

const MAGIC = [
  { bytes: [0xff, 0xd8, 0xff] }, { bytes: [0x89, 0x50, 0x4e, 0x47] }, { bytes: [0x52, 0x49, 0x46, 0x46] },
];
function looksLikeImage(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return MAGIC.some((m) => m.bytes.every((b, i) => buf[i] === b));
  } catch (_) { return false; }
}

const PAY_METHODS = [
  { code: 'gcash', label: 'GCash', numKey: 'GCASH_ACCOUNT_NUMBER', nameKey: 'GCASH_ACCOUNT_NAME', extra: '' },
  { code: 'paymaya', label: 'Maya', numKey: 'MAYA_ACCOUNT_NUMBER', nameKey: 'MAYA_ACCOUNT_NAME', extra: '' },
  { code: 'bpi', label: 'BPI', numKey: 'BPI_ACCOUNT_NUMBER', nameKey: 'BPI_ACCOUNT_NAME', extra: env.BPI_ACCOUNT_TYPE },
];
function activeMethods() {
  return PAY_METHODS.filter((m) => env[m.numKey]).map((m) => ({
    code: m.code, label: m.label, number: env[m.numKey], name: env[m.nameKey], extra: m.extra,
  }));
}

// ── Overview ──────────────────────────────────────────────
router.get('/dashboard', async (req, res, next) => {
  try {
    const [[counts]] = await pool.query(
      `SELECT COUNT(*) AS orders,
              COALESCE(SUM(charge - COALESCE(refund_amount,0)), 0) AS spent,
              SUM(status IN ('Pending','In progress','Processing')) AS active
       FROM orders WHERE user_id = ?`, [req.user.id]);
    const [recentOrders] = await pool.query(
      'SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 5', [req.user.id]);
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
      const [[svc]] = await pool.query('SELECT * FROM services WHERE id = ? AND enabled = 1 AND deleted = 0', [selectedService]);
      if (svc) preselected = { ...svc, ratePhp: pricing.ratePhpPer1000(svc) };
    }
    res.render('dashboard/order-new', { title: 'New Order', platforms: platforms.map((r) => r.platform), preselected });
  } catch (err) { next(err); }
});

router.get('/order/services.json', async (req, res, next) => {
  try {
    const platform = Object.prototype.hasOwnProperty.call(PLATFORM_LABELS, String(req.query.platform)) ? String(req.query.platform) : null;
    if (!platform) return res.json([]);
    const [services] = await pool.query(
      'SELECT id, name, category, min_qty, max_qty, rate_usd, markup_override, refill FROM services WHERE platform = ? AND enabled = 1 AND deleted = 0 ORDER BY category, rate_usd LIMIT 1000',
      [platform]);
    res.json(services.map((s) => ({
      id: s.id, name: s.name, category: s.category, min: s.min_qty, max: s.max_qty,
      refill: !!s.refill, ratePhp: pricing.ratePhpPer1000(s),
    })));
  } catch (err) { next(err); }
});

router.post('/order/new', async (req, res, next) => {
  try {
    const serviceId = clampInt(req.body.service_id, 1, 2147483647);
    const link = String(req.body.link || '').trim().slice(0, 2000);
    const quantity = clampInt(req.body.quantity, 1, 100000000);

    if (!serviceId || !quantity) { flash(req, 'error', 'Please pick a service and quantity.'); return res.redirect('/order/new'); }
    if (!isValidHttpUrl(link)) { flash(req, 'error', 'Please enter a valid link (http:// or https://).'); return res.redirect('/order/new'); }

    const [[service]] = await pool.query(
      `SELECT s.*, p.code AS provider_code FROM services s JOIN providers p ON p.id = s.provider_id
       WHERE s.id = ? AND s.enabled = 1 AND s.deleted = 0`, [serviceId]);
    if (!service) { flash(req, 'error', 'That service is no longer available.'); return res.redirect('/order/new'); }
    if (quantity < service.min_qty || quantity > service.max_qty) {
      flash(req, 'error', `Quantity must be between ${service.min_qty} and ${service.max_qty} for this service.`);
      return res.redirect(`/order/new?service=${service.id}`);
    }

    const promoCode = String(req.body.promo_code || '').trim().slice(0, 50) || null;
    const { orderCode, charge, discount } = await orderService.placeOrder(req.user, service, link, quantity, promoCode);
    const savedNote = discount > 0 ? ` (promo saved ₱${Number(discount).toFixed(2)})` : '';
    flash(req, 'success', `Order ${orderCode} placed — ₱${Number(charge).toFixed(2)} charged to your wallet${savedNote}.`);
    res.redirect('/orders');
  } catch (err) {
    if (err.message === 'Insufficient balance') { flash(req, 'error', 'Insufficient balance. Please add funds first.'); return res.redirect('/wallet'); }
    // Promo validation + pause errors are user-facing — show them on the order form.
    if (/promo code|temporarily paused/i.test(err.message)) { flash(req, 'error', err.message); return res.redirect(`/order/new?service=${req.body.service_id || ''}`); }
    if (err.orderId) { flash(req, 'error', err.message); return res.redirect('/orders'); }
    next(err);
  }
});

// ── Order history ─────────────────────────────────────────
router.get('/orders', async (req, res, next) => {
  try {
    const page = clampInt(req.query.page, 1, 100000) || 1;
    const perPage = 20;
    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM orders WHERE user_id = ?', [req.user.id]);
    const pages = Math.max(1, Math.ceil(total / perPage));
    const current = Math.min(page, pages);
    const [orders] = await pool.query(
      'SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
      [req.user.id, perPage, (current - 1) * perPage]);
    res.render('dashboard/orders', { title: 'My Orders', orders, pagination: { current, pages, total } });
  } catch (err) { next(err); }
});

router.post('/orders/:id/refresh', async (req, res) => {
  try {
    const orderId = clampInt(req.params.id, 1, 2147483647);
    const [[order]] = await pool.query('SELECT id, user_id FROM orders WHERE id = ?', [orderId]);
    if (!order || order.user_id !== req.user.id) return res.status(404).render('errors/404');
    await orderService.syncOrderById(orderId);
    flash(req, 'success', 'Order status refreshed.');
  } catch (err) {
    flash(req, 'error', 'Could not refresh the order right now. Please try again shortly.');
  }
  res.redirect('/orders');
});

// Raise a concern/ticket about an order (Cancel / Refill / Speed up / Other).
router.post('/orders/:id/ticket', async (req, res) => {
  try {
    const orderId = clampInt(req.params.id, 1, 2147483647);
    const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order || order.user_id !== req.user.id) return res.status(404).render('errors/404');

    const allowed = ['Cancel', 'Refill', 'Speed up', 'Other'];
    const requestType = allowed.includes(req.body.request_type) ? req.body.request_type : 'Other';
    const message = String(req.body.message || '').trim().slice(0, 2000);
    if (message.length < 3) { flash(req, 'error', 'Please describe your concern.'); return res.redirect('/orders'); }

    const [tRes] = await pool.query(
      `INSERT INTO tickets (user_id, subject, order_id, request_type, message, status, priority, provider_order_id, api_provider)
       VALUES (?, ?, ?, ?, ?, 'open', 'normal', ?, ?)`,
      [req.user.id, `Order concern: ${requestType}`, order.order_id, requestType, message, order.provider_order_id, order.api_provider]);
    // AI autopilot triages the new ticket right away (fire-and-forget).
    require('../services/autopilot').handleTicket(tRes.insertId).catch(() => {});
    flash(req, 'success', 'Your concern has been submitted — our team will take a look shortly.');
  } catch (err) {
    flash(req, 'error', 'Could not submit your concern right now. Please try again.');
  }
  res.redirect('/orders');
});

// ── Wallet / add funds ────────────────────────────────────
router.get('/wallet', async (req, res, next) => {
  try {
    const [deposits] = await pool.query('SELECT * FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT 20', [req.user.id]);
    const [transactions] = await pool.query('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 30', [req.user.id]);
    res.render('dashboard/wallet', {
      title: 'Wallet & Add Funds', deposits, transactions, methods: activeMethods(),
      bonusTiers: wallet.bonusTiers().slice().sort((a, b) => a.min - b.min),
    });
  } catch (err) { next(err); }
});

router.post('/wallet/deposit', (req, res, next) => {
  upload.single('receipt')(req, res, (err) => {
    if (err) { flash(req, 'error', err.code === 'LIMIT_FILE_SIZE' ? 'Receipt must be 5MB or smaller.' : 'Receipt upload failed. JPG, PNG or WEBP only.'); return res.redirect('/wallet'); }
    next();
  });
}, async (req, res, next) => {
  try {
    const method = ['gcash', 'paymaya', 'bpi'].includes(req.body.method) ? req.body.method : null;
    const amount = Number(req.body.amount);
    const reference = String(req.body.reference || '').trim().slice(0, 100);
    const fail = (msg) => { if (req.file) fs.unlink(req.file.path, () => {}); flash(req, 'error', msg); res.redirect('/wallet'); };

    if (!method) return fail('Please choose a payment method.');
    if (!Number.isFinite(amount) || amount < 50 || amount > 1000000) return fail('Amount must be between ₱50 and ₱1,000,000.');
    if (reference.length < 4) return fail('Please enter the payment reference number.');
    if (req.file && !looksLikeImage(req.file.path)) return fail('That file is not a valid image.');

    const [[dupe]] = await pool.query(
      "SELECT id FROM deposits WHERE user_id = ? AND reference_id = ? AND status <> 'Rejected'",
      [req.user.id, reference]);
    if (dupe) return fail('You already submitted a deposit with that reference number.');

    let depRes;
    try {
      [depRes] = await pool.query(
        "INSERT INTO deposits (user_id, payment_method, amount, reference_id, status, receipt_path) VALUES (?, ?, ?, ?, 'Pending', ?)",
        [req.user.id, method, amount.toFixed(4), reference, req.file ? path.basename(req.file.path) : null]);
    } catch (err) {
      // reference_id is globally unique — a reference someone else already used
      // must be rejected cleanly, never crash.
      if (err && err.code === 'ER_DUP_ENTRY') return fail('That reference number was already used. Please double-check your receipt.');
      throw err;
    }

    // Auto email + in-app notification confirming the funds request.
    const deposit = { id: depRes.insertId, payment_method: method, amount, reference_id: reference };
    mailer.sendDepositReceived(req.user.email, deposit).catch(() => {});
    notifications.notifyUser(req.user.id, 'deposit', 'Deposit request received ✅',
      `We received your ${method.toUpperCase()} deposit of ₱${amount.toFixed(2)} (ref: ${reference}). We'll credit your wallet once verified.`).catch(() => {});

    flash(req, 'success', 'Deposit submitted! We emailed you a confirmation and will credit your wallet once verified.');
    res.redirect('/wallet');
  } catch (err) { next(err); }
});

router.get('/receipt/:id', async (req, res) => {
  try {
    const depositId = clampInt(req.params.id, 1, 2147483647);
    const [[deposit]] = await pool.query('SELECT user_id, receipt_path FROM deposits WHERE id = ?', [depositId]);
    if (!deposit || !deposit.receipt_path) return res.status(404).render('errors/404');
    if (deposit.user_id !== req.user.id && !req.user.isAdmin) return res.status(404).render('errors/404');
    const filePath = path.join(uploadDir, path.basename(deposit.receipt_path));
    if (!fs.existsSync(filePath)) return res.status(404).render('errors/404');
    res.sendFile(filePath);
  } catch (err) { res.status(404).render('errors/404'); }
});

// ── Referrals (invite & earn) ─────────────────────────────
const referrals = require('../services/referrals');

router.get('/referrals', async (req, res, next) => {
  try {
    const code = await referrals.ensureCode(req.user.id);
    const info = await referrals.stats(req.user);
    const link = `${env.BASE_URL.replace(/\/$/, '')}/register?ref=${code}`;
    res.render('dashboard/referrals', { title: 'Invite & Earn', code, link, info });
  } catch (err) { next(err); }
});

router.post('/referrals/payout', async (req, res, next) => {
  try {
    const info = await referrals.stats(req.user);
    const amount = Math.round(Number(req.body.amount) * 100) / 100;
    const method = ['gcash', 'paymaya'].includes(req.body.method) ? req.body.method : null;
    const accountNumber = String(req.body.account_number || '').trim().slice(0, 50);
    const accountName = String(req.body.account_name || '').trim().slice(0, 100);

    if (!method) { flash(req, 'error', 'Please choose GCash or Maya for the payout.'); return res.redirect('/referrals'); }
    if (!/^[0-9+\-\s]{7,20}$/.test(accountNumber)) { flash(req, 'error', 'Please enter a valid account/mobile number.'); return res.redirect('/referrals'); }
    if (accountName.length < 3) { flash(req, 'error', 'Please enter the account holder name.'); return res.redirect('/referrals'); }
    if (!Number.isFinite(amount) || amount < info.minPayout) {
      flash(req, 'error', `Minimum payout is ₱${info.minPayout.toFixed(2)}.`); return res.redirect('/referrals');
    }
    if (amount > info.withdrawable) {
      flash(req, 'error', `You can withdraw up to ₱${info.withdrawable.toFixed(2)} of referral earnings right now.`);
      return res.redirect('/referrals');
    }

    await wallet.createPayoutRequest(req.user.id, amount, method, accountNumber, accountName);
    notifications.notifyUser(req.user.id, 'payout', 'Payout request received 💸',
      `We received your ₱${amount.toFixed(2)} payout request via ${method.toUpperCase()}. It will be processed by our team shortly.`).catch(() => {});
    flash(req, 'success', `Payout request submitted! ₱${amount.toFixed(2)} is on hold and will be sent to your ${method === 'gcash' ? 'GCash' : 'Maya'} once processed.`);
    res.redirect('/referrals');
  } catch (err) {
    if (err.message === 'Insufficient balance') {
      flash(req, 'error', 'Your wallet balance is lower than the requested payout.');
      return res.redirect('/referrals');
    }
    next(err);
  }
});

// ── Settings ──────────────────────────────────────────────
router.get('/settings', (req, res) => res.render('dashboard/settings', { title: 'Account Settings' }));

router.post('/settings/profile', async (req, res, next) => {
  try {
    const username = String(req.body.name || req.body.username || '').trim().slice(0, 100);
    if (username.length < 3) { flash(req, 'error', 'Username must be at least 3 characters.'); return res.redirect('/settings'); }
    const [[taken]] = await pool.query('SELECT id FROM users WHERE username = ? AND id <> ? LIMIT 1', [username, req.user.id]);
    if (taken) { flash(req, 'error', 'That username is already taken.'); return res.redirect('/settings'); }
    await pool.query('UPDATE users SET username = ? WHERE id = ?', [username, req.user.id]);
    flash(req, 'success', 'Profile updated.');
    res.redirect('/settings');
  } catch (err) { next(err); }
});

router.post('/settings/password', async (req, res, next) => {
  try {
    const current = String(req.body.current_password || '');
    const nextPass = String(req.body.new_password || '');
    if (nextPass.length < 8) { flash(req, 'error', 'New password must be at least 8 characters.'); return res.redirect('/settings'); }
    const [[user]] = await pool.query('SELECT password FROM users WHERE id = ?', [req.user.id]);
    if (user.password && !(await verifySecret(current, user.password))) {
      flash(req, 'error', 'Current password is incorrect.'); return res.redirect('/settings');
    }
    await pool.query('UPDATE users SET password = ? WHERE id = ?', [await hashSecret(nextPass), req.user.id]);
    flash(req, 'success', 'Password updated.');
    res.redirect('/settings');
  } catch (err) { next(err); }
});

router.post('/settings/api-key', async (req, res, next) => {
  try {
    await pool.query('UPDATE users SET api_key = ? WHERE id = ?', [randomToken(32), req.user.id]);
    flash(req, 'success', 'New API key generated. The old key stops working immediately.');
    res.redirect('/settings');
  } catch (err) { next(err); }
});

module.exports = router;
