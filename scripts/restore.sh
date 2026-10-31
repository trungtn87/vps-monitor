#!/usr/bin/env bash
# ==============================================================================
# VPS Monitor V1 — SQLite Database Restore Script
# Usage: sudo bash scripts/restore.sh <backup_file.db>
# ==============================================================================
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Error: This script must be run as root (use sudo)."
  exit 1
fi

BACKUP_FILE="${1:-}"
if [[ -z "$BACKUP_FILE" || ! -f "$BACKUP_FILE" ]]; then
  echo "Usage: sudo bash scripts/restore.sh <backup_file.db>"
  exit 1
fi

INSTALL_DIR="/opt/vps-monitor"
DB_FILE="$INSTALL_DIR/data/monitor.db"

echo "===> Restoring database from $BACKUP_FILE..."
echo "Stopping vps-monitor service..."
systemctl stop vps-monitor.service || true

# Remove existing WAL and SHM files
rm -f "${DB_FILE}" "${DB_FILE}-wal" "${DB_FILE}-shm"

# Restore database file
cp "$BACKUP_FILE" "$DB_FILE"
chown -R vpsmon:vpsmon "$INSTALL_DIR/data"
chmod 600 "$DB_FILE"

echo "Restarting vps-monitor service..."
systemctl start vps-monitor.service
sleep 2

HEALTH_RES=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5050/healthz || echo "000")
if [[ "$HEALTH_RES" == "200" ]]; then
  echo "✅ Database restore successful! Service is UP."
else
  echo "❌ Error: Service failed to start after restore (HTTP $HEALTH_RES)!"
  exit 1
fi
