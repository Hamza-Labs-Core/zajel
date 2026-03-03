# Implementation Plan 015: VPS Reverse Proxy with Rate Limiting

**Story:** Story 015 - Deploy VPS Behind Reverse Proxy with Connection Rate Limiting
**Priority:** THIS SPRINT
**Severity:** HIGH
**Component:** packages/server-vps, .github/workflows/deploy-vps.yml
**Estimated Effort:** 2-3 days

---

## 1. Summary

Deploy an nginx reverse proxy in front of the Node.js VPS signaling server to provide:
- TLS termination with Let's Encrypt certificates
- Connection-level rate limiting (max 20 concurrent connections per IP)
- HTTP request rate limiting (max 30 requests/second per IP)
- Infrastructure-layer protection against TCP floods, slowloris, and HTTP floods
- UFW firewall configuration (only ports 80, 443, SSH exposed)
- fail2ban monitoring for excessive connection attempts
- Node.js server bound to localhost only (not externally accessible)

**Current state:** Node.js listens directly on `0.0.0.0:80` with `ws://` (unencrypted), no reverse proxy, no infrastructure-layer rate limiting, no firewall configuration.

**Target state:** nginx listens on ports 80 (redirect to 443) and 443 (WSS with TLS), Node.js listens on `127.0.0.1:9000`, UFW firewall blocks all ports except 80/443/SSH, fail2ban monitors nginx logs.

---

## 2. Files to Modify

### 2.1 New Files

| File Path | Purpose |
|-----------|---------|
| `/home/meywd/zajel-ddos/packages/server-vps/deploy/nginx.conf.template` | nginx configuration template with rate limiting and WebSocket proxying |
| `/home/meywd/zajel-ddos/packages/server-vps/deploy/fail2ban-zajel.conf` | fail2ban jail configuration for excessive WebSocket connection attempts |
| `/home/meywd/zajel-ddos/packages/server-vps/deploy/fail2ban-zajel-filter.conf` | fail2ban filter to match excessive connection patterns in nginx logs |
| `/home/meywd/zajel-ddos/packages/server-vps/deploy/setup-firewall.sh` | UFW firewall setup script |
| `/home/meywd/zajel-ddos/packages/server-vps/deploy/setup-nginx.sh` | nginx installation and certificate provisioning script |

### 2.2 Modified Files

| File Path | Lines | Changes |
|-----------|-------|---------|
| `/home/meywd/zajel-ddos/.github/workflows/deploy-vps.yml` | 136-144 | Update start.sh to use port 9000, localhost bind, wss:// endpoint |
| `/home/meywd/zajel-ddos/.github/workflows/deploy-vps.yml` | 115-173 | Add nginx installation, firewall setup, certificate provisioning steps |
| `/home/meywd/zajel-ddos/packages/server-vps/src/config.ts` | 37-38 | Update default host/port (localhost:9000) |

---

## 3. Implementation Steps

### 3.1 Create nginx Configuration Template

**File:** `/home/meywd/zajel-ddos/packages/server-vps/deploy/nginx.conf.template`

```nginx
# Zajel VPS Server - nginx reverse proxy configuration
# This file is a template - PUBLIC_IP placeholder is replaced during deployment

upstream zajel_backend {
    server 127.0.0.1:9000;
    keepalive 32;
}

# Rate limiting zones
# http_limit: 30 requests/second per IP (burst up to 50 with delay)
limit_req_zone $binary_remote_addr zone=http_limit:10m rate=30r/s;

# conn_limit: max 20 concurrent connections per IP
limit_conn_zone $binary_remote_addr zone=conn_limit:10m;

# HTTP -> HTTPS redirect
server {
    listen 80;
    listen [::]:80;
    server_name PUBLIC_IP;

    # Allow ACME challenge for Let's Encrypt
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    # Redirect all other traffic to HTTPS
    location / {
        return 301 https://$host$request_uri;
    }
}

# HTTPS/WSS server
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name PUBLIC_IP;

    # TLS configuration (certificate paths set by certbot)
    ssl_certificate /etc/letsencrypt/live/PUBLIC_IP/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/PUBLIC_IP/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers off;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;

    # Connection limit: max 20 concurrent per IP
    limit_conn conn_limit 20;

    # HTTP request rate limit: 30 req/s, burst 50
    limit_req zone=http_limit burst=50 nodelay;

    # Logging
    access_log /var/log/nginx/zajel-access.log;
    error_log /var/log/nginx/zajel-error.log;

    # Health check endpoint (no rate limit for monitoring)
    location = /health {
        limit_req off;
        limit_conn off;
        proxy_pass http://zajel_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 10s;
        proxy_send_timeout 10s;
    }

    # WebSocket upgrade (for client and federation connections)
    location / {
        proxy_pass http://zajel_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket timeouts
        proxy_connect_timeout 5s;
        proxy_read_timeout 300s;  # 5 minutes for long-lived WS connections
        proxy_send_timeout 60s;

        # Disable buffering for WebSocket
        proxy_buffering off;
    }

    # Admin endpoints (/admin, /stats, /metrics)
    location ~ ^/(admin|stats|metrics) {
        proxy_pass http://zajel_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $http_connection;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Shorter timeouts for admin endpoints
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
        proxy_send_timeout 30s;
    }
}
```

