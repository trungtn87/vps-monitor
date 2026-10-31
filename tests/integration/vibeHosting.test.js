import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/common/config.js';
import { VibeContainerCollector } from '../../src/agent/vibeContainerCollector.js';

const secureEnv = {
  NODE_ENV: 'production',
  SERVER_ID: 'nhanhoa',
  HEARTBEAT_SECRET: 'a'.repeat(64),
  DASHBOARD_PASS: 'non-real-test-password-only',
  HOST: '0.0.0.0',
  PORT: '3000',
  REQUIRE_TLS: 'false',
  VIBE_HOSTING: 'true'
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
