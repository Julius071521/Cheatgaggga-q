#!/usr/bin/env bash
#
# ApexBoost — self-hosted AI on your VPS (Ollama + secure HTTPS gateway).
# Run this ONCE on your VPS as root (Ubuntu/Debian):
#
#     sudo AI_DOMAIN=ai.apexsmmboosting.com bash vps-ai-setup.sh
#
# What it sets up (secure by default):
#   • Ollama running on 127.0.0.1 only (NOT exposed to the internet)
#   • Models: llama3.1:8b  (best for the admin agent — supports tool-calling)
#             deepseek-r1:7b (reasoning model, optional)
#   • Caddy reverse proxy on https://$AI_DOMAIN with a SECRET TOKEN + auto TLS
#   • UFW firewall: only SSH + HTTP/HTTPS open; the AI port stays private
#
# BEFORE running: add a DNS record for the subdomain pointing to this VPS's IP.
#   In Cloudflare: A  ai  <THIS_VPS_IP>  — set it to "DNS only" (grey cloud),
#   so Caddy can get a Let's Encrypt certificate. You can switch to proxied later.
#
set -euo pipefail

# ── Settings ────────────────────────────────────────────────────────────────
AI_DOMAIN="${AI_DOMAIN:-}"                       # required, e.g. ai.apexsmmboosting.com
PRIMARY_MODEL="${PRIMARY_MODEL:-llama3.1:8b}"    # used by the site
EXTRA_MODEL="${EXTRA_MODEL:-deepseek-r1:7b}"     # optional second model ("none" to skip)
AI_TOKEN="${AI_TOKEN:-$(openssl rand -hex 24)}"  # auto-generated if not provided

if [[ -z "$AI_DOMAIN" ]]; then
  echo "ERROR: set AI_DOMAIN, e.g.  sudo AI_DOMAIN=ai.apexsmmboosting.com bash vps-ai-setup.sh" >&2
  exit 1
fi
if [[ $EUID -ne 0 ]]; then echo "Please run as root (use sudo)." >&2; exit 1; fi

echo "==> RAM check"
TOTAL_MB=$(free -m | awk '/Mem:/{print $2}')
echo "    Total RAM: ${TOTAL_MB} MB"
if (( TOTAL_MB < 7000 )); then
  echo "    ⚠️  WARNING: an 8B model needs ~6–8 GB free. With ${TOTAL_MB} MB it may swap or OOM."
  echo "       Consider a smaller model (llama3.2:3b) or add swap. Continuing in 5s…"; sleep 5
fi

echo "==> Base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl gnupg debian-keyring debian-archive-keyring apt-transport-https ufw

# ── Ollama (bound to localhost only) ────────────────────────────────────────
if ! command -v ollama >/dev/null 2>&1; then
  echo "==> Installing Ollama"
  curl -fsSL https://ollama.com/install.sh | sh
else
  echo "==> Ollama already installed"
fi

echo "==> Locking Ollama to localhost + keeping models warm"
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/override.conf <<EOF
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
Environment="OLLAMA_KEEP_ALIVE=24h"
EOF
systemctl daemon-reload
systemctl enable ollama
systemctl restart ollama
sleep 3

echo "==> Pulling model(s) — this downloads several GB, please wait"
ollama pull "$PRIMARY_MODEL"
if [[ -n "$EXTRA_MODEL" && "$EXTRA_MODEL" != "none" ]]; then ollama pull "$EXTRA_MODEL" || true; fi

# ── Caddy (HTTPS gateway with token auth) ───────────────────────────────────
if ! command -v caddy >/dev/null 2>&1; then
  echo "==> Installing Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
else
  echo "==> Caddy already installed"
fi

echo "==> Writing Caddyfile (token-protected reverse proxy → Ollama)"
cat > /etc/caddy/Caddyfile <<EOF
$AI_DOMAIN {
	# Reject anything without the exact bearer token.
	@unauthorized {
		not header Authorization "Bearer $AI_TOKEN"
	}
	respond @unauthorized "Unauthorized" 401

	# Forward the OpenAI-compatible API to Ollama (localhost).
	reverse_proxy 127.0.0.1:11434 {
		header_up Host localhost:11434
	}
}
EOF
systemctl enable caddy
systemctl restart caddy

# ── Firewall ────────────────────────────────────────────────────────────────
echo "==> Firewall (SSH + HTTP/HTTPS only; AI port stays private)"
ufw allow OpenSSH || ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# ── Done ────────────────────────────────────────────────────────────────────
echo
echo "======================================================================"
echo "✅ Self-hosted AI is ready on your VPS."
echo
echo "Add these to your website .env (on cPanel), then restart the Node app:"
echo "----------------------------------------------------------------------"
echo "AI_BASE_URL=https://$AI_DOMAIN/v1"
echo "AI_API_KEY=$AI_TOKEN"
echo "AI_MODEL=$PRIMARY_MODEL"
echo "----------------------------------------------------------------------"
echo
echo "Test it from anywhere (should return a JSON chat reply):"
echo "  curl https://$AI_DOMAIN/v1/chat/completions \\"
echo "    -H 'Authorization: Bearer $AI_TOKEN' -H 'Content-Type: application/json' \\"
echo "    -d '{\"model\":\"$PRIMARY_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"say hi\"}]}'"
echo
echo "Notes:"
echo "  • Keep AI_API_KEY ($AI_TOKEN) secret — it's the only thing guarding your AI."
echo "  • For the Telegram admin agent (tool-calling), use AI_MODEL=llama3.1:8b."
echo "  • First reply after idle is slower (model loads into RAM), then it's warm."
echo "  • Switch back to DeepSeek anytime by restoring the old AI_* values."
echo "======================================================================"