### 3.2 Create fail2ban Configuration

**File:** `/home/meywd/zajel-ddos/packages/server-vps/deploy/fail2ban-zajel.conf`

```ini
# fail2ban jail for Zajel VPS server
# Place in /etc/fail2ban/jail.d/zajel.conf

[zajel-ws]
enabled = true
port = 443
filter = zajel-ws
logpath = /var/log/nginx/zajel-access.log
maxretry = 100
findtime = 60
bantime = 3600
action = iptables-multiport[name=zajel, port="80,443", protocol=tcp]
```

**File:** `/home/meywd/zajel-ddos/packages/server-vps/deploy/fail2ban-zajel-filter.conf`

```ini
# fail2ban filter for Zajel WebSocket connections
# Place in /etc/fail2ban/filter.d/zajel-ws.conf

[Definition]
# Match 429 (rate limit exceeded) or 503 (service unavailable) responses
failregex = ^<HOST> .* "(GET|POST) .* HTTP/\d\.\d" (429|503) .*$
            ^<HOST> .* ".*" 444 0 .*$

ignoreregex =
```

### 3.3 Create Firewall Setup Script

**File:** `/home/meywd/zajel-ddos/packages/server-vps/deploy/setup-firewall.sh`

```bash
#!/bin/bash
# Zajel VPS Firewall Configuration
set -e

SSH_PORT="${1:-22}"

echo "=== Configuring UFW firewall ==="
echo "SSH port: $SSH_PORT"

# Reset UFW to clean state
sudo ufw --force reset

# Default policies
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Allow SSH (prevent lockout)
sudo ufw allow "$SSH_PORT/tcp" comment 'SSH access'

# Allow HTTP and HTTPS
sudo ufw allow 80/tcp comment 'HTTP (redirect to HTTPS)'
sudo ufw allow 443/tcp comment 'HTTPS/WSS'

# Enable firewall
sudo ufw --force enable

# Show status
echo "=== Firewall status ==="
sudo ufw status verbose
```

### 3.4 Create nginx Setup Script

**File:** `/home/meywd/zajel-ddos/packages/server-vps/deploy/setup-nginx.sh`

```bash
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
sudo apt-get install -y nginx certbot python3-certbot-nginx

echo "=== Stopping nginx for certificate provisioning ==="
sudo systemctl stop nginx

echo "=== Configuring nginx for Zajel ==="
# Replace PUBLIC_IP placeholder in template
sed "s/PUBLIC_IP/$PUBLIC_IP/g" /opt/zajel/server-vps/deploy/nginx.conf.template | \
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
```

### 3.5 Update Deploy Workflow - Server Configuration

**File:** `/home/meywd/zajel-ddos/.github/workflows/deploy-vps.yml`

**Before (lines 134-144):**
```yaml
            # Create startup script with embedded env vars
            # Get public IP for the endpoint
            PUBLIC_IP=$(curl -sf http://checkip.amazonaws.com || curl -sf http://ifconfig.me || echo "localhost")
            printf '#!/bin/bash\nexport ZAJEL_PORT=80\nexport ZAJEL_KEY_PATH=./data/server.key\nexport ZAJEL_DB_PATH=./data/zajel.db\nexport ZAJEL_PUBLIC_ENDPOINT=ws://%s\nexport ZAJEL_REGION=auto\nexport ZAJEL_BOOTSTRAP_URL=https://signal.zajel.hamzalabs.dev\nexport ZAJEL_ADMIN_JWT_SECRET=%s\nexport ZAJEL_CF_ADMIN_URL=https://admin.zajel.hamzalabs.dev\ncd /opt/zajel/server-vps\nexec node dist/index.js\n' "$PUBLIC_IP" "$ZAJEL_ADMIN_JWT_SECRET" > start.sh
            chmod 700 start.sh

            # Stop existing if running
            pm2 delete zajel-server 2>/dev/null || true

            # Start with PM2 using the wrapper script
            pm2 start start.sh --name zajel-server --interpreter bash --cwd /opt/zajel/server-vps --max-memory-restart 512M --exp-backoff-restart-delay=100
```

