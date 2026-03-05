#!/bin/bash
# Zajel VPS Firewall Configuration
set -e

SSH_PORT="${1:-22}"

echo "=== Configuring UFW firewall ==="
echo "SSH port: $SSH_PORT"

# Reset UFW to clean state
sudo ufw --force reset

# IMMEDIATELY allow SSH after reset to prevent lockout if script fails mid-way
sudo ufw allow "$SSH_PORT/tcp" comment 'SSH access'

# Default policies
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Allow HTTP and HTTPS
sudo ufw allow 80/tcp comment 'HTTP (certbot + redirect)'
sudo ufw allow 443/tcp comment 'HTTPS/WSS'
sudo ufw allow 8443/tcp comment 'Zajel signaling (WSS)'

# Enable firewall
sudo ufw --force enable

# Show status
echo "=== Firewall status ==="
sudo ufw status verbose
