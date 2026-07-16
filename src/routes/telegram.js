'use strict';
// Receives Telegram button presses (callback queries) and acts on them:
// block / allow / watch an IP, or show details. The secret in the URL path is
// the only auth Telegram supports for webhooks — keep TELEGRAM_WEBHOOK_SECRET long.
const express = require('express');
const env = require('../config/env');
const security = require('../services/security');
const telegram = require('../services/telegram');

const router = express.Router();

router.post('/telegram/webhook/:secret', express.json({ limit: '32kb' }), async (req, res) => {
  // Constant-ish secret check; always 200 so Telegram doesn't retry-storm.
  if (!env.TELEGRAM_WEBHOOK_SECRET || req.params.secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return res.sendStatus(200);
  }
  res.sendStatus(200); // ack immediately; process below

  try {
    const update = req.body || {};
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
      const lines = events.map((ev) =>
        `• <code>${e(ev.kind)}</code> ${e(ev.method || '')} ${e(String(ev.path || '').slice(0, 44))}`).join('\n') || '—';
      const text =
        `ℹ️ <b>IP ${e(ip)}</b>\n` +
        `Status: <b>${e(blocked ? 'blocked' : (rep && rep.status) || 'none')}</b>  ·  ` +
        `Score: ${rep ? rep.score : 0}  ·  Events: ${rep ? rep.events_count : 0}\n` +
        `Agent: ${e(String((rep && rep.user_agent) || '').slice(0, 70))}\n\n` +
        `<b>Last events:</b>\n${lines}`;
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
