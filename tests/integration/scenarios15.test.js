import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { MonitorDatabase } from '../../src/db/database.js';
import { MonitorEvaluator, NodeState } from '../../src/monitor/evaluator.js';
import { AlertEngine } from '../../src/monitor/alertEngine.js';
import { DiscordNotifier } from '../../src/discord/notifier.js';
import { DiscordInteractionsHandler } from '../../src/discord/interactions.js';
import { DiscordCommands } from '../../src/discord/commands.js';
import { SystemCollector } from '../../src/agent/collector.js';
import { HeartbeatReceiver } from '../../src/monitor/heartbeatReceiver.js';
import { AuthGuard } from '../../src/web/auth.js';

// Helper mock notifier to capture sent alerts
class MockDiscordNotifier extends DiscordNotifier {
  constructor(shouldSucceed = true) {
    super({ webhookUrl: 'mock-url' });
    this.alerts = [];
    this.shouldSucceed = shouldSucceed;
  }
  async sendAlert(embed) {
    this.alerts.push(embed);
    return this.shouldSucceed;
  }
}

test('Scenario 1: Heartbeat bình thường (<= 60s -> ONLINE)', async () => {
  const db = new MonitorDatabase(':memory:');
  const config = { disconnectThresholdSec: 180, startupGraceSec: 180 };
  const evaluator = new MonitorEvaluator({ db, config });

  db.recordHeartbeat({
    senderId: 'nhanhoa',
    receiverId: 'vinahost',
    sequence: 1,
    senderTimestamp: new Date().toISOString(),
    status: 'VALID'
  });

  const res = await evaluator.evaluatePeerHeartbeat('nhanhoa');
  assert.strictEqual(res.state, NodeState.ONLINE);
  assert.ok(res.elapsedSec <= 5);
  db.close();
});

test('Scenario 2: Mất heartbeat trên 180 giây (-> DISCONNECTED and alerts via outbox)', async () => {
  const db = new MonitorDatabase(':memory:');
  const config = {
    serverId: 'vinahost',
    serverName: 'VinaHost (11Ship)',
    peerServerId: 'nhanhoa',
    peerServerName: 'Nhân Hòa (AutoTrade)',
    disconnectThresholdSec: 180
  };
  const evaluator = new MonitorEvaluator({ db, config });
  const notifier = new MockDiscordNotifier();
  const alertEngine = new AlertEngine({ db, evaluator, notifier, config });

  // Record old heartbeat (> 180s ago)
  db.db.prepare(`
    INSERT INTO heartbeat_log (sender_id, receiver_id, sequence, sender_timestamp, received_at, status)
    VALUES ('nhanhoa', 'vinahost', 1, datetime('now', '-200 seconds'), datetime('now', '-200 seconds'), 'VALID')
  `).run();

  await alertEngine.checkPeerHeartbeat();

  // Evaluated to DISCONNECTED
  const stateRecord = db.getAlertState('nhanhoa:heartbeat');
  assert.strictEqual(stateRecord.current_state, NodeState.DISCONNECTED);

  // Event recorded in history
  const events = db.getRecentEvents(10);
  assert.strictEqual(events[0].event_type, 'HEARTBEAT_LOSS');
  assert.strictEqual(events[0].severity, 'CRITICAL');

  // Dispatched Discord alert and recorded in outbox as DELIVERED
  assert.strictEqual(notifier.alerts.length, 1);
  assert.ok(notifier.alerts[0].title.includes('MẤT KẾT NỐI'));

  const pending = db.getPendingAlerts();
  assert.strictEqual(pending.length, 0); // successfully delivered
  db.close();
});

