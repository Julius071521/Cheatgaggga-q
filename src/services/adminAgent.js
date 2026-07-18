'use strict';
// AI Admin Agent — a tool-using worker the owner commands over Telegram in plain
// language ("orders today?", "reply to ticket 12 processing na", "refund APX-123",
// "add ₱500 to juan", "block 1.2.3.4"). It runs a real function-calling loop
// against the configured AI (DeepSeek) with read + action tools over the site's
// own data. Admin-only (the Telegram webhook gates it to TELEGRAM_ADMIN_CHAT_ID).
//
// Safety: money-moving / risky actions (approve/reject deposit, refund/refill,
// add/deduct funds, ban, broadcast, create promo, pay out) are NOT executed
// inline. The agent stores them as a pending action and asks the owner to tap a
// Confirm/Cancel button first — so a mistaken or spoofed command can't move money.
const crypto = require('crypto');
const env = require('../config/env');
const pool = require('../db/pool');
const security = require('./security');

const enabled = Boolean(env.AI_API_KEY && env.AI_BASE_URL);

const SITE = env.SITE_NAME || 'ApexBoost';
const SYSTEM = `You are the admin worker for ${SITE}, an SMM (social media marketing) panel.
You help the OWNER run the business over Telegram — you can both answer questions AND do the work.
Always use the tools to fetch real data before answering — never invent numbers.
When the owner tells you to do something (reply to a ticket, refund an order, add funds, block an IP, make a promo, ban a user, broadcast a message), use the matching tool.
Money-moving or risky actions will be shown to the owner for a one-tap confirmation — that is expected; just call the tool and briefly say you've queued it for confirmation.
When drafting a reply to a customer's ticket, write it warmly and professionally in the SAME language the customer used (Filipino/Taglish is fine), keep it short, and never reveal supplier/provider names.
All money is in Philippine pesos (₱). Be concise and use short Telegram-friendly plain text with a few emojis — no markdown tables.`;

// Actions that must be confirmed by the owner before they run.
const CONFIRM = new Set([
  'approve_deposit', 'reject_deposit', 'refund_order', 'refill_order',
  'adjust_balance', 'ban_user', 'create_promo', 'broadcast', 'resolve_payout',
  'unsync_services',
]);

const PROVIDER_CODE = (p) => (/smmw|world/i.test(String(p)) ? 'smmworld' : 'rkd');

