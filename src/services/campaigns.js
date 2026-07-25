'use strict';
// Marketing email automation: the welcome campaign for new customers and the
// "new services added" digest for existing ones.
//
// Three rules hold everywhere in this file:
//   1. Nothing is sent twice. Every send is claimed in email_log first, and the
//      unique key (user_id, kind, ref) is what enforces it — not application
//      logic that a crash or an overlapping tick could skip.
//   2. Opted-out customers are never mailed. Only transactional mail
//      (verification, password reset, deposits, orders) ignores that flag.
//   3. A run is bounded and resumable. Each pass mails at most BATCH_LIMIT
//      people, then stops; the next pass continues where it left off, because
//      the campaign ref is derived from the data, not from the clock.
const crypto = require('crypto');
const pool = require('../db/pool');
const env = require('../config/env');
const mailer = require('./mailer');
const pricing = require('./pricing');
const { tidyCategory, tidyServiceName, platformLabel } = require('../utils/helpers');

// How many customers one pass will mail. Keeps a cron tick short and stays
// well inside shared-host SMTP limits; the rest go out on the next pass.
const BATCH_LIMIT = Number(env.EMAIL_BATCH_LIMIT) || 200;
// Pause between messages so a burst doesn't trip the provider's rate limit.
const SEND_GAP_MS = Number(env.EMAIL_SEND_GAP_MS) || 400;
// Don't mail people about a trickle of additions.
const MIN_NEW_SERVICES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── settings helpers ──────────────────────────────────────
async function getSetting(key, fallback = null) {
  try {
    const [[row]] = await pool.query('SELECT v FROM settings WHERE k = ?', [key]);
    return row ? row.v : fallback;
  } catch (_) { return fallback; }
}
async function setSetting(key, value) {
  await pool.query('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
    [key, String(value)]);
}
async function enabled() {
  return String(await getSetting('email_campaigns', 'on')).toLowerCase() !== 'off';
}

// ── unsubscribe links ─────────────────────────────────────
// HMAC over the user id, so no token column is needed and the link cannot be
// guessed. Rotating SESSION_SECRET invalidates every outstanding link.
function unsubToken(userId) {
  return crypto.createHmac('sha256', env.SESSION_SECRET)
    .update(`unsub:${userId}`).digest('hex').slice(0, 32);
}
function verifyUnsub(userId, token) {
  const expected = unsubToken(userId);
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function unsubUrl(user) {
  const base = String(env.BASE_URL || `https://${env.SITE_DOMAIN}`).replace(/\/$/, '');
  return `${base}/unsubscribe/${user.id}/${unsubToken(user.id)}`;
}

// ── idempotent claim ──────────────────────────────────────
// Returns true only for the caller that actually inserted the row. Anyone
// else (a retry, a second worker) gets false and must not send.
async function claim(userId, kind, ref) {
  try {
    await pool.query('INSERT INTO email_log (user_id, kind, ref) VALUES (?, ?, ?)',
      [userId, kind, String(ref).slice(0, 120)]);
    return true;
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') return false;
    throw err;
  }
}
async function markFailed(userId, kind, ref, message) {
  await pool.query(
    "UPDATE email_log SET status = 'failed', error = ? WHERE user_id = ? AND kind = ? AND ref = ?",
    [String(message || '').slice(0, 255), userId, kind, String(ref).slice(0, 120)]).catch(() => {});
}

// Who may receive marketing mail: active, verified, opted in, with an address.
const RECIPIENT_SQL = `
  FROM users u
  WHERE u.email IS NOT NULL AND u.email <> ''
    AND u.email_optout = 0
    AND u.email_verified = 1
    AND LOWER(COALESCE(u.status, 'active')) = 'active'`;

// ── content blocks ────────────────────────────────────────
function bonusTierRows() {
  return String(env.DEPOSIT_BONUS_TIERS || '')
    .split(',')
    .map((t) => t.split(':'))
    .filter((p) => p.length === 2 && Number(p[0]) > 0 && Number(p[1]) > 0)
    .map(([amount, pct]) => ({ amount: Number(amount), pct: Number(pct) }))
    .sort((a, b) => a.amount - b.amount);
}

function peso(n) {
  return `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Real best-sellers, never invented. Falls back to the cheapest live services
// when there is no order history yet.
async function trendingServices(limit = 5) {
  try {
    const [rows] = await pool.query(
      `SELECT s.id, s.name, s.platform, s.rate_usd, s.markup_override, COUNT(o.id) AS orders
         FROM services s
         JOIN providers p ON p.id = s.provider_id
         LEFT JOIN orders o ON CONVERT(o.service_id USING utf8mb4) COLLATE utf8mb4_bin =
                               CONVERT(s.provider_service_id USING utf8mb4) COLLATE utf8mb4_bin
                          AND o.created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
        WHERE s.enabled = 1 AND s.deleted = 0
        GROUP BY s.id
        ORDER BY orders DESC, s.rate_usd ASC
        LIMIT ?`, [limit * 6]); // over-fetch: dedupe by display name trims this down
    return pickForEmail(rows.map((s) => ({
      name: tidyServiceName(s.name, s.id),
      platform: platformLabel(s.platform),
      ratePhp: pricing.ratePhpPer1000(s),
    })), limit);
  } catch (_) { return []; }
}

// Provider service names carry delivery specs and emoji ("· Instant · 100%
// NonDrop · Max: 1M 🚀"). That reads as spam in an inbox and makes four
// near-identical rows, so email keeps only the leading, meaningful part.
function displayName(raw) {
  let s = String(raw || '');
  s = s.split(/[|·]|\s[–—-]\s/)[0];
  s = s.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '');
  s = s.replace(/\s{2,}/g, ' ').trim().replace(/[,:;.\-]+$/, '');
  return s.slice(0, 46);
}

// Trims, de-duplicates by display name, and caps the list — so a digest shows
// variety instead of the same service four times at different refill periods.
function pickForEmail(items, limit) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const name = displayName(item.name);
    if (!name) continue;
    const key = `${item.platform}|${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item, name });
    if (out.length >= limit) break;
  }
  return out;
}

