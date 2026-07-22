'use strict';
const express = require('express');
const pool = require('../db/pool');
const pricing = require('../services/pricing');
const { siteStats, popularServices, getSetting } = require('../services/stats');
const { clampInt, PLATFORM_LABELS } = require('../utils/helpers');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const [stats, showcase, announcement, reviewData] = await Promise.all([
      siteStats(), popularServices(), getSetting('announcement', ''), loadReviews(),
    ]);
    res.render('home', {
      title: null,
      stats,
      showcase: showcase.map((s) => ({ ...s, ratePhp: pricing.ratePhpPer1000(s) })),
      announcement,
      reviews: reviewData.reviews,
      reviewAvg: reviewData.avg,
      reviewCount: reviewData.count,
    });
  } catch (err) { next(err); }
});

// Real customer reviews for the homepage (masked names, visible only).
async function loadReviews() {
  try {
    const [[agg]] = await pool.query("SELECT COUNT(*) AS c, AVG(rating) AS a FROM reviews WHERE status = 'visible'");
    const [rows] = await pool.query(
      `SELECT r.rating, r.body, r.created_at, u.username, o.service_name
       FROM reviews r JOIN users u ON u.id = r.user_id JOIN orders o ON o.id = r.order_id
       WHERE r.status = 'visible' AND r.body IS NOT NULL AND CHAR_LENGTH(r.body) >= 3
       ORDER BY r.id DESC LIMIT 6`);
    const mask = (n) => { const s = String(n || 'Member'); return s.length <= 2 ? s[0] + '***' : s[0] + '***' + s[s.length - 1]; };
    return {
      count: agg.c || 0,
      avg: agg.a ? Number(agg.a).toFixed(1) : null,
      reviews: rows.map((r) => ({ name: mask(r.username), rating: r.rating, body: r.body, service: r.service_name, date: r.created_at })),
    };
  } catch (_) { return { count: 0, avg: null, reviews: [] }; }
}

router.get('/services', async (req, res, next) => {
  try {
    const platform = Object.prototype.hasOwnProperty.call(PLATFORM_LABELS, String(req.query.platform))
      ? String(req.query.platform) : '';
    const q = String(req.query.q || '').trim().slice(0, 100);
    const page = clampInt(req.query.page, 1, 10000) || 1;
    const perPage = 50;

    const where = ['enabled = 1', 'deleted = 0'];
    const params = [];
    if (platform) { where.push('platform = ?'); params.push(platform); }
    if (q) { where.push('(name LIKE ? OR category LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM services WHERE ${where.join(' AND ')}`, params);
    const pages = Math.max(1, Math.ceil(total / perPage));
    const current = Math.min(page, pages);

    const [services] = await pool.query(
      `SELECT * FROM services WHERE ${where.join(' AND ')}
       ORDER BY platform, category, rate_usd ASC LIMIT ? OFFSET ?`,
      [...params, perPage, (current - 1) * perPage]
    );

    const [platformRows] = await pool.query(
      "SELECT platform, COUNT(*) AS cnt FROM services WHERE enabled = 1 AND deleted = 0 GROUP BY platform ORDER BY cnt DESC"
    );

    res.render('services', {
      title: 'Services & Pricing',
      services: services.map((s) => ({ ...s, ratePhp: pricing.ratePhpPer1000(s) })),
      platforms: platformRows,
      filter: { platform, q },
      pagination: { current, pages, total },
    });
  } catch (err) { next(err); }
});

// Language switch: set a cookie and return to the previous page.
router.get('/lang/:code', (req, res) => {
  const code = req.params.code === 'fil' ? 'fil' : 'en';
  res.setHeader('Set-Cookie', `lang=${code}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`);
  const back = req.get('referer');
  res.redirect(back && back.startsWith(`${req.protocol}://${req.get('host')}`) ? back : '/');
});

router.get('/terms', (req, res) => res.render('terms', { title: 'Terms of Service' }));
router.get('/api-docs', (req, res) => res.render('api-docs', { title: 'API Documentation' }));

// ── SEO: robots + sitemap ──
router.get('/robots.txt', (req, res) => {
  const base = (require('../config/env').BASE_URL || `https://${req.get('host')}`).replace(/\/$/, '');
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /dashboard\nDisallow: /wallet\nDisallow: /settings\nDisallow: /support\nSitemap: ${base}/sitemap.xml\n`);
});
router.get('/sitemap.xml', (req, res) => {
  const base = (require('../config/env').BASE_URL || `https://${req.get('host')}`).replace(/\/$/, '');
  const pages = ['/', '/services', '/api-docs', '/terms', '/register', '/login'];
  const urls = pages.map((p) => `  <url><loc>${base}${p}</loc><changefreq>weekly</changefreq></url>`).join('\n');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
});

module.exports = router;
