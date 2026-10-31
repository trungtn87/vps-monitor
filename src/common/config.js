export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'production';
  const serverId = env.SERVER_ID || 'vinahost';
  const isVinaHost = serverId.toLowerCase() === 'vinahost';

  const heartbeatSecret = env.HEARTBEAT_SECRET || (nodeEnv === 'test' ? 'test-shared-secret-at-least-32-chars-long' : '');
  const dashboardPass = env.DASHBOARD_PASS || '';
  const apiToken = env.API_TOKEN || '';

  // Fail-closed security validation in production
  if (nodeEnv === 'production') {
    if (!heartbeatSecret || heartbeatSecret === 'dev-secret-change-in-production' || heartbeatSecret.length < 32) {
      throw new Error('[SECURITY FATAL] HEARTBEAT_SECRET must be set and contain at least 32 characters in production.');
    }
    if (!dashboardPass && !apiToken) {
      throw new Error('[SECURITY FATAL] DASHBOARD_PASS or API_TOKEN must be configured in production (fail-closed authentication).');
    }
  }

  // Parse allowed Discord users & guilds
  const parseList = (str) => str ? str.split(',').map(s => s.trim()).filter(Boolean) : [];

  return {
    nodeEnv,
    
    // Server Identification
    serverId,
    serverName: env.SERVER_NAME || (isVinaHost ? 'VinaHost (11Ship)' : 'Nhân Hòa (AutoTrade)'),
    host: env.HOST || '0.0.0.0',
    port: parseInt(env.PORT || '5050', 10),
    dbPath: env.DB_PATH || (nodeEnv === 'test' ? ':memory:' : './data/monitor.db'),
    
    // TLS / HTTPS Transport
    tlsCertPath: env.TLS_CERT_PATH || '',
    tlsKeyPath: env.TLS_KEY_PATH || '',
    requireTls: env.REQUIRE_TLS === 'true' || env.REQUIRE_TLS === '1',

    // Peer Node
    peerServerId: env.PEER_SERVER_ID || (isVinaHost ? 'nhanhoa' : 'vinahost'),
    peerServerName: env.PEER_SERVER_NAME || (isVinaHost ? 'Nhân Hòa (AutoTrade)' : 'VinaHost (11Ship)'),
    peerUrl: env.PEER_URL || '',
    
    // Shared Secret for HMAC-SHA256 Cross-Node Heartbeat
    heartbeatSecret,
    heartbeatIntervalSec: parseInt(env.HEARTBEAT_INTERVAL_SEC || '60', 10),
    disconnectThresholdSec: parseInt(env.DISCONNECT_THRESHOLD_SEC || '180', 10),
    startupGraceSec: parseInt(env.STARTUP_GRACE_SEC || env.DISCONNECT_THRESHOLD_SEC || '180', 10),

    // App Health Endpoint (local service on this VPS)
    appServiceId: env.APP_SERVICE_ID || (isVinaHost ? '11ship' : 'autotrade'),
    appServiceName: env.APP_SERVICE_NAME || (isVinaHost ? '11Ship Backend' : 'AutoTrade Bot'),
    appHealthUrl: env.APP_HEALTH_URL || '',
    
    // Expiry dates (manually configured, YYYY-MM-DD)
    expiryDate: env.EXPIRY_DATE || '',
    peerExpiryDate: env.PEER_EXPIRY_DATE || '',

    // Dashboard Security (Fail-Closed)
    dashboardUser: env.DASHBOARD_USER || 'admin',
    dashboardPass,
    apiToken,

    // Discord Integration
    discordWebhookUrl: env.DISCORD_WEBHOOK_URL || '',
    discordBotToken: env.DISCORD_BOT_TOKEN || '',
    discordChannelId: env.DISCORD_CHANNEL_ID || '', // Finding 9: Distinct channel ID
    discordAppId: env.DISCORD_APP_ID || '',
    discordPublicKey: env.DISCORD_PUBLIC_KEY || '',
    discordAllowedUserIds: parseList(env.DISCORD_ALLOWED_USER_IDS || ''),
    discordAllowedGuildIds: parseList(env.DISCORD_ALLOWED_GUILD_IDS || ''),

    // Thresholds
    cpuThresholdPct: parseFloat(env.CPU_THRESHOLD_PCT || '85'),
    ramThresholdPct: parseFloat(env.RAM_THRESHOLD_PCT || '85'),
    diskThresholdPct: parseFloat(env.DISK_THRESHOLD_PCT || '85'),
    consecutiveThresholdCount: parseInt(env.CONSECUTIVE_THRESHOLD_COUNT || '3', 10),
    
    // Retention
    retentionDays: parseInt(env.RETENTION_DAYS || '30', 10)
  };
}
