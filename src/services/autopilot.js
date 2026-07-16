'use strict';
// ── AI Autopilot ─────────────────────────────────────────────
// First responder for customer reports + stuck-order watchdog.
// Every action is written to autopilot_log and surfaced to the
// admin (in-app notification + /admin/autopilot panel). Anything
// it can't safely resolve is escalated as "needs_admin".
const pool = require('../db/pool');
const env = require('../config/env');
const orderService = require('./orders');
const notifications = require('./notifications');
const mailer = require('./mailer');
const wallet = require('./wallet');
const { getClient, allClients } = require('../providers');
const { getSetting, setSetting } = require('./stats');

const OPEN = ['Pending', 'In progress', 'Processing'];
const STUCK_HOURS = env.AUTOPILOT_STUCK_HOURS;

async function isOn() {
  return ['1', 'true', 'on', 'yes'].includes(String(await getSetting('autopilot', 'on')).toLowerCase());
}

// Write one audit row. Never throws — logging must not break the main flow.
async function log(entry) {
  try {
    const [res] = await pool.query(
      `INSERT INTO autopilot_log (ticket_id, order_ref, user_id, action, detail, outcome)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [entry.ticket_id || null, entry.order_ref || null, entry.user_id || null,
        String(entry.action).slice(0, 60), entry.detail ? String(entry.detail).slice(0, 2000) : null,
        entry.outcome || 'done']);
    return res.insertId;
  } catch (err) {
    console.warn('[autopilot] log failed:', err.message);
    return null;
  }
}

// In-app note to every admin account (+ optional email for escalations).
async function notifyAdmins(title, message, email = false) {
  try {
    const [admins] = await pool.query("SELECT id FROM users WHERE role IN ('admin', 'super_admin')");
    await Promise.all(admins.map((a) => notifications.notifyUser(a.id, 'autopilot', title, message)));
  } catch (err) {
    console.warn('[autopilot] notifyAdmins failed:', err.message);
  }
  if (email && env.SUPPORT_EMAIL) {
    mailer.send(env.SUPPORT_EMAIL, `[Autopilot] ${title}`, title,
      `<p>${String(message)}</p><p><a href="${env.BASE_URL}/admin/autopilot">Open the Autopilot panel</a></p>`)
      .catch(() => {});
  }
}

async function findOrderForTicket(ticket) {
  if (!ticket.order_id) return null;
  const [[order]] = await pool.query(
    'SELECT * FROM orders WHERE order_id = ? OR id = ? LIMIT 1',
    [ticket.order_id, /^\d+$/.test(String(ticket.order_id)) ? ticket.order_id : 0]);
  return order || null;
}

// Triage one ticket. Safe to call repeatedly — a ticket is only handled once.
async function handleTicket(ticketId) {
  if (!(await isOn())) return { skipped: 'autopilot off' };
  const [[ticket]] = await pool.query('SELECT * FROM tickets WHERE id = ?', [ticketId]);
  if (!ticket || ticket.ai_handled_at) return { skipped: 'missing or already handled' };
  if (['resolved', 'closed'].includes(String(ticket.status || '').toLowerCase())) return { skipped: 'closed' };

  const requestType = String(ticket.request_type || 'Other');
  const order = await findOrderForTicket(ticket);

  // Always pull a fresh provider status first so decisions use live data
  // (this alone resolves many "not completed" reports).
  let status = order ? order.status : null;
  if (order && OPEN.includes(order.status) && order.provider_order_id) {
    try { status = (await orderService.syncOrderById(order.id)) || order.status; } catch (_) { /* keep stale */ }
  }

  const client = order && order.provider_order_id
    ? getClient(order.api_provider === 'SMMWorld' ? 'smmworld' : 'rkd') : null;

  let action = 'escalated';
  let outcome = 'needs_admin';
  let ticketStatus = 'open'; // escalations stay in the open queue
  let detail = '';
  let userMsg = null;
  let providerAction = null;

  if (requestType === 'Refill' && client) {
    try {
      const resp = await client.refill(order.provider_order_id);
      action = 'refill_sent'; outcome = 'done'; ticketStatus = 'in_progress';
      providerAction = { status: 'refill_sent', response: JSON.stringify(resp).slice(0, 1000) };
      detail = `Refill sent to the provider for order ${order.order_id}.`;
      userMsg = `Good news! 🤖 A refill was requested for your order ${order.order_id}. Please allow some time for it to process — we'll keep an eye on it.`;
    } catch (err) {
      action = 'refill_failed'; detail = `Refill attempt failed for ${order.order_id}: ${err.message}`;
    }
  } else if (requestType === 'Cancel' && client) {
    try {
      const resp = await client.cancel(order.provider_order_id);
      action = 'cancel_sent'; outcome = 'done'; ticketStatus = 'in_progress';
      providerAction = { status: 'cancel_sent', response: JSON.stringify(resp).slice(0, 1000) };
      detail = `Cancel sent to the provider for order ${order.order_id}.`;
      userMsg = `Your cancel request for order ${order.order_id} was sent. 🤖 Once confirmed, the undelivered portion is refunded to your wallet automatically.`;
    } catch (err) {
      action = 'cancel_failed'; detail = `Cancel attempt failed for ${order.order_id}: ${err.message}`;
    }
  } else if (order && status === 'Completed') {
    action = 'auto_resolved'; outcome = 'done'; ticketStatus = 'resolved';
    detail = `Order ${order.order_id} now shows Completed at the provider — ticket auto-resolved.`;
    userMsg = `We checked order ${order.order_id} and it now shows ✅ Completed. If you still don't see the results after a few hours, just send another report and our team will review it personally.`;
  } else if (order && ['Partial', 'Canceled', 'Failed'].includes(status)) {
    action = 'auto_resolved'; outcome = 'done'; ticketStatus = 'resolved';
    detail = `Order ${order.order_id} ended as ${status}; the refundable portion was auto-refunded.`;
    userMsg = `Order ${order.order_id} ended as ${status}, and the undelivered portion was refunded to your wallet automatically. 💸 Thanks for your patience!`;
  } else {
    detail = order
      ? `Order ${order.order_id} is still "${status}" — "${requestType}" needs a human look.`
      : `No linked order — "${requestType}" needs a human look.`;
    userMsg = `Thanks for your report! 🤖 Our AI reviewed it and passed it to our team for personal attention. We'll update you here and by email.`;
  }

  const note = `[AI autopilot] ${detail}`;
  await pool.query(
    `UPDATE tickets SET ai_handled_at = NOW(), status = ?,
        internal_notes = CONCAT(COALESCE(internal_notes, ''), ?, '\n'),
        provider_action_status = COALESCE(?, provider_action_status),
        provider_action_response = COALESCE(?, provider_action_response)
      WHERE id = ?`,
    [ticketStatus, note, providerAction ? providerAction.status : null,
      providerAction ? providerAction.response : null, ticket.id]);

  await log({ ticket_id: ticket.id, order_ref: order ? order.order_id : ticket.order_id,
    user_id: ticket.user_id, action, detail, outcome });

  if (userMsg && ticket.user_id) {
    notifications.notifyUser(ticket.user_id, 'ticket', 'Update on your report 🤖', userMsg).catch(() => {});
  }
  if (outcome === 'needs_admin') {
    await notifyAdmins('Autopilot escalated a ticket',
      `Ticket #${ticket.id} (${requestType}): ${detail}`, true);
  } else {
    await notifyAdmins(`Autopilot: ${action.replace(/_/g, ' ')}`,
      `Ticket #${ticket.id} (${requestType}): ${detail}`);
  }
  return { action, outcome };
}

