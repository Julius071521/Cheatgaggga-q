# ApexBoost — SMM Boosting Panel

A complete social media boosting (SMM panel) website for **apexsmmboosting.com**:
services are imported from upstream SMM providers (RKD Panel, SMM World), priced
in Philippine pesos with a configurable markup, and paid for through a wallet
funded by manual **GCash / Maya / BPI** deposits.

Built with Node.js + Express + EJS + MySQL — everything is configured through
`.env`, nothing is hardcoded.

## Features

- 🎨 Animated landing page (scroll reveals, count-up stats, floating platform
  icons, parallax, tilt hero card, light/dark theme) — amazingsmm-style design
- 🔐 Email + password auth (verification emails, password reset), Google
  sign-in, Cloudflare Turnstile, rate limiting, CSRF protection
- 🛒 Multi-provider service catalog with automatic platform detection, search,
  filters, per-service markup overrides, soft-delete on provider removal
- 💰 PHP wallet: manual deposits with receipt upload → admin review queue →
  transactional crediting + full ledger
- 🚀 Orders: atomic wallet debit + provider dispatch, auto-refund on failure,
  status sync (single + batch) with automatic partial/cancel refunds
- 🧑‍💼 Admin panel: KPIs (revenue, cost, liabilities), deposits queue, orders,
  services manager, user management (adjust balance, ban), announcement banner
- 🔌 Reseller API (`POST /api/v2`) — standard SMM panel contract (services /
  add / status / balance) so others can resell your services
- 🤖 AI support chat widget backed by an OpenAI-compatible router (key stays
  server-side)

## Setup (fresh install)

```bash
cp .env.example .env         # fill in your real values
npm install
npm run migrate              # creates all tables
node src/db/seed.js admin@yourdomain.com "StrongPassword123"   # first admin
npm start                    # serves on PORT (default 3000)
```

## Setup on an EXISTING ApexBoost database

This build is designed to run against the existing production database
(users / orders / deposits / transactions are reused as-is). The migration is
**additive and non-destructive** — it never drops or recreates your data, it
only adds the support tables (`services`, `providers`, `settings`,
`ai_chat_logs`) and a few columns on `deposits`.

```bash
cp .env.example .env         # point DB_* at your existing database
npm install
npm run migrate              # additive only — safe on live data
npm start
```

- **Do not run the seed script** — your existing admin accounts (role
  `admin` / `super_admin`) already work. Existing users keep their passwords
  (bcrypt/pbkdf2); legacy plain-text accounts sign in via Google or the
  "forgot password" flow, exactly as before.
- Sign in as your admin, open **Admin → Services**, and hit the provider
  **Sync** buttons to populate the catalog.

## Cron jobs

```cron
*/5 * * * * cd /path/to/app && /usr/bin/node src/jobs/syncOrders.js >> logs/orders.log 2>&1
0 3 * * *   cd /path/to/app && /usr/bin/node src/jobs/syncServices.js >> logs/services.log 2>&1
```

`syncOrders` pulls status updates for open orders (and issues automatic
refunds); `syncServices` refreshes the catalog and provider balances.

## Deploying on cPanel

1. **Setup Node.js App** (Application Manager / Passenger): application root =
   this folder, startup file = `server.js`, Node 18+.
2. Create the MySQL database + user in cPanel and put the credentials in `.env`.
3. Run `npm install`, `npm run migrate`, and the seed command from the
   app's virtual-env shell (button in the Node.js App screen).
4. Add the two cron jobs above in cPanel → Cron Jobs (use the full node path
   shown in the Node.js App screen).
5. Point the domain at the app and make sure `BASE_URL=https://apexsmmboosting.com`.

## Environment notes

- `SERVICE_MARKUP_MULTIPLIER` and `USD_TO_PHP_RATE` control pricing — change
  them anytime and restart; no code edits needed.
- `TURNSTILE_SITE_KEY` **and** `TURNSTILE_SECRET_KEY` are both needed for the
  captcha; if either is missing the captcha is skipped automatically.
- Uploaded receipts are stored outside the web root (`uploads/receipts`) and
  served only to the owner and admins.
- Never commit `.env` — it is gitignored. Rotate any credential that has ever
  been shared in chats, screenshots, or commits.
