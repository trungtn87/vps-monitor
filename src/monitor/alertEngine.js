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
  }

  /**
   * Run a full check cycle
   * Evaluates peer connectivity, local app health, resource thresholds, and expiry.
   */
  async checkCycle() {
    await this.checkPeerHeartbeat();
    await this.checkLocalAppHealth();
    await this.checkResources();
    await this.checkExpiry();
  }

  /**
   * Check peer heartbeat connectivity
   */
  async checkPeerHeartbeat() {
    const peerId = this.config.peerServerId;
    const { state, elapsedSec, lastReceivedAt } = this.evaluator.evaluatePeerHeartbeat(peerId);

    const alertKey = `${peerId}:heartbeat`;
    const recorded = this.db.getAlertState(alertKey);
    const prevState = recorded ? recorded.current_state : NodeState.UNKNOWN;

    // Transition: became DISCONNECTED
    if (state === NodeState.DISCONNECTED && prevState !== NodeState.DISCONNECTED) {
      logger.warn(`Peer ${peerId} is DISCONNECTED (no heartbeat for ${elapsedSec}s)`);
      
      const message = `⚠️ VPS [${this.config.peerServerName}] mất kết nối! Không nhận được heartbeat trong ${elapsedSec} giây (> 180s).`;
      this.db.recordEvent({
        serverId: peerId,
        eventType: 'HEARTBEAT_LOSS',
        severity: 'CRITICAL',
        message,
        details: { elapsedSec, lastReceivedAt }
      });

      this.db.setAlertState(alertKey, NodeState.DISCONNECTED, 1, { elapsedSec, lastReceivedAt });
      
      await this.notifier.sendAlert({
        title: '🚨 CẢNH BÁO: VPS MẤT KẾT NỐI',
        description: message,
        color: 0xE74C3C, // Red
        fields: [
          { name: 'VPS', value: this.config.peerServerName, inline: true },
          { name: 'Thời gian gián đoạn', value: `${elapsedSec}s`, inline: true },
          { name: 'Heartbeat cuối', value: lastReceivedAt ? `${lastReceivedAt} UTC` : 'Chưa có', inline: false }
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

      await this.notifier.sendAlert({
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

        await this.notifier.sendAlert({
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

        await this.notifier.sendAlert({
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
   */
  async checkResources() {
    const serverId = this.config.serverId;
    const { cpuAlert, ramAlert, diskAlert, metrics } = this.evaluator.evaluateResources(serverId);
    if (!metrics) return;

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

          await this.notifier.sendAlert({
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

          await this.notifier.sendAlert({
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
   * Check VPS expiry dates (30, 15, 7, 3, 1 days)
   * Each node monitors its own expiry; deduplicated once per calendar day.
   */
  async checkExpiry() {
    const serverId = this.config.serverId;
    const expiryDate = this.config.expiryDate;
    if (!expiryDate) return;

    const { daysRemaining, thresholdHit } = this.evaluator.evaluateExpiry(expiryDate);
    if (thresholdHit === null || daysRemaining === null) return;

    const todayStr = new Date().toISOString().slice(0, 10);
    const alertKey = `expiry:${serverId}:${thresholdHit}d`;
    const recorded = this.db.getAlertState(alertKey);

    // If already alerted today for this threshold, skip
    if (recorded && recorded.last_alerted_at && recorded.last_alerted_at.startsWith(todayStr)) {
      return;
    }

    const message = `⏰ VPS [${this.config.serverName}] sắp hết hạn vào ngày ${expiryDate} (còn ${daysRemaining} ngày). Ngưỡng cảnh báo: ${thresholdHit} ngày.`;
    this.db.recordEvent({
      serverId,
      eventType: 'EXPIRY_WARNING',
      severity: daysRemaining <= 3 ? 'CRITICAL' : 'WARNING',
      message,
      details: { expiryDate, daysRemaining, thresholdHit }
    });

    this.db.setAlertState(alertKey, 'ALERTED', 1, { expiryDate, daysRemaining, date: todayStr });

    await this.notifier.sendAlert({
      title: '⏰ CẢNH BÁO: VPS SẮP HẾT HẠN',
      description: message,
      color: daysRemaining <= 3 ? 0xE74C3C : 0xF1C40F, // Red or Yellow
      fields: [
        { name: 'VPS', value: this.config.serverName, inline: true },
        { name: 'Ngày hết hạn', value: expiryDate, inline: true },
        { name: 'Số ngày còn lại', value: `${daysRemaining} ngày`, inline: true }
      ]
    });
  }
}
