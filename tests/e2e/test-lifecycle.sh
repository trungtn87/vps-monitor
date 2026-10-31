#!/usr/bin/env bash
# ==============================================================================
# VPS Monitor V1 — End-to-End Lifecycle Test (Install -> Backup -> Update -> Rollback -> Restore)
# Verifies operational safety on Ubuntu 24.04 / Linux runners in CI
# ==============================================================================
set -euo pipefail

echo "=================================================================="
echo "🚀 Starting VPS Monitor V1 Lifecycle E2E Verification..."
echo "=================================================================="

WORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_ROOT=$(mktemp -d /tmp/vpsmon-lifecycle-XXXXXX)
TEST_INSTALL_DIR="$TEST_ROOT/opt-vps-monitor"

cleanup() {
  echo "===> Cleaning up temporary test directory: $TEST_ROOT"
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

echo "===> [Step 1] Verifying installation script directory structure and permissions..."
export VPS_MONITOR_DIR="$TEST_INSTALL_DIR"
mkdir -p "$TEST_INSTALL_DIR"
cd "$WORK_DIR"

# Simulate install.sh copying repository with dotglob
mkdir -p "$TEST_INSTALL_DIR/data"
mkdir -p "$TEST_INSTALL_DIR/backups"
shopt -s dotglob
cp -r ./* "$TEST_INSTALL_DIR/"
shopt -u dotglob

# Verify .git is preserved (Finding 5)
if [[ ! -d "$TEST_INSTALL_DIR/.git" ]]; then
  echo "❌ Error: .git was not copied to $TEST_INSTALL_DIR!"
  exit 1
fi
echo "✔ .git directory successfully preserved in install target."

# Setup test .env file
TEST_PORT=5599
cat <<EOF > "$TEST_INSTALL_DIR/.env"
NODE_ENV="test"
SERVER_ID="vinahost"
SERVER_NAME="VinaHost (11Ship)"
PORT=$TEST_PORT
DB_PATH="$TEST_INSTALL_DIR/data/monitor.db"
HEARTBEAT_SECRET="lifecycle-test-secret-must-be-at-least-32-characters-long"
DASHBOARD_USER="admin"
DASHBOARD_PASS="testpass12345"
API_TOKEN="testtoken1234567890123456789012345"
DISCONNECT_THRESHOLD_SEC=180
STARTUP_GRACE_SEC=180
EOF
chmod 600 "$TEST_INSTALL_DIR/.env"
echo "✔ Configuration file created at $TEST_INSTALL_DIR/.env"

# Export test environment variables
set -a
source "$TEST_INSTALL_DIR/.env"
set +a

echo "===> [Step 2] Starting service and verifying HTTP /healthz endpoint..."
cd "$TEST_INSTALL_DIR"
node src/server.js &
SERVER_PID=$!
sleep 2

# Verify process is running
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "❌ Error: Server process exited unexpectedly!"
  exit 1
fi

HEALTH_RES=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$TEST_PORT/healthz" || echo "000")
if [[ "$HEALTH_RES" != "200" ]]; then
  echo "❌ Error: Healthcheck failed! HTTP response: $HEALTH_RES"
  exit 1
fi
echo "✔ Healthcheck verified (HTTP 200 OK)."

echo "===> [Step 3] Populating database with active monitor data..."
# Run a quick node script to populate test data into SQLite
node -e '
import { MonitorDatabase } from "./src/db/database.js";
const db = new MonitorDatabase("./data/monitor.db");
db.upsertServer({ serverId: "vinahost", name: "VinaHost", role: "11ship" });
db.upsertServer({ serverId: "nhanhoa", name: "Nhân Hòa", role: "autotrade" });
db.insertMetrics({
  serverId: "vinahost",
  cpuPct: 45.2,
  ramUsedMb: 1024,
  ramTotalMb: 4096,
  ramPct: 25.0,
  diskUsedGb: 20,
  diskTotalGb: 100,
  diskPct: 20.0,
  netRxBytes: 1000,
  netTxBytes: 2000,
  uptimeSec: 3600
});
db.recordHeartbeat({
  senderId: "nhanhoa",
  receiverId: "vinahost",
  sequence: 1,
  senderTimestamp: new Date().toISOString(),
  status: "VALID",
  latencyMs: 15
});
db.close();
'
echo "✔ Test data successfully written to SQLite."

echo "===> [Step 4] Testing atomic backup script (scripts/backup.sh)..."
bash "$TEST_INSTALL_DIR/scripts/backup.sh" "$TEST_INSTALL_DIR/backups"

BACKUP_FILE=$(ls -t "$TEST_INSTALL_DIR/backups"/monitor_backup_*.db | head -1)
if [[ ! -s "$BACKUP_FILE" ]]; then
  echo "❌ Error: Backup file not found or empty!"
  exit 1
fi
echo "✔ Backup created at $BACKUP_FILE"

# Verify backup SQLite integrity check if sqlite3 is installed
if command -v sqlite3 &>/dev/null; then
  INTEGRITY=$(sqlite3 "$BACKUP_FILE" "PRAGMA integrity_check;" 2>/dev/null || echo "failed")
  if [[ "$INTEGRITY" != "ok" ]]; then
    echo "❌ Error: Backup SQLite integrity check failed: $INTEGRITY"
    exit 1
  fi
  echo "✔ Backup SQLite PRAGMA integrity_check passed: ok."
fi

echo "===> [Step 5] Testing pre-update snapshot creation and codebase rollback..."
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SNAPSHOT_DIR="$TEST_INSTALL_DIR/backups/pre_update_$TIMESTAMP"
mkdir -p "$SNAPSHOT_DIR"

# Test atomic online backup (VACUUM INTO)
if command -v sqlite3 &>/dev/null; then
  sqlite3 "$TEST_INSTALL_DIR/data/monitor.db" "PRAGMA wal_checkpoint(TRUNCATE);"
  sqlite3 "$TEST_INSTALL_DIR/data/monitor.db" "VACUUM INTO '$SNAPSHOT_DIR/monitor.db';"
else
  cp "$TEST_INSTALL_DIR/data/monitor.db" "$SNAPSHOT_DIR/monitor.db"
fi
cp -r "$TEST_INSTALL_DIR/src" "$SNAPSHOT_DIR/"
cp "$TEST_INSTALL_DIR/package.json" "$SNAPSHOT_DIR/"
cp "$TEST_INSTALL_DIR/.env" "$SNAPSHOT_DIR/.env.bak"
echo "✔ Pre-update snapshot created at $SNAPSHOT_DIR"

# Simulate code modification (a simulated update)
echo "// updated at $(date)" >> "$TEST_INSTALL_DIR/src/server.js"

echo "===> [Step 6] Testing rollback script (scripts/rollback.sh)..."
# Stop background server
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true

# Execute rollback to snapshot
bash "$TEST_INSTALL_DIR/scripts/rollback.sh" "$SNAPSHOT_DIR"

# Restart server and verify health
node "$TEST_INSTALL_DIR/src/server.js" &
SERVER_PID=$!
sleep 2

HEALTH_RES=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$TEST_PORT/healthz" || echo "000")
if [[ "$HEALTH_RES" != "200" ]]; then
  echo "❌ Error: Server failed to respond with 200 after rollback! Got: $HEALTH_RES"
  exit 1
fi
echo "✔ Healthcheck verified after rollback (HTTP 200 OK)."

echo "===> [Step 7] Testing database restore script (scripts/restore.sh)..."
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true

bash "$TEST_INSTALL_DIR/scripts/restore.sh" "$BACKUP_FILE"

# Restart server and verify status endpoint with restored data
node "$TEST_INSTALL_DIR/src/server.js" &
SERVER_PID=$!
sleep 2

STATUS_RES=$(curl -s -u admin:testpass12345 "http://127.0.0.1:$TEST_PORT/api/status")
if ! echo "$STATUS_RES" | grep -q "vinahost"; then
  echo "❌ Error: Restored database did not contain expected data! Response: $STATUS_RES"
  exit 1
fi
echo "✔ Database restore verified. Data intact and accessible via API."

echo "=================================================================="
echo "🎉 ALL LIFECYCLE E2E CHECKS PASSED SUCCESSFULLY!"
echo "=================================================================="
