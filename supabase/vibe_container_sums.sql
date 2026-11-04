-- Sums ONLY the two application containers, NEVER the provider hosting account.
-- Separate from hosting_quota_metrics so sources can never be mislabeled.
CREATE TABLE IF NOT EXISTS vps_monitor.vibe_container_sums (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  server_id text NOT NULL REFERENCES vps_monitor.server_registry(server_id) ON DELETE CASCADE,
  collected_at timestamptz NOT NULL DEFAULT now(),
  cpu_used_vcpu double precision,
  ram_used_mb double precision NOT NULL,
  apps_json jsonb NOT NULL,
  CONSTRAINT vibe_sum_cpu_valid CHECK (cpu_used_vcpu IS NULL OR (cpu_used_vcpu >= 0 AND cpu_used_vcpu <= 1024)),
  CONSTRAINT vibe_sum_ram_valid CHECK (ram_used_mb >= 0 AND ram_used_mb <= 1000000)
);
CREATE INDEX IF NOT EXISTS idx_vibe_container_sums_server_time
  ON vps_monitor.vibe_container_sums (server_id, collected_at DESC);
ALTER TABLE vps_monitor.vibe_container_sums ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON vps_monitor.vibe_container_sums FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE vps_monitor.vibe_container_sums_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON vps_monitor.vibe_container_sums TO vps_monitor_app;
GRANT USAGE, SELECT ON SEQUENCE vps_monitor.vibe_container_sums_id_seq TO vps_monitor_app;
DROP POLICY IF EXISTS vibe_sums_private_app ON vps_monitor.vibe_container_sums;
CREATE POLICY vibe_sums_private_app ON vps_monitor.vibe_container_sums
  FOR ALL TO vps_monitor_app USING (true) WITH CHECK (true);
