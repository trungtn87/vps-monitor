#!/usr/bin/env bash
# Apply confirmed payment dates to an ALREADY RUNNING VinaHost Monitor.
# This script intentionally changes no other environment variable.
set -euo pipefail
[[ "${EUID}" -eq 0 ]] || { echo "Run as root"; exit 1; }

DIR=/opt/vps-monitor
ENV_FILE="$DIR/.env"
[[ -f "$ENV_FILE" ]] || { echo "Missing $ENV_FILE"; exit 1; }
# Do not enable dates against the legacy 30-day alert engine.
grep -Fq 'One single reminder' "$DIR/src/monitor/evaluator.js" || {
  echo "Please update VPS Monitor code to D-1 first. No config modified."
  exit 1
}

BACKUP="$(mktemp "$DIR/.env.before-billing.XXXXXXXX")"
cp -p "$ENV_FILE" "$BACKUP"

python3 - "$ENV_FILE" <<'PY'
import os
import pathlib
import stat
import sys
import tempfile

path = pathlib.Path(sys.argv[1])
values = {'EXPIRY_DATE': '2027-01-12', 'PEER_EXPIRY_DATE': '2026-11-30'}
original = path.read_text()
lines = []
used = set()
for line in original.splitlines():
    key, sep, _ = line.partition('=')
    if sep and key in values:
        if key not in used:
            lines.append(key + '=' + values[key])
            used.add(key)
    else:
        lines.append(line)
for key, val in values.items():
    if key not in used:
        lines.append(key + '=' + val)
meta = path.stat()
fd, name = tempfile.mkstemp(prefix='.env.billing.', dir=str(path.parent))
try:
    os.fchown(fd, meta.st_uid, meta.st_gid)
    os.fchmod(fd, stat.S_IMODE(meta.st_mode))
    with os.fdopen(fd, 'w') as f:
        f.write('\n'.join(lines) + '\n')
        f.flush()
        os.fsync(f.fileno())
    os.replace(name, path)
except BaseException:
    try:
        os.unlink(name)
    except FileNotFoundError:
        pass
    raise
PY

restore() {
  cp -p "$BACKUP" "$ENV_FILE"
  systemctl restart vps-monitor || true
  echo "Billing dates configuration rolled back."
}

if ! systemctl restart vps-monitor; then
  restore
  exit 1
fi
for _ in $(seq 1 15); do
  if curl -fsS --max-time 3 http://127.0.0.1:5050/healthz >/dev/null; then
    rm -f "$BACKUP"
    echo "Billing dates enabled. VinaHost due 2027-01-12 (D-1 2027-01-11)."
    echo "Nhân Hòa peer due 2026-11-30 (D-1 2026-11-29)."
    echo "Discord reminder is sent by each server ONLY one day before its OWN expiry."
    exit 0
  fi
  sleep 2
done
restore
exit 1