function servicesListHtml(items) {
  if (!items.length) return '';
  return `<ul style="margin:8px 0 0;padding-left:18px;color:#374151;">${items.map((s) =>
    `<li style="margin-bottom:5px;"><strong>${esc(s.platform)}</strong> — ${esc(s.name)}
      <span style="color:#047857;font-weight:bold;">${peso(s.ratePhp)} / 1,000</span></li>`).join('')}</ul>`;
}

function bonusHtml() {
  const tiers = bonusTierRows();
  if (!tiers.length) return '';
  return `
    <h3 style="margin:22px 0 6px;font-size:15px;color:#111827;">💰 Add funds &amp; get bonus credit</h3>
    <ul style="margin:6px 0 0;padding-left:18px;color:#374151;">
      ${tiers.map((t) => `<li style="margin-bottom:4px;">Top up ${peso(t.amount)} or more → <strong style="color:#047857;">+${t.pct}% bonus</strong></li>`).join('')}
    </ul>`;
}

function footerHtml(user) {
  return `<p style="margin:26px 0 0;color:#9ca3af;font-size:11px;line-height:1.5;">
    You're getting this because you have an ${esc(env.SITE_NAME)} account.
    <a href="${unsubUrl(user)}" style="color:#6b7280;">Unsubscribe from updates</a> — you'll still receive
    order, deposit and security emails.</p>`;
}

