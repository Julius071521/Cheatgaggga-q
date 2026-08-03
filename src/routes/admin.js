'use strict';
const express = require('express');
const pool = require('../db/pool');
const wallet = require('../services/wallet');
const mailer = require('../services/mailer');
const catalog = require('../services/catalog');
const orderService = require('../services/orders');
const { allClients, getClient } = require('../providers');
const { setSetting, getSetting } = require('../services/stats');
const notifications = require('../services/notifications');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { invalidate: invalidateGate } = require('../middleware/gate');
const { invalidate: invalidateNetguard } = require('../middleware/networkGuard');
const env = require('../config/env');
const { clampInt, isValidHttpUrl } = require('../utils/helpers');
const orderRef = require('../services/orderRef');

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

// ── AI Autopilot ──────────────────────────────────────────
const autopilot = require('../services/autopilot');

router.get('/admin/autopilot', async (req, res, next) => {
  try {
    const on = await autopilot.isOn();
    const [pending] = await pool.query(
      `SELECT l.*, u.username FROM autopilot_log l LEFT JOIN users u ON u.id = l.user_id
       WHERE l.outcome = 'needs_admin' AND l.acknowledged = 0 ORDER BY l.id DESC LIMIT 50`);
    const [recent] = await pool.query(
      `SELECT l.*, u.username FROM autopilot_log l LEFT JOIN users u ON u.id = l.user_id
       ORDER BY l.id DESC LIMIT 100`);
    const [[stats7]] = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM(outcome = 'done') AS done,
              SUM(outcome = 'needs_admin') AS escalated
       FROM autopilot_log WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`);
    res.render('admin/autopilot', { title: 'Admin · AI Autopilot', on, pending, recent, stats7 });
  } catch (err) { next(err); }
});

router.post('/admin/autopilot/toggle', async (req, res, next) => {
  try {
    const on = req.body.autopilot === '1' || req.body.autopilot === 'on';
    await setSetting('autopilot', on ? 'on' : 'off');
    flash(req, 'success', on
      ? 'AI Autopilot is ON — new reports are triaged automatically and stuck orders are watched.'
      : 'AI Autopilot is OFF — reports now wait for manual handling.');
    res.redirect('/admin/autopilot');
  } catch (err) { next(err); }
});

router.post('/admin/autopilot/ack/:id', async (req, res, next) => {
  try {
    await pool.query('UPDATE autopilot_log SET acknowledged = 1 WHERE id = ?', [clampInt(req.params.id, 1, 2147483647)]);
    flash(req, 'success', 'Marked as handled.');
    res.redirect('/admin/autopilot');
  } catch (err) { next(err); }
});

router.post('/admin/autopilot/run', async (req, res) => {
  try {
    const r = await autopilot.tick();
    flash(req, 'success', r
      ? `Autopilot pass done — orders checked: ${r.synced ? r.synced.checked : 0}, tickets triaged: ${r.tickets}, stuck flagged: ${r.flagged}.`
      : 'Autopilot is already running a pass — check back in a moment.');
  } catch (err) {
    flash(req, 'error', `Autopilot run failed: ${err.message}`);
  }
  res.redirect('/admin/autopilot');
});

// ── Security · Threat Radar ────────────────────────────────
const security = require('../services/security');

router.get('/admin/security', async (req, res, next) => {
  try {
    const enabled = ['1', 'true', 'on', 'yes'].includes(String(await getSetting('security_enabled', 'on')).toLowerCase());
    const autoBlock = ['1', 'true', 'on', 'yes'].includes(String(await getSetting('security_auto_block', 'off')).toLowerCase());
    const [threats] = await pool.query(
      `SELECT r.*, (SELECT COUNT(*) FROM blocked_ips b
                    WHERE b.ip = CONVERT(r.ip USING utf8mb4) COLLATE utf8mb4_general_ci) AS is_blocked
       FROM ip_reputation r
       WHERE r.status IS NULL OR r.status <> 'allowed'
       ORDER BY (r.status = 'blocked') DESC, r.score DESC, r.last_seen DESC LIMIT 60`);
    const [recent] = await pool.query(
      'SELECT * FROM security_events ORDER BY id DESC LIMIT 40');
    const [[stat]] = await pool.query(`
      SELECT COUNT(*) AS events24,
             COUNT(DISTINCT ip) AS ips24
      FROM security_events WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`);
    const [[blk]] = await pool.query('SELECT COUNT(*) AS c FROM blocked_ips');
    const cloudflare = require('../services/cloudflare');
    let cfThreats = [];
    let cfEdgeBlocked = 0;
    if (cloudflare.configured) {
      try { cfThreats = await cloudflare.recentThreats(23, 15); } catch (_) {}
      try { cfEdgeBlocked = (await cloudflare.listBlocked(100)).length; } catch (_) {}
    }
    const allowed = await security.listAllowed();
    const ipintel = require('../services/ipintel');
    const netguard = {
      mode: String(await getSetting('netguard_mode', env.NETGUARD_MODE)).toLowerCase(),
      hosting: ['1', 'true', 'on', 'yes'].includes(String(await getSetting('netguard_hosting', 'on')).toLowerCase()),
      vpn: ['1', 'true', 'on', 'yes'].includes(String(await getSetting('netguard_vpn', 'on')).toLowerCase()),
      proxy: ['1', 'true', 'on', 'yes'].includes(String(await getSetting('netguard_proxy', 'on')).toLowerCase()),
      tor: ['1', 'true', 'on', 'yes'].includes(String(await getSetting('netguard_tor', 'on')).toLowerCase()),
      stats: await ipintel.stats(),
      recent: await ipintel.recent(40).catch(() => []),
      ranges: ipintel.rangeCount,
      lookupOn: env.NETGUARD_LOOKUP,
    };
    res.render('admin/security', {
      title: 'Admin · Security', enabled, autoBlock, threats, recent, stat, blockedCount: blk.c, netguard,
      telegramOn: require('../services/telegram').enabled,
      underAttack: await security.underAttack(),
      threatLevel: security.threatLevel, flagEmoji: security.flagEmoji, kindLabel: security.KIND_LABEL,
      cfConfigured: cloudflare.configured, cfThreats, cfEdgeBlocked,
      allowed, myIp: req.clientIp || req.ip,
    });
  } catch (err) { next(err); }
});

router.post('/admin/security/toggle', async (req, res, next) => {
  try {
    const key = req.body.key === 'auto' ? 'security_auto_block' : 'security_enabled';
    const on = req.body.value === '1';
    await setSetting(key, on ? 'on' : 'off');
    flash(req, 'success', `${key === 'auto' ? 'Auto-block' : 'Threat Radar'} turned ${on ? 'ON' : 'OFF'}.`);
    res.redirect('/admin/security');
  } catch (err) { next(err); }
});

// ── Network Guard (VPN / proxy / Tor / VPS) ───────────────
router.post('/admin/security/netguard', async (req, res, next) => {
  try {
    const mode = String(req.body.mode || '').toLowerCase();
    if (['off', 'monitor', 'guard', 'block'].includes(mode)) {
      await setSetting('netguard_mode', mode);
      flash(req, 'success', `Network Guard set to ${mode.toUpperCase()}.`);
    } else {
      // Individual kind toggle.
      const kinds = { hosting: 'netguard_hosting', vpn: 'netguard_vpn', proxy: 'netguard_proxy', tor: 'netguard_tor' };
      const key = kinds[String(req.body.kind || '')];
      if (!key) { flash(req, 'error', 'Unknown Network Guard setting.'); return res.redirect('/admin/security'); }
      const on = req.body.value === '1';
      await setSetting(key, on ? 'on' : 'off');
      flash(req, 'success', `${req.body.kind.toUpperCase()} filtering turned ${on ? 'ON' : 'OFF'}.`);
    }
    invalidateNetguard();
    res.redirect('/admin/security');
  } catch (err) { next(err); }
});

// Clear one IP so a customer wrongly identified as VPN/VPS gets straight back
// in. Also trusts the IP outright, which short-circuits every later lookup.
router.post('/admin/security/netguard/clear', async (req, res, next) => {
  try {
    const ip = String(req.body.ip || '').trim().slice(0, 45);
    if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) { flash(req, 'error', 'Invalid IP.'); return res.redirect('/admin/security'); }
    await require('../services/ipintel').markResidential(ip);
    await security.allowIp(ip);
    flash(req, 'success', `${ip} cleared — this visitor can use the site normally now.`);
    res.redirect('/admin/security');
  } catch (err) { next(err); }
});

router.post('/admin/security/ip', async (req, res, next) => {
  try {
    const ip = String(req.body.ip || '').trim().slice(0, 45);
    const action = req.body.action;
    if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) { flash(req, 'error', 'Invalid IP.'); return res.redirect('/admin/security'); }
    if (action === 'block') await security.blockIp(ip, 'Blocked from admin panel', req.user.id);
    else if (action === 'allow' || action === 'trust') await security.allowIp(ip);
    else if (action === 'untrust') await security.untrustIp(ip);
    else if (action === 'watch') await security.watchIp(ip);
    const verb = { block: 'blocked', allow: 'trusted', trust: 'trusted', untrust: 'removed from trusted', watch: 'watched' }[action] || action;
    flash(req, 'success', `IP ${ip} ${verb}.`);
    res.redirect('/admin/security');
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
    const off = type === 'fixed' ? `₱${value.toFixed(2)} off` : `${value}% off`;
    notifications.postUpdate('promo', `New promo code: ${code}`, `Use code ${code} for ${off} on your next order!`, '/order/new').catch(() => {});
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
    const q = String(req.query.q || '').trim().slice(0, 80);
    const clauses = [];
    const params = [];
    if (status) { clauses.push('LOWER(t.status) = ?'); params.push(status); }
    if (q) {
      // Search by site order code (APX-…), provider order number, customer, or subject.
      clauses.push('(t.order_id LIKE ? OR t.provider_order_id = ? OR u.username LIKE ? OR u.email LIKE ? OR t.subject LIKE ?)');
      params.push(`%${q}%`, q, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const [tickets] = await pool.query(
      `SELECT t.*, u.username, u.email FROM tickets t LEFT JOIN users u ON u.id = t.user_id
       ${where} ORDER BY t.id DESC LIMIT 100`, params);
    res.render('admin/tickets', { title: 'Admin · Customer Concerns', tickets, status, q });
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
    let newStatus = 'in_progress';
    if (action === 'refill' || action === 'cancel') {
      const { providerOrderId, code } = await resolveTicketProvider(ticket);
      const client = getClient(code);
      if (!providerOrderId || !client) throw new Error('No provider order linked to this ticket.');
      const result = action === 'refill' ? await client.refill(providerOrderId) : await client.cancel(providerOrderId);
      statusText = `${action}_sent`;
      response = JSON.stringify(result).slice(0, 1000);
    } else if (action === 'refund') {
      // Refund the linked order straight from the concern.
      const [[order]] = await pool.query('SELECT id FROM orders WHERE order_id = ? OR id = ? LIMIT 1',
        [ticket.order_id, /^\d+$/.test(String(ticket.order_id)) ? ticket.order_id : 0]);
      if (!order) throw new Error('No order linked to this ticket to refund.');
      const r = await orderService.adminRefund(order.id, `Refund from concern #${ticket.id}`, req.user.id);
      if (r.refunded > 0 && r.userId) {
        notifications.notifyUser(r.userId, 'order', 'Order refunded 💸',
          `Your order ${r.orderCode} was refunded ₱${r.refunded.toFixed(2)} to your wallet.`).catch(() => {});
      }
      statusText = 'refunded';
      response = r.refunded > 0 ? `Refunded ₱${r.refunded.toFixed(2)}` : (r.skipped || 'nothing to refund');
      newStatus = 'resolved';
    } else if (action === 'speedup') {
      statusText = 'speedup_noted';
      response = 'Speed-up requested from provider (manual follow-up).';
    } else {
      flash(req, 'error', 'Unknown action.'); return res.redirect('/admin/tickets');
    }

    await pool.query(
      'UPDATE tickets SET provider_action_status = ?, provider_action_response = ?, status = ?, assigned_to = ? WHERE id = ?',
      [statusText, response, newStatus, req.user.id, ticket.id]);
    if (ticket.user_id) notifications.notifyUser(ticket.user_id, 'ticket', 'Update on your order concern',
      `Our team is processing your "${ticket.request_type || action}" request${ticket.order_id ? ' for order ' + ticket.order_id : ''}.`).catch(() => {});
    flash(req, 'success', action === 'refund' ? `${response} for ticket #${ticket.id}.` : `Action "${action}" sent for ticket #${ticket.id}.`);
  } catch (err) {
    flash(req, 'error', `Action failed: ${err.message}`);
  }
  res.redirect('/admin/tickets');
});

