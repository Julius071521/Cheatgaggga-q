# ApexBoost — SMM Boosting Website: Master Build Prompt + Implementation Plan

> Copy-paste ang **Section 1 (Master Prompt)** sa AI coding agent (Claude Code, Cursor, etc.)
> para i-build ang buong site. Ang **Section 2 (Implementation Plan)** ang phased roadmap
> na susundin ng agent (o mo) habang nagde-develop.
>
> Reference design: https://amazingsmm.com — goal ay **kahawig na look & feel at animations**,
> pero original branding (**ApexBoost / apexsmmboosting.com**), hindi kopya ng content.

---

## SECTION 1 — MASTER BUILD PROMPT

```
You are building a complete, production-ready SMM (Social Media Marketing) panel
website called "ApexBoost" (domain: apexsmmboosting.com), targeted at Philippine
customers. It resells services from upstream SMM provider APIs and accepts local
manual payments (GCash / Maya / BPI). The design and animation style should feel
similar to amazingsmm.com but with original branding, copy, and layout details.

════════════════════════════════════════════
TECH STACK (cPanel/shared-hosting friendly)
════════════════════════════════════════════
- Backend: Node.js 20 + Express
- Views: EJS server-rendered pages + vanilla JS (no SPA framework needed)
- DB: MySQL (mysql2/promise, connection pool)
- Auth: express-session + JWT for API tokens; bcrypt password hashing;
  Google OAuth (passport-google-oauth20); Cloudflare Turnstile on auth forms
- Email: nodemailer over SMTP (SSL port 465, custom TLS servername)
- Animations: GSAP + ScrollTrigger (CDN) for scroll reveals, animated counters,
  floating icons; CSS transitions for hovers; prefers-reduced-motion respected
- Styling: hand-written CSS with CSS custom properties (design tokens),
  light + dark theme via [data-theme] attribute, Poppins/Inter from Google Fonts
- All configuration comes from a .env file loaded with dotenv. NEVER hardcode
  secrets. Ship a .env.example with placeholders. Add .env to .gitignore.

════════════════════════════════════════════
ENVIRONMENT VARIABLES (already provisioned — read from process.env)
════════════════════════════════════════════
AI assistant (OpenAI-compatible router): AI_API_KEY, AI_MODEL, AI_BASE_URL
Upstream SMM providers (both speak the standard SMM Panel API v2):
  RKD_API_KEY, RKD_API_URL
  SMMWORLD_API_KEY, SMMWORLD_API_URL,
  SMMWORLD_IMPORT_SERVICE_IDS, SMMWORLD_IMPORT_KEYWORDS (optional import filters)
Pricing: SERVICE_MARKUP_MULTIPLIER (e.g. 2.50), USD_TO_PHP_RATE (e.g. 60.2898)
MySQL: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
SMTP: EMAIL_HOST, EMAIL_PORT, EMAIL_SECURE, EMAIL_TLS_SERVERNAME, EMAIL_USER,
  EMAIL_PASS, EMAIL_FROM_NAME, EMAIL_FROM, SUPPORT_EMAIL
Manual payments: GCASH_ACCOUNT_NUMBER, GCASH_ACCOUNT_NAME, MAYA_ACCOUNT_NUMBER,
  MAYA_ACCOUNT_NAME, BPI_ACCOUNT_NUMBER, BPI_ACCOUNT_NAME, BPI_ACCOUNT_TYPE
Auth/security: JWT_SECRET, SESSION_SECRET, EMAIL_VERIFICATION_REQUIRED,
  TURNSTILE_REQUIRED, TURNSTILE_SECRET_KEY
Google OAuth: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL
Hermes ops agent (Telegram): HERMES_AGENT_ENABLED, HERMES_AGENT_NAME,
  HERMES_TELEGRAM_BOT_TOKEN, HERMES_TELEGRAM_CHAT_ID,
  HERMES_TELEGRAM_WEBHOOK_SECRET, HERMES_TELEGRAM_AUTO_WEBHOOK
Hermes bridge/firewall: HERMES_BRIDGE_ENABLED, HERMES_BRIDGE_TOKEN,
  HERMES_BRIDGE_TRUSTED_IPS, HERMES_APP_FIREWALL_ENABLED,
  HERMES_APP_FIREWALL_AUTO_BLOCK, HERMES_OWNER_IPS, HERMES_FIREWALL_TRUSTED_IPS
OpenClaw site-help agent: OPENCLAW_AGENT_ENABLED, OPENCLAW_API_URL,
  OPENCLAW_API_TOKEN, OPENCLAW_TIMEOUT_MS, OPENCLAW_TRUSTED_HOSTS,
  OPENCLAW_REPLY_LIMIT, OPENCLAW_REPLY_WINDOW_MS

════════════════════════════════════════════
DESIGN SPEC (amazingsmm-style)
════════════════════════════════════════════
Overall feel: modern, trustworthy, conversion-focused. Blue/teal primary palette
with green accents for growth metrics; white/light-gray surfaces in light mode,
deep navy surfaces in dark mode. Poppins for headings, Inter for body. Rounded
cards (16px radius), soft layered shadows, subtle gradient overlays.

Landing page sections, in order:
1. Sticky navbar — logo, links (Services, How it works, FAQ, Blog), theme
   toggle, live mini-stats (Orders / Users / Services counts pulled from DB),
   Sign in + Sign up buttons. Navbar gains blur+shadow after scrolling.
2. Hero — big headline ("Cheapest & Fastest SMM Panel in the Philippines"
   vibe, original copy), social-proof line ("X,XXX+ members"), benefit chips
   (instant delivery, ₱ pricing, GCash/Maya/BPI, 24/7 support), primary CTA.
   Background: animated gradient mesh + floating platform icons (IG, TikTok,
   FB, YT, Twitter/X, Telegram, Spotify) drifting with GSAP yoyo tweens.
   A mock "phone dashboard" card animates follower/like counters climbing.
3. Stats strip — animated count-up numbers on scroll (total orders, users,
   services, avg. start time). GSAP ScrollTrigger + number tween.
4. How it works — 3 steps (Sign up → Add funds → Place order) as cards with
   icons, staggered fade-up reveal, connecting dashed line that draws itself
   (SVG stroke-dashoffset animation).
5. Why choose us / Features grid — 6–8 feature cards (cheap prices, instant
   delivery, PHP currency, local payments, API for resellers, 24/7 support,
   secure, no password needed). Hover: lift + glow border.
6. Popular services showcase — cards per platform showing live lowest price
   per 1000 (from DB), star rating, "Order now" button, and a collapsible
   mini-FAQ under each (accordion animation).
7. Comparison table — "Other panels" vs "ApexBoost" two-column checklist.
8. Testimonials — carousel/grid of review cards with masked names, star
   ratings, verified badge.
9. FAQ — accordion, 10–12 questions (what is an SMM panel, is it safe,
   delivery time, refill/refund policy, payment methods, etc.).
10. Final CTA band — gradient background, "Join ApexBoost today" + button.
11. Footer — logo, quick links, payment method badges (GCash, Maya, BPI),
    support email, legal disclaimer, © year.

Animation rules:
- Scroll reveals: fade-up with 40px offset, 0.6s ease-out, stagger 0.1s.
- Counters: animate integer count-up once when scrolled into view.
- Floating icons: slow 6–10s alternating y/rotation tweens, parallax on mouse.
- Buttons: 150ms transform scale(1.03) + shadow on hover; ripple optional.
- Accordions: height auto-animate with max-height/grid-template-rows trick.
- Everything gated behind matchMedia('(prefers-reduced-motion: reduce)').

════════════════════════════════════════════
FUNCTIONAL REQUIREMENTS
════════════════════════════════════════════

A. AUTH & ACCOUNTS
- Register with email + password: Turnstile verification (server-side check
  against TURNSTILE_SECRET_KEY, skippable when TURNSTILE_REQUIRED=false),
  email verification link (24h token) when EMAIL_VERIFICATION_REQUIRED=true.
- Login with email/password or "Continue with Google" (auto-verified email).
- Forgot/reset password via email. Session cookie (httpOnly, sameSite=lax,
  secure in production). Rate-limit auth endpoints.
- Roles: user, admin. Seed the first admin via a CLI script.

B. SERVICE CATALOG (multi-provider)
- Provider adapter layer: one client for the standard SMM Panel API v2
  (POST form fields: key, action=services|add|status|balance|refill).
  Instantiate for RKD and SMMWorld from env. Adding a third provider must be
  config-only.
- Import/sync job (admin-triggered + cron-able CLI): fetch provider services,
  filter SMMWorld by SMMWORLD_IMPORT_SERVICE_IDS / SMMWORLD_IMPORT_KEYWORDS
  when set, upsert into local `services` table with category and platform
  detection (Instagram/TikTok/etc. from name/category keywords).
- Selling price = provider_rate_usd × SERVICE_MARKUP_MULTIPLIER ×
  USD_TO_PHP_RATE, displayed in ₱ per 1000. Store both provider cost and
  selling price snapshots on each order.
- Public services page: searchable, filterable by platform/category table
  with min/max quantity, rate per 1000, avg time; deep-links to order form.

C. WALLET & MANUAL PAYMENTS (PHP)
- Each user has a PHP wallet balance (DECIMAL(12,2), never floats).
- "Add funds" page shows GCash / Maya / BPI account details from env with
  copy buttons and step-by-step instructions.
- User submits a deposit request: method, amount, reference number, optional
  receipt screenshot upload (multer, images only, 5MB max, stored outside
  web root or with randomized names).
- Admin reviews deposits (approve → credit wallet inside a DB transaction;
  reject with reason). Email + Hermes Telegram notification on both events.
- Full wallet ledger (transactions table) for every credit/debit.

D. ORDERS
- New order flow: pick service → enter link + quantity (validated against
  service min/max) → live price preview → confirm. Debit wallet and create
  provider order atomically; on provider API failure, auto-refund and mark
  failed.
- Status sync: cron-able job + manual "refresh" that calls provider
  action=status (batch where supported), maps provider statuses to local
  ones (pending, in_progress, processing, completed, partial, canceled,
  refunded). Partial/canceled auto-refunds the unspent remains per the
  provider's remains field.
- Order history page with status badges, charges, start counts, remains.

E. USER DASHBOARD
- Overview cards (balance, total orders, spent), quick order form, recent
  orders, deposits list, account settings (password change, API key for
  resellers with a documented /api/v2 endpoint that mirrors the standard
  SMM panel API so resellers can plug ApexBoost in as their provider).

F. ADMIN PANEL (/admin, role-gated)
- Dashboard KPIs (revenue, profit = selling − cost, pending deposits count,
  orders today), users table (search, adjust balance with reason, ban),
  deposits queue, orders table (with provider order id, resend/status
  check), services manager (enable/disable, per-service markup override,
  re-sync from providers), settings viewer (read-only env summary, secrets
  masked), broadcast/announcement banner editor.

G. AI SUPPORT ASSISTANT
- Floating chat widget on all pages. Backend proxies to the OpenAI-compatible
  router (AI_BASE_URL + /chat/completions, model AI_MODEL, bearer AI_API_KEY)
  — the key NEVER reaches the browser. System prompt embeds site knowledge
  (services, pricing model, payment steps, FAQ) and refuses off-topic use.
  Rate-limit per user/IP. If OPENCLAW_AGENT_ENABLED=true, first try the
  OpenClaw help endpoint (POST OPENCLAW_API_URL with bearer
  OPENCLAW_API_TOKEN, timeout OPENCLAW_TIMEOUT_MS, max OPENCLAW_REPLY_LIMIT
  replies per OPENCLAW_REPLY_WINDOW_MS per user) and fall back to the router.

H. HERMES OPS AGENT (Telegram)
- When HERMES_AGENT_ENABLED=true: send Telegram messages (bot token + chat
  id from env) for: new deposit submitted, deposit approved/rejected, order
  failed/refunded, new user registered, low provider balance (check on
  sync), and app errors. If HERMES_TELEGRAM_AUTO_WEBHOOK=true, register the
  webhook on boot with the secret token; expose the webhook route validated
  by HERMES_TELEGRAM_WEBHOOK_SECRET so the owner can run simple commands
  (/stats, /pending, /approve <id>) from Telegram — only from
  HERMES_TELEGRAM_CHAT_ID.
- App firewall middleware when HERMES_APP_FIREWALL_ENABLED=true: track
  suspicious activity (auth brute force, payload probes); IPs in
  HERMES_OWNER_IPS / HERMES_FIREWALL_TRUSTED_IPS are always allowed; only
  auto-block when HERMES_APP_FIREWALL_AUTO_BLOCK=true, otherwise just alert
  via Telegram. Bridge endpoints (status/health, block/unblock) require
  bearer HERMES_BRIDGE_TOKEN and a source IP in HERMES_BRIDGE_TRUSTED_IPS.

I. SECURITY & QUALITY BASELINE
- helmet, CORS locked to own origin, express-rate-limit, input validation
  (zod or express-validator) on every route, parameterized SQL only,
  CSRF protection on session forms, XSS-escaped EJS output by default,
  secrets never logged, uploads validated by magic bytes, admin routes
  double-checked server-side. Trust proxy configured for real client IPs.
- Money math in integer centavos or DECIMAL — never binary floats.
- Graceful degradation: if a provider or the AI router is down, the site
  still works; failures alert Hermes.

DELIVERABLES
- Complete runnable app: `npm install && npm run migrate && npm start`.
- SQL migrations (plain .sql files + a tiny runner) for all tables.
- Seed script (admin user, sample announcement).
- .env.example with every variable and placeholder values.
- README with setup, cron setup (status sync + service sync), and cPanel
  deployment notes (Node app via Passenger/Application Manager).
```

