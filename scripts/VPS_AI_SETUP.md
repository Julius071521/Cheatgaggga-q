# Self-hosted AI on your VPS (Ollama)

Run your own AI on the VPS so the website (and the Telegram admin agent) can use
it instead of the paid DeepSeek API. Secure by default: the AI is only reachable
over HTTPS with a secret token.

**Model:** `llama3.1:8b` is the primary — it supports **tool-calling**, which the
Telegram admin agent needs. `deepseek-r1:7b` is pulled too (a reasoning model,
optional). An 8B model needs ~6–8 GB RAM and answers in ~5–15s on CPU.

## Steps

### 1) Point a subdomain at the VPS
In Cloudflare DNS add an **A record**:

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| A | `ai` | `<your VPS IP>` | **DNS only** (grey cloud) |

Grey cloud lets the VPS get its own HTTPS certificate. (You can switch to proxied later.)

### 2) Run the setup script on the VPS
Copy `vps-ai-setup.sh` to the VPS (or paste it), then:

```bash
sudo AI_DOMAIN=ai.apexsmmboosting.com bash vps-ai-setup.sh
```

It installs Ollama (localhost only), downloads the model(s), puts a
token-protected HTTPS gateway (Caddy) in front, and turns on the firewall.
When it finishes it prints your **AI_BASE_URL / AI_API_KEY / AI_MODEL**.

### 3) Point the website at your VPS
On cPanel, edit the website `.env` with the three values the script printed:

```
AI_BASE_URL=https://ai.apexsmmboosting.com/v1
AI_API_KEY=<the secret token the script generated>
AI_MODEL=llama3.1:8b
```

Restart the Node app (cPanel → Setup Node.js App → Restart). Done — the site now
uses your VPS AI. Message the Telegram bot to confirm.

## Good to know
- **Keep `AI_API_KEY` secret** — it's the only guard on your AI endpoint.
- First reply after idle is slower (model loads into RAM), then it stays warm 24h.
- **Switch back to DeepSeek anytime** by restoring the old `AI_*` values in `.env`.
- Check status on the VPS: `systemctl status ollama caddy` · logs: `journalctl -u caddy -f`.
- Change model later: `ollama pull llama3.2:3b` (smaller/faster) then set `AI_MODEL`.