router.post('/admin/tickets/:id/status', async (req, res, next) => {
  try {
    const status = ['open', 'in_progress', 'resolved', 'closed'].includes(req.body.status) ? req.body.status : 'open';
    const note = String(req.body.internal_notes || '').trim().slice(0, 1000) || null;
    const ticketId = clampInt(req.params.id, 1, 2147483647);
    // Closing a ticket releases its dedupe slot, so the customer can raise the
    // same concern type again later if they need to.
    await pool.query(
      `UPDATE tickets SET status = ?, internal_notes = COALESCE(?, internal_notes), assigned_to = ?,
              dedupe_key = IF(LOWER(?) IN ('open','in_progress'), dedupe_key, NULL)
        WHERE id = ?`,
      [status, note, req.user.id, status, ticketId]);
    if (['resolved', 'closed'].includes(status)) {
      const [[tk]] = await pool.query('SELECT user_id, order_id FROM tickets WHERE id = ?', [ticketId]);
      if (tk && tk.user_id) notifications.notifyUser(tk.user_id, 'ticket', 'Your concern was resolved ✅',
        `Your order concern${tk.order_id ? ' for ' + tk.order_id : ''} has been marked ${status}.`).catch(() => {});
    }
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
    const { deposit, bonus, bonusPct, commission, referrerId } =
      await wallet.approveDeposit(clampInt(req.params.id, 1, 2147483647), req.user.id, String(req.body.note || '').trim());
    const [[user]] = await pool.query('SELECT email FROM users WHERE id = ?', [deposit.user_id]);
    if (user) mailer.sendDepositResult(user.email, deposit, true);
    const bonusLine = bonus > 0 ? ` + ₱${bonus.toFixed(2)} bonus (${bonusPct}%)` : '';
    notifications.notifyUser(deposit.user_id, 'deposit', 'Deposit approved 🎉',
      `Your ${String(deposit.payment_method).toUpperCase()} deposit of ₱${Number(deposit.amount).toFixed(2)} was approved${bonusLine} and added to your wallet.`).catch(() => {});
    if (referrerId && commission > 0) {
      notifications.notifyUser(referrerId, 'commission', 'Referral commission earned 💰',
        `You earned ₱${commission.toFixed(2)} because a member you invited topped up. Keep sharing your link!`).catch(() => {});
    }
    flash(req, 'success', `Deposit #${deposit.id} approved — ₱${Number(deposit.amount).toFixed(2)} credited${bonusLine}.`);
  } catch (err) { flash(req, 'error', err.message); }
  res.redirect('/admin/deposits');
});