// Triage any tickets that arrived while the app was asleep/off.
// Only recent tickets — old/stale ones stay untouched for manual handling
// (never auto-fire provider actions for months-old reports).
async function processPendingTickets(limit = 10) {
  const [rows] = await pool.query(
    `SELECT id FROM tickets WHERE ai_handled_at IS NULL
       AND LOWER(COALESCE(status, 'open')) IN ('open', 'pending')
       AND created_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)
     ORDER BY id ASC LIMIT ?`, [limit]);
  let handled = 0;
  for (const row of rows) {
    try { await handleTicket(row.id); handled += 1; }
    catch (err) { console.warn(`[autopilot] ticket ${row.id} triage failed:`, err.message); }
  }
  return handled;
}

// Flag open orders that have gone quiet for too long (once per order).
async function flagStuckOrders() {
  const [stuck] = await pool.query(
    `SELECT o.* FROM orders o
      WHERE o.status IN ('Pending', 'In progress', 'Processing')
        AND o.created_at < DATE_SUB(NOW(), INTERVAL ? HOUR)
        AND NOT EXISTS (SELECT 1 FROM autopilot_log l
                        WHERE l.order_ref = o.order_id AND l.action = 'stuck_flagged')
      ORDER BY o.id ASC LIMIT 20`, [STUCK_HOURS]);

  for (const o of stuck) {
    await log({ order_ref: o.order_id, user_id: o.user_id, action: 'stuck_flagged', outcome: 'needs_admin',
      detail: `Order ${o.order_id} (${String(o.service_name).slice(0, 80)}) still "${o.status}" after ${STUCK_HOURS}h.` });
    notifications.notifyUser(o.user_id, 'order', "We're watching your order 👀",
      `Your order ${o.order_id} is taking longer than usual, so our AI flagged it to the team. Some services take 5 days up to 1 month — but we're on it.`).catch(() => {});
  }
  if (stuck.length) {
    await notifyAdmins('⚠️ Stuck orders flagged',
      `${stuck.length} order(s) have been open for more than ${STUCK_HOURS}h. Check the Autopilot panel.`, true);
  }
  return stuck.length;
}

