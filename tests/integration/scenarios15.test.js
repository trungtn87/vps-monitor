import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { MonitorDatabase } from '../../src/db/database.js';
import { MonitorEvaluator, NodeState } from '../../src/monitor/evaluator.js';
import { AlertEngine } from '../../src/monitor/alertEngine.js';
import { DiscordNotifier } from '../../src/discord/notifier.js';
import { DiscordInteractionsHandler } from '../../src/discord/interactions.js';
import { DiscordCommands } from '../../src/discord/commands.js';
import { SystemCollector } from '../../src/agent/collector.js';
import { HeartbeatReceiver } from '../../src/monitor/heartbeatReceiver.js';
import { signHeartbeat, generateNonce } from '../../src/common/crypto.js';
import { AuthGuard } from '../../src/web/auth.js';

// Helper mock notifier to capture sent alerts
class MockDiscordNotifier extends DiscordNotifier {
  constructor() {
    super({ webhookUrl: 'mock-url' });
    this.alerts = [];
  }
  async sendAlert(embed) {
    this.alerts.push(embed);
    return true;
  }
}

test('Scenario 1: Heartbeat bình thường (<= 60s -> ONLINE)', () => {
  const db = new MonitorDatabase(':memory:');
  const config = { disconnectThresholdSec: 180 };
  const evaluator = new MonitorEvaluator({ db, config });

  db.recordHeartbeat({
    senderId: 'nhanhoa',
    receiverId: 'vinahost',
    sequence: 1,
    senderTimestamp: new Date().toISOString(),
    status: 'VALID'
  });

  const res = evaluator.evaluatePeerHeartbeat('nhanhoa');
  assert.strictEqual(res.state, NodeState.ONLINE);
  assert.ok(res.elapsedSec <= 5);
  db.close();
});

