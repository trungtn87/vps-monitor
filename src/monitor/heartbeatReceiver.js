import { verifyHeartbeat, isTimestampValid } from '../common/crypto.js';
import { logger } from '../common/logger.js';

// Reject stale, malformed, or oversized peer telemetry before it reaches storage.
// The sender is authenticated by the existing signed heartbeat.
export function validatePeerContainerSum(sum, now = Date.now()) {
  if (!sum || typeof sum !== 'object' || Array.isArray(sum) ||
      !Array.isArray(sum.apps) || sum.apps.length < 2 || sum.apps.length > 10 ||
      typeof sum.sampledAt !== 'string' ||
      !Number.isFinite(Date.parse(sum.sampledAt)) ||
      Math.abs(now - Date.parse(sum.sampledAt)) > 180000 ||
      typeof sum.ramUsedMb !== 'number' || !Number.isFinite(sum.ramUsedMb) ||
      sum.ramUsedMb < 0 || sum.ramUsedMb > 1000000 ||
      !(sum.cpuUsedVcpu === null || (typeof sum.cpuUsedVcpu === 'number' &&
        Number.isFinite(sum.cpuUsedVcpu) && sum.cpuUsedVcpu >= 0 && sum.cpuUsedVcpu <= 1024))) {
    return null;
  }
  const seen = new Set();
  const apps = [];
  for (const app of sum.apps) {
    if (!app || typeof app !== 'object' || Array.isArray(app) ||
        typeof app.appId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(app.appId) ||
        seen.has(app.appId) || typeof app.name !== 'string' ||
        app.name.length < 1 || app.name.length > 64 ||
        !(app.ramUsedMb === null || (typeof app.ramUsedMb === 'number' &&
          Number.isFinite(app.ramUsedMb) && app.ramUsedMb >= 0 && app.ramUsedMb <= 1000000)) ||
        !(app.cpuVcpu === null || (typeof app.cpuVcpu === 'number' &&
          Number.isFinite(app.cpuVcpu) && app.cpuVcpu >= 0 && app.cpuVcpu <= 64))) {
      return null;
    }
    seen.add(app.appId);
    apps.push({
      appId:app.appId, name:app.name, ramUsedMb:app.ramUsedMb, cpuVcpu:app.cpuVcpu,
      status:app.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'MEASURED'
    });
  }
  if (!seen.has('vps-monitor') || !seen.has('autotrade')) return null;
  return {sampledAt:sum.sampledAt, ramUsedMb:sum.ramUsedMb,
    cpuUsedVcpu:sum.cpuUsedVcpu, apps};
}

export class HeartbeatReceiver {
  /**
   * @param {object} options
   * @param {string} options.serverId - Local server ID
   * @param {string} options.heartbeatSecret - Shared secret
   * @param {import('../db/database.js').MonitorDatabase} options.db
   */
  constructor({ serverId, heartbeatSecret, db }) {
    this.serverId = serverId;
    this.heartbeatSecret = heartbeatSecret;
    this.db = db;
    this.seenNonces = new Map(); // nonce -> timestamp ms
  }

  _cleanupNonces() {
    const now = Date.now();
    const expiryMs = 10 * 60 * 1000; // 10 minutes
    for (const [nonce, ts] of this.seenNonces.entries()) {
      if (now - ts > expiryMs) {
        this.seenNonces.delete(nonce);
      }
    }
  }

