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
   */
  constructor({ db, config }) {
    this.db = db;
    this.config = config;
  }

  /**
   * Evaluate peer node connectivity state based on local received heartbeat
   * @param {string} peerId 
   * @returns {{ state: string, lastReceivedAt: string|null, elapsedSec: number }}
   */
  evaluatePeerHeartbeat(peerId) {
    const lastHb = this.db.getLastHeartbeat(peerId);
    if (!lastHb || !lastHb.received_at) {
      return { state: NodeState.UNKNOWN, lastReceivedAt: null, elapsedSec: Infinity };
    }

    const lastTime = new Date(lastHb.received_at + 'Z').getTime();
    const now = Date.now();
    const elapsedSec = Math.max(0, Math.floor((now - lastTime) / 1000));

    // Check alert state table for current recorded state
    const alertKey = `${peerId}:heartbeat`;
    const currentStateRecord = this.db.getAlertState(alertKey);
    const prevRecordedState = currentStateRecord ? currentStateRecord.current_state : NodeState.UNKNOWN;

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
  evaluateResources(serverId) {
    const metrics = this.db.getLatestMetrics(serverId);
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
   * @returns {{ daysRemaining: number|null, thresholdHit: number|null }}
   */
  evaluateExpiry(expiryDateStr) {
    if (!expiryDateStr) return { daysRemaining: null, thresholdHit: null };

    const expiryTime = new Date(expiryDateStr + 'T23:59:59Z').getTime();
    if (isNaN(expiryTime)) return { daysRemaining: null, thresholdHit: null };

    const now = Date.now();
    const diffMs = expiryTime - now;
    const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    const thresholds = [1, 3, 7, 15, 30];
    let thresholdHit = null;

    for (const t of thresholds) {
      if (daysRemaining <= t) {
        thresholdHit = t;
        break;
      }
    }

    return { daysRemaining, thresholdHit };
  }
}
