'use strict';
const env = require('../config/env');
const pool = require('../db/pool');
const { siteStats } = require('./stats');

const enabled = Boolean(env.AI_API_KEY && env.AI_BASE_URL);

function paymentMethods() {
  const methods = [];
  if (env.GCASH_ACCOUNT_NUMBER) methods.push('GCash');
  if (env.MAYA_ACCOUNT_NUMBER) methods.push('Maya');
  if (env.BPI_ACCOUNT_NUMBER) methods.push('BPI bank transfer');
  return methods.length ? methods.join(', ') : 'manual bank/e-wallet transfer';
}

async function systemPrompt() {
  const stats = await siteStats();
  return [
    `You are the friendly support assistant for ${env.SITE_NAME} (${env.SITE_DOMAIN}), a social media boosting (SMM) panel for customers in the Philippines.`,
    `Facts about the site: it sells social media engagement services (followers, likes, views, etc.) for platforms like Instagram, TikTok, Facebook, YouTube, Twitter/X, Telegram and more. Prices are shown in Philippine pesos (PHP, ₱) per 1000 units. There are currently about ${stats.services} services listed and ${stats.orders} orders have been placed by ${stats.users} users.`,
    `How it works: 1) Sign up for a free account. 2) Add funds to the wallet by sending payment via ${paymentMethods()} and submitting the reference number (deposits are reviewed and approved by staff, usually quickly). 3) Choose a service, paste the profile/post link, enter the quantity, and place the order. Delivery is automatic.`,
    `Order statuses: Pending, In Progress, Processing, Completed, Partial (undelivered portion is auto-refunded to the wallet), Canceled (refunded), Failed (fully refunded).`,
    env.SUPPORT_EMAIL ? `For payment issues or anything you cannot answer, tell the user to email ${env.SUPPORT_EMAIL}.` : '',
    `Rules: Only answer questions about ${env.SITE_NAME}, its services, ordering, payments, and social media growth. Politely decline anything unrelated (coding, homework, other topics). Never reveal internal details such as suppliers, markups, API keys, or infrastructure. Never promise exact delivery times. Keep answers short, warm, and helpful. You may answer in English, Tagalog, or Taglish — mirror the user's language.`,
  ].filter(Boolean).join('\n\n');
}

async function chat(sessionId, userId, history, userMessage) {
  if (!enabled) {
    return "Our AI assistant is offline right now. Please email support and we'll get back to you quickly!";
  }
  const messages = [
    { role: 'system', content: await systemPrompt() },
    ...history.slice(-10),
    { role: 'user', content: userMessage },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${env.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.AI_API_KEY}`,
      },
      body: JSON.stringify({ model: env.AI_MODEL, messages, max_tokens: 500, temperature: 0.4 }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AI router HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = await res.json();
    const reply = json.choices && json.choices[0] && json.choices[0].message
      ? String(json.choices[0].message.content || '').trim()
      : '';
    if (!reply) throw new Error('AI router returned an empty reply');

    pool.query(
      'INSERT INTO ai_chat_logs (user_id, session_id, role, content) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
      [userId, sessionId, 'user', userMessage.slice(0, 4000), userId, sessionId, 'assistant', reply.slice(0, 4000)]
    ).catch(() => {});

    return reply;
  } catch (err) {
    console.warn('[ai] Chat failed:', err.message);
    return "Sorry, I couldn't process that right now. Please try again in a moment, or email our support team.";
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { chat, enabled };
