import { createHmac, createPublicKey, timingSafeEqual, verify, randomBytes } from 'node:crypto';

/**
 * Generate HMAC-SHA256 signature for heartbeat payload
 * @param {string|object} payload 
 * @param {string} secret 
 * @returns {string} hex signature
 */
export function signHeartbeat(payload, secret) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return createHmac('sha256', secret).update(data).digest('hex');
}

/**
 * Verify HMAC-SHA256 signature for heartbeat payload with timing safe comparison
 * @param {string|object} payload 
 * @param {string} signature 
 * @param {string} secret 
 * @returns {boolean}
 */
export function verifyHeartbeat(payload, signature, secret) {
  if (!signature || typeof signature !== 'string') return false;
  try {
    const expected = signHeartbeat(payload, secret);
    const expectedBuf = Buffer.from(expected, 'hex');
    const givenBuf = Buffer.from(signature, 'hex');
    if (expectedBuf.length !== givenBuf.length) return false;
    return timingSafeEqual(expectedBuf, givenBuf);
  } catch {
    return false;
  }
}

/**
 * Validate heartbeat timestamp against clock drift and replay
 * @param {number|string} timestamp - ISO string or unix epoch ms
 * @param {number} maxDriftSec - Maximum allowed drift in seconds (default 300s)
 * @returns {boolean}
 */
export function isTimestampValid(timestamp, maxDriftSec = 300) {
  const timeMs = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp;
  if (isNaN(timeMs)) return false;
  const now = Date.now();
  const diffSec = Math.abs(now - timeMs) / 1000;
  return diffSec <= maxDriftSec;
}

/**
 * Generate a random nonce string
 * @returns {string}
 */
export function generateNonce() {
  return randomBytes(16).toString('hex');
}

// SPKI prefix for Ed25519 public key (RFC 8410: id-Ed25519 OID 1.3.101.112)
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Verify Discord HTTP Interaction Ed25519 signature
 * @param {string} rawBody 
 * @param {string} signatureHex - X-Signature-Ed25519 header
 * @param {string} timestamp - X-Signature-Timestamp header
 * @param {string} publicKeyHex - Discord Application Public Key
 * @returns {boolean}
 */
export function verifyDiscordSignature(rawBody, signatureHex, timestamp, publicKeyHex) {
  if (!signatureHex || !timestamp || !publicKeyHex || !rawBody) {
    return false;
  }
  try {
    const rawPub = Buffer.from(publicKeyHex, 'hex');
    if (rawPub.length !== 32) return false;
    
    const sigBuf = Buffer.from(signatureHex, 'hex');
    if (sigBuf.length !== 64) return false;

    const spkiKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawPub]),
      format: 'der',
      type: 'spki'
    });

    const message = Buffer.from(timestamp + rawBody, 'utf-8');
    return verify(null, message, spkiKey, sigBuf);
  } catch {
    return false;
  }
}
