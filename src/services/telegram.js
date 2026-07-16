'use strict';
// Thin Telegram Bot API client — security alerts with interactive buttons.
// Self-contained (no VPS needed): the site sends messages and receives button
// presses via a webhook. Configure with TELEGRAM_BOT_TOKEN + TELEGRAM_ADMIN_CHAT_ID.
const env = require('../config/env');

const enabled = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ADMIN_CHAT_ID);

function api(method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) return Promise.resolve(null);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  return fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: controller.signal,
  })
    .then((r) => r.json())
    .then((j) => {
      if (!j.ok) console.warn(`[telegram] ${method} failed:`, JSON.stringify(j).slice(0, 200));
      return j;
    })
    .catch((err) => { console.warn(`[telegram] ${method} error:`, err.message); return null; })
    .finally(() => clearTimeout(timer));
}

// Plain message to the admin chat.
function send(text, extra) {
  if (!enabled) return Promise.resolve(null);
  return api('sendMessage', Object.assign({
    chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }, extra || {}));
}

// Message with an inline keyboard (rows of [{ text, data }]).
function sendButtons(text, rows) {
  const inline_keyboard = (rows || []).map((row) =>
    row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data })));
  return send(text, { reply_markup: { inline_keyboard } });
}

function answerCallback(id, text, alert) {
  return api('answerCallbackQuery', { callback_query_id: id, text: text || '', show_alert: !!alert });
}

// Replace a message's text + buttons after an action (so the chat reflects state).
function editMessage(chatId, messageId, text, rows) {
  const reply_markup = rows
    ? { inline_keyboard: rows.map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))) }
    : undefined;
  return api('editMessageText', {
    chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML',
    disable_web_page_preview: true, reply_markup,
  });
}

// Point Telegram at our webhook so button presses reach the site.
function setWebhook(baseUrl) {
  if (!enabled || !env.TELEGRAM_WEBHOOK_SECRET) return Promise.resolve(null);
  const url = `${String(baseUrl).replace(/\/$/, '')}/telegram/webhook/${env.TELEGRAM_WEBHOOK_SECRET}`;
  return api('setWebhook', { url, allowed_updates: ['callback_query', 'message'], drop_pending_updates: false });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { enabled, send, sendButtons, answerCallback, editMessage, setWebhook, esc };
