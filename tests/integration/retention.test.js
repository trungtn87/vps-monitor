import { test } from 'node:test';
import assert from 'node:assert';
import { MonitorDatabase } from '../../src/db/database.js';

test('Retention policy purges metrics, heartbeats, and events older than 30 days', () => {
  const db = new MonitorDatabase(':memory:');
  db.upsertServer({ serverId: 'vinahost', name: 'VinaHost', host: 'localhost', port: 5050, isLocal: true });

  // Insert recent metric (today)
  db.insertMetrics({
    serverId: 'vinahost',
    cpuPct: 30,
    ramUsedMb: 500,
    ramTotalMb: 1000,
    ramPct: 50,
    diskUsedGb: 10,
    diskTotalGb: 50,
    diskPct: 20,
    uptimeSec: 3600
  });

  // Insert old metric (35 days ago)
  db.db.prepare(`
    INSERT INTO node_metrics (server_id, cpu_pct, ram_used_mb, ram_total_mb, ram_pct, disk_used_gb, disk_total_gb, disk_pct, uptime_sec, created_at)
    VALUES ('vinahost', 40, 600, 1000, 60, 10, 50, 20, 3600, datetime('now', '-35 days'))
  `).run();

  // Insert recent and old heartbeats
  db.recordHeartbeat({ senderId: 'nhanhoa', receiverId: 'vinahost', sequence: 1, senderTimestamp: new Date().toISOString(), status: 'VALID' });
  db.db.prepare(`
    INSERT INTO heartbeat_log (sender_id, receiver_id, sequence, sender_timestamp, received_at, status)
    VALUES ('nhanhoa', 'vinahost', 2, datetime('now', '-40 days'), datetime('now', '-40 days'), 'VALID')
  `).run();

  // Insert recent and old event history
  db.recordEvent({ serverId: 'vinahost', eventType: 'TEST', severity: 'INFO', message: 'Recent event' });
  db.db.prepare(`
    INSERT INTO event_history (server_id, event_type, severity, message, created_at)
    VALUES ('vinahost', 'OLD_EVENT', 'INFO', 'Old event', datetime('now', '-45 days'))
  `).run();

  // Execute retention cleanup
  const cleaned = db.cleanOldData(30);

  assert.strictEqual(cleaned.deletedMetrics, 1);
  assert.strictEqual(cleaned.deletedHeartbeats, 1);
  assert.strictEqual(cleaned.deletedEvents, 1);

  // Verify only recent entries remain
  const remainingMetrics = db.db.prepare('SELECT COUNT(*) as c FROM node_metrics').get();
  assert.strictEqual(remainingMetrics.c, 1);

  const remainingHb = db.db.prepare('SELECT COUNT(*) as c FROM heartbeat_log').get();
  assert.strictEqual(remainingHb.c, 1);

  const remainingEvents = db.db.prepare('SELECT COUNT(*) as c FROM event_history').get();
  assert.strictEqual(remainingEvents.c, 1);

  db.close();
});
