import pg from 'pg';

const { Pool } = pg;

// Rows are normalized to the date/number layout expected by the existing
// dashboard and evaluators, without changing VinaHost's SQLite backend.
function row(r) {
  if (!r) return null;
  const out = { ...r };
  for (const [key, value] of Object.entries(out)) {
    if (value instanceof Date) {
      out[key] = key.endsWith('_date') ? value.toISOString().slice(0,10) :
        value.toISOString().slice(0,19).replace('T',' ');
    }
    if (typeof value === 'string' && /^(id|last_metric_id|net_rx_bytes|net_tx_bytes|uptime_sec|sequence|latency_ms)$/.test(key) && /^\d+$/.test(value)) {
      out[key] = Number(value);
    }
  }
  return out;
}
const first = r => row(r.rows[0]);
const all = r => r.rows.map(row);

export class PgMonitorDatabase {
  constructor(url, { testMode = false } = {}) {
    if (!url) throw new Error('[DB CONFIG ERROR] DATABASE_URL missing for Supabase PostgreSQL');
    const u = new URL(url);
    if (!['postgresql:', 'postgres:'].includes(u.protocol)) {
      throw new Error('[DB CONFIG ERROR] DATABASE_URL must be postgres:// or postgresql://');
    }
    // Restrict production to this standalone project before opening a connection.
    // The shared Supabase pooler carries the project ref in its username.
    const projectRef = 'gmpgtwtxhjwjeincvkxn';
    const directHost = u.hostname === `db.${projectRef}.supabase.co`;
    const pooledHost = u.hostname.endsWith('.pooler.supabase.com') &&
      u.username.endsWith(`.${projectRef}`);
    if (!testMode && !directHost && !pooledHost) {
      throw new Error('[DB CONFIG ERROR] DATABASE_URL must target the dedicated VPS-Monitor Supabase project.');
    }
    // The Supabase shared Session pooler uses TLS but its server certificate
    // may not chain to Node's bundled trust store. The documented
    // sslmode=require profile mandates encryption without CA verification.
    // Parse the URI into individual parameters: pg's connectionString parser
    // can silently override an explicit ssl object when sslmode is in the URI.
    // Never allow an URI option to downgrade a production connection to cleartext.
    const sslmode = u.searchParams.get('sslmode');
    if (!testMode && sslmode && sslmode !== 'require') {
      throw new Error('[DB CONFIG ERROR] VPS-Monitor supports SSL mode=require only on the Supabase pooler.');
    }
    const pgOptions = {
      host: u.hostname,
      port: Number(u.port || 5432),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: decodeURIComponent(u.pathname.slice(1) || 'postgres'),
      max: 3, idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: testMode ? false : { rejectUnauthorized: false }
    };
    this.pool = new Pool(pgOptions);
    this.testMode = testMode;
    this.pool.on('error', () => { /* pool automatically replaces broken idle connections */ });
  }
  async init() {
    try {
      const check = await this.pool.query("SELECT to_regclass('vps_monitor.server_registry') AS t");
      if (!check.rows[0]?.t) throw new Error('[DB SCHEMA ERROR] vps_monitor schema missing. Apply monitor_schema.sql to the dedicated Supabase project.');
      return this;
    } catch (err) {
      await this.pool.end();
      throw err;
    }
  }
  q(sql, values = []) { return this.pool.query(sql, values); }
  async upsertServer(s) {
    return this.q(`INSERT INTO vps_monitor.server_registry
      (server_id,name,host,port,role,expiry_date,is_local) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (server_id) DO UPDATE SET name=EXCLUDED.name,host=EXCLUDED.host,
      port=EXCLUDED.port,role=EXCLUDED.role,expiry_date=EXCLUDED.expiry_date,
      is_local=EXCLUDED.is_local,updated_at=now()`, [
      s.serverId,s.name,s.host||'127.0.0.1',Number(s.port??5050),
      s.role||'PRIMARY',s.expiryDate||null,!!s.isLocal
    ]);
  }
  async getServer(id) { return first(await this.q('SELECT * FROM vps_monitor.server_registry WHERE server_id=$1',[id])); }
  async getAllServers() { return all(await this.q('SELECT * FROM vps_monitor.server_registry ORDER BY is_local DESC,server_id')); }
  async upsertService(s) {
    return this.q(`INSERT INTO vps_monitor.service_registry
      (service_id,server_id,name,health_url,status,last_check,last_error)
      VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(service_id) DO UPDATE SET server_id=EXCLUDED.server_id,
      name=EXCLUDED.name,health_url=EXCLUDED.health_url,status=EXCLUDED.status,
      last_check=EXCLUDED.last_check,last_error=EXCLUDED.last_error,updated_at=now()`,[
      s.serviceId,s.serverId,s.name,s.healthUrl||null,s.status||'UNKNOWN',
      s.lastCheck||null,s.lastError||null
    ]);
  }
  async getServicesByServer(id) { return all(await this.q('SELECT * FROM vps_monitor.service_registry WHERE server_id=$1',[id])); }
  async insertMetrics(m) {
    return this.q(`INSERT INTO vps_monitor.node_metrics
      (server_id,cpu_pct,ram_used_mb,ram_total_mb,ram_pct,disk_used_gb,
      disk_total_gb,disk_pct,net_rx_bytes,net_tx_bytes,uptime_sec)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[
      m.serverId,m.cpuPct,m.ramUsedMb,m.ramTotalMb,m.ramPct,m.diskUsedGb,
      m.diskTotalGb,m.diskPct,m.netRxBytes||0,m.netTxBytes||0,m.uptimeSec
    ]);
  }
  async getLatestMetrics(id) {
    return first(await this.q('SELECT * FROM vps_monitor.node_metrics WHERE server_id=$1 ORDER BY id DESC LIMIT 1',[id]));
  }
  async getMetricsHistory(id,limit=60) {
    const r=await this.q('SELECT * FROM vps_monitor.node_metrics WHERE server_id=$1 ORDER BY id DESC LIMIT $2',[id,limit]);
    return all(r).reverse();
  }
  async insertHostingQuota(serverId, sample) {
    await this.q(`INSERT INTO vps_monitor.hosting_quota_metrics (
      server_id,snapshot_at,cpu_used_vcpu,cpu_quota_vcpu,cpu_pct,
      ram_used_mb,ram_quota_mb,ram_pct,disk_used_mb,disk_quota_mb,disk_pct,apps_json)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [
      serverId,sample.snapshotAt,sample.cpuUsedVcpu,sample.cpuQuotaVcpu,sample.cpuPct,
      sample.ramUsedMb,sample.ramQuotaMb,sample.ramPct,
      sample.diskUsedMb,sample.diskQuotaMb,sample.diskPct,JSON.stringify(sample.apps)
    ]);
  }
  async getLatestHostingQuota(serverId) {
    const record = first(await this.q(`SELECT * FROM vps_monitor.hosting_quota_metrics
      WHERE server_id=$1 ORDER BY snapshot_at DESC LIMIT 1`,[serverId]));
    if (!record) return null;
    const ageSec = Math.max(0,Math.floor((Date.now()-new Date(record.snapshot_at).getTime())/1000));
    return {
      scope:'VIBE_HOSTING_ACCOUNT',source:'VIBE_QUOTA_API',
      snapshotAt:record.snapshot_at,ageSec,isStale:ageSec>180,
      cpuUsedVcpu:record.cpu_used_vcpu,cpuQuotaVcpu:record.cpu_quota_vcpu,cpuPct:record.cpu_pct,
      ramUsedMb:record.ram_used_mb,ramQuotaMb:record.ram_quota_mb,ramPct:record.ram_pct,
      diskUsedMb:record.disk_used_mb,diskQuotaMb:record.disk_quota_mb,diskPct:record.disk_pct,
      apps:record.apps_json
    };
  }
  async recordHeartbeat(h) {
    return this.q(`INSERT INTO vps_monitor.heartbeat_log
      (sender_id,receiver_id,sequence,sender_timestamp,status,latency_ms)
      VALUES($1,$2,$3,$4,$5,$6)`,[
      h.senderId,h.receiverId,h.sequence,h.senderTimestamp,h.status||'VALID',h.latencyMs||0
    ]);
  }
  async getLastHeartbeat(id) {
    return first(await this.q(`SELECT * FROM vps_monitor.heartbeat_log
      WHERE sender_id=$1 AND status='VALID' ORDER BY id DESC LIMIT 1`,[id]));
  }
  async recordEvent(e) {
    return this.q(`INSERT INTO vps_monitor.event_history
      (server_id,event_type,severity,message,details_json) VALUES($1,$2,$3,$4,$5)`,[
      e.serverId,e.eventType,e.severity||'INFO',e.message,e.details?JSON.stringify(e.details):null
    ]);
  }
  async getRecentEvents(limit=50) {
    return all(await this.q('SELECT * FROM vps_monitor.event_history ORDER BY id DESC LIMIT $1',[limit]));
  }
  async getAlertState(key) {
    return first(await this.q('SELECT * FROM vps_monitor.alert_state WHERE alert_key=$1',[key]));
  }
  async setAlertState(key,state,count=1,details=null) {
    return this.q(`INSERT INTO vps_monitor.alert_state
      (alert_key,current_state,consecutive_count,last_alerted_at,details_json)
      VALUES($1,$2,$3,now(),$4)
      ON CONFLICT(alert_key) DO UPDATE SET current_state=EXCLUDED.current_state,
      consecutive_count=EXCLUDED.consecutive_count,last_alerted_at=now(),
      details_json=EXCLUDED.details_json,updated_at=now()`,[
      key,state,count,details?JSON.stringify(details):null
    ]);
  }
  async updateAlertCount(key,count,details=null) {
    return this.q(`INSERT INTO vps_monitor.alert_state
      (alert_key,current_state,consecutive_count,details_json)
      VALUES($1,'NORMAL',$2,$3)
      ON CONFLICT(alert_key) DO UPDATE SET consecutive_count=EXCLUDED.consecutive_count,
      details_json=COALESCE(EXCLUDED.details_json,vps_monitor.alert_state.details_json),
      updated_at=now()`,[key,count,details?JSON.stringify(details):null]);
  }
  async recordAlertTransition(p) {
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO vps_monitor.alert_state
        (alert_key,current_state,consecutive_count,last_alerted_at,details_json)
        VALUES($1,$2,$3,now(),$4) ON CONFLICT(alert_key) DO UPDATE SET
        current_state=EXCLUDED.current_state,consecutive_count=EXCLUDED.consecutive_count,
        last_alerted_at=now(),details_json=EXCLUDED.details_json,updated_at=now()`,[
        p.alertKey,p.currentState,p.consecutiveCount??1,p.details?JSON.stringify(p.details):null
      ]);
      let eventId=null,outboxId=null;
      if(p.eventType&&p.message) {
        const e=await c.query(`INSERT INTO vps_monitor.event_history
          (server_id,event_type,severity,message,details_json)
          VALUES($1,$2,$3,$4,$5) RETURNING id`,[
          p.serverId,p.eventType,p.severity||'INFO',p.message,p.eventDetails?JSON.stringify(p.eventDetails):null
        ]);
        eventId=Number(e.rows[0].id);
      }
      if(p.alertPayload) {
        const a=await c.query(`INSERT INTO vps_monitor.alert_outbox
          (alert_key,payload_json,status,attempts,next_retry_at)
          VALUES($1,$2,'PENDING',0,now()) RETURNING id`,[
          p.alertKey,JSON.stringify(p.alertPayload)
        ]);
        outboxId=Number(a.rows[0].id);
      }
      await c.query('COMMIT');
      return {eventId,outboxId};
    } catch(e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); }
  }
  async queueAlert({alertKey,payload}) {
    const r=await this.q(`INSERT INTO vps_monitor.alert_outbox
      (alert_key,payload_json,status,attempts,next_retry_at)
      VALUES($1,$2,'PENDING',0,now()) RETURNING id`,[alertKey,JSON.stringify(payload)]);
    return Number(r.rows[0].id);
  }
  async getPendingAlerts(limit=10) {
    return all(await this.q(`SELECT * FROM vps_monitor.alert_outbox
      WHERE status='PENDING' AND next_retry_at<=now() ORDER BY id ASC LIMIT $1`,[limit]));
  }
  async markAlertDelivered(id) {
    return this.q(`UPDATE vps_monitor.alert_outbox SET status='DELIVERED',delivered_at=now() WHERE id=$1`,[id]);
  }
  async markAlertRetry(id,attempts,nextRetrySec,error) {
    return this.q(`UPDATE vps_monitor.alert_outbox
      SET attempts=$2,next_retry_at=now()+($3||' seconds')::interval,last_error=$4
      WHERE id=$1`,[id,attempts,nextRetrySec,error||null]);
  }
  async cleanOldData(days=30) {
    const r=await Promise.all([
      this.q("DELETE FROM vps_monitor.node_metrics WHERE created_at<now()-($1||' days')::interval",[days]),
      this.q("DELETE FROM vps_monitor.heartbeat_log WHERE received_at<now()-($1||' days')::interval",[days]),
      this.q("DELETE FROM vps_monitor.event_history WHERE created_at<now()-($1||' days')::interval",[days]),
      this.q("DELETE FROM vps_monitor.alert_outbox WHERE status='DELIVERED' AND created_at<now()-($1||' days')::interval",[days]),
      this.q("DELETE FROM vps_monitor.hosting_quota_metrics WHERE collected_at<now()-($1||' days')::interval",[days])
    ]);
    return {deletedMetrics:r[0].rowCount,deletedHeartbeats:r[1].rowCount,
      deletedEvents:r[2].rowCount,deletedOutbox:r[3].rowCount};
  }
  async close() {await this.pool.end();}
}