test('Scenario 3: Heartbeat phục hồi (DISCONNECTED -> RECOVERED alert)', async () => {
  const db = new MonitorDatabase(':memory:');
  const config = {
    serverId: 'vinahost',
    serverName: 'VinaHost (11Ship)',
    peerServerId: 'nhanhoa',
    peerServerName: 'Nhân Hòa (AutoTrade)',
    disconnectThresholdSec: 180
  };
  const evaluator = new MonitorEvaluator({ db, config });
  const notifier = new MockDiscordNotifier();
  const alertEngine = new AlertEngine({ db, evaluator, notifier, config });

  // Currently recorded as DISCONNECTED
  db.setAlertState('nhanhoa:heartbeat', NodeState.DISCONNECTED);

  // New valid heartbeat arrives
  db.recordHeartbeat({
    senderId: 'nhanhoa',
    receiverId: 'vinahost',
    sequence: 2,
    senderTimestamp: new Date().toISOString(),
    status: 'VALID'
  });

  await alertEngine.checkPeerHeartbeat();

  // New state is ONLINE
  const stateRecord = db.getAlertState('nhanhoa:heartbeat');
  assert.strictEqual(stateRecord.current_state, NodeState.ONLINE);

  // Event RECOVERED logged
  const events = db.getRecentEvents(10);
  assert.strictEqual(events[0].event_type, 'RECOVERED');
  assert.strictEqual(events[0].severity, 'INFO');

  // Recovery alert dispatched
  assert.strictEqual(notifier.alerts.length, 1);
  assert.ok(notifier.alerts[0].title.includes('PHỤC HỒI'));
  db.close();
});

test('Scenario 4: Agent ngừng hoạt động hoặc lỗi (gracefully handled without crashing)', async () => {
  const collector = new SystemCollector();
  // Corrupt state artificially to simulate broken collector read
  collector._prevCpu = { totalIdle: 'invalid', totalTick: 'invalid' };
  
  // Safe execution
  const metrics = collector.collect('vinahost');
  assert.ok(typeof metrics.cpuPct === 'number');
  assert.ok(typeof metrics.ramUsedMb === 'number');
});

test('Scenario 5: Monitor Service restart (State restored from REAL DISK SQLite database)', async () => {
  // Use real file path on disk to genuinely verify persistence across restarts
  const testDbFile = join(tmpdir(), `test-monitor-restart-${Date.now()}.db`);
  if (existsSync(testDbFile)) rmSync(testDbFile);

  try {
    // 1. First run: initialize DB on disk, set alert states and insert metrics
    const db1 = new MonitorDatabase(testDbFile);
    db1.upsertServer({ serverId: 'vinahost', name: 'VinaHost', host: 'localhost', port: 5050, isLocal: true });
    db1.setAlertState('nhanhoa:heartbeat', NodeState.DISCONNECTED, 1, { reason: 'network cut' });
    db1.setAlertState('vinahost:cpu', 'ALERTING', 3);
    db1.insertMetrics({
      serverId: 'vinahost',
      cpuPct: 89.5,
      ramUsedMb: 1200,
      ramTotalMb: 2000,
      ramPct: 60.0,
      diskUsedGb: 20,
      diskTotalGb: 50,
      diskPct: 40.0,
      uptimeSec: 10000
    });
    db1.queueAlert({ alertKey: 'test:persist', payload: { title: 'Persistent Alert' } });

    // Simulate process termination / shutdown
    db1.close();

    // 2. Second run: instantiate new MonitorDatabase from the same file
    const db2 = new MonitorDatabase(testDbFile);

    const restoredHeartbeat = db2.getAlertState('nhanhoa:heartbeat');
    assert.strictEqual(restoredHeartbeat.current_state, NodeState.DISCONNECTED);

    const restoredCpu = db2.getAlertState('vinahost:cpu');
    assert.strictEqual(restoredCpu.current_state, 'ALERTING');
    assert.strictEqual(restoredCpu.consecutive_count, 3);

    const restoredMetrics = db2.getLatestMetrics('vinahost');
    assert.strictEqual(restoredMetrics.cpu_pct, 89.5);
    assert.strictEqual(restoredMetrics.ram_used_mb, 1200);

    const pendingOutbox = db2.getPendingAlerts();
    assert.strictEqual(pendingOutbox.length, 1);
    assert.strictEqual(pendingOutbox[0].alert_key, 'test:persist');

    db2.close();
  } finally {
    try {
      if (existsSync(testDbFile)) rmSync(testDbFile, { force: true });
      if (existsSync(`${testDbFile}-wal`)) rmSync(`${testDbFile}-wal`, { force: true });
      if (existsSync(`${testDbFile}-shm`)) rmSync(`${testDbFile}-shm`, { force: true });
    } catch {
      // Windows lock release tolerance
    }
  }
});

