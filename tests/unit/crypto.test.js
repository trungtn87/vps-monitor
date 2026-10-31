import { test } from 'node:test';
import assert from 'node:assert';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  signHeartbeat,
  verifyHeartbeat,
  isTimestampValid,
  generateNonce,
  verifyDiscordSignature
} from '../../src/common/crypto.js';

test('signHeartbeat and verifyHeartbeat with valid secret', () => {
  const payload = { senderId: 'vinahost', seq: 1, ts: Date.now() };
  const secret = 'super-secret-key-12345';
  const sig = signHeartbeat(payload, secret);

  assert.ok(sig);
  assert.strictEqual(typeof sig, 'string');
  assert.ok(verifyHeartbeat(payload, sig, secret));
});

test('verifyHeartbeat rejects invalid signature or wrong secret', () => {
  const payload = { senderId: 'vinahost', seq: 1 };
  const secret = 'secret-1';
  const sig = signHeartbeat(payload, secret);

  assert.strictEqual(verifyHeartbeat(payload, sig, 'wrong-secret'), false);
  assert.strictEqual(verifyHeartbeat(payload, 'badsignature', secret), false);
  assert.strictEqual(verifyHeartbeat(payload, '', secret), false);
  assert.strictEqual(verifyHeartbeat({ ...payload, seq: 2 }, sig, secret), false);
});

test('isTimestampValid checks clock drift window', () => {
  const now = Date.now();
  assert.ok(isTimestampValid(now, 300));
  assert.ok(isTimestampValid(new Date().toISOString(), 300));

  // 10 minutes ago (> 300s) -> invalid
  const oldTime = now - 600 * 1000;
  assert.strictEqual(isTimestampValid(oldTime, 300), false);

  // 10 minutes in the future (> 300s) -> invalid
  const futureTime = now + 600 * 1000;
  assert.strictEqual(isTimestampValid(futureTime, 300), false);
});

test('generateNonce returns unique 32-char hex string', () => {
  const n1 = generateNonce();
  const n2 = generateNonce();
  assert.strictEqual(n1.length, 32);
  assert.notStrictEqual(n1, n2);
});

test('verifyDiscordSignature validates valid and invalid Ed25519 signatures', () => {
  // Generate test Ed25519 keypair
  const keyPair = generateKeyPairSync('ed25519');
  const rawPub = keyPair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const pubHex = rawPub.toString('hex');

  const timestamp = '1690000000';
  const body = '{"type":1}';
  const message = Buffer.from(timestamp + body, 'utf-8');
  const signature = sign(null, message, keyPair.privateKey).toString('hex');

  // Valid signature
  assert.ok(verifyDiscordSignature(body, signature, timestamp, pubHex));

  // Tampered body
  assert.strictEqual(verifyDiscordSignature('{"type":2}', signature, timestamp, pubHex), false);

  // Tampered timestamp
  assert.strictEqual(verifyDiscordSignature(body, signature, '1690000001', pubHex), false);

  // Bad signature format
  assert.strictEqual(verifyDiscordSignature(body, 'badhex', timestamp, pubHex), false);
});