router.post('/admin/deposits/:id/reject', async (req, res) => {
  try {
    const note = String(req.body.note || '').trim();
    const deposit = await wallet.rejectDeposit(clampInt(req.params.id, 1, 2147483647), req.user.id, note);
    const [[user]] = await pool.query('SELECT email FROM users WHERE id = ?', [deposit.user_id]);
    if (user) mailer.sendDepositResult(user.email, { ...deposit, admin_note: note }, false);
    notifications.notifyUser(deposit.user_id, 'deposit', 'Deposit rejected',
      `Your ${String(deposit.payment_method).toUpperCase()} deposit of ₱${Number(deposit.amount).toFixed(2)} was rejected.${note ? ' Reason: ' + note : ''}`).catch(() => {});
    flash(req, 'success', `Deposit #${deposit.id} rejected.`);
  } catch (err) { flash(req, 'error', err.message); }
  res.redirect('/admin/deposits');
});

// ── Referral payouts ──────────────────────────────────────
router.get('/admin/payouts', async (req, res, next) => {
  try {
    const [payouts] = await pool.query(
      `SELECT p.*, u.username, u.email FROM payout_requests p LEFT JOIN users u ON u.id = p.user_id
       ORDER BY (p.status = 'Pending') DESC, p.id DESC LIMIT 100`);
    res.render('admin/payouts', { title: 'Admin · Referral Payouts', payouts });
  } catch (err) { next(err); }
});

