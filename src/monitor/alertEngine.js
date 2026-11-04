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
  /** Three consecutive 30-second checks after a heartbeat timeout before Discord. */
  async checkPeerHeartbeat() {
    const peerId = this.config.peerServerId;
    const { state, elapsedSec, lastReceivedAt, isStartupFailure } = await this.evaluator.evaluatePeerHeartbeat(peerId);
    const alertKey = `${peerId}:heartbeat`;
    const recorded = await this.db.getAlertState(alertKey);
    const prevState = recorded?.current_state || NodeState.UNKNOWN;
    const threshold = this.config.connectionAlertConsecutiveCount || 3;
    if (state === NodeState.DISCONNECTED) {
      if (prevState === NodeState.DISCONNECTED) return; // One alert per outage.
      const count = prevState === 'DISCONNECTED_PENDING' ? Number(recorded.consecutive_count || 0) + 1 : 1;
      if (count < threshold) {
        await this.db.setAlertState(alertKey, 'DISCONNECTED_PENDING', count,
          { elapsedSec, lastReceivedAt, isStartupFailure: !!isStartupFailure });
        return;
      }
      const message = isStartupFailure
        ? `⚠️ VPS [${this.config.peerServerName}] chưa từng gửi heartbeat sau khởi động; lỗi liên tiếp ${count} lần kiểm tra.`
        : `⚠️ VPS [${this.config.peerServerName}] mất kết nối! Không nhận heartbeat ${elapsedSec}s, xác nhận liên tiếp ${count} lần kiểm tra.`;
      const alertPayload = {
        title: isStartupFailure ? '🚨 KHÔNG CÓ HEARTBEAT KHỞI ĐỘNG' : '🚨 VPS MẤT KẾT NỐI',
        description: message, color: 0xE74C3C,
        fields: [
          { name: 'VPS', value: this.config.peerServerName, inline: true },
          { name: 'Xác nhận', value: `${count} lần kiểm tra liên tiếp`, inline: true },
          { name: 'Heartbeat cuối', value: lastReceivedAt ? `${lastReceivedAt} UTC` : 'Chưa từng nhận', inline: false }
        ]
      };
      await this.db.recordAlertTransition({
        alertKey, currentState: NodeState.DISCONNECTED, consecutiveCount: count,
        details: { elapsedSec, lastReceivedAt, isStartupFailure: !!isStartupFailure },
        serverId: peerId, eventType: 'HEARTBEAT_LOSS', severity: 'CRITICAL',
        message, eventDetails: { elapsedSec, lastReceivedAt, consecutive: count }, alertPayload
      });
      await this.processOutbox();
      return;
    }
    if (state === NodeState.ONLINE || state === NodeState.RECOVERED) {
      if (prevState === NodeState.DISCONNECTED) {
        const message = `✅ VPS [${this.config.peerServerName}] đã khôi phục kết nối heartbeat.`;
        await this.db.recordAlertTransition({
          alertKey, currentState: NodeState.ONLINE, consecutiveCount: 0,
          details: { lastReceivedAt }, serverId: peerId, eventType: 'RECOVERED',
          severity: 'INFO', message, eventDetails: { lastReceivedAt },
          alertPayload: { title: '✅ PHỤC HỒI: VPS ĐÃ KẾT NỐI LẠI', description: message,
            color: 0x2ECC71, fields: [{ name: 'VPS', value: this.config.peerServerName, inline: true }] }
        });
        await this.processOutbox();
      } else if (prevState !== NodeState.ONLINE) {
        // Transient one- or two-check failure: reset without any Discord message.
        await this.db.setAlertState(alertKey, NodeState.ONLINE, 0, { lastReceivedAt });
      }
    } else if (prevState === 'DISCONNECTED_PENDING') {
      await this.db.setAlertState(alertKey, NodeState.UNKNOWN, 0, { lastReceivedAt });
    }
  }

  /**
   * Check local agent collection health (Blocker 4: Alert when local agent fails)
   */
  /** Treat agent telemetry gaps as an incident only after three stale checks. */
  async checkLocalAgentHealth() {
    const alertKey = `${this.config.serverId}:agent_health`;
    const latestMetrics = await this.db.getLatestMetrics(this.config.serverId);
    const recorded = await this.db.getAlertState(alertKey);
    const prevState = recorded?.current_state || 'HEALTHY';
    const threshold = this.config.connectionAlertConsecutiveCount || 3;
    let elapsedSec = 0;
    let isStale = !latestMetrics;
    if (latestMetrics) {
      const time = Date.parse(`${latestMetrics.created_at}Z`);
      elapsedSec = Number.isFinite(time) ? Math.max(0, Math.floor((Date.now()-time)/1000)) : Infinity;
      if (elapsedSec > (this.config.disconnectThresholdSec || 180)) isStale = true;
    }
    if (isStale) {
      if (prevState === 'STALE') return;
      const count = prevState === 'STALE_PENDING' ? Number(recorded.consecutive_count || 0)+1 : 1;
      if (count < threshold) {
        await this.db.setAlertState(alertKey, 'STALE_PENDING', count, { elapsedSec });
        return;
      }
      const message = `⚠️ Monitor Agent [${this.config.serverName}] ngừng thu thập chỉ số sau ${count} lần kiểm tra liên tiếp (dữ liệu cũ: ${elapsedSec}s).`;
      await this.db.recordAlertTransition({
        alertKey, currentState:'STALE', consecutiveCount:count,
        details:{elapsedSec}, serverId:this.config.serverId,
        eventType:'MONITOR_DEGRADED', severity:'WARNING', message,
        eventDetails:{elapsedSec,consecutive:count},
        alertPayload:{title:'⚠️ MONITOR AGENT NGỪNG THU THẬP', description:message,
          color:0xE67E22, fields:[
            {name:'VPS',value:this.config.serverName,inline:true},
            {name:'Xác nhận',value:`${count} lần kiểm tra`,inline:true}
          ]}
      });
      await this.processOutbox();
    } else if (prevState === 'STALE') {
      const message = `✅ Monitor Agent [${this.config.serverName}] đã khôi phục thu thập chỉ số.`;
      await this.db.recordAlertTransition({
        alertKey, currentState:'HEALTHY', consecutiveCount:0,
        details:null, serverId:this.config.serverId, eventType:'MONITOR_RECOVERED',
        severity:'INFO',message,eventDetails:null,
        alertPayload:{title:'✅ PHỤC HỒI: MONITOR AGENT HOẠT ĐỘNG BÌNH THƯỜNG',description:message,
          color:0x2ECC71,fields:[{name:'VPS',value:this.config.serverName,inline:true}]}
      });
      await this.processOutbox();
    } else if (prevState === 'STALE_PENDING') {
      await this.db.setAlertState(alertKey,'HEALTHY',0,null);
    }
  }

  /**
   * Check local app service health (11Ship or AutoTrade)
   */
  /** Health endpoints must fail three consecutive checks before Discord. */
  async checkLocalAppHealth() {
    const services = await this.db.getServicesByServer(this.config.serverId);
    const threshold = this.config.connectionAlertConsecutiveCount || 3;
    for (const svc of services) {
      const alertKey = `${svc.service_id}:health`;
      const recorded = await this.db.getAlertState(alertKey);
      const prevState = recorded?.current_state || 'HEALTHY';
      const failed = svc.status === 'UNHEALTHY' || svc.status === 'UNREACHABLE';
      const latched = ['DOWN','UNHEALTHY','UNREACHABLE'].includes(prevState);
      if (failed) {
        if (latched) continue; // Do not repeat when error subtype changes.
        const count = prevState === 'DOWN_PENDING' ? Number(recorded.consecutive_count || 0) + 1 : 1;
        if (count < threshold) {
          await this.db.setAlertState(alertKey,'DOWN_PENDING',count,
            { status: svc.status, error: svc.last_error });
          continue;
        }
        const message = `⚠️ Dịch vụ [${svc.name}] trên [${this.config.serverName}] lỗi ${count} lần kiểm tra liên tiếp! Trạng thái: ${svc.status}.`;
        await this.db.recordAlertTransition({
          alertKey, currentState:'DOWN', consecutiveCount:count,
          details:{ status:svc.status,error:svc.last_error },
          serverId:this.config.serverId, eventType:'SERVICE_DOWN', severity:'CRITICAL',
          message, eventDetails:{ status:svc.status,error:svc.last_error,consecutive:count },
          alertPayload:{
            title:'🚨 DỊCH VỤ ỨNG DỤNG MẤT KẾT NỐI', description:message, color:0xE74C3C,
            fields:[{name:'Dịch vụ',value:svc.name,inline:true},
              {name:'VPS',value:this.config.serverName,inline:true},
              {name:'Xác nhận',value:`${count} lần kiểm tra`,inline:true}]
          }
        });
        await this.processOutbox();
      } else if (svc.status === 'HEALTHY') {
        if (latched) {
          const message=`✅ Dịch vụ [${svc.name}] trên [${this.config.serverName}] đã hoạt động lại.`;
          await this.db.recordAlertTransition({
            alertKey, currentState:'HEALTHY', consecutiveCount:0, details:null,
            serverId:this.config.serverId, eventType:'SERVICE_RECOVERED', severity:'INFO',
            message, eventDetails:null,
            alertPayload:{title:'✅ DỊCH VỤ ĐÃ KHÔI PHỤC',description:message,color:0x2ECC71,
              fields:[{name:'Dịch vụ',value:svc.name,inline:true}]}
          });
          await this.processOutbox();
        } else if (prevState === 'DOWN_PENDING') {
          await this.db.setAlertState(alertKey,'HEALTHY',0,null);
        }
      } else if (prevState === 'DOWN_PENDING') {
        await this.db.setAlertState(alertKey,'HEALTHY',0,null);
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
   * Send one Discord reminder on D-1 (Vietnam calendar day).
   * The persisted alert key is unique per server/date, preventing repeats
   * across the 30-second alert cycle and subsequent process restarts.
   */
  async checkExpiry() {
    const serverId = this.config.serverId;
    const expiryDate = this.config.expiryDate;
    if (!expiryDate) return;

    const { daysRemaining, thresholdHit } = this.evaluator.evaluateExpiry(expiryDate);
    if (thresholdHit !== 1 || daysRemaining !== 1) return;

    const alertKey = `expiry:${serverId}:${expiryDate}:1d`;
    const recorded = await this.db.getAlertState(alertKey);
    if (recorded?.current_state === 'ALERTED') return;

    const message = `⏰ Dịch vụ [${this.config.serverName}] sẽ đến hạn thanh toán ngày ${expiryDate} (còn 1 ngày). Vui lòng thanh toán hoặc gia hạn.`;
    const alertPayload = {
      title: '⏰ NHẮC THANH TOÁN TRƯỚC 1 NGÀY',
      description: message,
      color: 0xF1C40F,
      fields: [
        { name: 'Dịch vụ', value: this.config.serverName, inline: true },
        { name: 'Hạn thanh toán', value: expiryDate, inline: true },
        { name: 'Còn lại', value: '1 ngày', inline: true }
      ]
    };

    await this.db.recordAlertTransition({
      alertKey,
      currentState: 'ALERTED',
      consecutiveCount: 1,
      details: { expiryDate, daysRemaining, milestone: '1d' },
      serverId,
      eventType: 'EXPIRY_WARNING',
      severity: 'WARNING',
      message,
      eventDetails: { expiryDate, daysRemaining, milestone: '1d' },
      alertPayload
    });
    await this.processOutbox();
  }
}