test('Scenario 6: Một VPS ngừng phản hồi (Detected by peer node)', async () => {
  const db = new MonitorDatabase(':memory:');
  const config = {
    serverId: 'nhanhoa',
    peerServerId: 'vinahost',
    peerServerName: 'VinaHost (11Ship)',
    disconnectThresholdSec: 180
  };
  const evaluator = new MonitorEvaluator({ db, config });
  const notifier = new MockDiscordNotifier();
  const alertEngine = new AlertEngine({ db, evaluator, notifier, config });

  // VinaHost is silent for 250s
  db.db.prepare(`
    INSERT INTO heartbeat_log (sender_id, receiver_id, sequence, sender_timestamp, received_at, status)
    VALUES ('vinahost', 'nhanhoa', 10, datetime('now', '-250 seconds'), datetime('now', '-250 seconds'), 'VALID')
  `).run();

  await alertEngine.checkPeerHeartbeat();

  assert.strictEqual(notifier.alerts.length, 1);
  assert.ok(notifier.alerts[0].description.includes('VinaHost (11Ship)'));
  db.close();
});

test('Scenario 7: Mất kết nối mạng một chiều (Asymmetric network partitioned)', async () => {
  const dbA = new MonitorDatabase(':memory:');
  const dbB = new MonitorDatabase(':memory:');

  // Node A receives heartbeats from B
  dbA.recordHeartbeat({ senderId: 'nhanhoa', receiverId: 'vinahost', sequence: 1, senderTimestamp: new Date().toISOString(), status: 'VALID' });

  const evalA = new MonitorEvaluator({ db: dbA, config: { disconnectThresholdSec: 180 } });
  const evalB = new MonitorEvaluator({ db: dbB, config: { disconnectThresholdSec: 180 } });

  assert.strictEqual(await evalA.evaluatePeerHeartbeat('nhanhoa').state, NodeState.ONLINE);
  assert.strictEqual(await evalB.evaluatePeerHeartbeat('vinahost').state, NodeState.UNKNOWN);

  dbA.close();
  dbB.close();
});

test('Scenario 8: Discord API tạm thời lỗi (Rate limit 429 & transient retry)', async () => {
  let callCount = 0;
  const mockServer = http.createServer((req, res) => {
    callCount++;
    if (callCount === 1) {
      // First attempt: 429 rate limit
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ retry_after: 0.1 }));
    } else {
      // Second attempt: 200 OK
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }
  });

  await new Promise(r => mockServer.listen(0, '127.0.0.1', r));
  const port = mockServer.address().port;

  try {
    const notifier = new DiscordNotifier({ webhookUrl: `http://127.0.0.1:${port}` });
    const success = await notifier.sendAlert({ title: 'Test Alert', description: 'Testing retry' });
    assert.strictEqual(success, true);
    assert.strictEqual(callCount, 2);
  } finally {
    mockServer.close();
  }
});

test('Scenario 9: Discord không gửi trùng cảnh báo (Duplicate alert suppression)', async () => {
  const db = new MonitorDatabase(':memory:');
  const config = {
    serverId: 'vinahost',
    peerServerId: 'nhanhoa',
    peerServerName: 'Nhân Hòa (AutoTrade)',
    disconnectThresholdSec: 180
  };
  const evaluator = new MonitorEvaluator({ db, config });
  const notifier = new MockDiscordNotifier();
  const alertEngine = new AlertEngine({ db, evaluator, notifier, config });

  // Missing heartbeat
  db.db.prepare(`
    INSERT INTO heartbeat_log (sender_id, receiver_id, sequence, sender_timestamp, received_at, status)
    VALUES ('nhanhoa', 'vinahost', 1, datetime('now', '-200 seconds'), datetime('now', '-200 seconds'), 'VALID')
  `).run();

  // Cycle 1: alerts
  await alertEngine.checkPeerHeartbeat();
  assert.strictEqual(notifier.alerts.length, 1);

  // Cycle 2: still disconnected -> NO duplicate alert!
  await alertEngine.checkPeerHeartbeat();
  assert.strictEqual(notifier.alerts.length, 1);

  // Cycle 3: still disconnected -> NO duplicate alert!
  await alertEngine.checkPeerHeartbeat();
  assert.strictEqual(notifier.alerts.length, 1);

  db.close();
});

