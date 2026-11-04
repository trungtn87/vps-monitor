import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startupFailureCode, diagnosticPayload } from '../../src/vibe/bootstrap.js';

test('Vibe startup errors are classified without exposing raw secrets', () => {
  assert.equal(startupFailureCode({ code: 'ENETUNREACH' }), 'DATABASE_NETWORK_UNREACHABLE');
  assert.equal(startupFailureCode({ code: '28P01' }), 'DATABASE_AUTH_FAILED');
  assert.equal(startupFailureCode(new Error('DATABASE_URL required for Supabase PostgreSQL')), 'DATABASE_URL_MISSING');
  assert.equal(startupFailureCode(new Error('DATABASE_URL must target the dedicated VPS-Monitor Supabase project.')), 'DATABASE_TARGET_INVALID');
  assert.equal(startupFailureCode(new Error('Connection failed for postgres://user:private-password@host')), 'STARTUP_FAILED');
  const response = diagnosticPayload('STARTUP_FAILED');
  assert.equal(response.ready, false);
  assert.equal(response.status, 'DEGRADED');
  assert.ok(!JSON.stringify(response).includes('private-password'));
  assert.equal(diagnosticPayload('random-unauthorized-code').errorCode, 'STARTUP_FAILED');
});
