# ApexBoost — Cloudflare Edge Blocking Setup

Connect your site to Cloudflare so it can **block attackers at the edge**
(before they ever reach your server) and **show you what Cloudflare's firewall
is stopping**. Every Block you press in Telegram or the admin panel will then
also block that IP at Cloudflare.

## 1. Get your Zone ID
1. Log in to https://dash.cloudflare.com
2. Click your domain **apexsmmboosting.com**.
3. On the **Overview** page, scroll down the right side to **API** → copy the
   **Zone ID**. That's your `CLOUDFLARE_ZONE_ID`.

## 2. Create a scoped API token (safe — limited permissions)
1. Go to https://dash.cloudflare.com/profile/api-tokens → **Create Token**.
2. Click **Create Custom Token** (Get started).
3. Name: `ApexBoost Security`.
4. **Permissions** — add these rows:
   - **Zone** → **Firewall Services** → **Edit**
   - **Zone** → **Analytics** → **Read**   *(so you can see what CF blocked)*
5. **Zone Resources**: Include → Specific zone → **apexsmmboosting.com**.
6. Continue → **Create Token** → **copy the token** (shown once).

> Only these two permissions on one zone — it can block/unblock IPs and read
> analytics, nothing else. If it ever leaks, roll it from the same page.

## 3. Add to your environment
In cPanel → **Setup Node.js App → Environment variables** (or `.env`):

```
CLOUDFLARE_API_TOKEN=your-token-here
CLOUDFLARE_ZONE_ID=your-zone-id-here
```

## 4. Restart the app
Restart the Node.js app. Then open **Admin → 🛡️ Security** — the
**☁️ Cloudflare edge** panel should say **Connected ✅** and list what
Cloudflare has blocked in the last 24h.

## What changes after this
- Pressing **🚫 Block** (in Telegram or the admin panel) blocks the IP at the
  **Cloudflare edge** as well as in the app — the attacker is stopped before
  reaching your server.
- Pressing **✅ Allow / Unblock** removes the edge block too.
- The Security page shows the IPs Cloudflare's WAF is blocking, with country
  and the path they tried.

Nothing breaks if the token is missing or wrong — the app just falls back to
its own blocklist and shows "Not connected".
