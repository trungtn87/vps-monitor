export function loadConfig(env = process.env) {
  const serverId = env.SERVER_ID || 'vinahost';
  const isVinaHost = serverId.toLowerCase() === 'vinahost';

  return {
    nodeEnv: env.NODE_ENV || 'production',
    
    // Server Identification
    serverId,
    serverName: env.SERVER_NAME || (isVinaHost ? 'VinaHost (11Ship)' : 'Nhân Hòa (AutoTrade)'),
    host: env.HOST || '0.0.0.0',
    port: parseInt(env.PORT || '5050', 10),
    dbPath: env.DB_PATH || (env.NODE_ENV === 'test' ? ':memory:' : './data/monitor.db'),
    
    // Peer Node
    peerServerId: env.PEER_SERVER_ID || (isVinaHost ? 'nhanhoa' : 'vinahost'),
    peerServerName: env.PEER_SERVER_NAME || (isVinaHost ? 'Nhân Hòa (AutoTrade)' : 'VinaHost (11Ship)'),
    peerUrl: env.PEER_URL || '',
    
    // Shared Secret for HMAC-SHA256 Cross-Node Heartbeat
    heartbeatSecret: env.HEARTBEAT_SECRET || 'dev-secret-change-in-production',
    heartbeatIntervalSec: parseInt(env.HEARTBEAT_INTERVAL_SEC || '60', 10),
    disconnectThresholdSec: parseInt(env.DISCONNECT_THRESHOLD_SEC || '180', 10),

    // App Health Endpoint (local service on this VPS)
    appServiceId: env.APP_SERVICE_ID || (isVinaHost ? '11ship' : 'autotrade'),
    appServiceName: env.APP_SERVICE_NAME || (isVinaHost ? '11Ship Backend' : 'AutoTrade Bot'),
    appHealthUrl: env.APP_HEALTH_URL || '',
    
    // Expiry dates (manually configured, YYYY-MM-DD)
    expiryDate: env.EXPIRY_DATE || '',
    peerExpiryDate: env.PEER_EXPIRY_DATE || '',

    // Dashboard Security
    dashboardUser: env.DASHBOARD_USER || 'admin',
    dashboardPass: env.DASHBOARD_PASS || '',
    apiToken: env.API_TOKEN || '',

    // Discord Integration
    discordWebhookUrl: env.DISCORD_WEBHOOK_URL || '',
    discordBotToken: env.DISCORD_BOT_TOKEN || '',
    discordPublicKey: env.DISCORD_PUBLIC_KEY || '',
    discordAppId: env.DISCORD_APP_ID || '',

    // Thresholds
    cpuThresholdPct: parseFloat(env.CPU_THRESHOLD_PCT || '85'),
    ramThresholdPct: parseFloat(env.RAM_THRESHOLD_PCT || '85'),
    diskThresholdPct: parseFloat(env.DISK_THRESHOLD_PCT || '85'),
    consecutiveThresholdCount: parseInt(env.CONSECUTIVE_THRESHOLD_COUNT || '3', 10),
    
    // Retention
    retentionDays: parseInt(env.RETENTION_DAYS || '30', 10)
  };
}
