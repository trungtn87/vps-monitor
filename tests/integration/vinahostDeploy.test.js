import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/common/config.js';

const env = {
  NODE_ENV: 'production',
  SERVER_ID: 'vinahost',
  HOST: '127.0.0.1', PORT: '5050',
  REQUIRE_TLS: 'false',
  TRUSTED_PLATFORM_PROXY: 'true',
  PUBLIC_DASHBOARD: 'true',
  DB_BACKEND: 'supabase_postgres',
  DATABASE_URL: 'postgresql://vps_monitor_app.gmpgtwtxhjwjeincvkxn:test@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres',
  HEARTBEAT_SECRET: 'tests-only-shared-heartbeat-secret-00000000',
  PEER_URL: 'https://vibetpmzwpxt7.vibe3.vnws.com'
};
test('VinaHost can use Supabase + public read-only behind loopback HTTPS proxy', () => {
  const c = loadConfig(env);
  assert.equal(c.dbBackend, 'supabase_postgres');
  assert.equal(c.metricScope, 'HOST');
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.publicDashboard, true);
  assert.equal(c.peerUrl, 'https://vibetpmzwpxt7.vibe3.vnws.com');
});
test('VinaHost cannot expose its public Dashboard via unencrypted public listen', () => {
  assert.throws(() => loadConfig({ ...env, HOST:'0.0.0.0' }), /SECURITY FATAL/);
  assert.throws(() => loadConfig({ ...env, TRUSTED_PLATFORM_PROXY:'false' }), /SECURITY FATAL/);
});
test('Dashboard login remains mandatory without explicit public-read-only mode', () => {
  assert.throws(() => loadConfig({ ...env, PUBLIC_DASHBOARD:'false' }), /DASHBOARD_PASS or API_TOKEN/);
});