---

## SECTION 2 — IMPLEMENTATION PLAN

### Phase 0 — Project scaffold (Day 1)
- [ ] `npm init`, install: express, ejs, mysql2, dotenv, bcrypt, express-session,
      passport + passport-google-oauth20, nodemailer, multer, helmet,
      express-rate-limit, zod (or express-validator), node-cron (optional)
- [ ] Folder layout:
  ```
  src/
    config/env.js          # validates + exports all env vars at boot
    db/ (pool.js, migrations/*.sql, migrate.js, seed.js)
    providers/ (smmApiClient.js, index.js)   # RKD + SMMWorld adapters
    services/ (pricing.js, catalogSync.js, orders.js, wallet.js,
               mailer.js, ai.js, openclaw.js, hermes/ (telegram.js, firewall.js, bridge.js))
    middleware/ (auth.js, admin.js, rateLimit.js, turnstile.js, firewall.js, csrf.js)
    routes/ (public.js, auth.js, dashboard.js, orders.js, wallet.js,
             admin.js, api-v2.js, ai.js, hermes.js)
    views/ (layouts, partials, pages...)
  public/ (css/, js/, img/, uploads/ NOT here — keep uploads outside web root)
  ```
- [ ] `.gitignore` (.env, node_modules, uploads), `.env.example`
- [ ] Env validation: crash loudly on missing required vars, warn on optional