// ── Deposit auto-approval (small amounts with a receipt) ────
// Safety gates: amount ≤ threshold, has an uploaded receipt, reference not
// used by any OTHER user, account active. Anything suspicious escalates.
async function processPendingDeposits(limit = 10) {
  const maxPhp = Number(env.AUTO_APPROVE_DEPOSITS_MAX_PHP) || 0;
  if (maxPhp <= 0) return 0;
  const [rows] = await pool.query(
    `SELECT d.*, u.email, u.status AS user_status FROM deposits d
       JOIN users u ON u.id = d.user_id
      WHERE LOWER(d.status) = 'pending' AND d.amount <= ?
        AND d.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      ORDER BY d.id ASC LIMIT ?`, [maxPhp, limit]);

  let approved = 0;
  for (const dep of rows) {
    try {
      if (String(dep.user_status || 'Active').toLowerCase() !== 'active') continue;
      if (!dep.receipt_path) {
        await log({ order_ref: `deposit #${dep.id}`, user_id: dep.user_id, action: 'deposit_escalated', outcome: 'needs_admin',
          detail: `Deposit #${dep.id} (₱${Number(dep.amount).toFixed(2)}) has no receipt — left for manual review.` });
        continue;
      }
      // Same reference used by a different account? Escalate, never auto-credit.
      const [[dupe]] = await pool.query(
        "SELECT id FROM deposits WHERE reference_id = ? AND user_id <> ? AND status <> 'Rejected' LIMIT 1",
        [dep.reference_id, dep.user_id]);
      if (dupe) {
        await log({ order_ref: `deposit #${dep.id}`, user_id: dep.user_id, action: 'deposit_escalated', outcome: 'needs_admin',
          detail: `Deposit #${dep.id}: reference "${dep.reference_id}" was already used by another account — possible reuse, needs manual review.` });
        continue;
      }

      const { deposit, bonus, bonusPct, commission, referrerId } =
        await wallet.approveDeposit(dep.id, null, 'Auto-approved by AI (small deposit with receipt)', { auto: true });
      approved += 1;

      const bonusLine = bonus > 0 ? ` + ₱${bonus.toFixed(2)} bonus (${bonusPct}%)` : '';
      mailer.sendDepositResult(dep.email, deposit, true).catch(() => {});
      notifications.notifyUser(dep.user_id, 'deposit', 'Deposit approved 🎉',
        `Your ${String(dep.payment_method).toUpperCase()} deposit of ₱${Number(dep.amount).toFixed(2)} was approved${bonusLine} and added to your wallet.`).catch(() => {});
      if (referrerId && commission > 0) {
        notifications.notifyUser(referrerId, 'commission', 'Referral commission earned 💰',
          `You earned ₱${commission.toFixed(2)} because a member you invited topped up. Keep sharing your link!`).catch(() => {});
      }
      await log({ order_ref: `deposit #${dep.id}`, user_id: dep.user_id, action: 'deposit_auto_approved', outcome: 'done',
        detail: `Auto-approved deposit #${dep.id}: ₱${Number(dep.amount).toFixed(2)} via ${dep.payment_method} (ref ${dep.reference_id})${bonusLine}.` });
      await notifyAdmins('Autopilot: deposit auto approved',
        `Deposit #${dep.id} — ₱${Number(dep.amount).toFixed(2)} via ${String(dep.payment_method).toUpperCase()}${bonusLine} credited automatically.`);
    } catch (err) {
      console.warn(`[autopilot] deposit ${dep.id} auto-approve failed:`, err.message);
    }
  }
  return approved;
}

