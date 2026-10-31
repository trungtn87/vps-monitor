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
    this._lastEvaluatedMetricId = {}; // Finding 8: distinct metric sample tracker
  }

  /**
   * Dispatch an alert via persistent outbox (Finding 3: Zero-loss delivery)
   * Queues to SQLite alert_outbox and immediately attempts outbox processing.
   * @param {string} alertKey 
   * @param {object} embed 
   */
  async dispatchAlert(alertKey, embed) {
    try {
      this.db.queueAlert({ alertKey, payload: embed });
    } catch (err) {
      logger.error(`Error queueing alert ${alertKey} to outbox:`, err);
    }
    await this.processOutbox();
  }

  /**
   * Process pending alerts in the persistent outbox
   * Retries failed deliveries with exponential backoff.
   */
  async processOutbox() {
    let pendingAlerts;
    try {
      pendingAlerts = this.db.getPendingAlerts(10);
    } catch (err) {
      logger.error('Error fetching pending alerts from outbox:', err);
      return;
    }

    for (const alert of pendingAlerts) {
      let payload;
      try {
        payload = JSON.parse(alert.payload_json);
      } catch {
        this.db.markAlertDelivered(alert.id); // discard corrupt json
        continue;
      }

      try {
        const delivered = await this.notifier.sendAlert(payload);
        if (delivered) {
          this.db.markAlertDelivered(alert.id);
          logger.debug(`Alert #${alert.id} (${alert.alert_key}) delivered successfully.`);
        } else {
          // Discord failed or returned false: calculate exponential backoff (10s, 20s, 40s... max 300s)
          const attempts = alert.attempts + 1;
          const nextRetrySec = Math.min(300, Math.max(10, Math.pow(2, attempts) * 5));
          this.db.markAlertRetry(alert.id, attempts, nextRetrySec, 'Delivery returned false or rate limited');
          logger.warn(`Alert #${alert.id} delivery failed; scheduled retry in ${nextRetrySec}s (attempt ${attempts})`);
        }
      } catch (err) {
        const attempts = alert.attempts + 1;
        const nextRetrySec = Math.min(300, Math.max(10, Math.pow(2, attempts) * 5));
        this.db.markAlertRetry(alert.id, attempts, nextRetrySec, err.message);
        logger.error(`Exception delivering alert #${alert.id}:`, err);
      }
    }
  }

  /**
   * Run a full check cycle
   * Evaluates peer connectivity, local app health, resource thresholds, expiry, and outbox.
   */
  async checkCycle() {
    await this.checkPeerHeartbeat();
    await this.checkLocalAppHealth();
    await this.checkResources();
    await this.checkExpiry();
    await this.processOutbox();
  }

  /**
   * Check peer heartbeat connectivity
   * Handles startup grace and missing first heartbeat (Finding 4)
   */
  async checkPeerHeartbeat() {
    const peerId = this.config.peerServerId;
    const { state, elapsedSec, lastReceivedAt, isStartupFailure } = this.evaluator.evaluatePeerHeartbeat(peerId);

    const alertKey = `${peerId}:heartbeat`;
    const recorded = this.db.getAlertState(alertKey);
    const prevState = recorded ? recorded.current_state : NodeState.UNKNOWN;

    // Transition: became DISCONNECTED (either lost active heartbeat OR never sent heartbeat after grace period)
    if (state === NodeState.DISCONNECTED && prevState !== NodeState.DISCONNECTED) {
      logger.warn(`Peer ${peerId} is DISCONNECTED (no heartbeat for ${elapsedSec}s, startupFail: ${!!isStartupFailure})`);
      
      const message = isStartupFailure
        ? `⚠️ VPS [${this.config.peerServerName}] chưa từng gửi heartbeat sau ${elapsedSec}s khởi động! Có thể VPS đang tắt hoặc tiến trình monitor gặp lỗi.`
        : `⚠️ VPS [${this.config.peerServerName}] mất kết nối! Không nhận được heartbeat trong ${elapsedSec} giây (> 180s).`;

      this.db.recordEvent({
        serverId: peerId,
        eventType: 'HEARTBEAT_LOSS',
        severity: 'CRITICAL',
        message,
        details: { elapsedSec, lastReceivedAt, isStartupFailure: !!isStartupFailure }
      });

      this.db.setAlertState(alertKey, NodeState.DISCONNECTED, 1, { elapsedSec, lastReceivedAt });
      
      await this.dispatchAlert(alertKey, {
        title: isStartupFailure ? '🚨 CẢNH BÁO: KHÔNG CÓ HEARTBEAT KHỞI ĐỘNG' : '🚨 CẢNH BÁO: VPS MẤT KẾT NỐI',
        description: message,
        color: 0xE74C3C, // Red
        fields: [
          { name: 'VPS', value: this.config.peerServerName, inline: true },
          { name: 'Thời gian gián đoạn', value: `${elapsedSec}s`, inline: true },
          { name: 'Heartbeat cuối', value: lastReceivedAt ? `${lastReceivedAt} UTC` : 'Chưa từng nhận', inline: false }
        ]
      });
    }
    // Transition: RECOVERED after DISCONNECTED
    else if ((state === NodeState.RECOVERED || (state === NodeState.ONLINE && prevState === NodeState.DISCONNECTED))) {
      logger.info(`Peer ${peerId} has RECOVERED connection`);

      const message = `✅ VPS [${this.config.peerServerName}] đã khôi phục kết nối heartbeat thành công.`;
      this.db.recordEvent({
        serverId: peerId,
        eventType: 'RECOVERED',
        severity: 'INFO',
        message,
        details: { lastReceivedAt }
      });

      this.db.setAlertState(alertKey, NodeState.ONLINE, 1, { lastReceivedAt });

      await this.dispatchAlert(alertKey, {
        title: '✅ PHỤC HỒI: VPS ĐÃ KẾT NỐI LẠI',
        description: message,
        color: 0x2ECC71, // Green
        fields: [
          { name: 'VPS', value: this.config.peerServerName, inline: true },
          { name: 'Trạng thái hiện tại', value: 'ONLINE', inline: true },
          { name: 'Thời gian nhận lại', value: `${lastReceivedAt} UTC`, inline: false }
        ]
      });
    }
    // If ONLINE and was already ONLINE (or initial UNKNOWN transition to ONLINE)
    else if (state === NodeState.ONLINE && prevState !== NodeState.ONLINE && prevState !== NodeState.DISCONNECTED) {
      this.db.setAlertState(alertKey, NodeState.ONLINE, 1, { lastReceivedAt });
    }
  }

  /**
   * Check local app service health (11Ship or AutoTrade)
   */
  async checkLocalAppHealth() {
    const services = this.db.getServicesByServer(this.config.serverId);
    for (const svc of services) {
      if (svc.status === 'DISABLED') continue;

      const alertKey = `${svc.service_id}:health`;
      const recorded = this.db.getAlertState(alertKey);
      const prevState = recorded ? recorded.current_state : 'HEALTHY';

      if ((svc.status === 'UNHEALTHY' || svc.status === 'UNREACHABLE') && prevState !== svc.status) {
        const message = `⚠️ Dịch vụ [${svc.name}] trên [${this.config.serverName}] không phản hồi! Trạng thái: ${svc.status}. Lỗi: ${svc.last_error || 'N/A'}`;
        this.db.recordEvent({
          serverId: this.config.serverId,
          eventType: 'SERVICE_DOWN',
          severity: 'CRITICAL',
          message,
          details: { status: svc.status, error: svc.last_error }
        });

        this.db.setAlertState(alertKey, svc.status, 1, { error: svc.last_error });

        await this.dispatchAlert(alertKey, {
          title: '🚨 CẢNH BÁO: DỊCH VỤ ỨNG DỤNG LỖI',
          description: message,
          color: 0xE74C3C,
          fields: [
            { name: 'Dịch vụ', value: svc.name, inline: true },
            { name: 'VPS', value: this.config.serverName, inline: true },
            { name: 'Chi tiết lỗi', value: svc.last_error || 'Không phản hồi HTTP health endpoint', inline: false }
          ]
        });
      } else if (svc.status === 'HEALTHY' && (prevState === 'UNHEALTHY' || prevState === 'UNREACHABLE')) {
        const message = `✅ Dịch vụ [${svc.name}] trên [${this.config.serverName}] đã hoạt động trở lại bình thường.`;
        this.db.recordEvent({
          serverId: this.config.serverId,
          eventType: 'SERVICE_RECOVERED',
          severity: 'INFO',
          message
        });

        this.db.setAlertState(alertKey, 'HEALTHY', 1);

        await this.dispatchAlert(alertKey, {
          title: '✅ PHỤC HỒI: DỊCH VỤ HOẠT ĐỘNG BÌNH THƯỜNG',
          description: message,
          color: 0x2ECC71,
          fields: [
            { name: 'Dịch vụ', value: svc.name, inline: true },
            { name: 'VPS', value: this.config.serverName, inline: true }
          ]
        });
      }
    }
  }

  /**
   * Check CPU, RAM, Disk resource thresholds for local server
   * Avoids counting same metric twice (Finding 8)
   */
  async checkResources() {
    const serverId = this.config.serverId;
    const { cpuAlert, ramAlert, diskAlert, metrics } = this.evaluator.evaluateResources(serverId);
    if (!metrics) return;

    // Finding 8: Only process new distinct metric snapshots
    if (metrics.id && metrics.id === this._lastEvaluatedMetricId[serverId]) {
      return; // already evaluated this sample
    }
    if (metrics.id) {
      this._lastEvaluatedMetricId[serverId] = metrics.id;
    }

    const resourceChecks = [
      { key: `${serverId}:cpu`, name: 'CPU', isHigh: cpuAlert, val: `${metrics.cpu_pct}%`, thresh: `${this.config.cpuThresholdPct}%` },
      { key: `${serverId}:ram`, name: 'RAM', isHigh: ramAlert, val: `${metrics.ram_pct}% (${metrics.ram_used_mb}/${metrics.ram_total_mb}MB)`, thresh: `${this.config.ramThresholdPct}%` },
      { key: `${serverId}:disk`, name: 'Disk', isHigh: diskAlert, val: `${metrics.disk_pct}% (${metrics.disk_used_gb}/${metrics.disk_total_gb}GB)`, thresh: `${this.config.diskThresholdPct}%` }
    ];

    for (const r of resourceChecks) {
      const recorded = this.db.getAlertState(r.key);
      const prevCount = recorded ? recorded.consecutive_count : 0;
      const prevState = recorded ? recorded.current_state : 'NORMAL';

      if (r.isHigh) {
        const newCount = prevCount + 1;
        if (newCount >= this.config.consecutiveThresholdCount && prevState !== 'ALERTING') {
          // Trigger alert
          const message = `⚠️ Tài nguyên ${r.name} trên [${this.config.serverName}] vượt ngưỡng (${r.val} >= ${r.thresh}) liên tục ${newCount} chu kỳ!`;
          this.db.recordEvent({
            serverId,
            eventType: 'HIGH_RESOURCE',
            severity: 'WARNING',
            message,
            details: { resource: r.name, value: r.val, threshold: r.thresh, consecutive: newCount }
          });

          this.db.setAlertState(r.key, 'ALERTING', newCount, { value: r.val });

          await this.dispatchAlert(r.key, {
            title: `⚠️ CẢNH BÁO TÀI NGUYÊN: ${r.name.toUpperCase()} CAO`,
            description: message,
            color: 0xF39C12, // Orange
            fields: [
              { name: 'VPS', value: this.config.serverName, inline: true },
              { name: 'Sử dụng hiện tại', value: r.val, inline: true },
              { name: 'Ngưỡng cảnh báo', value: r.thresh, inline: true }
            ]
          });
        } else {
          this.db.updateAlertCount(r.key, newCount);
        }
      } else {
        if (prevState === 'ALERTING') {
          // Recovered to normal
          const message = `✅ Tài nguyên ${r.name} trên [${this.config.serverName}] đã hạ xuống mức an toàn (${r.val} < ${r.thresh}).`;
          this.db.recordEvent({
            serverId,
            eventType: 'RESOURCE_NORMALIZED',
            severity: 'INFO',
            message
          });

          this.db.setAlertState(r.key, 'NORMAL', 0);

          await this.dispatchAlert(r.key, {
            title: `✅ TÀI NGUYÊN BÌNH THƯỜNG: ${r.name.toUpperCase()}`,
            description: message,
            color: 0x2ECC71,
            fields: [
              { name: 'VPS', value: this.config.serverName, inline: true },
              { name: 'Mức hiện tại', value: r.val, inline: true }
            ]
          });
        } else if (prevCount > 0) {
          this.db.updateAlertCount(r.key, 0);
        }
      }
    }
  }

  /**
   * Check VPS expiry dates (30, 15, 7, 3, 1 days & overdue)
   * Finding 7: Alerts exactly once per milestone per expiry date (no daily spam)
   */
  async checkExpiry() {
    const serverId = this.config.serverId;
    const expiryDate = this.config.expiryDate;
    if (!expiryDate) return;

    const { daysRemaining, thresholdHit, isOverdue } = this.evaluator.evaluateExpiry(expiryDate);
    if (thresholdHit === null || daysRemaining === null) return;

    // Milestone key scoped to the specific expiryDate so renewal automatically resets milestones
    const milestoneTag = isOverdue ? 'overdue' : `${thresholdHit}d`;
    const alertKey = `expiry:${serverId}:${expiryDate}:${milestoneTag}`;
    const recorded = this.db.getAlertState(alertKey);

    // If this milestone has already been alerted for this expiryDate, do NOT alert again
    if (recorded && recorded.current_state === 'ALERTED') {
      return;
    }

    let title, message, color;
    if (isOverdue) {
      title = '🚨 CẢNH BÁO KHẨN: VPS ĐÃ QUÁ HẠN!';
      message = `🚨 VPS [${this.config.serverName}] đã QUÁ HẠN vào ngày ${expiryDate} (quá hạn ${Math.abs(daysRemaining)} ngày). Cần gia hạn ngay lập tức!`;
      color = 0xE74C3C;
    } else {
      title = '⏰ CẢNH BÁO: VPS SẮP HẾT HẠN';
      message = `⏰ VPS [${this.config.serverName}] sắp hết hạn vào ngày ${expiryDate} (còn ${daysRemaining} ngày). Mốc cảnh báo: ${thresholdHit} ngày.`;
      color = daysRemaining <= 3 ? 0xE74C3C : 0xF1C40F;
    }

    this.db.recordEvent({
      serverId,
      eventType: 'EXPIRY_WARNING',
      severity: (daysRemaining <= 3 || isOverdue) ? 'CRITICAL' : 'WARNING',
      message,
      details: { expiryDate, daysRemaining, milestone: milestoneTag }
    });

    this.db.setAlertState(alertKey, 'ALERTED', 1, { expiryDate, daysRemaining, milestone: milestoneTag });

    await this.dispatchAlert(alertKey, {
      title,
      description: message,
      color,
      fields: [
        { name: 'VPS', value: this.config.serverName, inline: true },
        { name: 'Ngày hết hạn', value: expiryDate, inline: true },
        { name: 'Tình trạng', value: isOverdue ? `Đã quá ${Math.abs(daysRemaining)} ngày` : `Còn lại ${daysRemaining} ngày`, inline: true }
      ]
    });
  }
}