### Phase 1 — Database (Day 1–2)
Tables (InnoDB, utf8mb4):
- `users` (id, email, password_hash NULL for Google-only, name, google_id,
  role ENUM('user','admin'), balance DECIMAL(12,2) DEFAULT 0, api_key,
  email_verified_at, banned_at, created_at)
- `email_tokens` (user_id, token, purpose ENUM('verify','reset'), expires_at)
- `providers` (id, code 'rkd'|'smmworld', name, api_url, balance_usd, synced_at)
- `services` (id, provider_id, provider_service_id, platform, category, name,
  type, rate_usd DECIMAL(12,6), min, max, refill BOOL, cancel BOOL,
  markup_override DECIMAL(6,2) NULL, enabled BOOL, UNIQUE(provider_id, provider_service_id))
- `orders` (id, user_id, service_id, provider_order_id, link, quantity,
  charge_php DECIMAL(12,2), cost_usd DECIMAL(12,6), status ENUM(...),
  start_count, remains, error TEXT, created_at, updated_at)
- `deposits` (id, user_id, method ENUM('gcash','maya','bpi'), amount_php,
  reference_no, receipt_path, status ENUM('pending','approved','rejected'),
  admin_note, reviewed_by, reviewed_at, created_at)
- `transactions` (id, user_id, type ENUM('deposit','order','refund','adjustment'),
  amount_php signed, balance_after, ref_table, ref_id, note, created_at)