// ── Provider balance guard ──────────────────────────────────
// Refreshes upstream balances, alerts once per 24h per provider when low.
async function checkProviderBalances() {
  const threshold = Number(env.PROVIDER_LOW_BALANCE_THRESHOLD_PHP) || 0;
  if (threshold <= 0) return 0;
  let alerts = 0;
  for (const client of allClients()) {
    try {
      const bal = await client.balance();
      if (!bal || bal.balance === undefined) continue;
      await pool.query('UPDATE providers SET balance_usd = ?, currency = ?, synced_at = NOW() WHERE code = ?',
        [Number(bal.balance).toFixed(4), String(bal.currency || 'USD').slice(0, 8), client.code]);
      const php = Number(bal.balance) * env.USD_TO_PHP_RATE;
      if (php < threshold) {
        const [[already]] = await pool.query(
          `SELECT id FROM autopilot_log WHERE action = 'provider_low_balance' AND order_ref = ?
             AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) LIMIT 1`, [client.code]);
        if (!already) {
          alerts += 1;
          await log({ order_ref: client.code, action: 'provider_low_balance', outcome: 'needs_admin',
            detail: `Upstream funding is low: ≈₱${php.toFixed(2)} left (threshold ₱${threshold}). Top up soon or orders may start failing.` });
          await notifyAdmins('⚠️ Upstream funds running low',
            `One of our fulfillment networks is down to ≈₱${php.toFixed(2)}. Top it up soon${env.PROVIDER_BLOCK_ORDERS_BELOW_THRESHOLD ? ' — new orders on it are PAUSED' : ' or orders may start failing'}.`, true);
        }
      }
    } catch (err) {
      console.warn(`[autopilot] balance check ${client.code} failed:`, err.message);
    }
  }
  return alerts;
}

