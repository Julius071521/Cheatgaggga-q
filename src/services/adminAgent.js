'use strict';
// AI Admin Agent — a tool-using agent the owner talks to over Telegram in plain
// language ("orders today?", "who has pending deposits?", "block 1.2.3.4").
// It runs a real function-calling loop against the configured AI (DeepSeek) with
// read + action tools over the site's own data. Admin-only (the Telegram webhook
// gates it to TELEGRAM_ADMIN_CHAT_ID), so it may see everything.
const env = require('../config/env');
const pool = require('../db/pool');
const security = require('./security');

const enabled = Boolean(env.AI_API_KEY && env.AI_BASE_URL);

const SYSTEM = `You are the admin assistant for ${env.SITE_NAME || 'ApexBoost'}, an SMM (social media marketing) panel.
You help the OWNER manage the business over Telegram. Use the tools to fetch real data before answering — never invent numbers.
All money is in Philippine pesos (₱). Be concise and use short Telegram-friendly formatting (plain text, a few emojis, no markdown tables).
When the owner asks to block/unblock an IP or approve a deposit, use the matching tool and confirm what you did.`;

// ── Tool schemas (OpenAI/DeepSeek function-calling format) ──
const TOOLS = [
  { type: 'function', function: { name: 'site_stats', description: 'Overall business stats: users, orders today/total, revenue today/this month, profit today, pending deposits, open tickets, total customer wallet balance.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'find_user', description: 'Look up customers by username or email (partial match).', parameters: { type: 'object', properties: { query: { type: 'string', description: 'username or email to search' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'recent_orders', description: 'Most recent orders, optionally filtered by status.', parameters: { type: 'object', properties: { limit: { type: 'integer' }, status: { type: 'string', description: 'Pending|In progress|Processing|Completed|Partial|Canceled|Failed' } } } } },
  { type: 'function', function: { name: 'pending_deposits', description: 'Deposits awaiting review (add-funds requests).', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'approve_deposit', description: 'Approve a pending deposit by its id (credits the customer, applies bonus + referral commission).', parameters: { type: 'object', properties: { deposit_id: { type: 'integer' } }, required: ['deposit_id'] } } },
  { type: 'function', function: { name: 'order_lookup', description: 'Find an order by its site code (APX-...) or the provider order number.', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] } } },
  { type: 'function', function: { name: 'security_summary', description: 'Security status: flagged IPs, blocked count, whether the site is under attack.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'block_ip', description: 'Block an IP address (app + Cloudflare edge).', parameters: { type: 'object', properties: { ip: { type: 'string' } }, required: ['ip'] } } },
  { type: 'function', function: { name: 'unblock_ip', description: 'Unblock/allow an IP address.', parameters: { type: 'object', properties: { ip: { type: 'string' } }, required: ['ip'] } } },
];

// ── Tool implementations ──
const IMPL = {
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
  async pending_deposits() {
    const [rows] = await pool.query(
      `SELECT d.id, u.username, d.payment_method, d.amount, d.reference_id, d.created_at
       FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.status = 'Pending' ORDER BY d.id DESC LIMIT 20`);
    return rows.length ? rows : { note: 'no pending deposits' };
  },
  async approve_deposit({ deposit_id }) {
    const wallet = require('./wallet');
    try {
      const r = await wallet.approveDeposit(parseInt(deposit_id, 10), null, 'Approved via Telegram admin agent');
      const notifications = require('./notifications');
      notifications.notifyUser(r.deposit.user_id, 'deposit', 'Deposit approved 🎉',
        `Your ${String(r.deposit.payment_method).toUpperCase()} deposit of ₱${Number(r.deposit.amount).toFixed(2)} was approved.`).catch(() => {});
      return { ok: true, credited: Number(r.deposit.amount), bonus: r.bonus, commission: r.commission };
    } catch (e) { return { ok: false, error: e.message }; }
  },
  async order_lookup({ ref }) {
    const r = String(ref || '').slice(0, 60);
    const [rows] = await pool.query(
      `SELECT order_id, provider_order_id, service_name, quantity, charge, refund_amount, status, remains, created_at
       FROM orders WHERE order_id LIKE ? OR provider_order_id = ? ORDER BY id DESC LIMIT 3`, [`%${r}%`, r]);
    return rows.length ? rows : { note: 'no matching order' };
  },
  async security_summary() {
    const [[c]] = await pool.query("SELECT COUNT(*) AS blocked FROM blocked_ips");
    const [[f]] = await pool.query("SELECT COUNT(*) AS flagged FROM ip_reputation WHERE status IS NULL OR status='watch'");
    const [top] = await pool.query("SELECT ip, score, last_kind, country FROM ip_reputation WHERE status IS NULL OR status='watch' ORDER BY score DESC LIMIT 5");
    return { blocked: c.blocked, flagged: f.flagged, under_attack: await security.underAttack(), top_threats: top };
  },
  async block_ip({ ip }) {
    const r = await security.blockIp(String(ip).trim(), 'Blocked via Telegram admin agent', null);
    return r && r.skipped ? { ok: false, reason: r.skipped } : { ok: true, blocked: ip };
  },
  async unblock_ip({ ip }) { await security.allowIp(String(ip).trim()); return { ok: true, allowed: ip }; },
};

function apiUrl() { return `${env.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`; }

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

// Run the agent loop for one admin question; returns the final text answer.
async function ask(question) {
  if (!enabled) return 'AI is not configured right now.';
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: String(question).slice(0, 1000) }];
  for (let step = 0; step < 6; step++) {
    const msg = await callModel(messages);
    if (!msg) return 'Sorry, the AI is unavailable right now. Please try again.';
    messages.push(msg);
    if (msg.tool_calls && msg.tool_calls.length) {
      for (const tc of msg.tool_calls) {
        let result;
        try {
          const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          result = IMPL[tc.function.name] ? await IMPL[tc.function.name](args) : { error: 'unknown tool' };
        } catch (e) { result = { error: e.message }; }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 6000) });
      }
      continue; // let the model read the tool results and answer
    }
    return (msg.content || '').trim() || "I looked but couldn't form an answer.";
  }
  return 'That needed too many steps — try asking something more specific.';
}

module.exports = { enabled, ask };
