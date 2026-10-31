#!/usr/bin/env bash
# Add a dedicated HTTPS vhost for VPS Monitor without editing 11Ship's vhost.
# Run only after localhost health check passes.
set -euo pipefail
[[ "$EUID" -eq 0 ]] || { echo "Run as root"; exit 1; }
DOMAIN="${1:-}"
[[ -n "$DOMAIN" && "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || {
  echo "Usage: bash scripts/setup-vinahost-https.sh <domain-pointing-to-this-VPS>"
  exit 1
}
# Determine this VPS' actual public IPv4, never assume an address from examples.
PUBLIC_IPV4="$(curl --max-time 7 -fsS --ipv4 https://api.ipify.org)"
NAME="vps-monitor"
SITES_AVAILABLE="/etc/nginx/sites-available"
SITES_ENABLED="/etc/nginx/sites-enabled"
CONF="$SITES_AVAILABLE/$NAME.conf"
LINK="$SITES_ENABLED/$NAME.conf"
WEBROOT="/var/www/vps-monitor-acme"

command -v nginx >/dev/null || { echo "Nginx is not installed; aborting"; exit 1; }
nginx -t >/dev/null
curl --max-time 5 -fsS http://127.0.0.1:5050/healthz >/dev/null || {
  echo "VPS Monitor localhost:5050 is not UP; aborting nginx changes"; exit 1;
}
if ! getent ahostsv4 "$DOMAIN" | awk '{print $1}' | grep -Fxq "$PUBLIC_IPV4"; then
  echo "Domain does not resolve to expected VinaHost IPv4: $DOMAIN -> $PUBLIC_IPV4"
  echo "Do not change 11Ship/Nginx until DNS resolves correctly."
  exit 1
fi
[[ -d "$SITES_AVAILABLE" && -d "$SITES_ENABLED" ]] || {
  echo "Expected Debian Nginx sites-available/sites-enabled paths missing; aborting"; exit 1;
}
if [[ -e "$CONF" ]] && ! grep -q 'MANAGED BY VPS MONITOR' "$CONF"; then
  echo "Existing Nginx file conflicts with $CONF. Aborting."; exit 1;
fi
if [[ -e "$LINK" && ! -L "$LINK" ]]; then
  echo "Existing non-symlink $LINK. Aborting."; exit 1;
fi
if [[ -L "$LINK" && "$(readlink -f "$LINK")" != "$CONF" ]]; then
  echo "Existing $LINK points to a different site. Aborting."; exit 1;
fi

mkdir -p "$WEBROOT/.well-known/acme-challenge"
OLD_CONF=''
if [[ -f "$CONF" ]]; then
  OLD_CONF="$(mktemp /tmp/vps-monitor-nginx-old.XXXXXXXX)"
  cp -p "$CONF" "$OLD_CONF"
fi

restore() {
  if [[ -n "$OLD_CONF" && -f "$OLD_CONF" ]]; then
    cp -p "$OLD_CONF" "$CONF"
  else
    rm -f "$CONF" "$LINK"
  fi
  nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
  [[ -z "$OLD_CONF" ]] || rm -f "$OLD_CONF"
}
# Safe staging: HTTP serves ACME challenges only, NEVER public Monitor traffic.
cat >"$CONF" <<EOF
# MANAGED BY VPS MONITOR
server {
  listen 80;
  server_name $DOMAIN;
  location ^~ /.well-known/acme-challenge/ {
    root $WEBROOT;
  }
  location / { return 404; }
}
EOF
ln -sfn "$CONF" "$LINK"
if ! nginx -t; then restore; exit 1; fi
systemctl reload nginx

CERT="/etc/letsencrypt/live/$DOMAIN"
if [[ ! -s "$CERT/fullchain.pem" || ! -s "$CERT/privkey.pem" ]]; then
  if ! command -v certbot >/dev/null; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y certbot
  fi
  if ! certbot certonly --webroot --webroot-path "$WEBROOT" \
       -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email; then
    echo "Let's Encrypt failed; restoring original Nginx site, 11Ship untouched."
    restore
    exit 1
  fi
fi

cat >"$CONF" <<EOF
# MANAGED BY VPS MONITOR
server {
  listen 80;
  server_name $DOMAIN;
  location ^~ /.well-known/acme-challenge/ {
    root $WEBROOT;
  }
  location / { return 301 https://\$host\$request_uri; }
}
server {
  listen 443 ssl;
  server_name $DOMAIN;
  ssl_certificate $CERT/fullchain.pem;
  ssl_certificate_key $CERT/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_session_cache shared:SSL:10m;
  add_header X-Content-Type-Options nosniff always;

  location / {
    proxy_pass http://127.0.0.1:5050;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Connection "";
    proxy_connect_timeout 5s;
    proxy_send_timeout 15s;
    proxy_read_timeout 30s;
    client_max_body_size 64k;
  }
}
EOF
if ! nginx -t; then restore; exit 1; fi
systemctl reload nginx
[[ -z "$OLD_CONF" ]] || rm -f "$OLD_CONF"
printf '\nVinaHost HTTPS Monitor address: https://%s\n' "$DOMAIN"
curl --max-time 12 -fsS "https://$DOMAIN/healthz" || {
 echo; echo "HTTPS vhost is installed but external connectivity still needs verification."; exit 1;
}
echo
