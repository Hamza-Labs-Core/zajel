#!/bin/bash
# Zajel VPS nginx Installation and Configuration
set -e

PUBLIC_IP="${1}"
EMAIL="${2:-admin@zajel.hamzalabs.dev}"

if [ -z "$PUBLIC_IP" ]; then
  echo "Error: PUBLIC_IP not provided"
  exit 1
fi

echo "=== Installing nginx and certbot ==="
sudo apt-get update
sudo apt-get install -y nginx

# Certbot 5.3.0+ is required for IP certificate support (--ip-address flag).
# Ubuntu 24.04 apt may ship an older version, so install via pip if needed.
if command -v certbot &> /dev/null; then
  CERTBOT_VERSION=$(certbot --version 2>&1 | grep -oP '\d+\.\d+\.\d+')
  echo "Existing certbot version: $CERTBOT_VERSION"
else
  CERTBOT_VERSION="0.0.0"
fi

CERTBOT_MAJOR=$(echo "$CERTBOT_VERSION" | cut -d. -f1)
CERTBOT_MINOR=$(echo "$CERTBOT_VERSION" | cut -d. -f2)

if [ "$CERTBOT_MAJOR" -lt 5 ] || { [ "$CERTBOT_MAJOR" -eq 5 ] && [ "$CERTBOT_MINOR" -lt 3 ]; }; then
  echo "Certbot >= 5.3.0 required for IP certificates. Installing via pip..."
  sudo apt-get install -y python3-pip python3-venv
  sudo python3 -m pip install --upgrade certbot certbot-nginx
else
  echo "Certbot version $CERTBOT_VERSION is sufficient."
  sudo apt-get install -y certbot python3-certbot-nginx
fi

# Verify certbot version after installation
CERTBOT_INSTALLED_VERSION=$(certbot --version 2>&1 | grep -oP '\d+\.\d+\.\d+')
echo "Certbot version installed: $CERTBOT_INSTALLED_VERSION"

echo "=== Stopping nginx for certificate provisioning ==="
sudo systemctl stop nginx

echo "=== Configuring nginx for Zajel ==="
# Replace PUBLIC_IP placeholder in template
sed "s/PUBLIC_IP/$PUBLIC_IP/g" /opt/zajel/server-vps/deploy/nginx/zajel.conf | \
  sudo tee /etc/nginx/sites-available/zajel > /dev/null

# Remove default site, enable Zajel site
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sf /etc/nginx/sites-available/zajel /etc/nginx/sites-enabled/zajel

# Test nginx config syntax (will fail initially due to missing certs, expected)
sudo nginx -t 2>&1 || echo "nginx config check failed (expected - certs not yet provisioned)"

echo "=== Provisioning Let's Encrypt certificate for IP: $PUBLIC_IP ==="
# Let's Encrypt supports IP certificates since Jan 2026 (certbot 5.3.0+)
# Use standalone mode since nginx is stopped
sudo certbot certonly --standalone \
  --non-interactive \
  --agree-tos \
  --email "$EMAIL" \
  --ip-address "$PUBLIC_IP" \
  --preferred-challenges http \
  --keep-until-expiring

echo "=== Starting nginx ==="
sudo systemctl start nginx
sudo systemctl enable nginx

echo "=== Nginx configuration complete ==="
sudo nginx -t
sudo systemctl status nginx --no-pager

echo "=== Setting up certificate auto-renewal ==="
# Certbot installs a systemd timer by default, but verify it's enabled
sudo systemctl enable certbot.timer
sudo systemctl start certbot.timer
echo "Certificate renewal timer status:"
sudo systemctl status certbot.timer --no-pager