// ── 1) Welcome campaign ───────────────────────────────────
async function welcomeHtml(user) {
  const base = String(env.BASE_URL || `https://${env.SITE_DOMAIN}`).replace(/\/$/, '');
  const trending = await trendingServices(5);
  const [platRows] = await pool.query(
    'SELECT DISTINCT platform FROM services WHERE enabled = 1 AND deleted = 0 ORDER BY platform').catch(() => [[]]);
  const platforms = (platRows || []).map((r) => platformLabel(r.platform)).filter(Boolean);
  const [[counts]] = await pool.query(
    'SELECT COUNT(*) AS c FROM services WHERE enabled = 1 AND deleted = 0').catch(() => [[{ c: 0 }]]);

  return `
    <p>Great news — your ${esc(env.SITE_NAME)} account is ready. We help you grow your social media
       faster with fast, reliable services you can count on.</p>

    <h3 style="margin:22px 0 6px;font-size:15px;color:#111827;">⭐ Why ${esc(env.SITE_NAME)}?</h3>
    <ul style="margin:6px 0 0;padding-left:18px;color:#374151;">
      <li style="margin-bottom:4px;">${Number(counts.c).toLocaleString()} services across every major platform</li>
      <li style="margin-bottom:4px;">Instant, automated delivery — most orders start within minutes</li>
      <li style="margin-bottom:4px;">Failed or partial orders are <strong>auto-refunded</strong> in full</li>
      <li style="margin-bottom:4px;">Support in English and Tagalog, right inside your dashboard</li>
    </ul>

    ${bonusHtml()}

    <h3 style="margin:22px 0 6px;font-size:15px;color:#111827;">💳 Easy payment options</h3>
    <p style="margin:4px 0;color:#374151;">GCash · Maya · BPI</p>

    ${trending.length ? `<h3 style="margin:22px 0 6px;font-size:15px;color:#111827;">🔥 Popular right now</h3>
    ${servicesListHtml(trending)}` : ''}

    ${platforms.length ? `<h3 style="margin:22px 0 6px;font-size:15px;color:#111827;">📱 Platforms we support</h3>
    <p style="margin:4px 0;color:#374151;">${esc(platforms.join(' · '))}</p>` : ''}

    <h3 style="margin:22px 0 6px;font-size:15px;color:#111827;">🤝 Are you a reseller?</h3>
    <p style="margin:4px 0;color:#374151;">Plug our catalogue into your own panel with the
      <a href="${base}/api-docs" style="color:#1d4ed8;">API for resellers</a> — same prices, your brand.</p>

    <p style="margin:22px 0;"><a href="${base}/order/new"
      style="background:#1d4ed8;color:#ffffff;text-decoration:none;padding:12px 26px;border-radius:8px;font-weight:bold;display:inline-block;">Place your first order</a></p>

    ${footerHtml(user)}`;
}

// Sends the welcome email once per account, ever.
async function sendWelcome(userId) {
  if (!(await enabled())) return { sent: false, reason: 'disabled' };
  const [[user]] = await pool.query(
    `SELECT u.id, u.username, u.email, u.email_optout, u.email_verified, u.status
       FROM users u WHERE u.id = ?`, [userId]);
  if (!user || !user.email) return { sent: false, reason: 'no user' };
  if (user.email_optout) return { sent: false, reason: 'opted out' };
  // Mailing an unverified address earns bounces, which cost sender reputation
  // for every later message — so the welcome waits until the address is proven.
  if (!user.email_verified) return { sent: false, reason: 'not verified' };
  if (String(user.status || 'Active').toLowerCase() !== 'active') return { sent: false, reason: 'inactive account' };

  if (!(await claim(user.id, 'welcome', ''))) return { sent: false, reason: 'already sent' };
  try {
    const html = await welcomeHtml(user);
    const ok = await mailer.sendRaw(user.email,
      `🚀 Welcome to ${env.SITE_NAME} — bonus inside, ${user.username || 'friend'}!`,
      `Welcome aboard, ${user.username || 'friend'}! 👋`, html);
    if (!ok) await markFailed(user.id, 'welcome', '', 'SMTP not configured or send failed');
    return { sent: !!ok };
  } catch (err) {
    await markFailed(user.id, 'welcome', '', err.message);
    return { sent: false, reason: err.message };
  }
}

// ── 2) New-services digest ────────────────────────────────
// The campaign ref is derived from the data (the newest created_at in the
// batch), not from the clock. That is what makes an interrupted run resumable:
// the next pass recomputes the same window and therefore the same ref, so
// email_log correctly skips everyone already mailed.
async function pendingDigest() {
  const since = (await getSetting('last_service_digest_at')) || null;
  const params = [];
  let where = 's.enabled = 1 AND s.deleted = 0 AND s.created_at IS NOT NULL';
  if (since) { where += ' AND s.created_at > ?'; params.push(since); }
  else { where += ' AND s.created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)'; }

  const [rows] = await pool.query(
    `SELECT s.id, s.name, s.platform, s.category, s.rate_usd, s.markup_override, s.created_at
       FROM services s WHERE ${where}
      ORDER BY s.created_at DESC LIMIT 500`, params);
  if (!rows.length) return null;

  const newest = rows.reduce((m, r) => (r.created_at > m ? r.created_at : m), rows[0].created_at);
  return {
    ref: `svc-${new Date(newest).toISOString().slice(0, 19).replace('T', ' ')}`,
    watermark: newest,
    total: rows.length,
    services: rows.map((s) => ({
      name: tidyServiceName(s.name, s.id),
      platform: platformLabel(s.platform),
      category: tidyCategory(s.category),
      ratePhp: pricing.ratePhpPer1000(s),
    })),
  };
}