// ── Daily digest email to the admin ─────────────────────────
async function sendDailyDigest() {
  if (!env.SUPPORT_EMAIL) return false;
  const today = new Date().toISOString().slice(0, 10);
  if ((await getSetting('digest_last_date', '')) === today) return false;
  if (new Date().getHours() < Number(env.DAILY_DIGEST_HOUR)) return false;

  const [[o]] = await pool.query(`
    SELECT COUNT(*) AS orders,
           COALESCE(SUM(charge - COALESCE(refund_amount, 0)), 0) AS revenue,
           COALESCE(SUM(net_profit), 0) AS profit
    FROM orders WHERE created_at >= CURDATE() - INTERVAL 1 DAY AND created_at < CURDATE()
      AND status NOT IN ('Failed')`);
  const [[u]] = await pool.query(
    'SELECT COUNT(*) AS c FROM users WHERE created_at >= CURDATE() - INTERVAL 1 DAY AND created_at < CURDATE()');
  const [[d]] = await pool.query(`
    SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS total, SUM(auto_approved = 1) AS auto
    FROM deposits WHERE reviewed_at >= CURDATE() - INTERVAL 1 DAY AND reviewed_at < CURDATE() AND status = 'Approved'`);
  const [[a]] = await pool.query(`
    SELECT COUNT(*) AS total, SUM(outcome = 'needs_admin' AND acknowledged = 0) AS waiting
    FROM autopilot_log WHERE created_at >= CURDATE() - INTERVAL 1 DAY AND created_at < CURDATE()`);
  const [[pendingNow]] = await pool.query(
    "SELECT (SELECT COUNT(*) FROM deposits WHERE status = 'Pending') AS deposits, (SELECT COUNT(*) FROM tickets WHERE LOWER(status) IN ('open','in_progress')) AS tickets");

  const row = (label, value) => `<tr><td style="padding:6px 12px;color:#64748b">${label}</td><td style="padding:6px 12px;font-weight:700">${value}</td></tr>`;
  const html = `
    <p>Good morning! Here's yesterday's summary for ${env.SITE_NAME}:</p>
    <table style="border-collapse:collapse">
      ${row('Revenue', '₱' + Number(o.revenue).toFixed(2))}
      ${row('Profit', '₱' + Number(o.profit).toFixed(2))}
      ${row('Orders', o.orders)}
      ${row('New members', u.c)}
      ${row('Deposits approved', `${d.c} (₱${Number(d.total).toFixed(2)}, ${d.auto || 0} auto)`)}
      ${row('AI autopilot actions', `${a.total} (${a.waiting || 0} still need you)`)}
      ${row('Waiting right now', `${pendingNow.deposits} deposit(s), ${pendingNow.tickets} ticket(s)`)}
    </table>
    <p><a href="${env.BASE_URL}/admin">Open the admin panel</a> · <a href="${env.BASE_URL}/admin/autopilot">Autopilot log</a></p>`;
  await mailer.send(env.SUPPORT_EMAIL, `[${env.SITE_NAME}] Daily digest — ${today}`, 'Daily digest 📊', html);
  await setSetting('digest_last_date', today);
  return true;
}

// ── In-process scheduler (no cPanel cron needed) ────────────
let running = false;
let lastWatchdogAt = 0;

async function tick() {
  if (running) return null;
  running = true;
  const result = { synced: null, tickets: 0, flagged: 0, deposits: 0, balanceAlerts: 0, digest: false };
  try {
    if (!(await isOn())) return result;
    try { result.synced = await orderService.syncOpenOrders(150); }
    catch (err) { console.warn('[autopilot] order sync failed:', err.message); }
    result.tickets = await processPendingTickets();
    try { result.deposits = await processPendingDeposits(); }
    catch (err) { console.warn('[autopilot] deposit pass failed:', err.message); }
    if (Date.now() - lastWatchdogAt > 60 * 60 * 1000) {
      lastWatchdogAt = Date.now();
      result.flagged = await flagStuckOrders();
      try { result.balanceAlerts = await checkProviderBalances(); }
      catch (err) { console.warn('[autopilot] balance pass failed:', err.message); }
    }
    try { result.digest = await sendDailyDigest(); }
    catch (err) { console.warn('[autopilot] digest failed:', err.message); }
  } catch (err) {
    console.warn('[autopilot] tick failed:', err.message);
  } finally {
    running = false;
  }
  return result;
}

function startScheduler() {
  if (!env.AUTOPILOT_ENABLED) { console.log('[autopilot] disabled via AUTOPILOT_ENABLED'); return; }
  const everyMs = Math.max(2, env.AUTOPILOT_INTERVAL_MINUTES) * 60 * 1000;
  setInterval(tick, everyMs).unref();
  setTimeout(tick, 20 * 1000).unref(); // first pass shortly after boot
  console.log(`[autopilot] scheduler on — every ${Math.max(2, env.AUTOPILOT_INTERVAL_MINUTES)} min (stuck threshold ${STUCK_HOURS}h)`);
}

module.exports = {
  isOn, handleTicket, processPendingTickets, flagStuckOrders,
  processPendingDeposits, checkProviderBalances, sendDailyDigest,
  tick, startScheduler,
};