- `firewall_events` / `blocked_ips`, `announcements`, `ai_chat_logs`
- Migration runner executes `migrations/*.sql` in order, records in `_migrations`.

### Phase 2 — Auth (Day 2–3)
- Register/login/logout, Turnstile server verify, email verification flow,
  password reset, Google OAuth (link by email if account exists),
  session hardening, auth rate limits, admin seed script.

### Phase 3 — Provider layer + catalog (Day 3–4)
- Generic SMM v2 client: `services() / add() / status() / multiStatus() / balance()`
  via `application/x-www-form-urlencoded` POST; timeouts + retries; never log keys.
- Catalog sync with platform detection + SMMWorld import filters.
- Pricing helper: `phpPer1000 = rate_usd * (markup_override ?? SERVICE_MARKUP_MULTIPLIER) * USD_TO_PHP_RATE`
  (round UP to 2 decimals). Charge = phpPer1000 × qty / 1000, round up.
- Public `/services` page with search/filter.

### Phase 4 — Wallet + manual payments (Day 4–5)
- Add-funds page (env account details, copy buttons, instructions per method),
  deposit submission with receipt upload, admin approval queue,
  transactional wallet credit + ledger, emails + Hermes alerts.

### Phase 5 — Orders (Day 5–6)
- Order form with live ₱ preview, atomic place-order (debit → provider add →
  commit; refund on failure), status sync job + per-order refresh,
  partial/cancel refund math from `remains`, order history UI.

