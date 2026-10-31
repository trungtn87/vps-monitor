#!/usr/bin/env bash
# ==============================================================================
# VPS Monitor V1 — Safe SQLite Database Backup Script
# Usage: sudo bash scripts/backup.sh [destination_dir]
# ==============================================================================
set -euo pipefail

INSTALL_DIR="/opt/vps-monitor"
DB_FILE="$INSTALL_DIR/data/monitor.db"
BACKUP_DIR="${1:-$INSTALL_DIR/backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
TARGET_FILE="$BACKUP_DIR/monitor_backup_$TIMESTAMP.db"

mkdir -p "$BACKUP_DIR"

if [[ ! -f "$DB_FILE" ]]; then
  echo "Database file $DB_FILE not found. Nothing to backup."
  exit 0
fi

echo "===> Creating database backup to $TARGET_FILE..."

# Check if sqlite3 CLI is available for clean online backup
if command -v sqlite3 &>/dev/null; then
  sqlite3 "$DB_FILE" ".backup '$TARGET_FILE'"
else
  # Fallback to file copy with wal files
  cp "$DB_FILE" "$TARGET_FILE"
  if [[ -f "${DB_FILE}-wal" ]]; then
    cp "${DB_FILE}-wal" "${TARGET_FILE}-wal"
  fi
fi

echo "✅ Backup successfully created at: $TARGET_FILE"
# Keep only last 14 backups
ls -t "$BACKUP_DIR"/monitor_backup_*.db 2>/dev/null | tail -n +15 | xargs -r rm -f
