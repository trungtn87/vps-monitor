#!/usr/bin/env bash
# Enable Discord alerts on a running VinaHost Monitor without exposing
# the webhook in Git, shell history, or command output.
set -euo pipefail
[[ "$EUID" -eq 0 ]] || { echo "Run as root"; exit 1; }
ENV_FILE=/opt/vps-monitor/.env
[[ -f "$ENV_FILE" ]] || { echo "Missing $ENV_FILE"; exit 1; }
[[ -t 0 ]] || { echo "Run interactively in your SSH terminal"; exit 1; }

printf 'Paste the Discord VPS Monitor webhook URL (input hidden): '
IFS= read -r -s WEBHOOK
echo
[[ "$WEBHOOK" =~ ^https://discord\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]+$ ]] || {
 echo "Invalid Discord webhook URL. No changes made."; exit 1;
}

# Test exactly once before editing the running monitor's config.
PAYLOAD='{"content":"🧪 VPS Monitor — Discord webhook test from VinaHost. This is a test, not an outage alert.","allowed_mentions":{"parse":[]}}'
HTTP_CODE="$(curl -sS --max-time 12 -o /dev/null -w '%{http_code}' \
 -X POST -H 'Content-Type: application/json' --data "$PAYLOAD" "$WEBHOOK")"
if [[ "$HTTP_CODE" != 204 && "$HTTP_CODE" != 200 ]]; then
 echo "Discord returned HTTP $HTTP_CODE. Configuration not changed."
 exit 1
fi
echo "Discord accepted the test message (HTTP $HTTP_CODE)."

BACKUP="$(mktemp /opt/vps-monitor/.env.before-discord.XXXXXXXX)"
cp -p "$ENV_FILE" "$BACKUP"
export WEBHOOK
python3 - "$ENV_FILE" <<'PY'
import os, pathlib, stat, sys, tempfile
path = pathlib.Path(sys.argv[1])
webhook = os.environ['WEBHOOK']
original = path.read_text()
lines = original.splitlines()
new = []
found = False
for line in lines:
    if line.startswith('DISCORD_WEBHOOK_URL='):
        if not found:
            new.append('DISCORD_WEBHOOK_URL=' + webhook)
            found = True
    else:
        new.append(line)
if not found:
    new.append('DISCORD_WEBHOOK_URL=' + webhook)
current_stat = path.stat()
fd, name = tempfile.mkstemp(prefix='.env.discord.', dir=str(path.parent))
try:
    os.fchown(fd, current_stat.st_uid, current_stat.st_gid)
    os.fchmod(fd, stat.S_IMODE(current_stat.st_mode))
    with os.fdopen(fd, 'w') as output:
        output.write('\n'.join(new) + '\n')
        output.flush()
        os.fsync(output.fileno())
    os.replace(name, path)
except BaseException:
    try: os.unlink(name)
    except FileNotFoundError: pass
    raise
PY
unset WEBHOOK
if ! systemctl restart vps-monitor; then
 cp -p "$BACKUP" "$ENV_FILE"
 systemctl restart vps-monitor || true
 echo "Monitor failed to restart; config restored."
 exit 1
fi
for _ in $(seq 1 15); do
 if curl -fsS --max-time 3 http://127.0.0.1:5050/healthz >/dev/null; then
  rm -f "$BACKUP"
  echo "VinaHost Monitor is running with Discord webhook enabled."
  exit 0
 fi
 sleep 2
done
cp -p "$BACKUP" "$ENV_FILE"
systemctl restart vps-monitor || true
echo "Healthcheck failed. Previous config restored. Inspect journalctl -u vps-monitor."
exit 1