**After (lines 134-144):**
```yaml
            # Create startup script with embedded env vars
            # Get public IP for the endpoint
            PUBLIC_IP=$(curl -sf http://checkip.amazonaws.com || curl -sf http://ifconfig.me || echo "localhost")
            printf '#!/bin/bash\nexport ZAJEL_HOST=127.0.0.1\nexport ZAJEL_PORT=9000\nexport ZAJEL_KEY_PATH=./data/server.key\nexport ZAJEL_DB_PATH=./data/zajel.db\nexport ZAJEL_PUBLIC_ENDPOINT=wss://%s\nexport ZAJEL_REGION=auto\nexport ZAJEL_BOOTSTRAP_URL=https://signal.zajel.hamzalabs.dev\nexport ZAJEL_ADMIN_JWT_SECRET=%s\nexport ZAJEL_CF_ADMIN_URL=https://admin.zajel.hamzalabs.dev\ncd /opt/zajel/server-vps\nexec node dist/index.js\n' "$PUBLIC_IP" "$ZAJEL_ADMIN_JWT_SECRET" > start.sh
            chmod 700 start.sh

            # Stop existing if running
            pm2 delete zajel-server 2>/dev/null || true

            # Start with PM2 using the wrapper script (increased memory limit for production)
            pm2 start start.sh --name zajel-server --interpreter bash --cwd /opt/zajel/server-vps --max-memory-restart 1024M --exp-backoff-restart-delay=100
```

**Changes:**
- `ZAJEL_HOST=127.0.0.1` (bind to localhost only, not `0.0.0.0`)
- `ZAJEL_PORT=9000` (changed from 80)
- `ZAJEL_PUBLIC_ENDPOINT=wss://%s` (changed from `ws://` to `wss://`)
- `--max-memory-restart 1024M` (increased from 512M since nginx handles connection load)

### 3.6 Update Deploy Workflow - Add Infrastructure Setup Steps

**File:** `/home/meywd/zajel-ddos/.github/workflows/deploy-vps.yml`

Insert new step after "Setup server environment" (after line 88) and before "Prepare deployment" (line 89):

```yaml
      - name: Setup infrastructure (nginx, firewall, fail2ban)
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ vars.VPS_SERVERS }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          port: ${{ secrets.VPS_PORT || 22 }}
          script: |
            set -e

            # Get public IP
            PUBLIC_IP=$(curl -sf http://checkip.amazonaws.com || curl -sf http://ifconfig.me)
            echo "Public IP: $PUBLIC_IP"

            # Setup firewall (must happen before nginx to avoid lockout)
            if [ -f /opt/zajel/server-vps/deploy/setup-firewall.sh ]; then
              echo "=== Configuring firewall ==="
              bash /opt/zajel/server-vps/deploy/setup-firewall.sh "${{ secrets.VPS_PORT || 22 }}"
            fi

            # Setup nginx and TLS certificates
            if [ -f /opt/zajel/server-vps/deploy/setup-nginx.sh ]; then
              echo "=== Setting up nginx ==="
              bash /opt/zajel/server-vps/deploy/setup-nginx.sh "$PUBLIC_IP" "admin@zajel.hamzalabs.dev"
            else
              echo "nginx setup script not found, checking if nginx already configured..."
              if ! systemctl is-active --quiet nginx; then
                echo "ERROR: nginx not running and setup script missing"
                exit 1
              fi
            fi

            # Install fail2ban if not present
            if ! command -v fail2ban-server &> /dev/null; then
              echo "=== Installing fail2ban ==="
              sudo apt-get update
              sudo apt-get install -y fail2ban
            fi

            # Configure fail2ban
            if [ -f /opt/zajel/server-vps/deploy/fail2ban-zajel.conf ]; then
              echo "=== Configuring fail2ban ==="
              sudo cp /opt/zajel/server-vps/deploy/fail2ban-zajel.conf /etc/fail2ban/jail.d/zajel.conf
              sudo cp /opt/zajel/server-vps/deploy/fail2ban-zajel-filter.conf /etc/fail2ban/filter.d/zajel-ws.conf
              sudo systemctl restart fail2ban
              sudo fail2ban-client status
            fi
```

**Note:** This step runs BEFORE "Prepare deployment" to ensure infrastructure is set up before copying new application files. This step is idempotent - it checks if components are already installed before installing them.

### 3.7 Update Deploy Workflow - Health Check

**File:** `/home/meywd/zajel-ddos/.github/workflows/deploy-vps.yml`

**Before (lines 156-159):**
```yaml
            # Wait for server to be ready
            echo "Waiting for server to start..."
            for i in {1..6}; do
              if curl -sf http://localhost:80/health; then
```

**After (lines 156-159):**
```yaml
            # Wait for server to be ready
            echo "Waiting for server to start..."
            for i in {1..6}; do
              if curl -sf http://localhost:9000/health; then
```

**Change:** Health check now connects to `localhost:9000` (Node.js directly) instead of port 80 (nginx). This verifies that Node.js is responding, not just that nginx is running.

### 3.8 Update Server Config Defaults

**File:** `/home/meywd/zajel-ddos/packages/server-vps/src/config.ts`