### Phase 6 — Landing page + design system (Day 6–8)
- Design tokens CSS (colors, radii, shadows, spacing; light/dark),
  all 11 landing sections per the design spec, GSAP ScrollTrigger reveals,
  count-up stats fed by real DB counts, floating hero icons, accordions,
  responsive down to 360px, Lighthouse pass (defer GSAP, lazy images,
  preconnect fonts), `prefers-reduced-motion` fallbacks.

### Phase 7 — Dashboards (Day 8–10)
- User dashboard (overview, quick order, deposits, settings, reseller API key)
- Reseller API `/api/v2` (standard SMM panel contract: key + action fields)
- Admin panel (KPIs, users, deposits queue, orders, services manager,
  announcements)

### Phase 8 — AI assistant + Hermes + OpenClaw (Day 10–12)
- Chat widget + backend proxy (router first via OpenClaw when enabled,
  fallback to AI_BASE_URL router), knowledge-grounded system prompt,
  per-user rate limits, chat logging.
- Hermes Telegram notifier + webhook commands + firewall middleware +
  bridge endpoints (token + trusted-IP gated).

### Phase 9 — Hardening + deploy (Day 12–14)
- helmet/CSRF/validation sweep, upload security, error pages (404/500),
  request logging, backup notes, README + cPanel deployment guide
  (Node app setup, cron entries for `node src/jobs/syncOrders.js` every
  5 min and `syncServices.js` daily), smoke-test checklist.

---

## ⚠️ SECURITY NOTES (basahin!)

1. **Huwag i-commit ang totoong `.env`** — nasa `.gitignore` dapat. Ang
   `.env.example` lang (placeholders) ang pinupush sa repo.
2. Ang mga **API keys, DB password, SMTP password, bot token, at OAuth secret**
   na na-share sa chat/prompts ay ituring nang exposed — **i-rotate/palitan**
   ang mga ito bago mag-production (provider dashboards, Google Cloud Console,
   Telegram @BotFather /revoke, cPanel email password, DB password).
3. Ang `SERVICE_MARKUP_MULTIPLIER` at `USD_TO_PHP_RATE` ay env-config —
   pwedeng baguhin anumang oras nang walang code change (restart lang).