function digestHtml(user, batch) {
  const base = String(env.BASE_URL || `https://${env.SITE_DOMAIN}`).replace(/\/$/, '');
  const byPlatform = {};
  for (const s of batch.services) (byPlatform[s.platform] ||= []).push(s);
  // Feature a handful per platform; the full list lives on the site.
  const blocks = Object.entries(byPlatform).slice(0, 6).map(([plat, items]) => `
    <h3 style="margin:20px 0 4px;font-size:15px;color:#111827;">${esc(plat)}</h3>
    ${servicesListHtml(pickForEmail(items, 5))}`).join('');

  return `
    <p>We just added <strong>${batch.total}</strong> new service${batch.total === 1 ? '' : 's'} to
       ${esc(env.SITE_NAME)}. Here's a look at what's new:</p>
    ${blocks}
    ${batch.total > 30 ? `<p style="margin-top:14px;color:#6b7280;font-size:13px;">…and ${batch.total - 30} more.</p>` : ''}
    <p style="margin:22px 0;"><a href="${base}/services"
      style="background:#1d4ed8;color:#ffffff;text-decoration:none;padding:12px 26px;border-radius:8px;font-weight:bold;display:inline-block;">Browse all services</a></p>
    ${bonusHtml()}
    ${footerHtml(user)}`;
}

// One bounded pass. Returns what it did so the caller can log/report it.
async function runServiceDigest() {
  if (!(await enabled())) return { ran: false, reason: 'disabled' };
  if (!mailer.ready()) return { ran: false, reason: 'SMTP not configured' };

  const batch = await pendingDigest();
  if (!batch) return { ran: false, reason: 'nothing new' };
  if (batch.total < MIN_NEW_SERVICES) return { ran: false, reason: `only ${batch.total} new (min ${MIN_NEW_SERVICES})` };

  // Recipients who have not already been mailed THIS campaign.
  const [recipients] = await pool.query(
    `SELECT u.id, u.username, u.email
       ${RECIPIENT_SQL}
       AND NOT EXISTS (
         SELECT 1 FROM email_log e
          WHERE e.user_id = u.id AND e.kind = 'new_services' AND e.ref = ?)
     ORDER BY u.id LIMIT ?`, [batch.ref, BATCH_LIMIT]);

  let sent = 0; let failed = 0;
  for (const user of recipients) {
    if (!(await claim(user.id, 'new_services', batch.ref))) continue;
    try {
      const ok = await mailer.sendRaw(user.email,
        `${batch.total} new services just landed on ${env.SITE_NAME} ✨`,
        'Fresh services just added', digestHtml(user, batch));
      if (ok) sent += 1;
      else { failed += 1; await markFailed(user.id, 'new_services', batch.ref, 'send failed'); }
    } catch (err) {
      failed += 1;
      await markFailed(user.id, 'new_services', batch.ref, err.message);
    }
    if (SEND_GAP_MS) await sleep(SEND_GAP_MS);
  }

  // Any recipients left for this campaign? If not, close it out by moving the
  // watermark forward so the next batch of services starts a fresh campaign.
  const [[remainingRow]] = await pool.query(
    `SELECT COUNT(*) AS remaining
       ${RECIPIENT_SQL}
       AND NOT EXISTS (
         SELECT 1 FROM email_log e
          WHERE e.user_id = u.id AND e.kind = 'new_services' AND e.ref = ?)`, [batch.ref]);
  const remaining = Number(remainingRow.remaining);
  const complete = remaining === 0;
  if (complete) await setSetting('last_service_digest_at', new Date(batch.watermark).toISOString().slice(0, 19).replace('T', ' '));

  return { ran: true, ref: batch.ref, newServices: batch.total, sent, failed, remaining, complete };
}

