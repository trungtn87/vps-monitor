import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/common/config.js';
import { VibeContainerCollector } from '../../src/agent/vibeContainerCollector.js';
import { createServer } from '../../src/server.js';
import { MonitorDatabase } from '../../src/db/database.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const secureEnv = {
  NODE_ENV: 'production',
  SERVER_ID: 'nhanhoa',
  HEARTBEAT_SECRET: 'a'.repeat(64),
  DASHBOARD_PASS: 'non-real-test-password-only',
  HOST: '0.0.0.0',
  PORT: '3000',
  REQUIRE_TLS: 'false',
  VIBE_HOSTING: 'true',
  DB_BACKEND: 'supabase_postgres',
  DATABASE_URL: 'postgresql://postgres:fake-password@db.gmpgtwtxhjwjeincvkxn.supabase.co:5432/postgres'
};

test('Vibe mode rejects a public HTTP bind unless trusted ingress is explicitly acknowledged', () => {
  assert.throws(() => loadConfig(secureEnv), /SECURITY FATAL/);
  assert.throws(
    () => loadConfig({ ...secureEnv, TRUSTED_PLATFORM_PROXY: 'false' }),
    /SECURITY FATAL/
  );
  assert.throws(
    () => loadConfig({ ...secureEnv, TRUSTED_PLATFORM_PROXY: 'true', HOST: '127.0.0.1' }),
    /SECURITY FATAL/
  );
  assert.throws(
    () => loadConfig({ ...secureEnv, TRUSTED_PLATFORM_PROXY: 'true', REQUIRE_TLS: 'true' }),
    /SECURITY FATAL/
  );
});

test('Vibe app exposes container provenance and requires secure production credentials', () => {
  const env = { ...secureEnv, TRUSTED_PLATFORM_PROXY: 'true', DB_PATH: '/data/monitor.db' };
  const config = loadConfig(env);
  assert.equal(config.vibeHosting, true);
  assert.equal(config.metricScope, 'CONTAINER');
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 3000);
  assert.equal(config.dbPath, '/data/monitor.db');
  assert.throws(() => loadConfig({ ...env, HEARTBEAT_SECRET: '' }), /SECURITY FATAL/);
  assert.throws(() => loadConfig({ ...env, DASHBOARD_PASS: '' }), /SECURITY FATAL/);
  assert.throws(() => loadConfig({ ...env, DATABASE_URL: '' }), /DB CONFIG ERROR/);
  const publicConfig = loadConfig({ ...env, PUBLIC_DASHBOARD: 'true', DASHBOARD_PASS: '', API_TOKEN: '' });
  assert.equal(publicConfig.publicDashboard, true);
  assert.throws(() => loadConfig({
    ...env, PUBLIC_DASHBOARD: 'true', DASHBOARD_PASS: '', VIBE_HOSTING: 'false'
  }), /SECURITY FATAL/);
});

test('Existing VinaHost production mode remains host-scoped and loopback bound', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    SERVER_ID: 'vinahost',
    HEARTBEAT_SECRET: 'b'.repeat(64),
    DASHBOARD_PASS: 'non-real-test-password-only'
  });
  assert.equal(config.vibeHosting, false);
  assert.equal(config.metricScope, 'HOST');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 5050);
});

test('Vibe collector reports process uptime and unavailable VPS disk, not fake host readings', () => {
  const c = new VibeContainerCollector();
  const first = c.collect('nhanhoa');
  assert.equal(first.serverId, 'nhanhoa');
  assert.ok(first.cpuPct >= 0 && first.cpuPct <= 100);
  assert.ok(first.ramUsedMb >= 0);
  assert.ok(first.ramTotalMb >= 0);
  assert.ok(first.ramPct >= 0 && first.ramPct <= 100);
  assert.equal(first.diskTotalGb, 0);
  assert.equal(first.diskPct, 0);
  assert.ok(Math.abs(first.uptimeSec - process.uptime()) < 2);
});

test('Vibe public dashboard exposes GET only, but never bypasses heartbeat signature', async () => {
  const app = await createServer({
    NODE_ENV: 'test',
    SERVER_ID: 'nhanhoa',
    PORT: '0',
    HOST: '127.0.0.1',
    DB_PATH: ':memory:',
    VIBE_HOSTING: 'true',
    PUBLIC_DASHBOARD: 'true',
    PEER_URL: '',
    HEARTBEAT_SECRET: 'test-heartbeat-secret',
    DASHBOARD_PASS: '',
    API_TOKEN: ''
  });
  await app.start();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    for (const path of ['/', '/app.js', '/style.css', '/api/status', '/api/metrics', '/api/events']) {
      const r = await fetch(base + path);
      assert.equal(r.status, 200, path);
    }
    const posted = await fetch(base + '/api/status', { method: 'POST' });
    assert.equal(posted.status, 401);
    const unsigned = await fetch(base + '/api/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        senderId: 'vinahost', receiverId: 'nhanhoa', sequence: 1,
        timestamp: new Date().toISOString(), nonce: 'nonce-unsigned',
        metrics: { cpuPct: 10 }
      })
    });
    assert.equal(unsigned.status, 401);
  } finally {
    await app.stop();
  }
});

test('Legacy VinaHost SQLite remains independent and survives reopening its own file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'monitor-db-isolated-'));
  const monitorDb = join(dir, 'vps-monitor.db');
  const otherDb = join(dir, 'autotrade-unrelated.db');
  try {
    const db = new MonitorDatabase(monitorDb);
    db.upsertServer({ serverId: 'nhanhoa', name: 'Nhan Hoa', isLocal: true });
    db.close();
    assert.notEqual(monitorDb, otherDb);
    const reopened = new MonitorDatabase(monitorDb);
    assert.equal(reopened.getServer('nhanhoa').name, 'Nhan Hoa');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Nhân Hòa Monitor checks AutoTrade engine (not only its web dashboard)', () => {
  const config = loadConfig({
    ...secureEnv, TRUSTED_PLATFORM_PROXY: 'true',
    PUBLIC_DASHBOARD: 'true', DASHBOARD_PASS: ''
  });
  assert.equal(config.appHealthUrl, 'https://vibetpmzwpxt5.vibe3.vnws.com/engine/health');
  assert.equal(config.appServiceId, 'autotrade');
  assert.equal(config.appServiceName, 'AutoTrade Bot');
  assert.equal(loadConfig({ ...secureEnv, TRUSTED_PLATFORM_PROXY: 'true',
    PUBLIC_DASHBOARD: 'true', APP_HEALTH_DISABLED: 'true' }).appHealthUrl, '');
  assert.equal(loadConfig({ ...secureEnv, TRUSTED_PLATFORM_PROXY: 'true',
    PUBLIC_DASHBOARD: 'true',
    APP_HEALTH_URL: 'https://autotrade.example.org/engine/health' }).appHealthUrl,
    'https://autotrade.example.org/engine/health');
});