test('Scenario 10: CPU/RAM/Disk vượt ngưỡng (Sustained check triggers, distinct sample evaluated)', async () => {
  const db = new MonitorDatabase(':memory:');
  db.upsertServer({ serverId: 'vinahost', name: 'VinaHost', host: 'localhost', port: 5050, isLocal: true });

  const config = {
    serverId: 'vinahost',
    serverName: 'VinaHost',
    cpuThresholdPct: 85,
    ramThresholdPct: 85,
    diskThresholdPct: 85,
    consecutiveThresholdCount: 3
  };
  const evaluator = new MonitorEvaluator({ db, config });
  const notifier = new MockDiscordNotifier();
  const alertEngine = new AlertEngine({ db, evaluator, notifier, config });

  const recordCpu = (pct) => {
    db.insertMetrics({
      serverId: 'vinahost',
      cpuPct: pct,
      ramUsedMb: 1000,
      ramTotalMb: 2000,
      ramPct: 50,
      diskUsedGb: 10,
      diskTotalGb: 50,
      diskPct: 20,
      uptimeSec: 100
    });
  };

  // Sample 1: 90% CPU (1st spike)
  recordCpu(90);
  await alertEngine.checkResources();
  assert.strictEqual(notifier.alerts.length, 0);

  // Finding 8 verification: running checkResources again on same metric doesn't increment count!
  await alertEngine.checkResources();
  assert.strictEqual(notifier.alerts.length, 0);

  // Sample 2: 92% CPU (2nd spike)
  recordCpu(92);
  await alertEngine.checkResources();
  assert.strictEqual(notifier.alerts.length, 0);

  // Sample 3: 91% CPU (3rd consecutive spike) -> ALERTS!
  recordCpu(91);
  await alertEngine.checkResources();
  assert.strictEqual(notifier.alerts.length, 1);
  assert.ok(notifier.alerts[0].title.includes('CPU CAO'));

  // Sample 4: still 90% CPU -> no duplicate alert
  recordCpu(90);
  await alertEngine.checkResources();
  assert.strictEqual(notifier.alerts.length, 1);

  // Sample 5: drops to 40% -> NORMALIZATION alert
  recordCpu(40);
  await alertEngine.checkResources();
  assert.strictEqual(notifier.alerts.length, 2);
  assert.ok(notifier.alerts[1].title.includes('BÌNH THƯỜNG'));

  db.close();
});

test('Scenario 11: Ngày hết hạn vượt từng ngưỡng (Mỗi mốc báo đúng 1 lần, không lặp hàng ngày) (Finding 7)', async () => {
  const db = new MonitorDatabase(':memory:');
  const notifier = new MockDiscordNotifier();
  const expiryDate = '2026-12-31';

  const testWithDays = async (daysRemaining, expectedMilestone) => {
    const config = {
      serverId: 'vinahost',
      serverName: 'VinaHost',
      expiryDate
    };
    // Mock evaluateExpiry to simulate passage of days
    const evaluator = {
      evaluateExpiry: () => ({
        daysRemaining,
        thresholdHit: expectedMilestone,
        isOverdue: daysRemaining <= 0
      })
    };
    const alertEngine = new AlertEngine({ db, evaluator, notifier, config });
    await alertEngine.checkExpiry();
  };

  // Day 28 (milestone 30d): should alert
  await testWithDays(28, 30);
  assert.strictEqual(notifier.alerts.length, 1);
  assert.ok(notifier.alerts[0].description.includes('30 ngày'));

  // Day 27 (still milestone 30d): should NOT alert again!
  await testWithDays(27, 30);
  assert.strictEqual(notifier.alerts.length, 1); // no duplicate

  // Day 14 (crosses to milestone 15d): should alert
  await testWithDays(14, 15);
  assert.strictEqual(notifier.alerts.length, 2);

  // Day 6 (crosses to milestone 7d): should alert
  await testWithDays(6, 7);
  assert.strictEqual(notifier.alerts.length, 3);

  // Day 2 (crosses to milestone 3d): should alert
  await testWithDays(2, 3);
  assert.strictEqual(notifier.alerts.length, 4);

  // Day 1 (crosses to milestone 1d): should alert
  await testWithDays(1, 1);
  assert.strictEqual(notifier.alerts.length, 5);

  // Day 0 (overdue): should alert overdue
  await testWithDays(0, 0);
  assert.strictEqual(notifier.alerts.length, 6);
  assert.ok(notifier.alerts[5].title.includes('QUÁ HẠN'));

  db.close();
});