// ── 3) Backfill: welcome mail for accounts that predate this feature ──
// Off by default. Turning it on mails existing verified customers once.
async function runWelcomeBackfill() {
  if (!(await enabled())) return { ran: false, reason: 'disabled' };
  if (String(await getSetting('email_welcome_backfill', 'off')).toLowerCase() !== 'on') {
    return { ran: false, reason: 'backfill off' };
  }
  if (!mailer.ready()) return { ran: false, reason: 'SMTP not configured' };

  const [users] = await pool.query(
    `SELECT u.id
       ${RECIPIENT_SQL}
       AND NOT EXISTS (SELECT 1 FROM email_log e WHERE e.user_id = u.id AND e.kind = 'welcome')
     ORDER BY u.id LIMIT ?`, [BATCH_LIMIT]);
  if (!users.length) {
    await setSetting('email_welcome_backfill', 'off'); // finished — don't keep scanning
    return { ran: false, reason: 'backfill complete' };
  }
  let sent = 0;
  for (const u of users) {
    const r = await sendWelcome(u.id);
    if (r.sent) sent += 1;
    if (SEND_GAP_MS) await sleep(SEND_GAP_MS);
  }
  return { ran: true, sent, scanned: users.length };
}

async function stats() {
  const [[tot]] = await pool.query(
    "SELECT COUNT(*) AS sent FROM email_log WHERE status = 'sent'").catch(() => [[{ sent: 0 }]]);
  const [[fail]] = await pool.query(
    "SELECT COUNT(*) AS failed FROM email_log WHERE status = 'failed'").catch(() => [[{ failed: 0 }]]);
  const [[subs]] = await pool.query(`SELECT COUNT(*) AS subscribers ${RECIPIENT_SQL}`).catch(() => [[{ subscribers: 0 }]]);
  const [[out]] = await pool.query('SELECT COUNT(*) AS optouts FROM users WHERE email_optout = 1').catch(() => [[{ optouts: 0 }]]);
  const [byKind] = await pool.query(
    "SELECT kind, COUNT(*) AS n, MAX(created_at) AS last_at FROM email_log GROUP BY kind ORDER BY n DESC").catch(() => [[]]);
  const pending = await pendingDigest().catch(() => null);
  return {
    sent: Number(tot.sent), failed: Number(fail.failed),
    subscribers: Number(subs.subscribers), optouts: Number(out.optouts),
    byKind: byKind || [],
    pendingNewServices: pending ? pending.total : 0,
    enabled: await enabled(),
    // Without SMTP nothing can leave the server, however healthy the rest
    // looks — surface it so an empty send log is explainable at a glance.
    smtpReady: mailer.ready(),
    minNewServices: MIN_NEW_SERVICES,
    batchLimit: BATCH_LIMIT,
    digestHours: Math.max(1, Number(env.EMAIL_DIGEST_HOURS) || 24),
  };
}

// ── scheduler ─────────────────────────────────────────────
// Independent of the autopilot: the owner may turn autopilot off and still
// want customer mail. Passenger can run several processes, and each would
// start its own timer — harmless here, because every send is claimed in
// email_log first, so a duplicate tick sends nothing twice.
let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const digest = await runServiceDigest();
    if (digest.ran) {
      console.log(`[campaigns] new-services digest ${digest.ref}: sent ${digest.sent}, failed ${digest.failed}, ${digest.remaining} left`);
    }
    const backfill = await runWelcomeBackfill();
    if (backfill.ran) console.log(`[campaigns] welcome backfill: sent ${backfill.sent}`);
  } catch (err) {
    console.warn('[campaigns] tick failed:', err.message);
  } finally {
    running = false;
  }
}

function startScheduler() {
  const hours = Math.max(1, Number(env.EMAIL_DIGEST_HOURS) || 24);
  setInterval(tick, hours * 60 * 60 * 1000).unref();
  setTimeout(tick, 90 * 1000).unref(); // first pass a little after boot
  console.log(`[campaigns] email automation on — checking every ${hours}h`);
}

module.exports = {
  sendWelcome, runServiceDigest, runWelcomeBackfill,
  unsubToken, verifyUnsub, stats, enabled, getSetting, setSetting,
  tick, startScheduler,
};
