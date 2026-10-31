import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class MonitorDatabase {
  /**
   * @param {string} dbPath - File path to SQLite database or ':memory:'
   */
  constructor(dbPath = ':memory:') {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this._initPragmas();
    this._runMigrations();
  }

  _initPragmas() {
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (this.dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
      this.db.exec('PRAGMA busy_timeout = 5000;');
    }
  }

  _runMigrations() {
    const schemaSql = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
    this.db.exec(schemaSql);
  }

  // --- Server Registry ---
  upsertServer(server) {
    const stmt = this.db.prepare(`
      INSERT INTO server_registry (server_id, name, host, port, role, expiry_date, is_local, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(server_id) DO UPDATE SET
        name = excluded.name,
        host = excluded.host,
        port = excluded.port,
        role = excluded.role,
        expiry_date = excluded.expiry_date,
        is_local = excluded.is_local,
        updated_at = datetime('now')
    `);
    return stmt.run(
      server.serverId,
      server.name,
      server.host,
      server.port,
      server.role || 'PRIMARY',
      server.expiryDate || null,
      server.isLocal ? 1 : 0
    );
  }

  getServer(serverId) {
    const stmt = this.db.prepare('SELECT * FROM server_registry WHERE server_id = ?');
    return stmt.get(serverId) || null;
  }

  getAllServers() {
    const stmt = this.db.prepare('SELECT * FROM server_registry ORDER BY is_local DESC, server_id ASC');
    return stmt.all();
  }

  // --- Service Registry ---
  upsertService(service) {
    const stmt = this.db.prepare(`
      INSERT INTO service_registry (service_id, server_id, name, health_url, status, last_check, last_error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(service_id) DO UPDATE SET
        name = excluded.name,
        health_url = excluded.health_url,
        status = excluded.status,
        last_check = excluded.last_check,
        last_error = excluded.last_error,
        updated_at = datetime('now')
    `);
    return stmt.run(
      service.serviceId,
      service.serverId,
      service.name,
      service.healthUrl || null,
      service.status || 'UNKNOWN',
      service.lastCheck || null,
      service.lastError || null
    );
  }

  getServicesByServer(serverId) {
    const stmt = this.db.prepare('SELECT * FROM service_registry WHERE server_id = ?');
    return stmt.all(serverId);
  }

  // --- Metrics ---
  insertMetrics(m) {
    const stmt = this.db.prepare(`
      INSERT INTO node_metrics (
        server_id, cpu_pct, ram_used_mb, ram_total_mb, ram_pct,
        disk_used_gb, disk_total_gb, disk_pct, net_rx_bytes, net_tx_bytes,
        uptime_sec, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    return stmt.run(
      m.serverId,
      m.cpuPct,
      m.ramUsedMb,
      m.ramTotalMb,
      m.ramPct,
      m.diskUsedGb,
      m.diskTotalGb,
      m.diskPct,
      m.netRxBytes || 0,
      m.netTxBytes || 0,
      m.uptimeSec
    );
  }

  getLatestMetrics(serverId) {
    const stmt = this.db.prepare(`
      SELECT * FROM node_metrics 
      WHERE server_id = ? 
      ORDER BY id DESC 
      LIMIT 1
    `);
    return stmt.get(serverId) || null;
  }

  getMetricsHistory(serverId, limit = 60) {
    const stmt = this.db.prepare(`
      SELECT * FROM node_metrics 
      WHERE server_id = ? 
      ORDER BY id DESC 
      LIMIT ?
    `);
    const rows = stmt.all(serverId, limit);
    return rows.reverse(); // chronological order
  }

  // --- Heartbeat Log ---
  recordHeartbeat(hb) {
    const stmt = this.db.prepare(`
      INSERT INTO heartbeat_log (
        sender_id, receiver_id, sequence, sender_timestamp, received_at, status, latency_ms
      ) VALUES (?, ?, ?, ?, datetime('now'), ?, ?)
    `);
    return stmt.run(
      hb.senderId,
      hb.receiverId,
      hb.sequence,
      hb.senderTimestamp,
      hb.status || 'VALID',
      hb.latencyMs || 0
    );
  }

  getLastHeartbeat(senderId) {
    const stmt = this.db.prepare(`
      SELECT * FROM heartbeat_log 
      WHERE sender_id = ? AND status = 'VALID'
      ORDER BY id DESC 
      LIMIT 1
    `);
    return stmt.get(senderId) || null;
  }

  // --- Event History ---
  recordEvent(event) {
    const stmt = this.db.prepare(`
      INSERT INTO event_history (server_id, event_type, severity, message, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `);
    return stmt.run(
      event.serverId,
      event.eventType,
      event.severity || 'INFO',
      event.message,
      event.details ? JSON.stringify(event.details) : null
    );
  }

  getRecentEvents(limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM event_history 
      ORDER BY id DESC 
      LIMIT ?
    `);
    return stmt.all(limit);
  }

  // --- Alert State ---
  getAlertState(alertKey) {
    const stmt = this.db.prepare('SELECT * FROM alert_state WHERE alert_key = ?');
    return stmt.get(alertKey) || null;
  }

  setAlertState(alertKey, currentState, consecutiveCount = 1, details = null) {
    const stmt = this.db.prepare(`
      INSERT INTO alert_state (alert_key, current_state, consecutive_count, last_alerted_at, details_json, updated_at)
      VALUES (?, ?, ?, datetime('now'), ?, datetime('now'))
      ON CONFLICT(alert_key) DO UPDATE SET
        current_state = excluded.current_state,
        consecutive_count = excluded.consecutive_count,
        last_alerted_at = excluded.last_alerted_at,
        details_json = excluded.details_json,
        updated_at = datetime('now')
    `);
    return stmt.run(
      alertKey,
      currentState,
      consecutiveCount,
      details ? JSON.stringify(details) : null
    );
  }

  updateAlertCount(alertKey, count) {
    const stmt = this.db.prepare(`
      INSERT INTO alert_state (alert_key, current_state, consecutive_count, updated_at)
      VALUES (?, 'NORMAL', ?, datetime('now'))
      ON CONFLICT(alert_key) DO UPDATE SET
        consecutive_count = excluded.consecutive_count,
        updated_at = datetime('now')
    `);
    return stmt.run(alertKey, count);
  }

  // --- Alert Outbox (Persistent delivery queue) ---
  queueAlert({ alertKey, payload }) {
    const stmt = this.db.prepare(`
      INSERT INTO alert_outbox (alert_key, payload_json, status, attempts, next_retry_at, created_at)
      VALUES (?, ?, 'PENDING', 0, datetime('now'), datetime('now'))
    `);
    const res = stmt.run(alertKey, JSON.stringify(payload));
    return Number(res.lastInsertRowid);
  }

  getPendingAlerts(limit = 10) {
    const stmt = this.db.prepare(`
      SELECT * FROM alert_outbox 
      WHERE status = 'PENDING' AND next_retry_at <= datetime('now')
      ORDER BY id ASC 
      LIMIT ?
    `);
    return stmt.all(limit);
  }

  markAlertDelivered(id) {
    const stmt = this.db.prepare(`
      UPDATE alert_outbox 
      SET status = 'DELIVERED', delivered_at = datetime('now')
      WHERE id = ?
    `);
    return stmt.run(id);
  }

  markAlertRetry(id, attempts, nextRetrySec, error) {
    const stmt = this.db.prepare(`
      UPDATE alert_outbox 
      SET attempts = ?, next_retry_at = datetime('now', '+' || ? || ' seconds'), last_error = ?
      WHERE id = ?
    `);
    return stmt.run(attempts, nextRetrySec, error || null, id);
  }

  // --- Safe SQLite Snapshot Backup (VACUUM INTO) ---
  backup(destPath) {
    if (this.dbPath === ':memory:') {
      throw new Error('Cannot run VACUUM INTO on an in-memory database');
    }
    mkdirSync(dirname(destPath), { recursive: true });
    if (existsSync(destPath)) {
      rmSync(destPath);
    }
    // Checkpoint WAL and write a consistent, standalone database file
    this.db.exec(`PRAGMA wal_checkpoint(TRUNCATE);`);
    const sanitizedPath = destPath.replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${sanitizedPath}';`);
    return destPath;
  }

  // --- Retention Cleanup (30 days) ---
  cleanOldData(retentionDays = 30) {
    const cutoffDate = `-${retentionDays} days`;
    const delMetrics = this.db.prepare(`
      DELETE FROM node_metrics 
      WHERE created_at < datetime('now', ?)
    `).run(cutoffDate);

    const delHeartbeats = this.db.prepare(`
      DELETE FROM heartbeat_log 
      WHERE received_at < datetime('now', ?)
    `).run(cutoffDate);

    const delEvents = this.db.prepare(`
      DELETE FROM event_history 
      WHERE created_at < datetime('now', ?)
    `).run(cutoffDate);

    const delOutbox = this.db.prepare(`
      DELETE FROM alert_outbox 
      WHERE status = 'DELIVERED' AND created_at < datetime('now', ?)
    `).run(cutoffDate);

    return {
      deletedMetrics: delMetrics.changes,
      deletedHeartbeats: delHeartbeats.changes,
      deletedEvents: delEvents.changes,
      deletedOutbox: delOutbox.changes
    };
  }

  close() {
    this.db.close();
  }
}