  /**
   * Process and validate incoming heartbeat
   * @param {object} payload 
   * @param {string} signature 
   * @returns {{ valid: boolean, code: number, reason: string }}
   */
  async processHeartbeat(payload, signature) {
    this._cleanupNonces();

    if (!payload || typeof payload !== 'object') {
      return { valid: false, code: 400, reason: 'Invalid or missing payload' };
    }

    const { senderId, receiverId, sequence, timestamp, nonce, metrics } = payload;

    if (!senderId || !receiverId || sequence === undefined || !timestamp || !nonce) {
      return { valid: false, code: 400, reason: 'Missing required heartbeat fields' };
    }

    if (receiverId !== this.serverId) {
      logger.warn(`Heartbeat rejected: intended for ${receiverId}, this is ${this.serverId}`);
      return { valid: false, code: 403, reason: `Mismatched receiverId: expected ${this.serverId}` };
    }

    // 1. Verify HMAC-SHA256 signature
    const isSigValid = verifyHeartbeat(payload, signature, this.heartbeatSecret);
    if (!isSigValid) {
      logger.warn(`Heartbeat rejected from ${senderId}: invalid signature`);
      await this.db.recordHeartbeat({
        senderId,
        receiverId: this.serverId,
        sequence: sequence || 0,
        senderTimestamp: timestamp,
        status: 'INVALID_SIGNATURE'
      });
      return { valid: false, code: 401, reason: 'Invalid signature' };
    }

    // 2. Verify timestamp window (<= 300s clock drift)
    if (!isTimestampValid(timestamp, 300)) {
      logger.warn(`Heartbeat rejected from ${senderId}: timestamp expired or excessive clock drift`);
      await this.db.recordHeartbeat({
        senderId,
        receiverId: this.serverId,
        sequence,
        senderTimestamp: timestamp,
        status: 'EXPIRED'
      });
      return { valid: false, code: 400, reason: 'Timestamp expired or excessive clock drift (>300s)' };
    }

    // 3. Verify nonce for replay protection
    if (this.seenNonces.has(nonce)) {
      logger.warn(`Heartbeat rejected from ${senderId}: replayed nonce ${nonce}`);
      await this.db.recordHeartbeat({
        senderId,
        receiverId: this.serverId,
        sequence,
        senderTimestamp: timestamp,
        status: 'REPLAY'
      });
      return { valid: false, code: 409, reason: 'Replayed heartbeat nonce' };
    }
    this.seenNonces.set(nonce, Date.now());

    // Calculate latency from sender timestamp if clocks are roughly aligned
    const senderMs = new Date(timestamp).getTime();
    const latencyMs = Math.max(0, Date.now() - senderMs);

    // Record valid heartbeat in database
    await this.db.recordHeartbeat({
      senderId,
      receiverId: this.serverId,
      sequence,
      senderTimestamp: timestamp,
      status: 'VALID',
      latencyMs
    });

    // Record peer metrics if provided
    if (metrics && typeof metrics === 'object') {
      try {
        await this.db.insertMetrics({
          serverId: senderId,
          cpuPct: metrics.cpuPct || 0,
          ramUsedMb: metrics.ramUsedMb || 0,
          ramTotalMb: metrics.ramTotalMb || 0,
          ramPct: metrics.ramPct || 0,
          diskUsedGb: metrics.diskUsedGb || 0,
          diskTotalGb: metrics.diskTotalGb || 0,
          diskPct: metrics.diskPct || 0,
          netRxBytes: metrics.netRxBytes || 0,
          netTxBytes: metrics.netTxBytes || 0,
          uptimeSec: metrics.uptimeSec || 0
        });

        // If peer provided app status, update service registry
        if (metrics.appService) {
          await this.db.upsertService({
            serviceId: metrics.appService.serviceId,
            serverId: senderId,
            name: metrics.appService.name,
            healthUrl: metrics.appService.healthUrl || null,
            status: metrics.appService.status || 'UNKNOWN',
            lastCheck: new Date().toISOString(),
            lastError: metrics.appService.error || null
          });
        }
      } catch (err) {
        logger.error(`Error saving metrics from peer ${senderId}:`, err);
      }
    }

    // Optional peer breakdown: ignored on legacy senders and unavailable storage.
    // Only Nhân Hòa may publish this aggregate; failed/malformed telemetry
    // must not affect heartbeat health or Discord connectivity alerts.
    if (senderId === 'nhanhoa' && metrics?.vibeContainerSum &&
        typeof this.db.insertVibeContainerSum === 'function') {
      const snapshot = validatePeerContainerSum(metrics.vibeContainerSum);
      if (snapshot) {
        try {
          await this.db.insertVibeContainerSum(senderId, snapshot);
        } catch (err) {
          logger.warn('Peer container snapshot could not be persisted');
        }
      }
    }

    logger.debug(`Valid heartbeat recorded from ${senderId} (seq ${sequence})`);
    return { valid: true, code: 200, reason: 'OK' };
  }
}