// ── Tool schemas (OpenAI/DeepSeek function-calling format) ──
const TOOLS = [
  // reads
  { type: 'function', function: { name: 'site_stats', description: 'Overall business stats: users, orders today/total, revenue today/this month, profit today, pending deposits, open tickets, total customer wallet balance.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'find_user', description: 'Look up customers by username or email (partial match). Returns their id, balance, orders count.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'recent_orders', description: 'Most recent orders, optionally filtered by status.', parameters: { type: 'object', properties: { limit: { type: 'integer' }, status: { type: 'string', description: 'Pending|In progress|Processing|Completed|Partial|Canceled|Failed' } } } } },
  { type: 'function', function: { name: 'order_lookup', description: 'Find an order by its site code (APX-...) or the provider order number. Returns the order id needed for refund/refill.', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] } } },
  { type: 'function', function: { name: 'pending_deposits', description: 'Deposits awaiting review (add-funds requests), with id needed to approve/reject.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'list_tickets', description: 'Support tickets/concerns, newest first. Filter by status (open|in_progress|resolved|closed).', parameters: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'integer' } } } } },
  { type: 'function', function: { name: 'ticket_detail', description: 'Full detail of one support ticket by its id (customer, subject, message, linked order, status).', parameters: { type: 'object', properties: { ticket_id: { type: 'integer' } }, required: ['ticket_id'] } } },
  { type: 'function', function: { name: 'pending_payouts', description: 'Referral payout (withdrawal) requests awaiting review.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'security_summary', description: 'Security status: flagged IPs, blocked count, whether the site is under attack.', parameters: { type: 'object', properties: {} } } },
  // immediate actions (not money)
  { type: 'function', function: { name: 'reply_ticket', description: 'Send a reply/update to the customer on a support ticket and optionally set its status. Use to answer a concern.', parameters: { type: 'object', properties: { ticket_id: { type: 'integer' }, message: { type: 'string', description: 'the reply to the customer' }, status: { type: 'string', description: 'open|in_progress|resolved|closed (optional)' } }, required: ['ticket_id', 'message'] } } },
  { type: 'function', function: { name: 'set_ticket_status', description: 'Change a ticket status without messaging (open|in_progress|resolved|closed).', parameters: { type: 'object', properties: { ticket_id: { type: 'integer' }, status: { type: 'string' } }, required: ['ticket_id', 'status'] } } },
  { type: 'function', function: { name: 'resync_orders', description: 'Refresh order statuses from the provider (all open orders, or one order id).', parameters: { type: 'object', properties: { order_id: { type: 'integer' } } } } },
  { type: 'function', function: { name: 'set_announcement', description: 'Set the small site-wide announcement banner text (empty to clear).', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'block_ip', description: 'Block an IP address (app + Cloudflare edge).', parameters: { type: 'object', properties: { ip: { type: 'string' } }, required: ['ip'] } } },
  { type: 'function', function: { name: 'unblock_ip', description: 'Unblock/allow an IP address.', parameters: { type: 'object', properties: { ip: { type: 'string' } }, required: ['ip'] } } },
  { type: 'function', function: { name: 'unban_user', description: 'Un-ban a customer (set their account back to Active).', parameters: { type: 'object', properties: { user_id: { type: 'integer' } }, required: ['user_id'] } } },
  { type: 'function', function: { name: 'sync_services', description: 'Import/refresh services from a provider (fixes stale/"incorrect service ID" services and re-enables valid ones). provider is smmworld or rkd.', parameters: { type: 'object', properties: { provider: { type: 'string' } }, required: ['provider'] } } },
  // confirm-first actions (money / risky)
  { type: 'function', function: { name: 'approve_deposit', description: 'Approve a pending deposit by id (credits the customer + bonus + referral commission). Needs owner confirmation.', parameters: { type: 'object', properties: { deposit_id: { type: 'integer' } }, required: ['deposit_id'] } } },
  { type: 'function', function: { name: 'reject_deposit', description: 'Reject a pending deposit by id (e.g. fake/duplicate receipt). Needs owner confirmation.', parameters: { type: 'object', properties: { deposit_id: { type: 'integer' }, reason: { type: 'string' } }, required: ['deposit_id'] } } },
  { type: 'function', function: { name: 'refund_order', description: 'Refund an order back to the customer wallet by order id (get id via order_lookup). Needs owner confirmation.', parameters: { type: 'object', properties: { order_id: { type: 'integer' }, reason: { type: 'string' } }, required: ['order_id'] } } },
  { type: 'function', function: { name: 'refill_order', description: 'Ask the provider to refill an order (restore dropped followers/likes) by order id. Needs owner confirmation.', parameters: { type: 'object', properties: { order_id: { type: 'integer' } }, required: ['order_id'] } } },
  { type: 'function', function: { name: 'adjust_balance', description: 'Add (positive) or deduct (negative) wallet funds for a customer. Needs owner confirmation.', parameters: { type: 'object', properties: { user_id: { type: 'integer' }, amount: { type: 'number', description: 'PHP, positive to add, negative to deduct' }, reason: { type: 'string' } }, required: ['user_id', 'amount'] } } },
  { type: 'function', function: { name: 'ban_user', description: 'Ban a customer account by id. Needs owner confirmation.', parameters: { type: 'object', properties: { user_id: { type: 'integer' }, reason: { type: 'string' } }, required: ['user_id'] } } },
  { type: 'function', function: { name: 'create_promo', description: 'Create a discount/promo code. Needs owner confirmation.', parameters: { type: 'object', properties: { code: { type: 'string' }, type: { type: 'string', description: 'percentage|fixed' }, value: { type: 'number' }, max_uses: { type: 'integer' } }, required: ['code', 'type', 'value'] } } },
  { type: 'function', function: { name: 'broadcast', description: 'Post a site-wide update/announcement visible to all customers. Needs owner confirmation.', parameters: { type: 'object', properties: { title: { type: 'string' }, message: { type: 'string' } }, required: ['title', 'message'] } } },
  { type: 'function', function: { name: 'resolve_payout', description: 'Approve (mark paid) or reject a referral payout request by id. Needs owner confirmation.', parameters: { type: 'object', properties: { payout_id: { type: 'integer' }, approve: { type: 'boolean' }, note: { type: 'string' } }, required: ['payout_id', 'approve'] } } },
  { type: 'function', function: { name: 'unsync_services', description: 'Remove ALL of a provider\'s services from the catalog (soft-delete; re-sync restores them). provider is smmworld or rkd. Needs owner confirmation.', parameters: { type: 'object', properties: { provider: { type: 'string' } }, required: ['provider'] } } },
];

const peso = (n) => '₱' + Number(n || 0).toFixed(2);

// ── Read-tool implementations ──
const READS = {
  async site_stats() {
    const [[s]] = await pool.query(`SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM users WHERE created_at >= CURDATE()) AS new_users_today,
      (SELECT COUNT(*) FROM orders) AS orders_total,
      (SELECT COUNT(*) FROM orders WHERE created_at >= CURDATE()) AS orders_today,
      (SELECT COALESCE(SUM(charge - COALESCE(refund_amount,0)),0) FROM orders WHERE created_at >= CURDATE() AND status <> 'Failed') AS revenue_today,
      (SELECT COALESCE(SUM(net_profit),0) FROM orders WHERE created_at >= CURDATE() AND status NOT IN ('Failed','Canceled')) AS profit_today,
      (SELECT COALESCE(SUM(charge - COALESCE(refund_amount,0)),0) FROM orders WHERE created_at >= DATE_FORMAT(NOW(),'%Y-%m-01') AND status <> 'Failed') AS revenue_month,
      (SELECT COUNT(*) FROM deposits WHERE status = 'Pending') AS pending_deposits,
      (SELECT COALESCE(SUM(balance),0) FROM users) AS total_customer_balance,
      (SELECT COUNT(*) FROM tickets WHERE LOWER(status) IN ('open','in_progress')) AS open_tickets`);
    return s;
  },
  async find_user({ query }) {
    const like = `%${String(query || '').slice(0, 60)}%`;
    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.email, u.balance, u.status, u.created_at,
              (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS orders,
              (SELECT COALESCE(SUM(amount),0) FROM deposits d WHERE d.user_id = u.id AND d.status='Approved') AS total_deposited
       FROM users u WHERE u.username LIKE ? OR u.email LIKE ? LIMIT 5`, [like, like]);
    return rows.length ? rows : { note: 'no matching user' };
  },
  async recent_orders({ limit, status }) {
    const n = Math.min(20, Math.max(1, parseInt(limit, 10) || 8));
    const args = [];
    let where = '';
    if (status) { where = 'WHERE status = ?'; args.push(String(status)); }
    args.push(n);
    const [rows] = await pool.query(
      `SELECT order_id, service_name, quantity, charge, status, created_at FROM orders ${where} ORDER BY id DESC LIMIT ?`, args);
    return rows;
  },
  async order_lookup({ ref }) {
    const r = String(ref || '').slice(0, 60);
    const [rows] = await pool.query(
      `SELECT id, order_id, provider_order_id, service_name, quantity, charge, refund_amount, status, remains, user_id, created_at
       FROM orders WHERE order_id LIKE ? OR provider_order_id = ? ORDER BY id DESC LIMIT 3`, [`%${r}%`, r]);
    return rows.length ? rows : { note: 'no matching order' };
  },
  async pending_deposits() {
    const [rows] = await pool.query(
      `SELECT d.id, u.username, d.payment_method, d.amount, d.reference_id, d.created_at
       FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.status = 'Pending' ORDER BY d.id DESC LIMIT 20`);
    return rows.length ? rows : { note: 'no pending deposits' };
  },
  async list_tickets({ status, limit }) {
    const n = Math.min(20, Math.max(1, parseInt(limit, 10) || 10));
    const args = [];
    let where = '';
    if (status) { where = 'WHERE LOWER(t.status) = ?'; args.push(String(status).toLowerCase()); }
    args.push(n);
    const [rows] = await pool.query(
      `SELECT t.id, u.username, t.subject, t.request_type, t.order_id, t.status, t.priority, t.created_at
       FROM tickets t LEFT JOIN users u ON u.id = t.user_id ${where} ORDER BY t.id DESC LIMIT ?`, args);
    return rows.length ? rows : { note: 'no tickets' };
  },
  async ticket_detail({ ticket_id }) {
    const [[t]] = await pool.query(
      `SELECT t.id, u.username, u.id AS user_id, t.subject, t.request_type, t.message, t.order_id,
              t.status, t.priority, t.internal_notes, t.provider_action_status, t.created_at
       FROM tickets t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ?`, [parseInt(ticket_id, 10)]);
    return t || { note: 'ticket not found' };
  },
  async pending_payouts() {
    const [rows] = await pool.query(
      `SELECT p.id, u.username, p.amount, p.method, p.account_number, p.account_name, p.created_at
       FROM payout_requests p JOIN users u ON u.id = p.user_id WHERE p.status = 'Pending' ORDER BY p.id DESC LIMIT 20`);
    return rows.length ? rows : { note: 'no pending payouts' };
  },
  async security_summary() {
    const [[c]] = await pool.query('SELECT COUNT(*) AS blocked FROM blocked_ips');
    const [[f]] = await pool.query("SELECT COUNT(*) AS flagged FROM ip_reputation WHERE status IS NULL OR status='watch'");
    const [top] = await pool.query("SELECT ip, score, last_kind, country FROM ip_reputation WHERE status IS NULL OR status='watch' ORDER BY score DESC LIMIT 5");
    return { blocked: c.blocked, flagged: f.flagged, under_attack: await security.underAttack(), top_threats: top };
  },
};

// ── Immediate (non-money) action implementations ──
const ACTIONS = {
  async reply_ticket({ ticket_id, message, status }) {
    const id = parseInt(ticket_id, 10);
    const [[t]] = await pool.query('SELECT id, user_id, order_id FROM tickets WHERE id = ?', [id]);
    if (!t) return { ok: false, error: 'ticket not found' };
    const msg = String(message || '').slice(0, 900);
    const allowed = ['open', 'in_progress', 'resolved', 'closed'];
    const newStatus = allowed.includes(String(status || '').toLowerCase()) ? String(status).toLowerCase() : 'in_progress';
    await pool.query(
      "UPDATE tickets SET status = ?, internal_notes = CONCAT(COALESCE(internal_notes,''), ?, ?) WHERE id = ?",
      [newStatus, `\n[agent reply ${new Date().toISOString().slice(0, 16)}] `, msg, id]);
    if (t.user_id) {
      require('./notifications').notifyUser(t.user_id, 'ticket', 'Reply from support 💬', msg).catch(() => {});
    }
    return { ok: true, ticket: id, status: newStatus, sent: true };
  },
  async set_ticket_status({ ticket_id, status }) {
    const allowed = ['open', 'in_progress', 'resolved', 'closed'];
    const st = allowed.includes(String(status || '').toLowerCase()) ? String(status).toLowerCase() : null;
    if (!st) return { ok: false, error: 'bad status' };
    const id = parseInt(ticket_id, 10);
    const [r] = await pool.query('UPDATE tickets SET status = ? WHERE id = ?', [st, id]);
    if (['resolved', 'closed'].includes(st)) {
      const [[tk]] = await pool.query('SELECT user_id, order_id FROM tickets WHERE id = ?', [id]);
      if (tk && tk.user_id) require('./notifications').notifyUser(tk.user_id, 'ticket', 'Your concern was resolved ✅',
        `Your order concern${tk.order_id ? ' for ' + tk.order_id : ''} has been marked ${st}.`).catch(() => {});
    }
    return r.affectedRows ? { ok: true, ticket: id, status: st } : { ok: false, error: 'ticket not found' };
  },
  async resync_orders({ order_id }) {
    const orders = require('./orders');
    if (order_id) { const r = await orders.syncOrderById(parseInt(order_id, 10)); return { ok: true, synced: 1, order: r || null }; }
    const n = await orders.syncOpenOrders();
    return { ok: true, synced: n };
  },
  async set_announcement({ text }) {
    const { setSetting } = require('./stats');
    await setSetting('announcement', String(text || '').trim().slice(0, 300));
    return { ok: true, announcement: String(text || '').trim().slice(0, 300) || '(cleared)' };
  },
  async block_ip({ ip }) {
    const r = await security.blockIp(String(ip).trim(), 'Blocked via Telegram admin agent', null);
    return r && r.skipped ? { ok: false, reason: r.skipped } : { ok: true, blocked: ip };
  },
  async unblock_ip({ ip }) { await security.allowIp(String(ip).trim()); return { ok: true, allowed: ip }; },
  async unban_user({ user_id }) {
    const [r] = await pool.query("UPDATE users SET status = 'Active' WHERE id = ? AND role NOT IN ('admin','super_admin')", [parseInt(user_id, 10)]);
    return r.affectedRows ? { ok: true, unbanned: user_id } : { ok: false, error: 'user not found or is staff' };
  },
  async sync_services({ provider }) {
    const code = PROVIDER_CODE(provider);
    try {
      const r = await require('./catalog').syncProvider(code);
      return { ok: true, provider: r.provider, imported: r.imported, provider_lists: r.totalFromProvider };
    } catch (e) { return { ok: false, error: e.message }; }
  },
};

// ── Confirmed (money / risky) action implementations. Run only after the owner taps ✅. ──
const PERFORM = {
  async approve_deposit({ deposit_id }) {
    const wallet = require('./wallet');
    const r = await wallet.approveDeposit(parseInt(deposit_id, 10), null, 'Approved via Telegram agent');
    require('./notifications').notifyUser(r.deposit.user_id, 'deposit', 'Deposit approved 🎉',
      `Your ${String(r.deposit.payment_method).toUpperCase()} deposit of ${peso(r.deposit.amount)} was approved.`).catch(() => {});
    return `Approved deposit #${deposit_id} — credited ${peso(r.deposit.amount)}${r.bonus ? ` (+${peso(r.bonus)} bonus)` : ''}.`;
  },
  async reject_deposit({ deposit_id, reason }) {
    const wallet = require('./wallet');
    await wallet.rejectDeposit(parseInt(deposit_id, 10), null, reason ? String(reason).slice(0, 200) : 'Rejected via Telegram agent');
    return `Rejected deposit #${deposit_id}.`;
  },
  async refund_order({ order_id, reason }) {
    const orders = require('./orders');
    const r = await orders.adminRefund(parseInt(order_id, 10), reason ? String(reason).slice(0, 200) : 'Refund via Telegram agent', null);
    if (r.refunded > 0 && r.userId) require('./notifications').notifyUser(r.userId, 'order', 'Order refunded 💸',
      `Your order ${r.orderCode} was refunded ${peso(r.refunded)} to your wallet.`).catch(() => {});
    return r.refunded > 0 ? `Refunded ${peso(r.refunded)} for order #${order_id}.` : `Nothing to refund (${r.skipped || 'already settled'}).`;
  },
  async refill_order({ order_id }) {
    const [[o]] = await pool.query('SELECT id, order_id, provider_order_id, api_provider FROM orders WHERE id = ?', [parseInt(order_id, 10)]);
    if (!o || !o.provider_order_id) throw new Error('No provider order linked to this order.');
    const { getClient } = require('../providers');
    const client = getClient(o.api_provider === 'SMMWorld' ? 'smmworld' : 'rkd');
    if (!client) throw new Error('Provider client unavailable.');
    const res = await client.refill(o.provider_order_id);
    await pool.query('UPDATE tickets SET provider_action_status = ? WHERE order_id = ?', ['refill_sent', o.order_id]).catch(() => {});
    return `Refill requested for ${o.order_id} (provider says: ${JSON.stringify(res).slice(0, 120)}).`;
  },
  async adjust_balance({ user_id, amount, reason }) {
    const wallet = require('./wallet');
    const amt = Number(amount);
    const nb = await wallet.adjustBalance(parseInt(user_id, 10), amt, null, reason ? String(reason).slice(0, 200) : 'Telegram agent adjustment');
    require('./notifications').notifyUser(parseInt(user_id, 10), 'wallet',
      amt >= 0 ? 'Funds added 💰' : 'Wallet adjusted',
      `${amt >= 0 ? 'Added' : 'Deducted'} ${peso(Math.abs(amt))}${reason ? ' — ' + String(reason).slice(0, 120) : ''}.`).catch(() => {});
    return `${amt >= 0 ? 'Added' : 'Deducted'} ${peso(Math.abs(amt))} for user #${user_id}. New balance: ${peso(nb)}.`;
  },
  async ban_user({ user_id, reason }) {
    const [r] = await pool.query("UPDATE users SET status = 'Banned' WHERE id = ? AND role NOT IN ('admin','super_admin')", [parseInt(user_id, 10)]);
    if (!r.affectedRows) throw new Error('User not found or is staff (cannot ban).');
    return `Banned user #${user_id}${reason ? ' — ' + String(reason).slice(0, 120) : ''}.`;
  },
  async create_promo({ code, type, value, max_uses }) {
    const c = String(code || '').trim().toUpperCase().slice(0, 50);
    if (!/^[A-Z0-9_-]{3,50}$/.test(c)) throw new Error('Code must be 3–50 chars (A–Z, 0–9, - or _).');
    const t = type === 'fixed' ? 'fixed' : 'percentage';
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0 || (t === 'percentage' && v > 100)) throw new Error('Invalid discount value.');
    const [[dupe]] = await pool.query('SELECT id FROM promos WHERE UPPER(code) = ? LIMIT 1', [c]);
    if (dupe) throw new Error(`Promo ${c} already exists.`);
    await pool.query(
      "INSERT INTO promos (code, type, value, max_uses, uses, expires_at, max_discount_amount, active) VALUES (?,?,?,?,0,NULL,NULL,1)",
      [c, t, v.toFixed(2), Math.max(0, parseInt(max_uses, 10) || 0)]);
    const off = t === 'fixed' ? `${peso(v)} off` : `${v}% off`;
    require('./notifications').postUpdate('promo', `New promo code: ${c}`, `Use code ${c} for ${off} on your next order!`, '/order/new').catch(() => {});
    return `Created promo ${c} (${off}).`;
  },
  async broadcast({ title, message }) {
    await require('./notifications').postUpdate('announcement', String(title || 'Announcement').slice(0, 180), String(message || '').slice(0, 500), null);
    return `Broadcast posted: "${String(title || '').slice(0, 60)}".`;
  },
  async unsync_services({ provider }) {
    const r = await require('./catalog').unsyncProvider(PROVIDER_CODE(provider));
    return `Un-synced ${r.provider}: ${r.removed} service(s) removed from the catalog. Re-sync anytime to bring them back.`;
  },
  async resolve_payout({ payout_id, approve, note }) {
    const wallet = require('./wallet');
    const p = await wallet.resolvePayout(parseInt(payout_id, 10), null, !!approve, note ? String(note).slice(0, 200) : null);
    require('./notifications').notifyUser(p.user_id, 'wallet', approve ? 'Payout sent ✅' : 'Payout rejected',
      approve ? `Your ${peso(p.amount)} withdrawal was marked paid.` : `Your ${peso(p.amount)} withdrawal was rejected and returned to your wallet.`).catch(() => {});
    return `Payout #${payout_id} ${approve ? 'approved (paid)' : 'rejected (refunded)'} — ${peso(p.amount)}.`;
  },
};

// Human-readable summary of a pending action (shown with the Confirm button).
async function describe(action, args) {
  try {
    if (action === 'adjust_balance') {
      const a = Number(args.amount);
      const [[u]] = await pool.query('SELECT username, balance FROM users WHERE id = ?', [parseInt(args.user_id, 10)]);
      const who = u ? `${u.username} (#${args.user_id}, now ${peso(u.balance)})` : `user #${args.user_id}`;
      return `${a >= 0 ? '➕ Add' : '➖ Deduct'} ${peso(Math.abs(a))} ${a >= 0 ? 'to' : 'from'} ${who}${args.reason ? `\nReason: ${args.reason}` : ''}`;
    }
    if (action === 'approve_deposit') { const [[d]] = await pool.query('SELECT amount, payment_method FROM deposits WHERE id = ?', [parseInt(args.deposit_id, 10)]); return d ? `Approve deposit #${args.deposit_id}: ${peso(d.amount)} via ${String(d.payment_method).toUpperCase()}` : `Approve deposit #${args.deposit_id}`; }
    if (action === 'reject_deposit') return `Reject deposit #${args.deposit_id}${args.reason ? `\nReason: ${args.reason}` : ''}`;
    if (action === 'refund_order') { const [[o]] = await pool.query('SELECT order_id, charge FROM orders WHERE id = ?', [parseInt(args.order_id, 10)]); return o ? `Refund order ${o.order_id} (${peso(o.charge)})${args.reason ? `\nReason: ${args.reason}` : ''}` : `Refund order #${args.order_id}`; }
    if (action === 'refill_order') { const [[o]] = await pool.query('SELECT order_id FROM orders WHERE id = ?', [parseInt(args.order_id, 10)]); return `Refill order ${o ? o.order_id : '#' + args.order_id} at the provider`; }
    if (action === 'ban_user') { const [[u]] = await pool.query('SELECT username FROM users WHERE id = ?', [parseInt(args.user_id, 10)]); return `🚫 Ban ${u ? u.username : 'user'} (#${args.user_id})${args.reason ? `\nReason: ${args.reason}` : ''}`; }
    if (action === 'create_promo') return `Create promo ${String(args.code).toUpperCase()} — ${args.type === 'fixed' ? peso(args.value) + ' off' : args.value + '% off'}${args.max_uses ? `, max ${args.max_uses} uses` : ''}`;
    if (action === 'broadcast') return `📢 Broadcast to all customers:\n${args.title}\n${String(args.message || '').slice(0, 160)}`;
    if (action === 'resolve_payout') return `${args.approve ? '✅ Approve (mark paid)' : '❌ Reject'} payout #${args.payout_id}`;
    if (action === 'unsync_services') return `⊘ Un-sync ALL services from ${PROVIDER_CODE(args.provider)} (removes them from the catalog; re-sync restores)`;
  } catch (_) { /* fall through */ }
  return `${action} ${JSON.stringify(args).slice(0, 120)}`;
}

// ── Pending-action store (owner confirms via Telegram button) ──
async function queueAction(action, args) {
  const token = crypto.randomBytes(9).toString('base64url').slice(0, 16);
  const summary = await describe(action, args);
  await pool.query('INSERT INTO agent_actions (token, action, args, summary) VALUES (?,?,?,?)',
    [token, action, JSON.stringify(args).slice(0, 4000), summary.slice(0, 300)]);
  return { token, summary };
}

// Called from the Telegram webhook when the owner taps ✅ Confirm.
async function runConfirmed(token) {
  const [[row]] = await pool.query('SELECT * FROM agent_actions WHERE token = ?', [token]);
  if (!row) return { ok: false, error: 'This action expired or was already handled.' };
  if (row.status !== 'pending') return { ok: false, error: `Already ${row.status}.`, already: true };
  let result;
  try {
    const args = row.args ? JSON.parse(row.args) : {};
    result = await PERFORM[row.action](args);
    await pool.query("UPDATE agent_actions SET status='done', result=?, decided_at=NOW() WHERE token=?", [String(result).slice(0, 400), token]);
    return { ok: true, result };
  } catch (e) {
    await pool.query("UPDATE agent_actions SET status='done', result=?, decided_at=NOW() WHERE token=?", [('Failed: ' + e.message).slice(0, 400), token]);
    return { ok: false, error: e.message };
  }
}

// Called when the owner taps ❌ Cancel.
async function cancelConfirmed(token) {
  const [r] = await pool.query("UPDATE agent_actions SET status='canceled', decided_at=NOW() WHERE token=? AND status='pending'", [token]);
  return r.affectedRows > 0;
}

function apiUrl() { return `${env.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`; }

// Local reasoning models (e.g. deepseek-r1 via Ollama) wrap their scratch
// reasoning in <think>…</think>. Strip it so the owner only sees the answer.
function clean(s) { return String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim(); }

async function callModel(messages) {
  const models = [env.AI_MODEL, 'deepseek-v4-flash', 'deepseek-chat'].filter((v, i, a) => v && a.indexOf(v) === i);
  for (let i = 0; i < models.length; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const res = await fetch(apiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AI_API_KEY}` },
        body: JSON.stringify({ model: models[i], messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.2, max_tokens: 1200 }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) { if (i < models.length - 1 && ![401, 403].includes(res.status)) continue; return null; }
      const json = JSON.parse(text);
      return json.choices && json.choices[0] ? json.choices[0].message : null;
    } catch (_) { /* next model */ } finally { clearTimeout(timer); }
  }
  return null;
}

// Run the agent loop for one admin command.
// Returns { text } or { text, confirm: [{token, summary}] } when confirmation is needed.
async function ask(question) {
  if (!enabled) return { text: 'AI is not configured right now.' };
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: String(question).slice(0, 1000) }];
  for (let step = 0; step < 6; step++) {
    const msg = await callModel(messages);
    if (!msg) return { text: 'Sorry, the AI is unavailable right now. Please try again.' };
    messages.push(msg);
    if (msg.tool_calls && msg.tool_calls.length) {
      const confirm = [];
      for (const tc of msg.tool_calls) {
        let result;
        try {
          const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          const name = tc.function.name;
          if (CONFIRM.has(name)) {
            const q = await queueAction(name, args);
            confirm.push(q);
            result = { status: 'awaiting_owner_confirmation', summary: q.summary };
          } else if (READS[name]) {
            result = await READS[name](args);
          } else if (ACTIONS[name]) {
            result = await ACTIONS[name](args);
          } else {
            result = { error: 'unknown tool' };
          }
        } catch (e) { result = { error: e.message }; }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 6000) });
      }
      if (confirm.length) {
        // Ask one more time so the model writes a short natural lead-in, then attach buttons.
        const lead = await callModel(messages);
        const text = clean(lead && lead.content) || 'Please confirm:';
        return { text, confirm };
      }
      continue; // let the model read tool results and answer
    }
    return { text: clean(msg.content) || "I looked but couldn't form an answer." };
  }
  return { text: 'That needed too many steps — try asking something more specific.' };
}

module.exports = { enabled, ask, runConfirmed, cancelConfirmed };