router.post('/admin/payouts/:id/resolve', async (req, res) => {
  try {
    const approve = req.body.decision === 'paid';
    const note = String(req.body.note || '').trim();
    const p = await wallet.resolvePayout(clampInt(req.params.id, 1, 2147483647), req.user.id, approve, note);
    notifications.notifyUser(p.user_id, 'payout',
      approve ? 'Payout sent 🎉' : 'Payout request rejected',
      approve
        ? `Your ₱${Number(p.amount).toFixed(2)} referral payout was sent to your ${String(p.method).toUpperCase()} (${p.account_number}).`
        : `Your ₱${Number(p.amount).toFixed(2)} payout request was rejected and the amount was returned to your wallet.${note ? ' Reason: ' + note : ''}`).catch(() => {});
    flash(req, 'success', `Payout #${p.id} marked ${approve ? 'Paid' : 'Rejected'}.`);
  } catch (err) { flash(req, 'error', err.message); }
  res.redirect('/admin/payouts');
});

// ── Orders ────────────────────────────────────────────────
router.get('/admin/orders', async (req, res, next) => {
  try {
    const page = clampInt(req.query.page, 1, 100000) || 1;
    const perPage = 30;
    const status = ORDER_STATUSES.includes(req.query.status) ? req.query.status : '';
    // Search by site order code (APX-...), provider order id, or user.
    const q = String(req.query.q || '').trim().slice(0, 100);

    const clauses = [];
    const params = [];
    if (status) { clauses.push('o.status = ?'); params.push(status); }
    if (q) {
      // Same resolver the customer's search uses, so staff can paste whatever
      // the customer quoted — public code, legacy code, bare id, provider id —
      // plus the account fields only staff can search on.
      clauses.push(`(${orderRef.searchClause('o')} OR u.username LIKE ? OR u.email LIKE ?)`);
      const like = `%${q}%`;
      params.push(...orderRef.searchParams(q), like, like);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM orders o JOIN users u ON u.id = o.user_id ${where}`, params);
    const pages = Math.max(1, Math.ceil(total / perPage));
    const current = Math.min(page, pages);
    const [orders] = await pool.query(
      `SELECT o.*, u.email, u.username FROM orders o JOIN users u ON u.id = o.user_id
       ${where} ORDER BY o.id DESC LIMIT ? OFFSET ?`, [...params, perPage, (current - 1) * perPage]);
    res.render('admin/orders', { title: 'Admin · Orders', orders, status, q, pagination: { current, pages, total }, orderStatuses: ORDER_STATUSES });
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

// Un-sync: remove all of a provider's services from the catalog (soft-delete).
// Reversible — syncing that provider again restores them. Order history is kept.
router.post('/admin/services/unsync/:code', async (req, res) => {
  try {
    const result = await catalog.unsyncProvider(String(req.params.code));
    flash(req, 'success', `Un-synced ${result.provider}: ${result.removed} service(s) removed from the catalog. Re-sync anytime to bring them back.`);
  } catch (err) { flash(req, 'error', `Un-sync failed: ${err.message}`); }
  res.redirect('/admin/services');
});

// Remove a single service from the catalog (soft-delete; re-sync restores it).
router.post('/admin/services/:id/remove', async (req, res, next) => {
  try {
    await pool.query('UPDATE services SET deleted = 1 WHERE id = ?', [clampInt(req.params.id, 1, 2147483647)]);
    flash(req, 'success', 'Service removed from the catalog. Re-sync its provider to bring it back.');
    res.redirect(req.get('referer') || '/admin/services');
  } catch (err) { next(err); }
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

// ── Support chat: read a ticket thread + reply to the customer ──
router.get('/admin/tickets/:id/thread', async (req, res, next) => {
  try {
    const id = clampInt(req.params.id, 1, 2147483647);
    const data = await require('../services/tickets').thread(id);
    if (!data) { flash(req, 'error', 'Ticket not found.'); return res.redirect('/admin/tickets'); }
    const [[u]] = await pool.query('SELECT username, email FROM users WHERE id = ?', [data.ticket.user_id]);
    await pool.query('UPDATE tickets SET staff_unread = 0 WHERE id = ?', [id]);
    res.render('admin/ticket-thread', { title: `Ticket #${id}`, ticket: data.ticket, messages: data.messages, customer: u || {} });
  } catch (err) { next(err); }
});

router.post('/admin/tickets/:id/reply', async (req, res) => {
  const id = clampInt(req.params.id, 1, 2147483647);
  try {
    const body = String(req.body.message || '').trim().slice(0, 4000);
    if (body.length < 1) { flash(req, 'error', 'Type a message.'); return res.redirect(`/admin/tickets/${id}/thread`); }
    const posted = await require('../services/tickets').postMessage(id, 'staff', body);
    if (!posted) { flash(req, 'error', 'Ticket not found.'); return res.redirect('/admin/tickets'); }
    const status = ['open', 'in_progress', 'resolved', 'closed'].includes(req.body.status) ? req.body.status : 'in_progress';
    await pool.query(
      `UPDATE tickets SET status = ?, assigned_to = ?,
              dedupe_key = IF(LOWER(?) IN ('open','in_progress'), dedupe_key, NULL)
        WHERE id = ?`,
      [status, req.user.id, status, id]);
    flash(req, 'success', 'Reply sent to the customer.');
  } catch (err) { flash(req, 'error', `Could not send: ${err.message}`); }
  res.redirect(`/admin/tickets/${id}/thread`);
});

// ── Analytics: where the money comes from ───────────────────
// ── Email automation ──────────────────────────────────────
const campaigns = require('../services/campaigns');

router.get('/admin/emails', async (req, res, next) => {
  try {
    const stats = await campaigns.stats();
    const backfill = String(await campaigns.getSetting('email_welcome_backfill', 'off')).toLowerCase() === 'on';
    const lastDigest = await campaigns.getSetting('last_service_digest_at');
    const [recent] = await pool.query(
      `SELECT e.kind, e.ref, e.status, e.error, e.created_at, u.username, u.email
         FROM email_log e LEFT JOIN users u ON u.id = e.user_id
        ORDER BY e.id DESC LIMIT 60`);
    res.render('admin/emails', {
      title: 'Admin · Email automation', crumb: 'Email automation',
      stats, backfill, lastDigest, recent,
    });
  } catch (err) { next(err); }
});

router.post('/admin/emails/toggle', async (req, res, next) => {
  try {
    const on = req.body.campaigns === '1' || req.body.campaigns === 'on';
    await campaigns.setSetting('email_campaigns', on ? 'on' : 'off');
    flash(req, 'success', on
      ? 'Email automation is ON — new customers get the welcome email and subscribers get new-service digests.'
      : 'Email automation is OFF — no marketing email will be sent. Account emails still work.');
    res.redirect('/admin/emails');
  } catch (err) { next(err); }
});

router.post('/admin/emails/backfill', async (req, res, next) => {
  try {
    const on = req.body.backfill === '1' || req.body.backfill === 'on';
    await campaigns.setSetting('email_welcome_backfill', on ? 'on' : 'off');
    flash(req, 'success', on
      ? 'Welcome backfill queued — existing verified customers will get the welcome email once, in batches.'
      : 'Welcome backfill stopped.');
    res.redirect('/admin/emails');
  } catch (err) { next(err); }
});

// Run a pass now instead of waiting for the timer.
router.post('/admin/emails/run', async (req, res) => {
  try {
    const r = await campaigns.runServiceDigest();
    flash(req, r.ran ? 'success' : 'error', r.ran
      ? `Digest pass done — ${r.newServices} new services, sent ${r.sent}, failed ${r.failed}, ${r.remaining} still queued.`
      : `Nothing sent: ${r.reason}.`);
  } catch (err) {
    flash(req, 'error', `Digest failed: ${err.message}`);
  }
  res.redirect('/admin/emails');
});

router.get('/admin/analytics', async (req, res, next) => {
  try {
    // Headline tiles (this month).
    const [[now]] = await pool.query(`SELECT
      (SELECT COALESCE(SUM(charge - COALESCE(refund_amount,0)),0) FROM orders WHERE created_at >= DATE_FORMAT(NOW(),'%Y-%m-01') AND status <> 'Failed') AS revenue,
      (SELECT COALESCE(SUM(net_profit),0) FROM orders WHERE created_at >= DATE_FORMAT(NOW(),'%Y-%m-01') AND status NOT IN ('Failed','Canceled')) AS profit,
      (SELECT COUNT(*) FROM orders WHERE created_at >= DATE_FORMAT(NOW(),'%Y-%m-01')) AS orders,
      (SELECT COUNT(*) FROM users WHERE created_at >= DATE_FORMAT(NOW(),'%Y-%m-01')) AS new_users`);

    // 12-month revenue + profit trend.
    const [monthly] = await pool.query(`
      SELECT DATE_FORMAT(created_at, '%Y-%m') AS ym,
             COALESCE(SUM(CASE WHEN status <> 'Failed' THEN charge - COALESCE(refund_amount,0) ELSE 0 END),0) AS revenue,
             COALESCE(SUM(CASE WHEN status NOT IN ('Failed','Canceled') THEN net_profit ELSE 0 END),0) AS profit
      FROM orders WHERE created_at >= DATE_SUB(DATE_FORMAT(NOW(),'%Y-%m-01'), INTERVAL 11 MONTH)
      GROUP BY ym ORDER BY ym`);

    // Daily revenue, last 30 days.
    const [daily] = await pool.query(`
      SELECT DATE(created_at) AS d,
             COALESCE(SUM(CASE WHEN status <> 'Failed' THEN charge - COALESCE(refund_amount,0) ELSE 0 END),0) AS revenue
      FROM orders WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
      GROUP BY d ORDER BY d`);

    // Top services by profit + top customers by spend (last 30 days).
    const [topServices] = await pool.query(`
      SELECT service_name, COUNT(*) AS orders, COALESCE(SUM(net_profit),0) AS profit
      FROM orders WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) AND status NOT IN ('Failed','Canceled')
      GROUP BY service_name ORDER BY profit DESC LIMIT 10`);
    const [topCustomers] = await pool.query(`
      SELECT u.username, u.email, COUNT(*) AS orders,
             COALESCE(SUM(o.charge - COALESCE(o.refund_amount,0)),0) AS spend,
             COALESCE(SUM(CASE WHEN o.status NOT IN ('Failed','Canceled') THEN o.net_profit ELSE 0 END),0) AS profit
      FROM orders o JOIN users u ON u.id = o.user_id
      WHERE o.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) AND o.status <> 'Failed'
      GROUP BY o.user_id ORDER BY spend DESC LIMIT 10`);

    // Approved deposits by method (last 30 days).
    const [byMethod] = await pool.query(`
      SELECT payment_method, COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS total
      FROM deposits WHERE status = 'Approved' AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY payment_method ORDER BY total DESC`);

    res.render('admin/analytics', {
      title: 'Admin · Analytics', now, monthly, daily, topServices, topCustomers, byMethod,
    });
  } catch (err) { next(err); }
});

module.exports = router;
