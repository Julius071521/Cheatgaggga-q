'use strict';
// Receives Telegram button presses (callback queries) and acts on them:
// block / allow / watch an IP, or show details. The secret in the URL path is
// the only auth Telegram supports for webhooks — keep TELEGRAM_WEBHOOK_SECRET long.
const express = require('express');
const env = require('../config/env');
const security = require('../services/security');
const telegram = require('../services/telegram');
const adminAgent = require('../services/adminAgent');

const router = express.Router();

const HELP =
  '👋 <b>Hi boss!</b> I\'m your ApexBoost assistant. Just talk to me normally — I can check the business and take actions for you.\n\n' +
  'Try asking:\n' +
  '• <i>How many orders today?</i>\n' +
  '• <i>Any pending deposits?</i>\n' +
  '• <i>Look up user juan</i>\n' +
  '• <i>Find order APX-... (or a provider order number)</i>\n' +
  '• <i>Are we under attack?</i>\n' +
  '• <i>Block 1.2.3.4</i>  /  <i>Unblock 1.2.3.4</i>\n' +
  '• <i>Approve deposit 42</i>';

router.post('/telegram/webhook/:secret', express.json({ limit: '32kb' }), async (req, res) => {
  // Constant-ish secret check; always 200 so Telegram doesn't retry-storm.
  if (!env.TELEGRAM_WEBHOOK_SECRET || req.params.secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return res.sendStatus(200);
  }
  res.sendStatus(200); // ack immediately; process below

  try {
    const update = req.body || {};

    // ── Plain text messages → AI admin agent ──
    if (update.message && !update.callback_query) {
      const msg = update.message;
      const fromChat = String(msg.chat && msg.chat.id);
      // Only the owner may talk to the agent. Ignore everyone else silently.
      if (!env.TELEGRAM_ADMIN_CHAT_ID || fromChat !== String(env.TELEGRAM_ADMIN_CHAT_ID)) return;
      const text = String(msg.text || '').trim();
      if (!text) return;
      if (/^\/(start|help)\b/i.test(text)) { await telegram.send(HELP); return; }
      // Strip a leading /command (e.g. "/ask orders today") so bot commands still work.
      const question = text.replace(/^\/[a-z0-9_]+(@\w+)?\s*/i, '').trim() || text;
      await telegram.chatAction('typing');
      let reply;
      try { reply = await adminAgent.ask(question); }
      catch (e) { reply = 'Sorry, something went wrong: ' + telegram.esc(e.message); }
      await telegram.send(telegram.esc(reply || 'No answer.'));
      return;
    }

    const cq = update.callback_query;
    if (!cq || !cq.data) return;

    // Only the configured admin chat may drive actions.
    const fromChat = String(cq.message && cq.message.chat && cq.message.chat.id);
    if (env.TELEGRAM_ADMIN_CHAT_ID && fromChat !== String(env.TELEGRAM_ADMIN_CHAT_ID)) {
      return telegram.answerCallback(cq.id, 'Not authorized.', true);
    }

    const [action, ip] = String(cq.data).split(':');
    if (!ip) return telegram.answerCallback(cq.id, 'Bad action.');
    const e = telegram.esc;
    const chatId = cq.message.chat.id;
    const msgId = cq.message.message_id;

    if (action === 'blk') {
      await security.blockIp(ip, 'Blocked from Telegram', null);
      await telegram.answerCallback(cq.id, `🚫 Blocked ${ip}`);
      await telegram.editMessage(chatId, msgId, `🚫 <b>Blocked</b> <code>${e(ip)}</code>\nThis IP can no longer reach the site.`,
        [[{ text: '✅ Unblock', data: `alw:${ip}` }, { text: 'ℹ️ Details', data: `inf:${ip}` }]]);
    } else if (action === 'alw') {
      await security.allowIp(ip);
      await telegram.answerCallback(cq.id, `✅ Allowed ${ip}`);
      await telegram.editMessage(chatId, msgId, `✅ <b>Allowed</b> <code>${e(ip)}</code>\nUnblocked and whitelisted from future alerts.`,
        [[{ text: '🚫 Block', data: `blk:${ip}` }, { text: 'ℹ️ Details', data: `inf:${ip}` }]]);
    } else if (action === 'wch') {
      await security.watchIp(ip);
      await telegram.answerCallback(cq.id, `👁 Watching ${ip}`);
    } else if (action === 'inf') {
      const { rep, events, blocked } = await security.ipDetails(ip);
      const lvl = security.threatLevel(rep ? rep.score : 0);
      const lines = events.map((ev) =>
        `• <b>${e(security.KIND_LABEL[ev.kind] || ev.kind)}</b> — <code>${e(ev.method || '')} ${e(String(ev.path || '').slice(0, 40))}</code>`).join('\n') || '—';
      const loc = rep ? [rep.city, rep.country].filter(Boolean).join(', ') : '';
      const flag = rep ? security.flagEmoji(rep.country_code) : '';
      const text =
        `ℹ️ <b>IP ${e(ip)}</b>\n` +
        `<b>Location:</b> ${flag} ${e(loc || 'Unknown')}${rep && rep.is_proxy ? '  ⚠️ VPN/Proxy' : ''}\n` +
        `<b>Network:</b> ${e(String((rep && rep.isp) || 'Unknown').slice(0, 50))}\n` +
        `<b>Status:</b> ${e(blocked ? '🚫 blocked' : (rep && rep.status) || 'flagged')}  ·  ` +
        `<b>Danger:</b> ${lvl.emoji} ${lvl.label} (${rep ? rep.score : 0})  ·  Events: ${rep ? rep.events_count : 0}\n` +
        `<b>Device:</b> ${e(String((rep && rep.user_agent) || '').slice(0, 60))}\n\n` +
        `<b>Recent activity:</b>\n${lines}`;
      const rows = blocked
        ? [[{ text: '✅ Unblock', data: `alw:${ip}` }, { text: '👁 Watch', data: `wch:${ip}` }]]
        : [[{ text: '🚫 Block', data: `blk:${ip}` }, { text: '✅ Allow', data: `alw:${ip}` }, { text: '👁 Watch', data: `wch:${ip}` }]];
      await telegram.answerCallback(cq.id, '');
      await telegram.send(text, { reply_markup: { inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))) } });
    } else {
      await telegram.answerCallback(cq.id, 'Unknown action.');
    }
  } catch (err) {
    console.warn('[telegram] webhook error:', err.message);
  }
});

module.exports = router;
