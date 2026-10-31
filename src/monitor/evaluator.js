export const NodeState = {
  ONLINE: 'ONLINE',
  DISCONNECTED: 'DISCONNECTED',
  RECOVERED: 'RECOVERED',
  UNKNOWN: 'UNKNOWN'
};

export class MonitorEvaluator {
  /**
   * @param {object} options
   * @param {import('../db/database.js').MonitorDatabase} options.db
   * @param {object} options.config
   * @param {number} [options.serviceStartedAt] - Boot timestamp (epoch ms)
   */
  constructor({ db, config, serviceStartedAt = Date.now() }) {
    this.db = db;
    this.config = config;
    this.serviceStartedAt = serviceStartedAt;
  }

  /**
   * Evaluate peer node connectivity state based on local received heartbeat
   * Includes startup grace period to avoid silent boot-time failure (Finding 4)
   * @param {string} peerId 
   * @returns {{ state: string, lastReceivedAt: string|null, elapsedSec: number }}
   */
  async evaluatePeerHeartbeat(peerId) {
    const lastHb = await this.db.getLastHeartbeat(peerId);
    const now = Date.now();

    // Check alert state table for current recorded state
    const alertKey = `${peerId}:heartbeat`;
    const currentStateRecord = await this.db.getAlertState(alertKey);
    const prevRecordedState = currentStateRecord ? currentStateRecord.current_state : NodeState.UNKNOWN;

    if (!lastHb || !lastHb.received_at) {
      const elapsedSinceStart = Math.max(0, Math.floor((now - this.serviceStartedAt) / 1000));
      const startupGraceSec = this.config.startupGraceSec || this.config.disconnectThresholdSec || 180;

      // If startup grace period has expired without any heartbeat, mark as DISCONNECTED
      if (elapsedSinceStart > startupGraceSec) {
        return {
          state: NodeState.DISCONNECTED,
          lastReceivedAt: null,
          elapsedSec: elapsedSinceStart,
          isStartupFailure: true
        };
      }

      return {
        state: NodeState.UNKNOWN,
        lastReceivedAt: null,
        elapsedSec: elapsedSinceStart,
        isStartupFailure: false
      };
    }

    const lastTime = new Date(lastHb.received_at + 'Z').getTime();
    const elapsedSec = Math.max(0, Math.floor((now - lastTime) / 1000));

    let state;
    if (elapsedSec > this.config.disconnectThresholdSec) {
      state = NodeState.DISCONNECTED;
    } else {
      if (prevRecordedState === NodeState.DISCONNECTED) {
        state = NodeState.RECOVERED;
      } else {
        state = NodeState.ONLINE;
      }
    }

    return {
      state,
      lastReceivedAt: lastHb.received_at,
      elapsedSec
    };
  }

  /**
   * Evaluate resource thresholds for a server
   * @param {string} serverId 
   * @returns {{ cpuAlert: boolean, ramAlert: boolean, diskAlert: boolean, metrics: object|null }}
   */
  async evaluateResources(serverId) {
    const metrics = await this.db.getLatestMetrics(serverId);
    if (!metrics) {
      return { cpuAlert: false, ramAlert: false, diskAlert: false, metrics: null };
    }

    return {
      cpuAlert: metrics.cpu_pct >= this.config.cpuThresholdPct,
      ramAlert: metrics.ram_pct >= this.config.ramThresholdPct,
      diskAlert: metrics.disk_pct >= this.config.diskThresholdPct,
      metrics
    };
  }

  /**
   * Evaluate VPS expiration date
   * @param {string} expiryDateStr - YYYY-MM-DD
   * @returns {{ daysRemaining: number|null, thresholdHit: number|string|null, isOverdue: boolean }}
   */
  evaluateExpiry(expiryDateStr, nowMs = Date.now()) {
    if (typeof expiryDateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expiryDateStr)) {
      return { daysRemaining: null, thresholdHit: null, isOverdue: false };
    }
    const [y, m, d] = expiryDateStr.split('-').map(Number);
    const expiryUTC = Date.UTC(y, m - 1, d);
    // Reject nonexistent calendar dates instead of normalizing (e.g. Feb 30).
    if (!Number.isFinite(expiryUTC) ||
        new Date(expiryUTC).toISOString().slice(0, 10) !== expiryDateStr) {
      return { daysRemaining: null, thresholdHit: null, isOverdue: false };
    }

    // Billing deadlines are calendar dates in Vietnam, not UTC timestamps.
    // Comparing UTC midnight representations of LOCAL dates avoids DST/rounding
    // drift near midnight and counts the due date as 0 (not overdue).
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date(nowMs));
    const v = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const todayUTC = Date.UTC(Number(v.year), Number(v.month) - 1, Number(v.day));
    const daysRemaining = Math.round((expiryUTC - todayUTC) / 86400000);
    const isOverdue = daysRemaining < 0;

    let thresholdHit = null;
    if (isOverdue || daysRemaining === 0) {
      thresholdHit = 0;
    } else {
      for (const threshold of [1, 3, 7, 15, 30]) {
        if (daysRemaining <= threshold) {
          thresholdHit = threshold;
          break;
        }
      }
    }

    return { daysRemaining, thresholdHit, isOverdue };
  }
}
