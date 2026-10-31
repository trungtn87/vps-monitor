import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PgMonitorDatabase } from '../../src/db/pgDatabase.js';

const url = process.env.MONITOR_TEST_DATABASE_URL;

test('real PostgreSQL adapter preserves metrics and atomic alert outbox across reopen', { skip: !url }, async () => {
  const d = await new PgMonitorDatabase(url, { testMode: true }).init();
  try {
    await d.upsertServer({
      serverId: 'pg-ci-monitor', name: 'PG Integration', host: '127.0.0.1',
      port: 3000, role: 'PRIMARY', isLocal: true, expiryDate: null
    });
    await d.upsertService({
      serviceId: 'pg-ci-autotrade', serverId: 'pg-ci-monitor',
      name: 'AutoTrade test', status: 'HEALTHY'
    });
    await d.insertMetrics({
      serverId: 'pg-ci-monitor', cpuPct: 15, ramUsedMb: 100, ramTotalMb: 200,
      ramPct: 50, diskUsedGb: 1, diskTotalGb: 2, diskPct: 50,
      netRxBytes: 42, netTxBytes: 21, uptimeSec: 360
    });
    await d.insertHostingQuota('pg-ci-monitor', {
      snapshotAt: new Date().toISOString(),
      cpuUsedVcpu:0.0129,cpuQuotaVcpu:1,cpuPct:1.29,
      ramUsedMb:146.07,ramQuotaMb:2048,ramPct:7.1,
      diskUsedMb:1.69,diskQuotaMb:3072,diskPct:0.1,
      apps:[{name:'autotrade',cpuVcpu:0.0129,ramMb:120.7,ramLimitMb:1024}]
    });
    await d.insertVibeContainerSum('pg-ci-monitor', {
      cpuUsedVcpu:0.0159,ramUsedMb:156.7,
      apps:[
        {name:'VPS Monitor',appId:'vps-monitor',cpuVcpu:0.003,ramUsedMb:34.7},
        {name:'AutoTrade',appId:'autotrade',cpuVcpu:0.0129,ramUsedMb:122}
      ]
    });
    const combined = await d.getLatestVibeContainerSum('pg-ci-monitor');
    assert.equal(combined.source,'CONTAINER_SUM');
    assert.equal(combined.scope,'VIBE_APPLICATIONS_ONLY');
    assert.equal(combined.ramUsedMb,156.7);
    assert.equal(combined.cpuUsedVcpu,0.0159);
    assert.equal(combined.apps.length,2);
    const trend=await d.getVibeContainerSumHistory('pg-ci-monitor',10,1,2048);
    assert.ok(trend.length >= 1);
    assert.ok(Math.abs(trend.at(-1).cpu_pct - 1.59) < 0.0001);
    assert.ok(Math.abs(trend.at(-1).ram_pct - 156.7/2048*100) < 0.0001);
    assert.notEqual(combined.scope,'VIBE_HOSTING_ACCOUNT');
    const quota = await d.getLatestHostingQuota('pg-ci-monitor');
    assert.equal(quota.scope,'VIBE_HOSTING_ACCOUNT');
    assert.equal(quota.cpuUsedVcpu,0.0129);
    assert.equal(quota.ramQuotaMb,2048);
    const quotaHistory = await d.getHostingQuotaHistory('pg-ci-monitor',20);
    assert.ok(quotaHistory.length >= 1);
    assert.equal(quotaHistory.at(-1).cpu_pct,1.29);
    await d.recordHeartbeat({
      senderId: 'pg-ci-peer', receiverId: 'pg-ci-monitor', sequence: 1,
      senderTimestamp: new Date().toISOString(), status: 'VALID'
    });
    assert.equal((await d.getLatestMetrics('pg-ci-monitor')).cpu_pct, 15);
    assert.equal((await d.getMetricsHistory('pg-ci-monitor', 5)).length, 1);
    assert.equal((await d.getServicesByServer('pg-ci-monitor'))[0].status, 'HEALTHY');
    assert.equal((await d.getLastHeartbeat('pg-ci-peer')).status, 'VALID');
    const result = await d.recordAlertTransition({
      alertKey: 'pg-ci-atomic-1', currentState: 'DISCONNECTED',
      serverId: 'pg-ci-monitor', eventType: 'HEARTBEAT_LOSS',
      severity: 'CRITICAL', message: 'Test atomic storage',
      alertPayload: { title: 'Test' }
    });
    assert.ok(result.eventId > 0 && result.outboxId > 0);
    assert.equal((await d.getAlertState('pg-ci-atomic-1')).current_state, 'DISCONNECTED');
    assert.ok((await d.getRecentEvents(100)).some(e => e.event_type === 'HEARTBEAT_LOSS'));
    assert.ok((await d.getPendingAlerts(100)).some(e => e.alert_key === 'pg-ci-atomic-1'));

    // A JSON serialization failure after BEGIN must rollback state and event.
    await assert.rejects(() => d.recordAlertTransition({
      alertKey: 'pg-ci-rollback', currentState: 'DISCONNECTED',
      serverId: 'pg-ci-monitor', eventType: 'HEARTBEAT_LOSS',
      message: 'Should roll back', alertPayload: { invalid: 1n }
    }));
    assert.equal(await d.getAlertState('pg-ci-rollback'), null);

    await d.markAlertDelivered(result.outboxId);
    assert.ok(!(await d.getPendingAlerts(100)).some(e => e.alert_key === 'pg-ci-atomic-1'));
  } finally {
    await d.close();
  }
  const reopened = await new PgMonitorDatabase(url, { testMode: true }).init();
  try {
    assert.equal((await reopened.getAlertState('pg-ci-atomic-1')).current_state, 'DISCONNECTED');
    assert.equal((await reopened.getLatestMetrics('pg-ci-monitor')).cpu_pct, 15);
    assert.equal((await reopened.getLatestHostingQuota('pg-ci-monitor')).cpuPct,1.29);
    await reopened.cleanOldData(30);
  } finally { await reopened.close(); }
});