test('Scenario 2: Mất heartbeat trên 180 giây (-> DISCONNECTED and alerts)', async () => {
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

  // Dispatched Discord alert
  assert.strictEqual(notifier.alerts.length, 1);
  assert.ok(notifier.alerts[0].title.includes('MẤT KẾT NỐI'));
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

test('Scenario 4: Agent ngừng hoạt động hoặc lỗi (gracefully handled without crashing)', () => {
  const collector = new SystemCollector();
  // Corrupt state artificially to simulate broken collector read
  collector._prevCpu = { totalIdle: 'invalid', totalTick: 'invalid' };
  
  // Safe execution
  const metrics = collector.collect('vinahost');
  assert.ok(typeof metrics.cpuPct === 'number');
  assert.ok(typeof metrics.ramUsedMb === 'number');
});

test('Scenario 5: Monitor Service restart (State restored from SQLite database, not lost)', async () => {
  const db = new MonitorDatabase(':memory:');
  const config = {
    serverId: 'vinahost',
    peerServerId: 'nhanhoa',
    peerServerName: 'Nhân Hòa',
    disconnectThresholdSec: 180
  };

  // State before "shutdown"
  db.setAlertState('nhanhoa:heartbeat', NodeState.DISCONNECTED, 1, { reason: 'network cut' });
  db.setAlertState('vinahost:cpu', 'ALERTING', 3);

  // Simulate new startup by querying persisted state
  const restartedHeartbeatState = db.getAlertState('nhanhoa:heartbeat');
  assert.strictEqual(restartedHeartbeatState.current_state, NodeState.DISCONNECTED);

  const restartedCpuState = db.getAlertState('vinahost:cpu');
  assert.strictEqual(restartedCpuState.current_state, 'ALERTING');
  assert.strictEqual(restartedCpuState.consecutive_count, 3);

  db.close();
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

test('Scenario 7: Mất kết nối mạng một chiều (Asymmetric network partitioned)', () => {
  const dbA = new MonitorDatabase(':memory:');
  const dbB = new MonitorDatabase(':memory:');

  // Node A receives heartbeats from B
  dbA.recordHeartbeat({ senderId: 'nhanhoa', receiverId: 'vinahost', sequence: 1, senderTimestamp: new Date().toISOString(), status: 'VALID' });
  // Node B did NOT receive heartbeats from A (one-way drop)

  const evalA = new MonitorEvaluator({ db: dbA, config: { disconnectThresholdSec: 180 } });
  const evalB = new MonitorEvaluator({ db: dbB, config: { disconnectThresholdSec: 180 } });

  assert.strictEqual(evalA.evaluatePeerHeartbeat('nhanhoa').state, NodeState.ONLINE);
  assert.strictEqual(evalB.evaluatePeerHeartbeat('vinahost').state, NodeState.UNKNOWN);

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

test('Scenario 10: CPU/RAM/Disk vượt ngưỡng (Sustained check triggers, transient does not)', async () => {
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

  // Check 1: 90% CPU (1st spike) -> no alert yet
  recordCpu(90);
  await alertEngine.checkResources();
  assert.strictEqual(notifier.alerts.length, 0);

  // Check 2: 92% CPU (2nd spike) -> no alert yet
  recordCpu(92);
  await alertEngine.checkResources();
  assert.strictEqual(notifier.alerts.length, 0);

  // Check 3: 91% CPU (3rd consecutive spike) -> ALERTS!
  recordCpu(91);
  await alertEngine.checkResources();
  assert.strictEqual(notifier.alerts.length, 1);
  assert.ok(notifier.alerts[0].title.includes('CPU CAO'));

  // Check 4: still 90% CPU -> no duplicate alert
  recordCpu(90);
  await alertEngine.checkResources();
  assert.strictEqual(notifier.alerts.length, 1);

  // Check 5: drops to 40% -> NORMALIZATION alert
  recordCpu(40);
  await alertEngine.checkResources();
  assert.strictEqual(notifier.alerts.length, 2);
  assert.ok(notifier.alerts[1].title.includes('BÌNH THƯỜNG'));

  db.close();
});

test('Scenario 11: Ngày hết hạn vượt từng ngưỡng (30, 15, 7, 3, 1 ngày)', async () => {
  const db = new MonitorDatabase(':memory:');
  const notifier = new MockDiscordNotifier();

  const testThreshold = async (days, expectedHit) => {
    const targetDate = new Date(Date.now() + days * 86400 * 1000).toISOString().slice(0, 10);
    const config = {
      serverId: 'vinahost',
      serverName: 'VinaHost',
      expiryDate: targetDate
    };
    const evaluator = new MonitorEvaluator({ db, config });
    const alertEngine = new AlertEngine({ db, evaluator, notifier, config });

    await alertEngine.checkExpiry();
    const alertState = db.getAlertState(`expiry:vinahost:${expectedHit}d`);
    assert.ok(alertState, `Threshold ${expectedHit}d should be recorded`);
  };

  await testThreshold(29, 30);
  await testThreshold(14, 15);
  await testThreshold(6, 7);
  await testThreshold(2, 3);
  await testThreshold(0, 1);

  assert.strictEqual(notifier.alerts.length, 5);
  db.close();
});

test('Scenario 12: Dữ liệu không hợp lệ hoặc thiếu (Malformed payload rejected safely)', () => {
  const db = new MonitorDatabase(':memory:');
  const receiver = new HeartbeatReceiver({
    serverId: 'vinahost',
    heartbeatSecret: 'secret',
    db
  });

  // Empty or non-object
  assert.strictEqual(receiver.processHeartbeat(null, 'sig').valid, false);

  // Missing senderId or receiverId
  assert.strictEqual(receiver.processHeartbeat({ sequence: 1 }, 'sig').valid, false);

  // Wrong receiverId
  const wrongReceiverPayload = {
    senderId: 'nhanhoa',
    receiverId: 'other-server',
    sequence: 1,
    timestamp: new Date().toISOString(),
    nonce: '123'
  };
  assert.strictEqual(receiver.processHeartbeat(wrongReceiverPayload, 'sig').code, 403);

  db.close();
});

test('Scenario 13: API không được xác thực (401 Unauthorized for invalid/missing token)', () => {
  const guard = new AuthGuard({ user: 'admin', pass: 'secretpass', apiToken: 'token123' });

  // No auth header
  assert.strictEqual(guard.isAuthorized({ headers: {} }), false);

  // Wrong basic auth
  const badBasic = Buffer.from('admin:wrongpass').toString('base64');
  assert.strictEqual(guard.isAuthorized({ headers: { authorization: `Basic ${badBasic}` } }), false);

  // Wrong bearer token
  assert.strictEqual(guard.isAuthorized({ headers: { authorization: 'Bearer wrongtoken' } }), false);

  // Valid basic auth
  const goodBasic = Buffer.from('admin:secretpass').toString('base64');
  assert.strictEqual(guard.isAuthorized({ headers: { authorization: `Basic ${goodBasic}` } }), true);

  // Valid bearer token
  assert.strictEqual(guard.isAuthorized({ headers: { authorization: 'Bearer token123' } }), true);
});

test('Scenario 14: Discord interaction có chữ ký sai (401 on bad Ed25519 signature)', () => {
  const db = new MonitorDatabase(':memory:');
  const config = { serverId: 'vinahost', serverName: 'VinaHost', disconnectThresholdSec: 180 };
  const evaluator = new MonitorEvaluator({ db, config });
  const commands = new DiscordCommands({ db, evaluator, config });

  // 32-byte dummy public key
  const dummyPubKey = '00'.repeat(32);
  const handler = new DiscordInteractionsHandler({ publicKey: dummyPubKey, commands });

  const res = handler.handle('{"type":1}', 'bad-sig', '1690000000');
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body, 'Invalid request signature');

  db.close();
});

test('Scenario 15: Lịch sử dữ liệu quá 30 ngày (Automatically pruned by retention)', () => {
  const db = new MonitorDatabase(':memory:');
  db.upsertServer({ serverId: 'vinahost', name: 'VinaHost', host: 'localhost', port: 5050, isLocal: true });

  // Insert metric from 31 days ago
  db.db.prepare(`
    INSERT INTO node_metrics (server_id, cpu_pct, ram_used_mb, ram_total_mb, ram_pct, disk_used_gb, disk_total_gb, disk_pct, uptime_sec, created_at)
    VALUES ('vinahost', 40, 500, 1000, 50, 10, 50, 20, 100, datetime('now', '-31 days'))
  `).run();

  // Insert current metric
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
