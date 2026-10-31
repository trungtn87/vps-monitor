#!/usr/bin/env bash
# ==============================================================================
# VPS Monitor V1 — Certbot Deploy Hook
# Copies renewed certificates to unprivileged service directory /etc/vps-monitor/certs
# and sets strict permissions (0600 vpsmon:vpsmon) so the service starts cleanly.
# Usage in certbot:
#   certbot renew --deploy-hook /opt/vps-monitor/ops/scripts/deploy-cert-hook.sh
# ==============================================================================
set -euo pipefail

CERT_DEST="/etc/vps-monitor/certs"
mkdir -p "$CERT_DEST"

if [[ -n "${RENEWED_LINEAGE:-}" && -d "$RENEWED_LINEAGE" ]]; then
  echo "[VPS-MONITOR] Deploying renewed certificates from $RENEWED_LINEAGE to $CERT_DEST..."
  cp "$RENEWED_LINEAGE/fullchain.pem" "$CERT_DEST/fullchain.pem"
  cp "$RENEWED_LINEAGE/privkey.pem" "$CERT_DEST/privkey.pem"
  chown -R vpsmon:vpsmon "$CERT_DEST"
  chmod 700 "$CERT_DEST"
  chmod 600 "$CERT_DEST"/*.pem
  echo "[VPS-MONITOR] Certificates deployed successfully with mode 0600 owned by vpsmon:vpsmon."

  if systemctl is-active --quiet vps-monitor.service 2>/dev/null; then
    systemctl restart vps-monitor.service
    echo "[VPS-MONITOR] Service restarted with updated certificates."
  fi
fi
