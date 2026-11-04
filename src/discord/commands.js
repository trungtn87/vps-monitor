import { NodeState } from '../monitor/evaluator.js';

export class DiscordCommands {
  /**
   * @param {object} options
   * @param {import('../db/database.js').MonitorDatabase} options.db
   * @param {import('../monitor/evaluator.js').MonitorEvaluator} options.evaluator
   * @param {object} options.config
   */
  constructor({ db, evaluator, config }) {
    this.db = db;
    this.evaluator = evaluator;
    this.config = config;
  }

  async _formatServerDetails(serverId) {
    const isLocal = serverId === this.config.serverId;
    const name = isLocal ? this.config.serverName : this.config.peerServerName;
    const expiry = isLocal ? this.config.expiryDate : this.config.peerExpiryDate;
    
    // Connectivity
    let state = NodeState.ONLINE;
    let hbInfo = 'Local Node';
    if (!isLocal) {
      const evalRes = await this.evaluator.evaluatePeerHeartbeat(serverId);
      state = evalRes.state;
      hbInfo = evalRes.lastReceivedAt ? `${evalRes.elapsedSec}s trước` : 'Chưa nhận';
    }

    const stateEmoji = state === NodeState.ONLINE ? '🟢' : (state === NodeState.DISCONNECTED ? '🔴' : '⚪');

    // Metrics
    const metrics = await this.db.getLatestMetrics(serverId);
    const cpuStr = metrics ? `${metrics.cpu_pct}%` : 'N/A';
    const ramStr = metrics ? `${metrics.ram_pct}% (${metrics.ram_used_mb}/${metrics.ram_total_mb}MB)` : 'N/A';
    const diskStr = metrics ? `${metrics.disk_pct}% (${metrics.disk_used_gb}/${metrics.disk_total_gb}GB)` : 'N/A';
    const uptimeStr = metrics ? `${Math.floor(metrics.uptime_sec / 86400)}d ${Math.floor((metrics.uptime_sec % 86400) / 3600)}h` : 'N/A';

    // Service
    const services = await this.db.getServicesByServer(serverId);
    let appStatusStr = 'Chưa cấu hình';
    if (services.length > 0) {
      const s = services[0];
      const emoji = s.status === 'HEALTHY' ? '✅' : (s.status === 'UNHEALTHY' || s.status === 'UNREACHABLE' ? '❌' : '⚪');
      appStatusStr = `${emoji} ${s.name} (${s.status})`;
    }

    // Expiry
    const expRes = this.evaluator.evaluateExpiry(expiry);
    const expStr = expRes.daysRemaining !== null ? `${expiry} (còn ${expRes.daysRemaining} ngày)` : 'Chưa cấu hình';

    return {
      serverId,
      name,
      state,
      stateEmoji,
      hbInfo,
      cpuStr,
      ramStr,
      diskStr,
      uptimeStr,
      appStatusStr,
      expStr
    };
  }

  /**
   * Handle /status
   */
  async handleStatus() {
    const vh = await this._formatServerDetails('vinahost');
    const nh = await this._formatServerDetails('nhanhoa');

    return {
      type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
      data: {
        embeds: [
          {
            title: '📊 TỔNG QUAN HỆ THỐNG VPS MONITOR',
            color: (vh.state === NodeState.ONLINE && nh.state === NodeState.ONLINE) ? 0x2ECC71 : 0xE74C3C,
            fields: [
              {
                name: `${vh.stateEmoji} ${vh.name}`,
                value: `• **Trạng thái:** ${vh.state}\n• **Heartbeat:** ${vh.hbInfo}\n• **CPU / RAM / Disk:** ${vh.cpuStr} | ${vh.ramStr} | ${vh.diskStr}\n• **Dịch vụ:** ${vh.appStatusStr}\n• **Hạn VPS:** ${vh.expStr}`,
                inline: false
              },
              {
                name: `${nh.stateEmoji} ${nh.name}`,
                value: `• **Trạng thái:** ${nh.state}\n• **Heartbeat:** ${nh.hbInfo}\n• **CPU / RAM / Disk:** ${nh.cpuStr} | ${nh.ramStr} | ${nh.diskStr}\n• **Dịch vụ:** ${nh.appStatusStr}\n• **Hạn VPS:** ${nh.expStr}`,
                inline: false
              }
            ],
            footer: { text: `Cập nhật: ${new Date().toISOString()}` }
          }
        ]
      }
    };
  }

