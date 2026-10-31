#!/usr/bin/env bash
# ==============================================================================
# VPS Monitor V1 — Automated Installation Script for Ubuntu 24.04
# Usage: sudo bash scripts/install.sh [vinahost|nhanhoa]
# ==============================================================================
set -euo pipefail

ROLE="${1:-}"
if [[ "$ROLE" != "vinahost" && "$ROLE" != "nhanhoa" ]]; then
  echo "Usage: sudo bash scripts/install.sh <vinahost|nhanhoa>"
  exit 1
fi

if [[ $EUID -ne 0 ]]; then
  echo "Error: This script must be run as root (use sudo)."
  exit 1
fi

echo "===> [1/6] Checking system requirements..."
# Check Node.js
if ! command -v node &> /dev/null; then
  echo "Node.js not found. Installing Node.js 22 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [[ "$NODE_VERSION" -lt 22 ]]; then
  echo "Error: Node.js version must be >= 22. Current: $(node -v)"
  exit 1
fi
echo "Node.js version: $(node -v) (OK)"

echo "===> [2/6] Checking port availability (default: 5050)..."
PORT=5050
if ss -tuln | grep -q ":${PORT} "; then
  echo "Warning: Port ${PORT} is already in use by another process!"
  echo "Please verify existing services before proceeding."
  ss -tulnp | grep ":${PORT} "
  exit 1
fi
echo "Port ${PORT} is available."

echo "===> [3/6] Creating service user 'vpsmon'..."
if ! id -u vpsmon &>/dev/null; then
  useradd --system --shell /usr/sbin/nologin --home-dir /opt/vps-monitor vpsmon
  echo "User 'vpsmon' created."
else
  echo "User 'vpsmon' already exists."
fi

echo "===> [4/6] Setting up /opt/vps-monitor..."
INSTALL_DIR="/opt/vps-monitor"
mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/data"
mkdir -p "$INSTALL_DIR/backups"

# Copy repository files to /opt/vps-monitor
cp -r ./* "$INSTALL_DIR/"

# Setup initial .env if not exists
if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  echo "Copying config/${ROLE}.env.example to $INSTALL_DIR/.env..."
  cp "$INSTALL_DIR/config/${ROLE}.env.example" "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"
  echo "IMPORTANT: Please edit $INSTALL_DIR/.env with your actual IPs, shared secret, and Discord credentials!"
fi

chown -R vpsmon:vpsmon "$INSTALL_DIR"
chmod 700 "$INSTALL_DIR/data"

echo "===> [5/6] Installing systemd service..."
cp "$INSTALL_DIR/ops/systemd/vps-monitor.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable vps-monitor.service

echo "===> [6/6] Setting up logrotate..."
if [[ -f "$INSTALL_DIR/ops/logrotate/vps-monitor" ]]; then
  cp "$INSTALL_DIR/ops/logrotate/vps-monitor" /etc/logrotate.d/vps-monitor
fi

echo "------------------------------------------------------------------"
echo "✅ VPS Monitor V1 installation completed successfully!"
echo "Configuration file: $INSTALL_DIR/.env"
echo "To start the service:"
echo "   sudo systemctl start vps-monitor"
echo "To check status and logs:"
echo "   sudo systemctl status vps-monitor"
echo "   sudo journalctl -u vps-monitor -f"
echo "To test health:"
echo "   curl http://127.0.0.1:5050/healthz"
echo "------------------------------------------------------------------"
