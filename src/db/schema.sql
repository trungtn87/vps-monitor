-- VPS Monitor V1 SQLite Schema
-- Designed for standalone execution with future HA readiness

PRAGMA foreign_keys = ON;

-- 1. Server Registry: tracks both nodes in the monitoring topology
CREATE TABLE IF NOT EXISTS server_registry (
  server_id TEXT PRIMARY KEY,               -- e.g. 'vinahost', 'nhanhoa'
  name TEXT NOT NULL,                       -- Display name: 'VinaHost (11Ship)'
  host TEXT NOT NULL,                       -- IP or FQDN
  port INTEGER NOT NULL,                    -- Monitor service port
  role TEXT NOT NULL DEFAULT 'PRIMARY',     -- PRIMARY, STANDBY, INACTIVE (HA foundation)
  expiry_date TEXT,                         -- YYYY-MM-DD
  is_local INTEGER NOT NULL DEFAULT 0,      -- 1 if this is the local node running this instance
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. Service Registry: tracks app services running on each server (e.g. 11Ship, AutoTrade)
CREATE TABLE IF NOT EXISTS service_registry (
  service_id TEXT PRIMARY KEY,              -- e.g. '11ship-backend', 'autotrade-bot'
  server_id TEXT NOT NULL,                  -- Foreign key to server_registry
  name TEXT NOT NULL,                       -- e.g. '11Ship Production Backend'
  health_url TEXT,                          -- http://127.0.0.1:8000/healthz
  status TEXT NOT NULL DEFAULT 'UNKNOWN',   -- HEALTHY, UNHEALTHY, UNREACHABLE, DISABLED
  last_check TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (server_id) REFERENCES server_registry(server_id) ON DELETE CASCADE
);

-- 3. Node Metrics: periodic resource snapshots (CPU, RAM, Disk, Net, Uptime)
CREATE TABLE IF NOT EXISTS node_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL,
  cpu_pct REAL NOT NULL,
  ram_used_mb INTEGER NOT NULL,
  ram_total_mb INTEGER NOT NULL,
  ram_pct REAL NOT NULL,
  disk_used_gb REAL NOT NULL,
  disk_total_gb REAL NOT NULL,
  disk_pct REAL NOT NULL,
  net_rx_bytes INTEGER NOT NULL DEFAULT 0,
  net_tx_bytes INTEGER NOT NULL DEFAULT 0,
  uptime_sec INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (server_id) REFERENCES server_registry(server_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_node_metrics_server_created 
  ON node_metrics(server_id, created_at DESC);

-- 4. Heartbeat Log: tracks incoming and outgoing heartbeats
CREATE TABLE IF NOT EXISTS heartbeat_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id TEXT NOT NULL,
  receiver_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  sender_timestamp TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL,                     -- VALID, INVALID_SIGNATURE, REPLAY, EXPIRED
  latency_ms INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_heartbeat_sender_received 
  ON heartbeat_log(sender_id, received_at DESC);

-- 5. Event History: log of state transitions (loss, recovery, thresholds, expiry)
CREATE TABLE IF NOT EXISTS event_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL,
  event_type TEXT NOT NULL,                 -- HEARTBEAT_LOSS, RECOVERED, SERVICE_DOWN, HIGH_RESOURCE, EXPIRY_WARNING
  severity TEXT NOT NULL,                   -- INFO, WARNING, CRITICAL
  message TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_history_created 
  ON event_history(created_at DESC);

-- 6. Alert State: deduplication & state tracking across restarts
CREATE TABLE IF NOT EXISTS alert_state (
  alert_key TEXT PRIMARY KEY,               -- e.g. 'vinahost:heartbeat', 'nhanhoa:cpu', 'expiry:vinahost:30d'
  current_state TEXT NOT NULL,              -- ONLINE, DISCONNECTED, RECOVERED, ALERTING, NORMAL
  consecutive_count INTEGER NOT NULL DEFAULT 0,
  last_alerted_at TEXT,
  details_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 7. Schema Version Migration Tracker
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (1);
