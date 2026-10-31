import { NodeState } from './evaluator.js';
import { logger } from '../common/logger.js';

export class AlertEngine {
  /**
   * @param {object} options
   * @param {import('../db/database.js').MonitorDatabase} options.db
   * @param {import('./evaluator.js').MonitorEvaluator} options.evaluator
   * @param {import('../discord/notifier.js').DiscordNotifier} options.notifier
   * @param {object} options.config
   */
  constructor({ db, evaluator, notifier, config }) {
    this.db = db;
    this.evaluator = evaluator;
    this.notifier = notifier;
    this.config = config;
    this._lastEvaluatedMetricId = {};

  }

  // Restore tracker after the optional PostgreSQL backend has connected.
  async init() {
    // Blocker 5: Restore last evaluated metric ID from SQLite alert_state to survive restarts
    try {
      const evalState = await this.db.getAlertState(`${this.config.serverId}:resource_eval`);
      if (evalState && evalState.details_json) {
        const parsed = JSON.parse(evalState.details_json);
        if (parsed.last_metric_id) {
          this._lastEvaluatedMetricId[this.config.serverId] = parsed.last_metric_id;
        }
      } else {
        const cpuState = await this.db.getAlertState(`${this.config.serverId}:cpu`);
        if (cpuState && cpuState.details_json) {
          const parsed = JSON.parse(cpuState.details_json);
          if (parsed.last_metric_id) {
            this._lastEvaluatedMetricId[this.config.serverId] = parsed.last_metric_id;
          }
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  /**
   * Helper to dispatch an alert directly via persistent outbox
   * @param {string} alertKey 
   * @param {object} embed 
   */
  async dispatchAlert(alertKey, embed) {
    try {
      await this.db.queueAlert({ alertKey, payload: embed });
    } catch (err) {
      logger.error(`Error queueing alert ${alertKey} to outbox:`, err);
    }
    await this.processOutbox();
  }

  /**
   * Process pending alerts in the persistent outbox
   * At-least-once delivery with exponential backoff retry.
   */
  async processOutbox() {
    let pendingAlerts;
    try {
      pendingAlerts = this.db.claimPendingAlerts
        ? await this.db.claimPendingAlerts(10)
        : await this.db.getPendingAlerts(10);
    } catch (err) {
      logger.error('Error fetching pending alerts from outbox:', err);
      return;
    }

    for (const alert of pendingAlerts) {
      let payload;
      try {
        payload = JSON.parse(alert.payload_json);
      } catch {
        await this.db.markAlertDelivered(alert.id); // discard corrupt json
        continue;
      }

      try {
        const delivered = await this.notifier.sendAlert(payload);
        if (delivered) {
          await this.db.markAlertDelivered(alert.id);
          logger.debug(`Alert #${alert.id} (${alert.alert_key}) delivered successfully.`);
        } else {
          // Discord returned false / rate limited: backoff 10s -> 300s
          const attempts = alert.attempts + 1;
          const nextRetrySec = Math.min(300, Math.max(10, Math.pow(2, attempts) * 5));
          await this.db.markAlertRetry(alert.id, attempts, nextRetrySec, 'Delivery returned false or rate limited');
          logger.warn(`Alert #${alert.id} delivery failed; scheduled retry in ${nextRetrySec}s (attempt ${attempts})`);
        }
      } catch (err) {
        const attempts = alert.attempts + 1;
        const nextRetrySec = Math.min(300, Math.max(10, Math.pow(2, attempts) * 5));
        await this.db.markAlertRetry(alert.id, attempts, nextRetrySec, err.message);
        logger.error(`Exception delivering alert #${alert.id}:`, err);
      }
    }
  }

  /**
   * Run a full check cycle
   */
  async checkCycle() {
    await this.checkPeerHeartbeat();
    await this.checkLocalAppHealth();
    await this.checkLocalAgentHealth(); // Blocker 4: Check if local agent is stale
    await this.checkResources();
    await this.checkExpiry();
    await this.processOutbox();
  }

  /**
   * Check peer heartbeat connectivity
   * Atomic state transition + outbox queue (Blocker 2)
   */
  async checkPeerHeartbeat() {
    const peerId = this.config.peerServerId;
    const { state, elapsedSec, lastReceivedAt, isStartupFailure } = await this.evaluator.evaluatePeerHeartbeat(peerId);

    const alertKey = `${peerId}:heartbeat`;
    const recorded = await this.db.getAlertState(alertKey);
    const prevState = recorded ? recorded.current_state : NodeState.UNKNOWN;

    // Transition: became DISCONNECTED
    if (state === NodeState.DISCONNECTED && prevState !== NodeState.DISCONNECTED) {
      logger.warn(`Peer ${peerId} is DISCONNECTED (no heartbeat for ${elapsedSec}s, startupFail: ${!!isStartupFailure})`);
      
      const message = isStartupFailure
        ? `⚠️ VPS [${this.config.peerServerName}] chưa từng gửi heartbeat sau ${elapsedSec}s khởi động! Có thể VPS đang tắt hoặc tiến trình monitor gặp lỗi.`
        : `⚠️ VPS [${this.config.peerServerName}] mất kết nối! Không nhận được heartbeat trong ${elapsedSec} giây (> 180s).`;

      const alertPayload = {
        title: isStartupFailure ? '🚨 CẢNH BÁO: KHÔNG CÓ HEARTBEAT KHỞI ĐỘNG' : '🚨 CẢNH BÁO: VPS MẤT KẾT NỐI',
        description: message,
        color: 0xE74C3C, // Red
        fields: [
          { name: 'VPS', value: this.config.peerServerName, inline: true },
          { name: 'Thời gian gián đoạn', value: `${elapsedSec}s`, inline: true },
          { name: 'Heartbeat cuối', value: lastReceivedAt ? `${lastReceivedAt} UTC` : 'Chưa từng nhận', inline: false }
        ]
      };

      // Atomic transition + outbox enqueue (Blocker 2)
      await this.db.recordAlertTransition({
        alertKey,
        currentState: NodeState.DISCONNECTED,
        consecutiveCount: 1,
        details: { elapsedSec, lastReceivedAt, isStartupFailure: !!isStartupFailure },
        serverId: peerId,
        eventType: 'HEARTBEAT_LOSS',
        severity: 'CRITICAL',
        message,
        eventDetails: { elapsedSec, lastReceivedAt, isStartupFailure: !!isStartupFailure },
        alertPayload
      });

      await this.processOutbox();
    }
    // Transition: RECOVERED after DISCONNECTED
    else if ((state === NodeState.RECOVERED || (state === NodeState.ONLINE && prevState === NodeState.DISCONNECTED))) {
      logger.info(`Peer ${peerId} has RECOVERED connection`);

      const message = `✅ VPS [${this.config.peerServerName}] đã khôi phục kết nối heartbeat thành công.`;
      const alertPayload = {
        title: '✅ PHỤC HỒI: VPS ĐÃ KẾT NỐI LẠI',
        description: message,
        color: 0x2ECC71, // Green
        fields: [
          { name: 'VPS', value: this.config.peerServerName, inline: true },
          { name: 'Trạng thái hiện tại', value: 'ONLINE', inline: true },
          { name: 'Thời gian nhận lại', value: `${lastReceivedAt} UTC`, inline: false }
        ]
      };

      // Atomic transition + outbox enqueue (Blocker 2)
      await this.db.recordAlertTransition({
        alertKey,
        currentState: NodeState.ONLINE,
        consecutiveCount: 1,
        details: { lastReceivedAt },
        serverId: peerId,
        eventType: 'RECOVERED',
        severity: 'INFO',
        message,
        eventDetails: { lastReceivedAt },
        alertPayload
      });

      await this.processOutbox();
    }
    // If ONLINE and was already ONLINE (or initial UNKNOWN transition to ONLINE)
    else if (state === NodeState.ONLINE && prevState !== NodeState.ONLINE && prevState !== NodeState.DISCONNECTED) {
      await this.db.setAlertState(alertKey, NodeState.ONLINE, 1, { lastReceivedAt });
    }
  }

  /**
   * Check local agent collection health (Blocker 4: Alert when local agent fails)
   */
  async checkLocalAgentHealth() {
    const alertKey = `${this.config.serverId}:agent_health`;
    const latestMetrics = await this.db.getLatestMetrics(this.config.serverId);
    const recorded = await this.db.getAlertState(alertKey);
    const prevState = recorded ? recorded.current_state : 'HEALTHY';

    let isStale = false;
    let elapsedSec = 0;

    if (!latestMetrics) {
      isStale = true;
    } else {
      const metricTime = new Date(latestMetrics.created_at + 'Z').getTime();
      elapsedSec = Math.max(0, Math.floor((Date.now() - metricTime) / 1000));
      // If no new metrics for > 180s (3 missed cycles)
      if (elapsedSec > (this.config.disconnectThresholdSec || 180)) {
        isStale = true;
      }
    }

    if (isStale && prevState !== 'STALE') {
      const message = `⚠️ Cảnh báo: Monitor Agent trên [${this.config.serverName}] ngừng thu thập dữ liệu trong ${elapsedSec}s (>180s)! Dữ liệu tài nguyên có thể đã cũ (STALE).`;
      const alertPayload = {
        title: '⚠️ CẢNH BÁO: MONITOR AGENT NGỪNG THU THẬP',
        description: message,
        color: 0xE67E22,
        fields: [
          { name: 'VPS', value: this.config.serverName, inline: true },
          { name: 'Thời gian gián đoạn', value: `${elapsedSec}s`, inline: true }
        ]
      };

      await this.db.recordAlertTransition({
        alertKey,
        currentState: 'STALE',
        consecutiveCount: 1,
        details: { elapsedSec },
        serverId: this.config.serverId,
        eventType: 'MONITOR_DEGRADED',
        severity: 'WARNING',
        message,
        eventDetails: { elapsedSec },
        alertPayload
      });

      await this.processOutbox();
    } else if (!isStale && prevState === 'STALE') {
      const message = `✅ Monitor Agent trên [${this.config.serverName}] đã khôi phục thu thập chỉ số bình thường.`;
      const alertPayload = {
        title: '✅ PHỤC HỒI: MONITOR AGENT HOẠT ĐỘNG BÌNH THƯỜNG',
        description: message,
        color: 0x2ECC71,
        fields: [{ name: 'VPS', value: this.config.serverName, inline: true }]
      };

      await this.db.recordAlertTransition({
        alertKey,
        currentState: 'HEALTHY',
        consecutiveCount: 1,
        details: null,
        serverId: this.config.serverId,
        eventType: 'MONITOR_RECOVERED',
        severity: 'INFO',
        message,
        eventDetails: null,
        alertPayload
      });

      await this.processOutbox();
    }
  }

  /**
   * Check local app service health (11Ship or AutoTrade)
   */
  async checkLocalAppHealth() {
    const services = await this.db.getServicesByServer(this.config.serverId);
    for (const svc of services) {
      if (svc.status === 'DISABLED') continue;

      const alertKey = `${svc.service_id}:health`;
      const recorded = await this.db.getAlertState(alertKey);
      const prevState = recorded ? recorded.current_state : 'HEALTHY';

      if ((svc.status === 'UNHEALTHY' || svc.status === 'UNREACHABLE') && prevState !== svc.status) {
        const message = `⚠️ Dịch vụ [${svc.name}] trên [${this.config.serverName}] không phản hồi! Trạng thái: ${svc.status}. Lỗi: ${svc.last_error || 'N/A'}`;
        const alertPayload = {
          title: '🚨 CẢNH BÁO: DỊCH VỤ ỨNG DỤNG LỖI',
          description: message,
          color: 0xE74C3C,
          fields: [
            { name: 'Dịch vụ', value: svc.name, inline: true },
            { name: 'VPS', value: this.config.serverName, inline: true },
            { name: 'Chi tiết lỗi', value: svc.last_error || 'Không phản hồi HTTP health endpoint', inline: false }
          ]
        };

        await this.db.recordAlertTransition({
          alertKey,
          currentState: svc.status,
          consecutiveCount: 1,
          details: { error: svc.last_error },
          serverId: this.config.serverId,
          eventType: 'SERVICE_DOWN',
          severity: 'CRITICAL',
          message,
          eventDetails: { status: svc.status, error: svc.last_error },
          alertPayload
        });

        await this.processOutbox();
      } else if (svc.status === 'HEALTHY' && (prevState === 'UNHEALTHY' || prevState === 'UNREACHABLE')) {
        const message = `✅ Dịch vụ [${svc.name}] trên [${this.config.serverName}] đã hoạt động trở lại bình thường.`;
        const alertPayload = {
          title: '✅ PHỤC HỒI: DỊCH VỤ HOẠT ĐỘNG BÌNH THƯỜNG',
          description: message,
          color: 0x2ECC71,
          fields: [
            { name: 'Dịch vụ', value: svc.name, inline: true },
            { name: 'VPS', value: this.config.serverName, inline: true }
          ]
        };

        await this.db.recordAlertTransition({
          alertKey,
          currentState: 'HEALTHY',
          consecutiveCount: 1,
          details: null,
          serverId: this.config.serverId,
          eventType: 'SERVICE_RECOVERED',
          severity: 'INFO',
          message,
          eventDetails: null,
          alertPayload
        });

        await this.processOutbox();
      }
    }
  }

  /**
   * Check CPU, RAM, Disk resource thresholds for local server
   */
  async checkResources() {
    const serverId = this.config.serverId;
    const { cpuAlert, ramAlert, diskAlert, metrics } = await this.evaluator.evaluateResources(serverId);
    if (!metrics) return;

    // Blocker 5 & Finding 8: Only process new distinct metric snapshots
    if (metrics.id && metrics.id === this._lastEvaluatedMetricId[serverId]) {
      return; // already evaluated this sample
    }
    if (metrics.id) {
      this._lastEvaluatedMetricId[serverId] = metrics.id;
      // Persist to alert_state immediately so restarts don't re-evaluate
      await this.db.setAlertState(`${serverId}:resource_eval`, 'TRACKING', 0, { last_metric_id: metrics.id });
    }

    const resourceChecks = [
      { key: `${serverId}:cpu`, name: 'CPU', isHigh: cpuAlert, val: `${metrics.cpu_pct}%`, thresh: `${this.config.cpuThresholdPct}%` },
      { key: `${serverId}:ram`, name: 'RAM', isHigh: ramAlert, val: `${metrics.ram_pct}% (${metrics.ram_used_mb}/${metrics.ram_total_mb}MB)`, thresh: `${this.config.ramThresholdPct}%` },
      { key: `${serverId}:disk`, name: 'Disk', isHigh: diskAlert, val: `${metrics.disk_pct}% (${metrics.disk_used_gb}/${metrics.disk_total_gb}GB)`, thresh: `${this.config.diskThresholdPct}%` }
    ];

    for (const r of resourceChecks) {
      const recorded = await this.db.getAlertState(r.key);
      const prevCount = recorded ? recorded.consecutive_count : 0;
      const prevState = recorded ? recorded.current_state : 'NORMAL';

      if (r.isHigh) {
        const newCount = prevCount + 1;
        if (newCount >= this.config.consecutiveThresholdCount && prevState !== 'ALERTING') {
          const message = `⚠️ Tài nguyên ${r.name} trên [${this.config.serverName}] vượt ngưỡng (${r.val} >= ${r.thresh}) liên tục ${newCount} chu kỳ!`;
          const alertPayload = {
            title: `⚠️ CẢNH BÁO TÀI NGUYÊN: ${r.name.toUpperCase()} CAO`,
            description: message,
            color: 0xF39C12, // Orange
            fields: [
              { name: 'VPS', value: this.config.serverName, inline: true },
              { name: 'Sử dụng hiện tại', value: r.val, inline: true },
              { name: 'Ngưỡng cảnh báo', value: r.thresh, inline: true }
            ]
          };

          // Blocker 2 & 5: Atomic transition + persist last_metric_id
          await this.db.recordAlertTransition({
            alertKey: r.key,
            currentState: 'ALERTING',
            consecutiveCount: newCount,
            details: { value: r.val, last_metric_id: metrics.id },
            serverId,
            eventType: 'HIGH_RESOURCE',
            severity: 'WARNING',
            message,
            eventDetails: { resource: r.name, value: r.val, threshold: r.thresh, consecutive: newCount },
            alertPayload
          });

          await this.processOutbox();
        } else {
          // Blocker 5: Preserve consecutive count and metric ID across restarts
          await this.db.updateAlertCount(r.key, newCount, { last_metric_id: metrics.id, value: r.val });
        }
      } else {
        if (prevState === 'ALERTING') {
          const message = `✅ Tài nguyên ${r.name} trên [${this.config.serverName}] đã hạ xuống mức an toàn (${r.val} < ${r.thresh}).`;
          const alertPayload = {
            title: `✅ TÀI NGUYÊN BÌNH THƯỜNG: ${r.name.toUpperCase()}`,
            description: message,
            color: 0x2ECC71,
            fields: [
              { name: 'VPS', value: this.config.serverName, inline: true },
              { name: 'Mức hiện tại', value: r.val, inline: true }
            ]
          };

          await this.db.recordAlertTransition({
            alertKey: r.key,
            currentState: 'NORMAL',
            consecutiveCount: 0,
            details: { value: r.val, last_metric_id: metrics.id },
            serverId,
            eventType: 'RESOURCE_NORMALIZED',
            severity: 'INFO',
            message,
            eventDetails: { resource: r.name },
            alertPayload
          });

          await this.processOutbox();
        } else if (prevCount > 0) {
          await this.db.updateAlertCount(r.key, 0);
        }
      }
    }
  }

  /**
   * Check VPS expiry dates (30, 15, 7, 3, 1 days & overdue)
   */
  async checkExpiry() {
    const serverId = this.config.serverId;
    const expiryDate = this.config.expiryDate;
    if (!expiryDate) return;

    const { daysRemaining, thresholdHit, isOverdue } = this.evaluator.evaluateExpiry(expiryDate);
    if (thresholdHit === null || daysRemaining === null) return;

    const milestoneTag = isOverdue ? 'overdue' : `${thresholdHit}d`;
    const alertKey = `expiry:${serverId}:${expiryDate}:${milestoneTag}`;
    const recorded = await this.db.getAlertState(alertKey);

    if (recorded && recorded.current_state === 'ALERTED') {
      return;
    }

    let title, message, color;
    if (isOverdue) {
      title = '🚨 CẢNH BÁO KHẨN: VPS ĐÃ QUÁ HẠN!';
      message = `🚨 VPS [${this.config.serverName}] đã QUÁ HẠN vào ngày ${expiryDate} (quá hạn ${Math.abs(daysRemaining)} ngày). Cần gia hạn ngay lập tức!`;
      color = 0xE74C3C;
    } else if (daysRemaining === 0) {
      title = '⏰ ĐẾN HẠN THANH TOÁN HÔM NAY';
      message = `⏰ Dịch vụ [${this.config.serverName}] đến hạn thanh toán vào hôm nay (${expiryDate}). Cần thanh toán hoặc gia hạn.`;
      color = 0xE74C3C;
    } else {
      title = '⏰ CẢNH BÁO: VPS SẮP HẾT HẠN';
      message = `⏰ Dịch vụ [${this.config.serverName}] đến hạn thanh toán ngày ${expiryDate} (còn ${daysRemaining} ngày). Mốc nhắc: ${thresholdHit} ngày.`;
      color = daysRemaining <= 3 ? 0xE74C3C : 0xF1C40F;
    }

    const alertPayload = {
      title,
      description: message,
      color,
      fields: [
        { name: 'VPS', value: this.config.serverName, inline: true },
        { name: 'Ngày hết hạn', value: expiryDate, inline: true },
        { name: 'Tình trạng', value: isOverdue ? `Đã quá ${Math.abs(daysRemaining)} ngày` : (daysRemaining === 0 ? 'Đến hạn hôm nay' : `Còn lại ${daysRemaining} ngày`), inline: true }
      ]
    };

    // Blocker 2: Atomic transition + outbox queue
    await this.db.recordAlertTransition({
      alertKey,
      currentState: 'ALERTED',
      consecutiveCount: 1,
      details: { expiryDate, daysRemaining, milestone: milestoneTag },
      serverId,
      eventType: 'EXPIRY_WARNING',
      severity: (daysRemaining <= 3 || isOverdue) ? 'CRITICAL' : 'WARNING',
      message,
      eventDetails: { expiryDate, daysRemaining, milestone: milestoneTag },
      alertPayload
    });

    await this.processOutbox();
  }
}