test('Supabase Session pooler uses encrypted SSL require without CA verification', () => {
  const url = 'postgresql://vps_monitor_app.gmpgtwtxhjwjeincvkxn:example-password@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require';
  const pg = new PgMonitorDatabase(url);
  assert.equal(pg.pool.options.host, 'aws-0-ap-southeast-1.pooler.supabase.com');
  assert.equal(pg.pool.options.port, 5432);
  assert.equal(pg.pool.options.user, 'vps_monitor_app.gmpgtwtxhjwjeincvkxn');
  assert.equal(pg.pool.options.ssl.rejectUnauthorized, false);
  assert.equal(pg.pool.options.password, 'example-password');
  // Do not close the never-opened Pool just to inspect construction:
  // no connection is created by new Pool().
});

test('Supabase connection must never silently fall back to plaintext or wrong project', () => {
  const base = 'postgresql://vps_monitor_app.gmpgtwtxhjwjeincvkxn:example-password@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres';
  assert.throws(() => new PgMonitorDatabase(base + '?sslmode=disable'), /SSL mode=require/);
  assert.throws(() => new PgMonitorDatabase(base.replace('gmpgtwtxhjwjeincvkxn', 'frrlvmhblvqyjxbjspdq')), /dedicated VPS-Monitor/);
  const local = new PgMonitorDatabase('postgresql://postgres:test@127.0.0.1:5432/postgres', { testMode: true });
  assert.equal(local.pool.options.ssl, false);
});

test('two independent Monitor dispatchers claim each Discord alert only once', { skip: !url }, async () => {
  const nodeA = await new PgMonitorDatabase(url, { testMode: true }).init();
  const nodeB = await new PgMonitorDatabase(url, { testMode: true }).init();
  let id;
  try {
    id = await nodeA.queueAlert({
      alertKey: 'pg-ci-discord-claim',
      payload: { title: 'CI atomic lease check' }
    });
    const [first, second] = await Promise.all([
      nodeA.claimPendingAlerts(100), nodeB.claimPendingAlerts(100)
    ]);
    const claims = [...first, ...second].filter(r => r.id === id);
    assert.equal(claims.length, 1, 'a single event may not be claimed by two nodes');
    const claimedState = await nodeA.q('SELECT status FROM vps_monitor.alert_outbox WHERE id=$1',[id]);
    assert.equal(claimedState.rows[0].status, 'SENDING');

    await nodeA.markAlertRetry(id, 1, 0, 'test retry');
    const retried = await nodeB.claimPendingAlerts(100);
    assert.equal(retried.filter(r => r.id === id).length, 1, 'a failed send can be retried');
    await nodeB.markAlertDelivered(id);
    assert.equal((await nodeA.claimPendingAlerts(100)).filter(r => r.id === id).length, 0);
  } finally {
    if (id) await nodeA.markAlertDelivered(id);
    await Promise.all([nodeA.close(), nodeB.close()]);
  }
});
