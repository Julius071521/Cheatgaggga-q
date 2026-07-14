'use strict';
const express = require('express');
const ai = require('../services/ai');
const { aiLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.post('/ai/chat', aiLimiter, express.json({ limit: '8kb' }), async (req, res) => {
  const message = String((req.body && req.body.message) || '').trim().slice(0, 1000);
  if (!message) return res.status(400).json({ error: 'Empty message' });

  if (!req.session.aiHistory) req.session.aiHistory = [];
  const history = req.session.aiHistory;

  const reply = await ai.chat(req.session.id, req.user ? req.user.id : null, history, message);

  history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
  req.session.aiHistory = history.slice(-12);

  res.json({ reply });
});

module.exports = router;