  /**
   * Handle /vinahost
   */
  async handleVinaHost() {
    const vh = await this._formatServerDetails('vinahost');
    return {
      type: 4,
      data: {
        embeds: [
          {
            title: `${vh.stateEmoji} CHI TIẾT SỨC KHỎE VINAHOST (11SHIP)`,
            color: vh.state === NodeState.ONLINE ? 0x3498DB : 0xE74C3C,
            fields: [
              { name: 'Trạng thái', value: `${vh.stateEmoji} ${vh.state}`, inline: true },
              { name: 'Heartbeat', value: vh.hbInfo, inline: true },
              { name: 'Uptime', value: vh.uptimeStr, inline: true },
              { name: 'CPU Usage', value: vh.cpuStr, inline: true },
              { name: 'RAM Usage', value: vh.ramStr, inline: true },
              { name: 'Disk Usage', value: vh.diskStr, inline: true },
              { name: '11Ship App Service', value: vh.appStatusStr, inline: false },
              { name: 'Ngày hết hạn VPS', value: vh.expStr, inline: false }
            ],
            footer: { text: `Cập nhật: ${new Date().toISOString()}` }
          }
        ]
      }
    };
  }

  /**
   * Handle /nhanhoa
   */
  async handleNhanHoa() {
    const nh = await this._formatServerDetails('nhanhoa');
    return {
      type: 4,
      data: {
        embeds: [
          {
            title: `${nh.stateEmoji} CHI TIẾT SỨC KHỎE NHÂN HÒA (AUTOTRADE)`,
            color: nh.state === NodeState.ONLINE ? 0x9B59B6 : 0xE74C3C,
            fields: [
              { name: 'Trạng thái', value: `${nh.stateEmoji} ${nh.state}`, inline: true },
              { name: 'Heartbeat', value: nh.hbInfo, inline: true },
              { name: 'Uptime', value: nh.uptimeStr, inline: true },
              { name: 'CPU Usage', value: nh.cpuStr, inline: true },
              { name: 'RAM Usage', value: nh.ramStr, inline: true },
              { name: 'Disk Usage', value: nh.diskStr, inline: true },
              { name: 'AutoTrade Bot Service', value: nh.appStatusStr, inline: false },
              { name: 'Ngày hết hạn VPS', value: nh.expStr, inline: false }
            ],
            footer: { text: `Cập nhật: ${new Date().toISOString()}` }
          }
        ]
      }
    };
  }

  /**
   * Handle /expiry
   */
  handleExpiry() {
    const isVhLocal = this.config.serverId === 'vinahost';
    const vhExpDate = isVhLocal ? this.config.expiryDate : this.config.peerExpiryDate;
    const nhExpDate = !isVhLocal ? this.config.expiryDate : this.config.peerExpiryDate;

    const vhExp = this.evaluator.evaluateExpiry(vhExpDate);
    const nhExp = this.evaluator.evaluateExpiry(nhExpDate);

    const vhWarn = (vhExp.daysRemaining !== null && vhExp.daysRemaining <= 7) ? '⚠️ Sắp hết hạn' : 'Đang hoạt động';
    const nhWarn = (nhExp.daysRemaining !== null && nhExp.daysRemaining <= 7) ? '⚠️ Sắp hết hạn' : 'Đang hoạt động';

    return {
      type: 4,
      data: {
        embeds: [
          {
            title: '⏰ THỜI HẠN DỊCH VỤ VPS VINAHOST & NHÂN HÒA',
            color: (vhExp.daysRemaining <= 7 || nhExp.daysRemaining <= 7) ? 0xE67E22 : 0x2ECC71,
            fields: [
              {
                name: 'VinaHost (11Ship)',
                value: `• **Ngày hết hạn:** ${vhExpDate || 'Chưa cấu hình'}\n• **Còn lại:** ${vhExp.daysRemaining !== null ? `${vhExp.daysRemaining} ngày` : 'N/A'}\n• **Đánh giá:** ${vhWarn}`,
                inline: false
              },
              {
                name: 'Nhân Hòa (AutoTrade)',
                value: `• **Ngày hết hạn:** ${nhExpDate || 'Chưa cấu hình'}\n• **Còn lại:** ${nhExp.daysRemaining !== null ? `${nhExp.daysRemaining} ngày` : 'N/A'}\n• **Đánh giá:** ${nhWarn}`,
                inline: false
              }
            ],
            footer: { text: 'Ngưỡng cảnh báo: 30, 15, 7, 3 và 1 ngày' }
          }
        ]
      }
    };
  }

  /**
   * Dispatch interaction command
   * @param {string} commandName 
   * @returns {object}
   */
  async dispatch(commandName) {
    switch (commandName.toLowerCase()) {
      case 'status':
        return await this.handleStatus();
      case 'vinahost':
        return await this.handleVinaHost();
      case 'nhanhoa':
        return await this.handleNhanHoa();
      case 'expiry':
        return this.handleExpiry();
      default:
        return {
          type: 4,
          data: { content: `Lệnh không hợp lệ: /${commandName}` }
        };
    }
  }
}
