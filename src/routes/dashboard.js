'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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
const { randomToken, isValidHttpUrl, clampInt, strictInt, PLATFORM_LABELS } = require('../utils/helpers');
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

// SHA-256 of a file's bytes — used to reject a reused receipt screenshot.
function fileSha256(filePath) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); }
  catch (_) { return null; }
}

// Reject obviously fake payment reference numbers before they reach an admin.
// Normalizes spacing, checks a sane length, and blocks trivial patterns
// (all-same digit, simple sequences). Real GCash/Maya refs are 10–15 chars.
function validReference(raw) {
  const ref = String(raw || '').replace(/[\s-]/g, '');
  if (!/^[A-Za-z0-9]{7,40}$/.test(ref)) return { ok: false, msg: 'Enter the reference number exactly as shown on your receipt (letters/numbers only).' };
  // All-same character (e.g. 0000000000000, aaaaaaa) is an obvious placeholder.
  if (/^(.)\1+$/.test(ref)) return { ok: false, msg: 'That reference number looks invalid. Please copy it exactly from your receipt.' };
  // A pure ascending/descending run (12345678, 98765432) — exact match only, so
  // a real random reference that merely contains such a run is never rejected.
  const asc = '01234567890123456789';
  const desc = '98765432109876543210';
  if (/^\d+$/.test(ref) && (asc.includes(ref) || desc.includes(ref))) {
    return { ok: false, msg: 'That reference number looks invalid. Please copy it exactly from your receipt.' };
  }
  return { ok: true, ref };
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
    // Optional link + quantity prefill (used by the "Reorder" button on My Orders).
    const rawLink = String(req.query.link || '').slice(0, 500);
    const prefillLink = isValidHttpUrl(rawLink) ? rawLink : '';
    const prefillQty = clampInt(req.query.qty, 1, 100000000000) || '';
    const [[{ svcCount }]] = await pool.query(
      'SELECT COUNT(*) AS svcCount FROM services WHERE enabled = 1 AND deleted = 0');
    res.render('dashboard/order-new', {
      title: 'New Order', crumb: 'Place an order',
      platforms: platforms.map((r) => r.platform), preselected, prefillLink, prefillQty, svcCount,
    });
  } catch (err) { next(err); }
});

// ── Mass order (many links at once) ───────────────────────
router.get('/order/mass', async (req, res, next) => {
  try {
    const [platforms] = await pool.query(
      "SELECT DISTINCT platform FROM services WHERE enabled = 1 AND deleted = 0 ORDER BY platform");
    res.render('dashboard/order-mass', { title: 'Mass Order', platforms: platforms.map((r) => r.platform) });
  } catch (err) { next(err); }
});