test('Scenario 12: Dữ liệu không hợp lệ hoặc thiếu (Malformed payload rejected safely)', async () => {
  const db = new MonitorDatabase(':memory:');
  const receiver = new HeartbeatReceiver({
    serverId: 'vinahost',
    heartbeatSecret: 'secret',
    db
  });

  assert.strictEqual(await receiver.processHeartbeat(null, 'sig').valid, false);
  assert.strictEqual(await receiver.processHeartbeat({ sequence: 1 }, 'sig').valid, false);

  const wrongReceiverPayload = {
    senderId: 'nhanhoa',
    receiverId: 'other-server',
    sequence: 1,
    timestamp: new Date().toISOString(),
    nonce: '123'
  };
  assert.strictEqual(await receiver.processHeartbeat(wrongReceiverPayload, 'sig').code, 403);

  db.close();
});

test('Scenario 13: API không được xác thực & Fail-closed (Finding 1)', async () => {
  // Case A: Missing credentials fail closed
  const closedGuard = new AuthGuard({ user: 'admin', pass: '', apiToken: '' });
  assert.strictEqual(closedGuard.isAuthorized({ headers: {} }), false);
  assert.strictEqual(closedGuard.isAuthorized({ headers: { authorization: 'Basic YWRtaW46' } }), false);

  // Case B: Configured credentials
  const guard = new AuthGuard({ user: 'admin', pass: 'secretpass', apiToken: 'token123' });
  assert.strictEqual(guard.isAuthorized({ headers: {} }), false);

  const badBasic = Buffer.from('admin:wrongpass').toString('base64');
  assert.strictEqual(guard.isAuthorized({ headers: { authorization: `Basic ${badBasic}` } }), false);

  const goodBasic = Buffer.from('admin:secretpass').toString('base64');
  assert.strictEqual(guard.isAuthorized({ headers: { authorization: `Basic ${goodBasic}` } }), true);

  const goodBearer = 'token123';
  assert.strictEqual(guard.isAuthorized({ headers: { authorization: `Bearer ${goodBearer}` } }), true);
});

test('Scenario 14: Discord interaction có chữ ký sai (401 on bad Ed25519 signature)', async () => {
  const db = new MonitorDatabase(':memory:');
  const config = { serverId: 'vinahost', serverName: 'VinaHost', disconnectThresholdSec: 180 };
  const evaluator = new MonitorEvaluator({ db, config });
  const commands = new DiscordCommands({ db, evaluator, config });

  const dummyPubKey = '00'.repeat(32);
  const handler = new DiscordInteractionsHandler({ publicKey: dummyPubKey, commands });

  const res = await handler.handle('{"type":1}', 'bad-sig', '1690000000');
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body, 'Invalid request signature');

  db.close();
});

test('Scenario 15: Lịch sử dữ liệu quá 30 ngày (Automatically pruned by retention)', async () => {
  const db = new MonitorDatabase(':memory:');
  db.upsertServer({ serverId: 'vinahost', name: 'VinaHost', host: 'localhost', port: 5050, isLocal: true });

  // Metric from 31 days ago
  db.db.prepare(`
    INSERT INTO node_metrics (server_id, cpu_pct, ram_used_mb, ram_total_mb, ram_pct, disk_used_gb, disk_total_gb, disk_pct, uptime_sec, created_at)
    VALUES ('vinahost', 40, 500, 1000, 50, 10, 50, 20, 100, datetime('now', '-31 days'))
  `).run();

  // Current metric
  db.insertMetrics({
    serverId: 'vinahost',
    cpuPct: 20,
    ramUsedMb: 400,
    ramTotalMb: 1000,
    ramPct: 40,
    diskUsedGb: 10,
    diskTotalGb: 50,
    diskPct: 20,
    uptimeSec: 100
  });

  const cleaned = db.cleanOldData(30);
  assert.strictEqual(cleaned.deletedMetrics, 1);

  const remaining = db.db.prepare('SELECT COUNT(*) as c FROM node_metrics').get();
  assert.strictEqual(remaining.c, 1);

  db.close();
});

