#!/usr/bin/env bash
#
# ApexBoost VPS Guard — run ONCE on the VPS as root:
#
#   sudo SITE_URL=https://apexsmmboosting.com \
#        TG_TOKEN=<telegram bot token> \
#        TG_CHAT=<telegram admin chat id> \
#        BACKUP_TOKEN=<same value as BACKUP_TOKEN in the site .env> \
#        bash vps-guard-setup.sh
#
# Installs three jobs (cron):
#   • Keep-alive: pings the site every 5 min so cPanel/Passenger never sleeps
#     (autopilot, refill tracking and the morning brief keep running at night).
#   • Uptime monitor: 2 straight failed pings → 🔴 Telegram alert;
#     recovery → 🟢 Telegram alert. State kept in /root/apex-guard/state.
#   • Nightly backup (02:30 server time): pulls a gzipped SQL dump from
#     /internal/backup, verifies it, keeps the last 14 days, alerts on failure.
#
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)." >&2; exit 1; }
: "${SITE_URL:?set SITE_URL}"; : "${TG_TOKEN:?set TG_TOKEN}"; : "${TG_CHAT:?set TG_CHAT}"; : "${BACKUP_TOKEN:?set BACKUP_TOKEN}"

DIR=/root/apex-guard
mkdir -p "$DIR/backups"
cat > "$DIR/config" <<EOF
SITE_URL=$SITE_URL
TG_TOKEN=$TG_TOKEN
TG_CHAT=$TG_CHAT
BACKUP_TOKEN=$BACKUP_TOKEN
EOF
chmod 600 "$DIR/config"

# ── guard.sh: keep-alive ping + up/down alerts ──────────────────────────────
cat > "$DIR/guard.sh" <<'EOF'
#!/usr/bin/env bash
set -u
. /root/apex-guard/config
STATE=/root/apex-guard/state
tg() { curl -s -m 15 "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TG_CHAT}" --data-urlencode "text=$1" >/dev/null 2>&1; }

ok=0
for i in 1 2; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 -L "$SITE_URL/") && [[ "$code" =~ ^(2|3) ]] && { ok=1; break; }
  sleep 10
done

prev=$(cat "$STATE" 2>/dev/null || echo "UP 0")
status=${prev%% *}; fails=${prev##* }

if [[ $ok -eq 1 ]]; then
  if [[ "$status" == "DOWN" ]]; then tg "🟢 ApexBoost is BACK UP — $SITE_URL is responding again."; fi
  echo "UP 0" > "$STATE"
else
  fails=$((fails + 1))
  if [[ "$status" != "DOWN" && $fails -ge 2 ]]; then
    tg "🔴 ApexBoost looks DOWN! $SITE_URL is not responding (checked twice). Check cPanel / Node app."
    echo "DOWN $fails" > "$STATE"
  else
    echo "$status $fails" > "$STATE"
  fi
fi
EOF
chmod +x "$DIR/guard.sh"

# ── backup.sh: nightly SQL dump pull + retention + failure alert ────────────
cat > "$DIR/backup.sh" <<'EOF'
#!/usr/bin/env bash
set -u
. /root/apex-guard/config
tg() { curl -s -m 15 "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TG_CHAT}" --data-urlencode "text=$1" >/dev/null 2>&1; }

OUT=/root/apex-guard/backups/apex-$(date +%F).sql.gz
if curl -fsS -m 300 -H "X-Backup-Token: ${BACKUP_TOKEN}" "$SITE_URL/internal/backup" -o "$OUT" \
   && [[ $(stat -c%s "$OUT" 2>/dev/null || echo 0) -gt 10240 ]] && gzip -t "$OUT" 2>/dev/null; then
  find /root/apex-guard/backups -name 'apex-*.sql.gz' -mtime +14 -delete
  # Quiet on success — the file listing is the receipt. Weekly heads-up on Sundays.
  [[ $(date +%u) -eq 7 ]] && tg "💾 Weekly backup check: latest DB backup $(basename "$OUT") ($(du -h "$OUT" | cut -f1)) saved on the VPS. $(ls /root/apex-guard/backups | wc -l) copies kept."
else
  rm -f "$OUT"
  tg "⚠️ ApexBoost nightly DB backup FAILED — could not pull a valid dump from $SITE_URL/internal/backup. Check BACKUP_TOKEN in the site .env and that the site is up."
fi
EOF
chmod +x "$DIR/backup.sh"

# ── cron ────────────────────────────────────────────────────────────────────
cat > /etc/cron.d/apex-guard <<'EOF'
*/5 * * * * root /root/apex-guard/guard.sh >/dev/null 2>&1
30 2 * * * root /root/apex-guard/backup.sh >/dev/null 2>&1
EOF
chmod 644 /etc/cron.d/apex-guard

echo "✅ Guard installed. First checks:"
"$DIR/guard.sh" && echo "  keep-alive/uptime: ran (state: $(cat $DIR/state))"
echo "  Running first backup now (may take a minute)…"
"$DIR/backup.sh"
ls -lh "$DIR/backups" | tail -3
echo
echo "Done. Every 5 min the site is pinged (never sleeps); you get a Telegram"
echo "alert if it goes down and when it recovers; a DB backup lands nightly in"
echo "$DIR/backups (14 days kept, weekly Sunday summary on Telegram)."
