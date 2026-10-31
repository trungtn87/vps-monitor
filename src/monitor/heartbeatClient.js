import { signHeartbeat, generateNonce } from '../common/crypto.js';
import { logger } from '../common/logger.js';

export class HeartbeatClient {
  /**
   * @param {object} options
   * @param {string} options.serverId
   * @param {string} options.peerServerId
   * @param {string} options.peerUrl
   * @param {string} options.heartbeatSecret
   * @param {function} options.getMetricsPayload - function returning current local metrics & app status
   * @param {number} [options.timeoutMs=5000]
   */
  constructor({
    serverId,
    peerServerId,
    peerUrl,
    heartbeatSecret,
    getMetricsPayload,
    timeoutMs = 5000
  }) {
    this.serverId = serverId;
    this.peerServerId = peerServerId;
    this.peerUrl = peerUrl ? peerUrl.replace(/\/+$/, '') : '';
    this.heartbeatSecret = heartbeatSecret;
    this.getMetricsPayload = getMetricsPayload;
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
  }

  /**
   * Send heartbeat to peer node
   * @returns {Promise<{ success: boolean, latencyMs: number, error?: string }>}
   */
  async sendHeartbeat() {
    if (!this.peerUrl) {
      return { success: false, latencyMs: 0, error: 'Peer URL not configured' };
    }

    this.sequence++;
    const nowIso = new Date().toISOString();
    const nonce = generateNonce();
    const metrics = this.getMetricsPayload ? this.getMetricsPayload() : {};

    const payload = {
      senderId: this.serverId,
      receiverId: this.peerServerId,
      sequence: this.sequence,
      timestamp: nowIso,
      nonce,
      metrics
    };

    const signature = signHeartbeat(payload, this.heartbeatSecret);
    const targetUrl = `${this.peerUrl}/api/heartbeat`;
    const start = Date.now();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature-SHA256': signature,
          'User-Agent': `VPS-Monitor/${this.serverId}`
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timer);

      const latencyMs = Date.now() - start;

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        logger.warn(`Heartbeat to ${this.peerServerId} failed with HTTP ${res.status}: ${body}`);
        return {
          success: false,
          latencyMs,
          error: `HTTP ${res.status}: ${body}`
        };
      }

      logger.debug(`Heartbeat sent to ${this.peerServerId} successfully (${latencyMs}ms)`);
      return { success: true, latencyMs };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const isTimeout = err.name === 'AbortError';
      const errMsg = isTimeout ? 'Connection timed out' : (err.message || 'Network error');
      logger.warn(`Heartbeat to ${this.peerServerId} failed: ${errMsg}`);
      return { success: false, latencyMs, error: errMsg };
    }
  }
}
