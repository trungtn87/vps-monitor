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

if [[ $EUID -ne 0 && "${NODE_ENV:-}" != "test" && "${SKIP_ROOT_CHECK:-}" != "1" ]]; then
  echo "Error: This script must be run as root (use sudo)."
  exit 1
fi

echo "===> [1/6] Checking system requirements..."
# Check Node.js
if ! command -v node &> /dev/null; then
  echo "Node.js not found. Installing Node.js 22 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs sqlite3
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [[ "$NODE_VERSION" -lt 22 ]]; then
  echo "Error: Node.js version must be >= 22. Current: $(node -v)"
  exit 1
fi
echo "Node.js version: $(node -v) (OK)"

echo "===> [2/6] Checking port availability (default: 5050)..."
PORT=5050
if command -v ss &>/dev/null; then
  if ss -tuln | grep -q ":${PORT} "; then
    echo "Warning: Port ${PORT} is already in use by another process!"
    echo "Please verify existing services before proceeding."
    ss -tulnp | grep ":${PORT} " 2>/dev/null || true
    exit 1
  fi
  echo "Port ${PORT} is available."
else
  echo "Notice: ss command not found; skipping port check."
fi

echo "===> [3/6] Creating service user 'vpsmon'..."
if [[ $EUID -eq 0 ]]; then
  if ! id -u vpsmon &>/dev/null; then
    useradd --system --shell /usr/sbin/nologin --home-dir /opt/vps-monitor vpsmon
    echo "User 'vpsmon' created."
  else
    echo "User 'vpsmon' already exists."
  fi
else
  echo "Notice: Non-root test execution; skipping useradd vpsmon."
fi

INSTALL_DIR="${VPS_MONITOR_DIR:-/opt/vps-monitor}"
echo "===> [4/6] Setting up $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/data"
mkdir -p "$INSTALL_DIR/backups"

# Blocker 1: Setup secure directory for TLS certs if native TLS is used
if [[ $EUID -eq 0 ]]; then
  mkdir -p /etc/vps-monitor/certs
  if id -u vpsmon &>/dev/null; then
    chown -R vpsmon:vpsmon /etc/vps-monitor
  fi
  chmod 700 /etc/vps-monitor
  chmod 700 /etc/vps-monitor/certs
else
  mkdir -p "$INSTALL_DIR/certs"
fi

# Copy all repository files to install dir including .git and dotfiles (Finding 5)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
shopt -s dotglob
cp -r "$SCRIPT_DIR"/* "$INSTALL_DIR/"
shopt -u dotglob

# Installer makes shell scripts executable, but repository blobs are
# committed as 100644; prevent chmod-only changes from dirtying Git working tree.
if [[ -d "$INSTALL_DIR/.git" ]] && command -v git >/dev/null 2>&1; then
  git -C "$INSTALL_DIR" config --local core.filemode false
fi
# Ensure scripts have execute permissions
chmod +x "$INSTALL_DIR"/scripts/*.sh 2>/dev/null || true
chmod +x "$INSTALL_DIR"/ops/scripts/*.sh 2>/dev/null || true

# Verify .git exists so future updates work seamlessly
if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "Git repository preserved at $INSTALL_DIR/.git (Update path verified)."
else
  echo "Warning: .git directory was not found in source. Automated git update will require git clone."
fi

# Setup initial .env if not exists
if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  echo "Copying config/${ROLE}.env.example to $INSTALL_DIR/.env..."
  cp "$INSTALL_DIR/config/${ROLE}.env.example" "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"
  echo "IMPORTANT: Please edit $INSTALL_DIR/.env with your actual IPs, TLS certs, and Discord credentials!"
fi

if [[ $EUID -eq 0 ]] && id -u vpsmon &>/dev/null; then
  chown -R vpsmon:vpsmon "$INSTALL_DIR"
fi
chmod 700 "$INSTALL_DIR/data"

echo "===> [5/6] Installing systemd service..."
if [[ $EUID -eq 0 && -d /etc/systemd/system ]]; then
  cp "$INSTALL_DIR/ops/systemd/vps-monitor.service" /etc/systemd/system/
  if command -v systemctl &>/dev/null && systemctl is-system-running &>/dev/null; then
    systemctl daemon-reload
    systemctl enable vps-monitor.service
  fi
else
  echo "Notice: Non-root execution or systemd directory not writable; skipping systemd unit installation."
fi

echo "===> [6/6] Setting up logrotate..."
if [[ $EUID -eq 0 && -d /etc/logrotate.d && -f "$INSTALL_DIR/ops/logrotate/vps-monitor" ]]; then
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
