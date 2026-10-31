export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'production';
  const serverId = env.SERVER_ID || 'vinahost';
  const isVinaHost = serverId.toLowerCase() === 'vinahost';

  const heartbeatSecret = env.HEARTBEAT_SECRET || (nodeEnv === 'test' ? 'test-shared-secret-at-least-32-chars-long' : '');
  const dashboardPass = env.DASHBOARD_PASS || '';
  const apiToken = env.API_TOKEN || '';
  const requireTls = env.REQUIRE_TLS === 'true' || env.REQUIRE_TLS === '1';
  const allowInsecureHttp = env.ALLOW_INSECURE_HTTP === 'true' || env.ALLOW_INSECURE_HTTP === '1';
  // Vibe Hosting terminates public HTTPS before forwarding private HTTP to the app.
  // Explicit opt-in only; the runtime must never expose its container port directly.
  const vibeHosting = env.VIBE_HOSTING === 'true';
  const trustedPlatformProxy = env.TRUSTED_PLATFORM_PROXY === 'true';
  const publicDashboard = env.PUBLIC_DASHBOARD === 'true';
  const dbBackend = env.DB_BACKEND || (vibeHosting && nodeEnv === 'production' ? 'supabase_postgres' : 'sqlite');
  const databaseUrl = env.DATABASE_URL || '';
  const host = env.HOST || (nodeEnv === 'production' && !requireTls ? '127.0.0.1' : '0.0.0.0');

  // Fail-closed security validation in production
  if (nodeEnv === 'production') {
    if (!heartbeatSecret || heartbeatSecret === 'dev-secret-change-in-production' || heartbeatSecret.length < 32) {
      throw new Error('[SECURITY FATAL] HEARTBEAT_SECRET must be set and contain at least 32 characters in production.');
    }
    if (vibeHosting && dbBackend !== 'supabase_postgres') {
      throw new Error('[DB CONFIG ERROR] Production Vibe requires DB_BACKEND=supabase_postgres; SQLite is not supported.');
    }
    if (dbBackend === 'supabase_postgres' && !databaseUrl) {
      throw new Error('[DB CONFIG ERROR] DATABASE_URL required for Supabase PostgreSQL.');
    }
    if (publicDashboard && (!vibeHosting || !trustedPlatformProxy)) {
      throw new Error('[SECURITY FATAL] PUBLIC_DASHBOARD=true is allowed only for Vibe behind the configured HTTPS platform proxy.');
    }
    if (!publicDashboard && !dashboardPass && !apiToken) {
      throw new Error('[SECURITY FATAL] DASHBOARD_PASS or API_TOKEN must be configured in production (fail-closed authentication).');
    }
    if (vibeHosting && (!trustedPlatformProxy || requireTls || host !== '0.0.0.0')) {
      throw new Error('[SECURITY FATAL] VIBE_HOSTING needs TRUSTED_PLATFORM_PROXY=true, REQUIRE_TLS=false, HOST=0.0.0.0 behind the platform HTTPS ingress.');
    }
    // Review Round 3: Prevent unencrypted public HTTP when terminating TLS via reverse proxy
    if (!requireTls && host === '0.0.0.0' && !allowInsecureHttp && !(vibeHosting && trustedPlatformProxy)) {
      throw new Error(
        '[SECURITY FATAL] Binding to 0.0.0.0 with REQUIRE_TLS=false in production exposes unencrypted HTTP to the public internet. ' +
        'Under Nginx/Caddy reverse proxy TLS termination, set HOST=127.0.0.1. ' +
        'If using native HTTPS directly on port 5050, set REQUIRE_TLS=true with valid TLS certificates.'
      );
    }
  }

  // Parse allowed Discord users & guilds
  const parseList = (str) => str ? str.split(',').map(s => s.trim()).filter(Boolean) : [];

  return {
    nodeEnv,
    
    // Server Identification
    serverId,
    serverName: env.SERVER_NAME || (isVinaHost ? 'VinaHost (11Ship)' : 'Nhân Hòa (AutoTrade)'),
    vibeHosting,
    vibeQuotaUrl: env.VIBE_QUOTA_URL || '',
    vibeQuotaAccessToken: env.VIBE_QUOTA_ACCESS_TOKEN || '',
    vibeQuotaUserId: env.VIBE_QUOTA_USER_ID || '',
    publicDashboard,
    dbBackend,
    databaseUrl,
    metricScope: vibeHosting ? 'CONTAINER' : 'HOST',
    peerMetricScope: env.PEER_METRIC_SCOPE || 'HOST',
    host,
    port: parseInt(env.PORT || '5050', 10),
    dbPath: env.DB_PATH || (nodeEnv === 'test' ? ':memory:' : './data/monitor.db'),
    
    // TLS / HTTPS Transport
    tlsCertPath: env.TLS_CERT_PATH || '',
    tlsKeyPath: env.TLS_KEY_PATH || '',
    requireTls,

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
