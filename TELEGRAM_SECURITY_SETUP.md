# ApexBoost — Telegram Security Bot Setup (5 minutes)

Your site now has a **Threat Radar** that detects scanners/attackers and can
alert you on Telegram with one-tap **Block / Allow** buttons. Follow these
steps once to turn on the phone alerts.

> Use a **NEW, separate bot** for this — don't reuse your OpenClaw bot. That
> keeps the two from fighting over the same Telegram connection.

## 1. Create the bot
1. Open Telegram, search **@BotFather**.
2. Send `/newbot`, pick a name (e.g. `ApexBoost Security`) and a username
   ending in `bot` (e.g. `apexboost_sec_bot`).
3. BotFather replies with a **token** like `8123456789:AAH...`. Copy it.

## 2. Get your chat id
1. Open your new bot and press **Start** (send it any message).
2. Search **@userinfobot**, press Start — it replies with your numeric **Id**
   (e.g. `5566778899`). That's your `TELEGRAM_ADMIN_CHAT_ID`.

## 3. Make a webhook secret
Any long random string. On your PC/VPS: `openssl rand -hex 24`
(or just mash 40+ random letters/numbers — no spaces).

## 4. Add to your environment
In cPanel → **Setup Node.js App → Environment variables** (or your `.env`):

```
TELEGRAM_BOT_TOKEN=8123456789:AAH...your-token...
TELEGRAM_ADMIN_CHAT_ID=5566778899
TELEGRAM_WEBHOOK_SECRET=your-long-random-string
```

Leave the `SECURITY_*` values at their defaults unless you want to tune them.

## 5. Restart the app
Restart the Node.js app in cPanel. On boot it will:
- Register the Telegram webhook automatically (needs your site on **https**).
- Send you a **"🟢 ApexBoost security is online"** message.

If you don't get that message, double-check the token/chat-id, and that the
site is reachable at `https://apexsmmboosting.com`.

## What you'll get
- 🚨 An alert whenever a scanner/attacker hits the site, showing the IP, what
  they tried, a threat score, and their recent requests.
- Buttons on each alert: **🚫 Block · ✅ Allow · 👁 Watch · ℹ️ Details** —
  tapping Block bans the IP instantly (same list as `/admin/ips`).
- Everything is also on the web at **Admin → 🛡️ Security**, including on/off
  and an **auto-block** switch that bans obvious attackers for you.

## Tuning (optional, in env)
| Variable | Default | Meaning |
|---|---|---|
| `SECURITY_ALERT_SCORE` | 40 | Score that triggers a Telegram alert |
| `SECURITY_AUTOBLOCK_SCORE` | 120 | Score that auto-blocks (when auto-block is ON) |
| `SECURITY_ALERT_COOLDOWN_MIN` | 30 | Minutes between repeat alerts for the same IP |
| `SECURITY_404_THRESHOLD` | 15 | 404s per minute from one IP = scanning |
| `SECURITY_FLOOD_THRESHOLD` | 150 | Requests per minute from one IP = flood |

## Connecting your existing OpenClaw / VPS (optional)
Your site also exposes a reseller API at `/api/v2` (balance, order status).
If you want OpenClaw to answer questions with live data, give it your admin
`api_key` (from **Settings**) and point it at
`https://apexsmmboosting.com/api/v2`. The security bot above does **not** need
the VPS at all — it runs entirely inside the website.