router.post('/order/mass', async (req, res, next) => {
  try {
    const serviceId = strictInt(req.body.service_id, 1, 2147483647);
    const quantity = strictInt(req.body.quantity, 1, 100000000);
    const rawLinks = String(req.body.links || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // Unique, valid links, capped so one submit can't fire thousands of orders.
    const links = [...new Set(rawLinks)].filter((l) => isValidHttpUrl(l)).slice(0, 50);

    if (!serviceId || !quantity) { flash(req, 'error', 'Pick a service and quantity.'); return res.redirect('/order/mass'); }
    if (!links.length) { flash(req, 'error', 'Enter at least one valid link (http:// or https://), one per line.'); return res.redirect('/order/mass'); }

    const [[service]] = await pool.query(
      `SELECT s.*, p.code AS provider_code FROM services s JOIN providers p ON p.id = s.provider_id
       WHERE s.id = ? AND s.enabled = 1 AND s.deleted = 0`, [serviceId]);
    if (!service) { flash(req, 'error', 'That service is no longer available.'); return res.redirect('/order/mass'); }
    if (quantity < service.min_qty || quantity > service.max_qty) {
      flash(req, 'error', `Quantity must be between ${service.min_qty} and ${service.max_qty}.`); return res.redirect('/order/mass');
    }

    let placed = 0;
    let failed = 0;
    let spent = 0;
    let stopped = false;
    for (const link of links) {
      try {
        const r = await orderService.placeOrder(req.user, service, link, quantity, null);
        placed += 1; spent += Number(r.charge);
      } catch (err) {
        failed += 1;
        if (err.message === 'Insufficient balance') { stopped = true; break; } // stop early — no funds left
      }
    }
    const msg = `${placed} order${placed === 1 ? '' : 's'} placed (₱${spent.toFixed(2)})`
      + (failed ? ` · ${failed} failed` : '')
      + (stopped ? ' · stopped: insufficient balance' : '');
    flash(req, placed ? 'success' : 'error', placed ? msg : 'No orders were placed. ' + (stopped ? 'Insufficient balance.' : 'Please try again.'));
    res.redirect(placed ? '/orders' : '/order/mass');
  } catch (err) { next(err); }
});

router.get('/order/services.json', async (req, res, next) => {
  try {
    const platform = Object.prototype.hasOwnProperty.call(PLATFORM_LABELS, String(req.query.platform)) ? String(req.query.platform) : null;
    if (!platform) return res.json([]);
    const [services] = await pool.query(
      'SELECT id, name, category, min_qty, max_qty, rate_usd, markup_override, refill, dripfeed FROM services WHERE platform = ? AND enabled = 1 AND deleted = 0 ORDER BY category, rate_usd LIMIT 1000',
      [platform]);
    const { tidyCategory, tidyServiceName } = require('../utils/helpers');
    res.json(services.map((s) => ({
      id: s.id, name: tidyServiceName(s.name, s.id), category: tidyCategory(s.category),
      min: Number(s.min_qty), max: Number(s.max_qty),
      refill: !!s.refill, dripfeed: !!s.dripfeed, ratePhp: pricing.ratePhpPer1000(s), platform,
    })));
  } catch (err) { next(err); }
});

router.post('/order/new', async (req, res, next) => {
  try {
    const serviceId = strictInt(req.body.service_id, 1, 2147483647);
    const link = String(req.body.link || '').trim().slice(0, 2000);
    const quantity = strictInt(req.body.quantity, 1, 100000000);

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
    const dripOpts = (service.dripfeed && req.body.dripfeed === 'on')
      ? { runs: req.body.runs, interval: req.body.interval } : {};
    const { orderCode, charge, discount } = await orderService.placeOrder(req.user, service, link, quantity, promoCode, dripOpts);
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
    const q = String(req.query.q || '').trim().slice(0, 80);
    const status = ['Pending', 'In progress', 'Processing', 'Completed', 'Partial', 'Canceled', 'Failed']
      .find((s) => s.toLowerCase() === String(req.query.status || '').toLowerCase()) || '';
    // Build an optional search/status filter over the customer's own orders.
    const filt = ['o.user_id = ?'];
    const fparams = [req.user.id];
    if (q) { filt.push('(o.order_id LIKE ? OR o.service_name LIKE ? OR o.url LIKE ?)'); fparams.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (status) { filt.push('o.status = ?'); fparams.push(status); }
    const whereSql = filt.join(' AND ');

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM orders o WHERE ${whereSql}`, fparams);
    const pages = Math.max(1, Math.ceil(total / perPage));
    const current = Math.min(page, pages);
    // local_service_id lets the "Reorder" button jump straight back into the
    // order form with the same service preselected.
    const [orders] = await pool.query(
      `SELECT o.*, s.id AS local_service_id
       FROM orders o
       LEFT JOIN providers pr ON pr.code = IF(o.api_provider = 'SMMWorld', 'smmworld', 'rkd')
       LEFT JOIN services s ON s.provider_id = pr.id
            AND CONVERT(s.provider_service_id USING utf8mb4) COLLATE utf8mb4_bin =
                CONVERT(o.service_id USING utf8mb4) COLLATE utf8mb4_bin
            AND s.enabled = 1 AND s.deleted = 0
       WHERE ${whereSql} ORDER BY o.id DESC LIMIT ? OFFSET ?`,
      [...fparams, perPage, (current - 1) * perPage]);

    // Latest concern/ticket per order on this page, so the list can show live
    // refill/cancel progress ("Refill in progress", "Refill done", …).
    const ticketByOrder = {};
    const codes = orders.map((o) => o.order_id).filter(Boolean);
    if (codes.length) {
      const [tks] = await pool.query(
        `SELECT order_id, request_type, status, provider_action_status FROM tickets
         WHERE user_id = ? AND order_id IN (${codes.map(() => '?').join(',')}) ORDER BY id DESC`,
        [req.user.id, ...codes]);
      for (const t of tks) if (!ticketByOrder[t.order_id]) ticketByOrder[t.order_id] = t;
    }

    // Which of these orders the customer has already reviewed (to toggle the button).
    const reviewed = new Set();
    const ids = orders.map((o) => o.id);
    if (ids.length) {
      const [rv] = await pool.query(`SELECT order_id FROM reviews WHERE order_id IN (${ids.map(() => '?').join(',')})`, ids);
      for (const r of rv) reviewed.add(r.order_id);
    }
    res.render('dashboard/orders', { title: 'My Orders', orders, ticketByOrder, reviewed, q, status, pagination: { current, pages, total } });
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
    return res.redirect(`/support/${tRes.insertId}`);
  } catch (err) {
    flash(req, 'error', 'Could not submit your concern right now. Please try again.');
  }
  res.redirect('/orders');
});

// Leave a review for a completed order (one per order).
router.post('/orders/:id/review', async (req, res) => {
  try {
    const orderId = clampInt(req.params.id, 1, 2147483647);
    const rating = strictInt(req.body.rating, 1, 5);
    const body = String(req.body.body || '').trim().slice(0, 600);
    const [[order]] = await pool.query('SELECT id, user_id, status FROM orders WHERE id = ?', [orderId]);
    if (!order || order.user_id !== req.user.id) return res.status(404).render('errors/404');
    if (String(order.status) !== 'Completed') { flash(req, 'error', 'You can only review completed orders.'); return res.redirect('/orders'); }
    if (!rating) { flash(req, 'error', 'Please pick a star rating.'); return res.redirect('/orders'); }
    try {
      await pool.query('INSERT INTO reviews (user_id, order_id, rating, body) VALUES (?, ?, ?, ?)',
        [req.user.id, orderId, rating, body || null]);
      flash(req, 'success', 'Thanks for your review! 🌟');
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') flash(req, 'error', 'You already reviewed this order.');
      else throw err;
    }
  } catch (err) {
    flash(req, 'error', 'Could not save your review. Please try again.');
  }
  res.redirect('/orders');
});

// ── Support inbox (two-way chat) ──────────────────────────
router.get('/support', async (req, res, next) => {
  try {
    const [tickets] = await pool.query(
      `SELECT id, subject, request_type, order_id, status, customer_unread, created_at
       FROM tickets WHERE user_id = ? ORDER BY id DESC LIMIT 100`, [req.user.id]);
    res.render('dashboard/support', { title: 'Support', tickets });
  } catch (err) { next(err); }
});

router.get('/support/:id', async (req, res, next) => {
  try {
    const tickets = require('../services/tickets');
    const id = clampInt(req.params.id, 1, 2147483647);
    const [[own]] = await pool.query('SELECT user_id FROM tickets WHERE id = ?', [id]);
    if (!own || own.user_id !== req.user.id) return res.status(404).render('errors/404');
    const data = await tickets.thread(id);
    // Customer opened it → clear their unread flag.
    await pool.query('UPDATE tickets SET customer_unread = 0 WHERE id = ?', [id]);
    res.render('dashboard/support-thread', { title: `Ticket #${id}`, ticket: data.ticket, messages: data.messages });
  } catch (err) { next(err); }
});

router.post('/support/:id/reply', async (req, res) => {
  const id = clampInt(req.params.id, 1, 2147483647);
  try {
    const [[own]] = await pool.query('SELECT user_id FROM tickets WHERE id = ?', [id]);
    if (!own || own.user_id !== req.user.id) return res.status(404).render('errors/404');
    const body = String(req.body.message || '').trim().slice(0, 4000);
    if (body.length < 2) { flash(req, 'error', 'Please type a message.'); return res.redirect(`/support/${id}`); }
    await require('../services/tickets').postMessage(id, 'customer', body);
  } catch (err) {
    flash(req, 'error', 'Could not send your message. Please try again.');
  }
  res.redirect(`/support/${id}`);
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

    // Verify CSRF here (after multer parsed the multipart body) so the token
    // travels in a hidden field, never the URL.
    if (!require('../middleware/csrf').verifyToken(req)) return fail('Your session expired. Please try again.');

    if (!method) return fail('Please choose a payment method.');
    if (!Number.isFinite(amount) || amount < 50 || amount > 1000000) return fail('Amount must be between ₱50 and ₱1,000,000.');
    const refCheck = validReference(reference);
    if (!refCheck.ok) return fail(refCheck.msg);
    if (req.file && !looksLikeImage(req.file.path)) return fail('That file is not a valid image.');

    // Same reference already used by ANYONE (not just this user) is a red flag.
    const [[dupe]] = await pool.query(
      "SELECT id, user_id FROM deposits WHERE reference_id = ? AND status <> 'Rejected'", [reference]);
    if (dupe) return fail(dupe.user_id === req.user.id
      ? 'You already submitted a deposit with that reference number.'
      : 'That reference number was already used. Please double-check your receipt.');

    // Same receipt SCREENSHOT reused across accounts = fraud. Fingerprint it.
    let receiptHash = null;
    if (req.file) {
      receiptHash = fileSha256(req.file.path);
      if (receiptHash) {
        const [[dupImg]] = await pool.query(
          "SELECT id FROM deposits WHERE receipt_hash = ? AND status <> 'Rejected' LIMIT 1", [receiptHash]);
        if (dupImg) return fail('That receipt image was already submitted. Please upload the correct screenshot for this payment.');
      }
    }

    let depRes;
    try {
      [depRes] = await pool.query(
        "INSERT INTO deposits (user_id, payment_method, amount, reference_id, status, receipt_path, receipt_hash) VALUES (?, ?, ?, ?, 'Pending', ?, ?)",
        [req.user.id, method, amount.toFixed(4), reference, req.file ? path.basename(req.file.path) : null, receiptHash]);
      req._depositSaved = true; // receipt now belongs to a saved deposit — don't clean it up
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
  } catch (err) {
    // An unexpected error before the deposit row was saved would otherwise
    // leave the uploaded receipt orphaned on disk — clean it up.
    if (req.file && !req._depositSaved) fs.unlink(req.file.path, () => {});
    next(err);
  }
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
const totp = require('../utils/totp');

router.get('/settings', async (req, res, next) => {
  try {
    // A pending 2FA setup (secret generated, not yet confirmed) lives in session.
    const pending = req.session.pending2fa || null;
    const [[me]] = await pool.query('SELECT email_optout FROM users WHERE id = ?', [req.user.id]);
    res.render('dashboard/settings', {
      title: 'Account Settings',
      twofaEnabled: !!req.user.totp_enabled,
      pending2fa: pending,
      emailUpdates: !(me && me.email_optout),
    });
  } catch (err) { next(err); }
});

// Marketing email preference. Transactional mail is unaffected either way.
router.post('/settings/emails', async (req, res, next) => {
  try {
    const optIn = req.body.email_updates === 'on';
    await pool.query(
      'UPDATE users SET email_optout = ?, email_optout_at = IF(? = 1, NOW(), NULL) WHERE id = ?',
      [optIn ? 0 : 1, optIn ? 0 : 1, req.user.id]);
    flash(req, 'success', optIn
      ? 'You\'ll now get product updates and new-service announcements.'
      : 'Turned off. You\'ll still get order, deposit and security emails.');
    res.redirect('/settings');
  } catch (err) { next(err); }
});

// Start 2FA setup: generate a secret, stash it in the session, show the key.
router.post('/settings/2fa/start', (req, res) => {
  if (req.user.totp_enabled) { flash(req, 'error', 'Two-factor is already enabled.'); return res.redirect('/settings'); }
  const secret = totp.generateSecret();
  req.session.pending2fa = {
    secret,
    otpauth: totp.otpauthUrl(secret, req.user.email || req.user.username, env.SITE_NAME || 'ApexBoost'),
  };
  res.redirect('/settings#twofa');
});

// Confirm 2FA: verify a code from the authenticator app, then enable.
router.post('/settings/2fa/enable', async (req, res, next) => {
  try {
    const pending = req.session.pending2fa;
    if (!pending || !pending.secret) { flash(req, 'error', 'Start the 2FA setup first.'); return res.redirect('/settings'); }
    if (!totp.verify(pending.secret, req.body.code)) {
      flash(req, 'error', 'That code is incorrect or expired. Make sure your phone time is correct and try again.');
      return res.redirect('/settings#twofa');
    }
    await pool.query('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?', [pending.secret, req.user.id]);
    delete req.session.pending2fa;
    flash(req, 'success', 'Two-factor authentication is now ON. You will be asked for a code at each login. 🔐');
    res.redirect('/settings');
  } catch (err) { next(err); }
});

// Cancel a pending (unconfirmed) 2FA setup.
router.post('/settings/2fa/cancel', (req, res) => {
  delete req.session.pending2fa;
  res.redirect('/settings');
});

// Disable 2FA — requires a valid current code so a hijacked session can't do it.
router.post('/settings/2fa/disable', async (req, res, next) => {
  try {
    if (!req.user.totp_enabled) return res.redirect('/settings');
    const [[u]] = await pool.query('SELECT totp_secret FROM users WHERE id = ?', [req.user.id]);
    if (!u || !totp.verify(u.totp_secret, req.body.code)) {
      flash(req, 'error', 'Enter a valid current 2FA code to turn it off.'); return res.redirect('/settings');
    }
    await pool.query('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?', [req.user.id]);
    flash(req, 'success', 'Two-factor authentication turned off.');
    res.redirect('/settings');
  } catch (err) { next(err); }
});

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