test('Finding 3 Special: Persistent Outbox preserves and retries alerts when Discord fails', async () => {
  const db = new MonitorDatabase(':memory:');
  const config = {
    serverId: 'vinahost',
    serverName: 'VinaHost',
    peerServerId: 'nhanhoa',
    peerServerName: 'Nhân Hòa',
    disconnectThresholdSec: 180
  };
  const evaluator = new MonitorEvaluator({ db, config });
  // Simulating Discord service outage (fails to send)
  const failingNotifier = new MockDiscordNotifier(false);
  const alertEngine = new AlertEngine({ db, evaluator, notifier: failingNotifier, config });

  // Trigger alert
  await alertEngine.dispatchAlert('test:outage', { title: 'Network Outage Alert' });

  // Alert must be in alert_outbox with attempts >= 1 and status PENDING
  const outboxRows = db.db.prepare('SELECT * FROM alert_outbox WHERE alert_key = ?').all('test:outage');
  assert.strictEqual(outboxRows.length, 1);
  assert.strictEqual(outboxRows[0].status, 'PENDING');
  assert.strictEqual(outboxRows[0].attempts, 1);

  // Now Discord recovers (succeeds)
  failingNotifier.shouldSucceed = true;
  // Fast forward next_retry_at to now for test
  db.db.prepare("UPDATE alert_outbox SET next_retry_at = datetime('now')").run();

  await alertEngine.processOutbox();

  // Now pending outbox should be empty
  const pending = db.getPendingAlerts();
  assert.strictEqual(pending.length, 0);

  // Status should be DELIVERED
  const row = db.db.prepare('SELECT * FROM alert_outbox WHERE alert_key = ?').get('test:outage');
  assert.strictEqual(row.status, 'DELIVERED');
  assert.ok(row.delivered_at);

  db.close();
});

test('Finding 4 Special: Silent boot-time failure alert when peer never connects', async () => {
  const db = new MonitorDatabase(':memory:');
  const config = {
    serverId: 'vinahost',
    serverName: 'VinaHost',
    peerServerId: 'nhanhoa',
    peerServerName: 'Nhân Hòa',
    disconnectThresholdSec: 180,
    startupGraceSec: 180
  };
  // Booted 200s ago with ZERO heartbeats received from peer
  const serviceStartedAt = Date.now() - 200 * 1000;
  const evaluator = new MonitorEvaluator({ db, config, serviceStartedAt });
  const notifier = new MockDiscordNotifier();
  const alertEngine = new AlertEngine({ db, evaluator, notifier, config });

  await alertEngine.checkPeerHeartbeat();

  assert.strictEqual(notifier.alerts.length, 1);
  assert.ok(notifier.alerts[0].title.includes('KHÔNG CÓ HEARTBEAT KHỞI ĐỘNG'));
  assert.ok(notifier.alerts[0].description.includes('chưa từng gửi heartbeat'));

  db.close();
});

test('Finding 6 Special: Atomic Online SQLite Backup (VACUUM INTO) creates valid consistent snapshot', async () => {
  const srcDbFile = join(tmpdir(), `test-src-db-${Date.now()}.db`);
  const destDbFile = join(tmpdir(), `test-dest-db-${Date.now()}.db`);
  if (existsSync(srcDbFile)) rmSync(srcDbFile);
  if (existsSync(destDbFile)) rmSync(destDbFile);

  try {
    const srcDb = new MonitorDatabase(srcDbFile);
    srcDb.upsertServer({ serverId: 'vinahost', name: 'VinaHost', host: 'localhost', port: 5050, isLocal: true });
    srcDb.insertMetrics({
      serverId: 'vinahost',
      cpuPct: 45,
      ramUsedMb: 500,
      ramTotalMb: 1000,
      ramPct: 50,
      diskUsedGb: 10,
      diskTotalGb: 50,
      diskPct: 20,
      uptimeSec: 500
    });

    // Run online backup
    srcDb.backup(destDbFile);
    assert.ok(existsSync(destDbFile));

    // Open backup with new database instance and verify data integrity
    const backupDb = new MonitorDatabase(destDbFile);
    const server = backupDb.getServer('vinahost');
    assert.strictEqual(server.server_id, 'vinahost');

    const metrics = backupDb.getLatestMetrics('vinahost');
    assert.strictEqual(metrics.cpu_pct, 45);

    srcDb.close();
    backupDb.close();
  } finally {
    if (existsSync(srcDbFile)) rmSync(srcDbFile);
    if (existsSync(`${srcDbFile}-wal`)) rmSync(`${srcDbFile}-wal`);
    if (existsSync(`${srcDbFile}-shm`)) rmSync(`${srcDbFile}-shm`);
    if (existsSync(destDbFile)) rmSync(destDbFile);
  }
});