**Before (lines 36-38):**
```typescript
    network: {
      host: envString('ZAJEL_HOST', '0.0.0.0'),
      port: envNumber('ZAJEL_PORT', 9000),
```

**After (lines 36-38):**
```typescript
    network: {
      host: envString('ZAJEL_HOST', '127.0.0.1'),
      port: envNumber('ZAJEL_PORT', 9000),
```

**Change:** Default host changed from `0.0.0.0` (all interfaces) to `127.0.0.1` (localhost only). This ensures that if `ZAJEL_HOST` is not explicitly set, the server is not exposed to external connections.

**Note:** Port default is already 9000, which is correct.

---

## 4. Test Plan

### 4.1 Pre-Deployment Tests (Local Development)

**Test 1: nginx Configuration Validation**
```bash
# On local machine with nginx installed
cd /home/meywd/zajel-ddos/packages/server-vps/deploy
sed 's/PUBLIC_IP/127.0.0.1/g' nginx.conf.template > /tmp/zajel-test.conf
sudo nginx -t -c /tmp/zajel-test.conf
```
**Expected:** Configuration syntax is valid (may warn about missing cert files, that's expected)

**Test 2: Firewall Script Dry Run**
```bash
cd /home/meywd/zajel-ddos/packages/server-vps/deploy
bash -n setup-firewall.sh
bash -n setup-nginx.sh
```
**Expected:** No syntax errors

**Test 3: fail2ban Configuration Validation**
```bash
# On local machine with fail2ban installed
fail2ban-client -t -c /home/meywd/zajel-ddos/packages/server-vps/deploy
```
**Expected:** Configuration is valid

### 4.2 Post-Deployment Smoke Tests

**Test 4: TLS Certificate Verification**
```bash
# From GitHub Actions or external machine
PUBLIC_IP=$(curl -sf http://checkip.amazonaws.com)
openssl s_client -connect $PUBLIC_IP:443 -servername $PUBLIC_IP < /dev/null
```
**Expected:**
- Connection succeeds
- Certificate is issued by Let's Encrypt
- Certificate subject matches public IP
- No certificate warnings

**Test 5: HTTP to HTTPS Redirect**
```bash
curl -I http://$PUBLIC_IP/health
```
**Expected:**
- Response: `301 Moved Permanently`
- `Location` header: `https://$PUBLIC_IP/health`

**Test 6: Health Check through nginx**
```bash
curl -k https://$PUBLIC_IP/health
```
**Expected:**
- Response: `200 OK`
- JSON body with `status: "healthy"`, `serverId`, `uptime`, etc.

**Test 7: Node.js Not Externally Accessible**
```bash
# From external machine
nc -zv $PUBLIC_IP 9000
```
**Expected:** Connection refused or timeout (port 9000 should not be accessible)

**Test 8: WebSocket Connection via WSS**
```bash
# Using websocat or similar WebSocket CLI tool
websocat wss://$PUBLIC_IP
# Or from Flutter E2E test harness
```
**Expected:**
- TLS handshake succeeds
- WebSocket upgrade succeeds
- Server sends `server-info` message with `serverId`, `endpoint` (wss://...), etc.

**Test 9: Firewall Configuration**
```bash
# From VPS via SSH
sudo ufw status verbose
```
**Expected:**
```
Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), disabled (routed)

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    Anywhere                   # SSH access
80/tcp                     ALLOW IN    Anywhere                   # HTTP (redirect to HTTPS)
443/tcp                    ALLOW IN    Anywhere                   # HTTPS/WSS
```

**Test 10: fail2ban Status**
```bash
# From VPS via SSH
sudo fail2ban-client status zajel-ws
```
**Expected:**
```
Status for the jail: zajel-ws
|- Filter
|  |- Currently failed: 0
|  |- Total failed:     0
|  `- File list:        /var/log/nginx/zajel-access.log
`- Actions
   |- Currently banned: 0
   |- Total banned:     0
   `- Banned IP list:
```

### 4.3 Rate Limiting Tests

**Test 11: Connection Rate Limit**
```bash
# Open 25 concurrent WebSocket connections from same IP
for i in {1..25}; do
  websocat wss://$PUBLIC_IP &
done
wait
```
**Expected:**
- First 20 connections succeed
- Connections 21-25 receive `503 Service Unavailable` or are rejected by nginx
- nginx logs show `limiting connections by zone "conn_limit"`

**Test 12: HTTP Request Rate Limit**
```bash
# Send 100 requests in 1 second
ab -n 100 -c 10 https://$PUBLIC_IP/health
```
**Expected:**
- First ~30-50 requests (within burst window) succeed with `200 OK`
- Subsequent requests receive `429 Too Many Requests` or `503 Service Unavailable`
- nginx logs show `limiting requests, excess: X.XXX by zone "http_limit"`

**Test 13: Health Check Rate Limit Exemption**
```bash
# Health check should NOT be rate limited
for i in {1..100}; do
  curl -sf https://$PUBLIC_IP/health > /dev/null && echo "OK" || echo "FAIL"
done
```
**Expected:** All 100 requests succeed (no rate limit on `/health`)

**Test 14: fail2ban Trigger and Unban**
```bash
# Generate 100+ failed connection attempts in 60 seconds
for i in {1..120}; do
  curl -sf https://$PUBLIC_IP/nonexistent-endpoint
  sleep 0.5
done

# Check if IP is banned
sudo fail2ban-client status zajel-ws
```
**Expected:**
- After ~100 429/503 responses, fail2ban bans the source IP
- Subsequent requests from that IP are rejected by iptables (connection refused)
- IP appears in fail2ban banned list
- IP is automatically unbanned after 3600 seconds (1 hour)

### 4.4 Federation and Admin Tests

**Test 15: Server-to-Server Federation via nginx**
```bash
# Start a second VPS server with same configuration
# Verify federation WebSocket connects through nginx on both servers
# Check federation logs for successful SWIM handshake
```
**Expected:**
- Federation WebSocket connections upgrade successfully through nginx
- No connection timeouts or proxy errors
- SWIM gossip protocol operates normally

**Test 16: Admin Dashboard via HTTPS**
```bash
# Generate admin JWT token
JWT_TOKEN=$(curl -sf -X POST https://admin.zajel.hamzalabs.dev/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"..."}' | jq -r .token)

# Access admin stats endpoint
curl -sf https://$PUBLIC_IP/stats \
  -H "Authorization: Bearer $JWT_TOKEN"
```
**Expected:**
- Admin endpoints accessible via HTTPS
- JWT authentication works
- Stats/metrics data is returned

### 4.5 Rollback Test

**Test 17: Rollback to Previous Version**
```bash
# From GitHub Actions or via SSH
cd /opt/zajel/server-vps
pm2 stop zajel-server
rm -rf dist
mv dist.backup dist
pm2 start start.sh --name zajel-server --interpreter bash
sleep 5
curl -sf http://localhost:9000/health
```
**Expected:**
- Previous version restarts successfully
- Health check passes
- WebSocket connections work (assuming nginx was already configured)

**Test 18: nginx Configuration Rollback**
```bash
# If nginx setup fails, remove configuration
sudo rm -f /etc/nginx/sites-enabled/zajel
sudo ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
sudo systemctl restart nginx
```
**Expected:**
- nginx serves default page
- Zajel server still accessible on port 9000 via `http://localhost:9000` (from VPS)

---

## 5. Rollback Risk Assessment

### 5.1 Risk Level: **MEDIUM**

This deployment changes critical infrastructure (firewall, reverse proxy, TLS). Errors can cause:
- **Complete service outage** if nginx fails to start or TLS certificate provisioning fails
- **SSH lockout** if UFW firewall is misconfigured
- **Port conflicts** if port 80/443 are already in use
- **Certificate rate limits** if Let's Encrypt provisioning is attempted too many times (5 failures/hour limit)

### 5.2 Rollback Procedure

**Scenario 1: nginx fails to start**
```bash
# Via SSH (if accessible)
sudo systemctl stop nginx
cd /opt/zajel/server-vps
# Reconfigure start.sh to use port 80, 0.0.0.0, ws://
printf '#!/bin/bash\nexport ZAJEL_HOST=0.0.0.0\nexport ZAJEL_PORT=80\n...\nexport ZAJEL_PUBLIC_ENDPOINT=ws://%s\n...\n' "$PUBLIC_IP" > start.sh
pm2 restart zajel-server
# Server is now accessible on port 80 again (no TLS)
```

**Scenario 2: SSH lockout due to firewall**
- Access VPS via cloud provider's web console (e.g., DigitalOcean Droplet Console, AWS EC2 Serial Console)
- Run: `sudo ufw disable`
- Reconfigure firewall rules
- Re-enable UFW

**Scenario 3: Let's Encrypt certificate provisioning fails**
- Server deployment continues without TLS (nginx config has placeholder paths)
- Manual fix: SSH to VPS, run `sudo certbot certonly --standalone --ip-address $PUBLIC_IP`
- Or: Use self-signed certificate as temporary fallback:
  ```bash
  sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout /etc/ssl/private/zajel-selfsigned.key \
    -out /etc/ssl/certs/zajel-selfsigned.crt
  # Update nginx.conf to use self-signed cert paths
  ```

**Scenario 4: Complete deployment failure**
- Via GitHub Actions: Click "Re-run failed jobs" to retry
- Via SSH: Manually run steps from deploy workflow
- Worst case: Re-provision VPS from scratch, redeploy previous known-good version

### 5.3 Mitigation Strategies

1. **Staged rollout:** Deploy to a single test VPS first, then production VPS
2. **Idempotent infrastructure setup:** All setup scripts check for existing configuration before making changes
3. **Health check timeout:** Deploy workflow waits 30 seconds for health check; if failed, shows PM2 logs and exits
4. **SSH port configuration:** UFW allows SSH on `$VPS_PORT` (from GitHub secret), defaults to 22
5. **Certificate fallback:** If Let's Encrypt fails, deployment continues; admin can manually provision cert later
6. **nginx config test:** Run `sudo nginx -t` before restarting nginx; abort if config is invalid
7. **Backup dist directory:** Existing `dist/` is moved to `dist.backup` before deploying new version

---

## 6. Dependencies and Related Stories

### 6.1 Depends On (Blockers)

**None.** This story is infrastructure-only and does not depend on other application-level changes.

### 6.2 Blocks (Required By)

**None.** Other stories can proceed in parallel. However, this story's completion makes the following stories safer/easier:

- **Story 020 (IP Reputation Scoring):** nginx access logs provide structured data for IP reputation analysis. Without nginx, IP tracking is limited to Node.js logs.
- **Story 018 (SDP Signing):** TLS (via nginx) protects SDP in transit at the transport layer, while SDP signing (Story 018) protects at the application layer. Both are defense-in-depth measures.

### 6.3 Related (Enhances or Enhanced By)

- **Story 011 (Per-Endpoint Rate Limiting):** This story implements connection-level and HTTP-level rate limiting at the nginx layer. Story 011 focuses on application-level rate limiting (e.g., per-message, per-pairing-code). Both layers are complementary.
- **Story 014 (Security Test Coverage):** E2E tests for rate limiting (Test 11-14 above) should be added to the security test suite in Story 014.

### 6.4 Conflicts (Incompatible With)

**None identified.** This story changes infrastructure configuration but does not conflict with any planned application features.

---

## 7. Security Considerations

### 7.1 TLS Configuration

- **Protocols:** TLSv1.2 and TLSv1.3 only (no TLSv1.0/1.1 due to known vulnerabilities)
- **Ciphers:** `HIGH:!aNULL:!MD5` (strong ciphers, no anonymous or MD5-based)
- **HSTS:** Strict-Transport-Security header enforces HTTPS for 1 year

### 7.2 Let's Encrypt IP Certificates

- **Availability:** Let's Encrypt IP certificate support launched January 2026 (requires certbot 5.3.0+)
- **Renewal:** 6-day short-lived certificates, auto-renewed every 3 days by certbot systemd timer
- **Rate Limits:** 5 failed validation attempts per IP per hour; deploy script uses `--keep-until-expiring` to avoid re-issuing

### 7.3 Rate Limiting Strategy

- **Connection limit (20/IP):** Prevents connection pool exhaustion; balances legitimate multi-tab usage vs. abuse
- **Request limit (30 req/s):** Allows ~1800 requests/minute per IP, sufficient for typical WebSocket control messages
- **Burst allowance (50 requests):** Allows brief spikes without falsely blocking legitimate clients
- **Health check exemption:** Monitoring tools (e.g., UptimeRobot, Pingdom) can poll `/health` without hitting rate limits

### 7.4 fail2ban Monitoring

- **Threshold:** 100 failures in 60 seconds (conservative to avoid false positives)
- **Ban duration:** 1 hour (3600 seconds)
- **Action:** iptables blocks all traffic from banned IP (not just port 443)
- **Log source:** nginx access log (structured, easy to parse)

### 7.5 Attack Surface Reduction

| Before | After | Risk Reduction |
|--------|-------|----------------|
| Port 80 (HTTP) exposed to internet | Port 80 redirects to 443 | No unencrypted traffic accepted |
| Port 9000 (Node.js) exposed to internet | Port 9000 bound to localhost only | Node.js not directly accessible |
| All ports accessible | Only 80, 443, SSH open | Reduced attack surface |
| No connection limits | 20 connections/IP | TCP flood resistance |
| No HTTP rate limit | 30 req/s per IP | HTTP flood resistance |

---

## 8. Performance Impact

### 8.1 Expected Performance Changes

- **Latency:** +5-10ms per request due to nginx proxy layer (negligible for WebSocket long-lived connections)
- **Throughput:** No significant change; nginx is highly efficient for WebSocket proxying
- **Memory:** +50-100 MB for nginx process (negligible on VPS with 1+ GB RAM)
- **CPU:** +5-10% for TLS handshake processing (offloaded from Node.js to nginx)

### 8.2 Bottleneck Analysis

- **Before:** Node.js handles TCP accept, TLS handshake (if configured), HTTP parsing, WebSocket upgrade
- **After:** nginx handles TCP accept, TLS handshake, HTTP parsing; Node.js only handles WebSocket application logic
- **Result:** Node.js event loop is less burdened by connection-level processing, can handle more concurrent WebSocket clients

### 8.3 PM2 Memory Limit Increase

- **Before:** `--max-memory-restart 512M`
- **After:** `--max-memory-restart 1024M`
- **Rationale:** With nginx handling connection load and rate limiting, Node.js memory usage is more predictable and less prone to spikes. Increasing the limit reduces unnecessary restarts.

---

## 9. Monitoring and Observability

### 9.1 New Log Files

| File | Content | Retention |
|------|---------|-----------|
| `/var/log/nginx/zajel-access.log` | HTTP/HTTPS requests, WebSocket upgrades, rate limit events | 14 days (logrotate) |
| `/var/log/nginx/zajel-error.log` | nginx errors (proxy failures, upstream timeouts) | 14 days (logrotate) |
| `/var/log/fail2ban.log` | Ban/unban events | 30 days (default) |

### 9.2 Metrics to Monitor

- **nginx connection rate:** `limit_conn_zone` counter (visible in nginx logs as "limiting connections")
- **nginx request rate:** `limit_req_zone` counter (visible in nginx logs as "limiting requests")
- **fail2ban banned IPs:** `fail2ban-client status zajel-ws | grep "Currently banned"`
- **TLS certificate expiry:** `sudo certbot certificates` (should show 3-6 days remaining)
- **Node.js port 9000 accessibility:** Should NOT be reachable from external IPs

### 9.3 Alerts to Configure (Future Work)

- Certificate expiry < 2 days (certbot should auto-renew, but alert if it fails)
- fail2ban banned IPs > 10 (indicates active attack)
- nginx error log rate > 10 errors/minute (indicates backend issues)
- Health check failures > 3 in 5 minutes (indicates server crash or overload)

---

## 10. Documentation Updates Required

### 10.1 README Updates

**File:** `/home/meywd/zajel-ddos/packages/server-vps/README.md`

Add section:
```markdown
## Production Deployment

The VPS server runs behind an nginx reverse proxy for TLS termination and rate limiting.

**Architecture:**
- nginx: Listens on ports 80 (HTTP redirect) and 443 (HTTPS/WSS)
- Node.js: Listens on 127.0.0.1:9000 (localhost only)
- UFW firewall: Blocks all ports except 80, 443, SSH

**TLS Certificates:**
- Let's Encrypt IP certificates (auto-renewed every 3 days)
- Certbot 5.3.0+ required for IP certificate support

**Rate Limits:**
- Max 20 concurrent connections per IP
- Max 30 HTTP requests/second per IP (burst up to 50)
- fail2ban: 100 failures in 60 seconds = 1 hour ban

**Manual Setup:**
See `deploy/setup-nginx.sh` and `deploy/setup-firewall.sh` for manual installation steps.
```

### 10.2 Deployment Guide

Create **File:** `/home/meywd/zajel-ddos/packages/server-vps/docs/DEPLOYMENT.md`

```markdown
# VPS Server Deployment Guide

## Prerequisites

- Ubuntu 24.04 LTS (or similar)
- Root or sudo access
- Public IP address (for Let's Encrypt IP certificates)
- Open ports 80, 443, SSH (configured via UFW)

## Automated Deployment (GitHub Actions)

Deployment is automated via `.github/workflows/deploy-vps.yml`. On push to `main` branch:

1. Build server-vps package
2. Run tests
3. Upload artifact
4. SSH to VPS servers (configured via `VPS_SERVERS` GitHub variable)
5. Install Node.js, PM2, nginx, certbot, fail2ban
6. Configure firewall (UFW)
7. Provision TLS certificate (Let's Encrypt)
8. Copy built dist/ to /opt/zajel/server-vps
9. Start server with PM2
10. Verify health check

## Manual Deployment

### 1. Install Dependencies
(Script content from setup-nginx.sh and setup-firewall.sh)

### 2. Deploy Application
(Manual steps for copying dist/, running npm ci, starting PM2)

### 3. Verify Deployment
(Commands from Test Plan section)

## Troubleshooting

### Health check fails
- Check PM2 logs: `pm2 logs zajel-server`
- Check nginx error log: `sudo tail -f /var/log/nginx/zajel-error.log`
- Verify Node.js is listening on port 9000: `sudo ss -tlnp | grep 9000`

### TLS certificate provisioning fails
- Check certbot version: `certbot --version` (must be 5.3.0+)
- Check Let's Encrypt rate limits: `sudo certbot certificates`
- Manual renewal: `sudo certbot renew --force-renewal`

### fail2ban not banning IPs
- Check jail status: `sudo fail2ban-client status zajel-ws`
- Check filter regex: `fail2ban-regex /var/log/nginx/zajel-access.log /etc/fail2ban/filter.d/zajel-ws.conf`
- Restart fail2ban: `sudo systemctl restart fail2ban`
```

---

## 11. Open Questions and Future Work

### 11.1 Open Questions

1. **Multi-VPS Load Balancing:** Should multiple VPS servers share a single domain with DNS round-robin? Or should each VPS have its own IP-based certificate?
   - **Recommendation:** Keep IP-based certificates for now (simpler). Consider CloudFlare Load Balancer or similar in the future.

2. **nginx Cluster Mode:** Should we run multiple nginx worker processes?
   - **Recommendation:** nginx auto-configures workers based on CPU cores. Default is sufficient.

3. **PM2 Cluster Mode:** Should Node.js run in PM2 cluster mode (multiple processes)?
   - **Recommendation:** Not yet. WebSocket state (pairing codes, connected clients) is in-memory and not cluster-aware. Would require Redis/shared state layer.

4. **Certificate Backup:** Should TLS certificates be backed up to GitHub Secrets or S3?
   - **Recommendation:** Not necessary. Certificates are auto-renewed and can be re-provisioned in <5 minutes if lost.

### 11.2 Future Enhancements

1. **DDoS Mitigation Service:** Integrate CloudFlare, AWS Shield, or similar for large-scale DDoS protection (beyond VPS capacity)
2. **WAF (Web Application Firewall):** Add ModSecurity or similar to nginx for application-layer attack detection
3. **IP Reputation Database:** Integrate with external IP reputation services (AbuseIPDB, IPQualityScore) for proactive blocking
4. **Rate Limit Dynamic Adjustment:** Adjust rate limits based on server load (e.g., lower limits when CPU > 80%)
5. **Certificate Monitoring Dashboard:** Admin dashboard widget showing TLS certificate expiry and renewal status
6. **Automated Rollback:** If health check fails after deployment, automatically rollback to `dist.backup` and restart

---

## 12. Checklist for Implementation

- [ ] Create `deploy/nginx.conf.template`
- [ ] Create `deploy/fail2ban-zajel.conf`
- [ ] Create `deploy/fail2ban-zajel-filter.conf`
- [ ] Create `deploy/setup-firewall.sh`
- [ ] Create `deploy/setup-nginx.sh`
- [ ] Update `.github/workflows/deploy-vps.yml` (start.sh configuration)
- [ ] Update `.github/workflows/deploy-vps.yml` (add infrastructure setup step)
- [ ] Update `.github/workflows/deploy-vps.yml` (health check port)
- [ ] Update `src/config.ts` (default host to 127.0.0.1)
- [ ] Test nginx config syntax locally
- [ ] Test firewall script syntax
- [ ] Deploy to test VPS
- [ ] Run smoke tests (TLS, health check, WebSocket)
- [ ] Run rate limiting tests
- [ ] Run fail2ban trigger test
- [ ] Verify SSH access still works
- [ ] Verify port 9000 not externally accessible
- [ ] Deploy to production VPS
- [ ] Monitor nginx logs for 24 hours
- [ ] Monitor fail2ban for 24 hours
- [ ] Update README.md
- [ ] Create DEPLOYMENT.md documentation
- [ ] Close Story 015

---

## 13. Estimated Timeline

| Phase | Duration | Tasks |
|-------|----------|-------|
| **Day 1 - Setup** | 4 hours | Create nginx, fail2ban, firewall config files; update deploy workflow |
| **Day 1 - Testing** | 2 hours | Local syntax validation, workflow dry-run |
| **Day 2 - Staging Deploy** | 2 hours | Deploy to test VPS, run smoke tests |
| **Day 2 - Rate Limit Testing** | 2 hours | Run rate limiting and fail2ban tests |
| **Day 3 - Production Deploy** | 1 hour | Deploy to production VPS |
| **Day 3 - Monitoring** | 2 hours | Monitor logs, verify alerts |
| **Day 3 - Documentation** | 1 hour | Update README and create deployment guide |
| **Total** | **14 hours** (~2 days) | |

**Contingency:** +1 day for troubleshooting certificate provisioning or firewall issues.

---

## 14. Success Criteria

✅ **Implementation is complete when:**

1. nginx is running on production VPS, listening on ports 80 and 443
2. Let's Encrypt TLS certificate is provisioned and valid
3. Node.js is listening on `127.0.0.1:9000` only (not externally accessible)
4. `ZAJEL_PUBLIC_ENDPOINT` uses `wss://` (encrypted WebSocket)
5. UFW firewall is active with only ports 80, 443, SSH open
6. fail2ban is active and monitoring nginx logs
7. Health check is accessible at `https://$PUBLIC_IP/health`
8. WebSocket clients can connect via `wss://$PUBLIC_IP`
9. Federation server-to-server connections work through nginx
10. Rate limiting tests pass (connection limit, request limit, fail2ban trigger)
11. Rollback procedure is documented and tested
12. README and deployment guide are updated

---

**Plan prepared by:** Claude Sonnet 4.5
**Date:** 2026-03-03
**Status:** READY FOR REVIEW
