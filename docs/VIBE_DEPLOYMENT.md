# Nhân Hòa Vibe Hosting — GitHub/Docker deployment

## Scope
This branch runs one **isolated** Monitor application on Vibe Hosting.
It does not alter or redeploy the existing AutoTrade service.

A Vibe deployment is containerized; unlike the VinaHost systemd agent, it
**cannot read the whole Nhân Hòa host's CPU/RAM/disk**. The Vibe dashboard labels
container/process metrics and explicitly shows disk as unavailable. Never
interpret these as full VPS values or use them for host-level capacity alerts.

## Step 1 — Create a NEW application, not the existing AutoTrade application

- Source: `trungtn87/vps-monitor`
- Branch: `deploy/vibe-nhanhoa`
- Build method: Dockerfile in repository root (`Dockerfile`).
- Context/build directory (Root Directory / Build Path): **`.`** (repository root).
- Dockerfile filename (only when there is a separate field): `Dockerfile`.
- **Do not enter `Dockerfile` as Build Path.** Otherwise Dokploy tries to `cd .../code/Dockerfile` and fails because it is a file, not a directory.
- Container internal port: `3000`.
- Start command: built into image (`node src/server.js`), no additional build script.
- Node version: 24 via the image.
- Public inbound HTTPS: provided by Vibe Hosting's reverse proxy/domain.
- **Do not publish HTTP port 3000 directly to the Internet**; only expose it
  through Vibe's authenticated HTTPS domain routing. `TRUSTED_PLATFORM_PROXY=true`
  acknowledges this platform boundary; it does not itself create encryption.

## Step 2 — Persistent data (important)

The application creates its **own SQLite database** at `DB_PATH=/data/vps-monitor.db` on first start, completely independent of AutoTrade and Supabase. Mount a **dedicated persistent read/write volume** at `/data` for this Monitor application before enabling production operation. Do not mount any AutoTrade path or share its database.

If Vibe Hosting does not support such a volume, the app may boot and display
live information but its SQLite alerts/history will be lost on rebuild.
**Do not treat the deployment as production-ready or use it as an independent
Discord alerting node** until persistent data is verified across redeploys.
No changes to AutoTrade's storage or database are allowed.

## Step 3 — Environment variables

Copy the variable names from `config/vibe.env.example` into Vibe Hosting's
Environment panel, not into source control.

Required for production:
- `NODE_ENV=production`
- `VIBE_HOSTING=true`, `TRUSTED_PLATFORM_PROXY=true`
- `SERVER_ID=nhanhoa`, `HOST=0.0.0.0`, `PORT=3000`, `REQUIRE_TLS=false`
- `DB_PATH=/data/vps-monitor.db` (Monitor-only persistent volume required)
- `HEARTBEAT_SECRET` = one unique random secret (>=32 characters), **identical
  on VinaHost**. Do not paste it into tickets or chats.
- `PUBLIC_DASHBOARD=true` permits anonymous **GET-only** access to Dashboard files,
  status, graphs and event history. No `DASHBOARD_PASS` or `API_TOKEN` is required.
  All status data becomes visible to anyone with the URL. Never publish secrets
  or private host IPs in status/event descriptions.
  This option is valid only with `VIBE_HOSTING=true` behind a verified HTTPS proxy.
- `DASHBOARD_PASS`/`API_TOKEN` are optional in public Dashboard mode; the default
  VinaHost/main configuration still requires authentication.
- `PEER_SERVER_ID=vinahost`, `PEER_URL=https://<vinahost-monitor-domain>`
  when VinaHost Dashboard is live on HTTPS. No `:5050` on the public URL.
- `APP_HEALTH_URL=https://<existing-autotrade-public-health-url>` only if
  verified; otherwise leave empty and display DISABLED.

Optional: Discord credentials, actual expiry dates, resource alert thresholds.
Set `DISCORD_WEBHOOK_URL` only when you have verified which instance is
responsible for an alert; otherwise duplicate notifications are possible.

If Vibe does not provide a persistent volume or HTTPS reverse proxy,
**do not try to bypass by enabling public insecure HTTP**.

## Step 4 — Build and verify (no SSH)

Build and deploy the NEW application through Vibe's GitHub UI. Open the
generated HTTPS app domain:
- `GET /healthz` should return 200, with status UP.
- Opening `/` should show the read-only Dashboard **without a login prompt**.
- GET `/api/status` should respond 200 without a password; POST is not made public.
- POST `/api/heartbeat` without a valid HMAC signature must be rejected.
- `GET /api/status` after authorization should list two nodes.
- Local Nhân Hòa resource origin must be marked as `CONTAINER`, not `HOST`;
  disk must appear as `N/A`.
- Peer can be `UNKNOWN` until VinaHost is online and configured.
- Rebuild/redeploy once and confirm metrics/history retained (requires volume).
- Check that the Monitor created `/data/vps-monitor.db` in its **own** volume; do not point it at the AutoTrade database.

If only container metrics are available, that is a platform limitation, not a
VPS failure. To obtain whole-host metrics in the future, obtain an official
host metrics API or a host-level read-only agent.

## Step 5 — Cross-monitoring & alerts

Once both Vibe and VinaHost are reachable over HTTPS:
1. Configure VinaHost `PEER_URL` to the generated HTTPS Vibe monitor URL.
2. Configure matching `HEARTBEAT_SECRET` on both sides.
3. Use 60s heartbeat, 180s disconnect threshold.
4. Check each Dashboard's receipt of partner heartbeat; don't interpret a
   network partition as proof the underlying machine is off.
5. Test loss/recovery via an isolated agent simulation, not by stopping the
   production AutoTrade or 11Ship service.
6. Only then activate Discord alerts and slash commands with allowlists.

The Discord Interaction Endpoint URL is bound to one app endpoint; it does not
automatically fail over to the other node.

## Limits
- No SSH/root access into Nhân Hòa hosting machine.
- No host-level CPU/RAM/disk/uptime from Vibe.
- SQLite needs a confirmed persistent volume.
- No automatic failover/HA or control over the production applications.
- No changes to `main` until PR review.
