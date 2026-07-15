'use strict';
const pool = require('../db/pool');

// Personal notification for one user (deposit result, ticket update, order done).
async function notifyUser(userId, type, title, message, metadata) {
  try {
    await pool.query(
      'INSERT INTO user_notifications (user_id, type, title, message, metadata) VALUES (?, ?, ?, ?, ?)',
      [userId, String(type).slice(0, 50), String(title).slice(0, 160), message ? String(message) : null,
        metadata ? JSON.stringify(metadata).slice(0, 2000) : null]
    );
  } catch (err) {
    console.warn('[notifications] notifyUser failed:', err.message);
  }
}

// Global update everyone sees (new promo code, new services).
async function postUpdate(type, title, message, url) {
  try {
    await pool.query(
      'INSERT INTO updates (type, title, message, url) VALUES (?, ?, ?, ?)',
      [String(type).slice(0, 40), String(title).slice(0, 180), message ? String(message).slice(0, 500) : null, url || null]
    );
  } catch (err) {
    console.warn('[notifications] postUpdate failed:', err.message);
  }
}

// Unread count = personal unread + global updates newer than the user's marker.
async function unreadCount(user) {
  try {
    const [[p]] = await pool.query('SELECT COUNT(*) AS c FROM user_notifications WHERE user_id = ? AND read_at IS NULL', [user.id]);
    const [[g]] = await pool.query('SELECT COUNT(*) AS c FROM updates WHERE created_at > COALESCE(?, "1970-01-01")', [user.notifications_seen_at || null]);
    return Number(p.c) + Number(g.c);
  } catch (_) { return 0; }
}

// Merged recent feed (personal + global), newest first.
async function recentFeed(user, limit = 20) {
  try {
    const [personal] = await pool.query(
      'SELECT id, type, title, message, read_at, created_at FROM user_notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?',
      [user.id, limit]);
    const [global] = await pool.query('SELECT id, type, title, message, url, created_at FROM updates ORDER BY id DESC LIMIT ?', [limit]);
    const seenAt = user.notifications_seen_at ? new Date(user.notifications_seen_at).getTime() : 0;
    const items = [
      ...personal.map((n) => ({ ...n, scope: 'personal', unread: !n.read_at })),
      ...global.map((n) => ({ ...n, scope: 'global', unread: new Date(n.created_at).getTime() > seenAt })),
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limit);
    return items;
  } catch (_) { return []; }
}

async function markAllRead(user) {
  try {
    await pool.query('UPDATE user_notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL', [user.id]);
    await pool.query('UPDATE users SET notifications_seen_at = NOW() WHERE id = ?', [user.id]);
  } catch (err) {
    console.warn('[notifications] markAllRead failed:', err.message);
  }
}

module.exports = { notifyUser, postUpdate, unreadCount, recentFeed, markAllRead };
