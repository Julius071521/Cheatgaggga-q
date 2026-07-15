'use strict';
const express = require('express');
const notifications = require('../services/notifications');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/notifications', requireAuth, async (req, res, next) => {
  try {
    const feed = await notifications.recentFeed(req.user, 40);
    res.render('dashboard/notifications', { title: 'Notifications', feed });
    // Mark everything read after the page is prepared.
    notifications.markAllRead(req.user).catch(() => {});
  } catch (err) { next(err); }
});

module.exports = router;
