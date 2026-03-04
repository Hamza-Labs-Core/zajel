# Story 015: Deploy VPS Behind Reverse Proxy with Connection Rate Limiting

## Priority: THIS SPRINT
## Severity: HIGH
## Component: packages/server-vps, .github/workflows/deploy-vps.yml

## Summary

The VPS signaling server runs as a bare Node.js process on port 80 with no reverse proxy, no TLS termination at the infrastructure layer, no connection rate limiting, and no DDoS mitigation. The deployment workflow starts the server via PM2 directly listening on port 80, exposing raw `ws://` WebSocket connections to the internet. An attacker can overwhelm the server with connection floods, slowloris attacks, or HTTP request floods that bypass the application-level per-IP connection limit (`MAX_CONNECTIONS_PER_IP: 50`).

## Current Behavior

**Deployment workflow** (`.github/workflows/deploy-vps.yml`, lines 126-173):
```bash
# The start.sh script sets:
export ZAJEL_PORT=80
export ZAJEL_PUBLIC_ENDPOINT=ws://$PUBLIC_IP
# ...
pm2 start start.sh --name zajel-server --interpreter bash \
  --cwd /opt/zajel/server-vps --max-memory-restart 512M \
  --exp-backoff-restart-delay=100
```

Key observations:
- Port 80 (HTTP, no TLS) is used directly
- `ZAJEL_PUBLIC_ENDPOINT` uses `ws://` (unencrypted WebSocket)
- PM2 is used for process management with `--max-memory-restart 512M`
- No nginx, caddy, or other reverse proxy is configured
- No firewall rules (iptables/nftables) are set up
- No fail2ban or similar intrusion prevention
- No TLS is configured (despite the server supporting it via `ZAJEL_TLS_CERT` and `ZAJEL_TLS_KEY` env vars)

**Server listening** (`packages/server-vps/src/index.ts`, lines 368-374):
```typescript
await new Promise<void>((resolve) => {
  httpServer.listen(config.network.port, config.network.host, () => {
    console.log(`[Zajel] Listening on ${config.network.host}:${config.network.port}`);
    resolve();
  });
});
```
The server listens on `0.0.0.0:80` -- all interfaces, HTTP.

**Application-level connection limits** (`packages/server-vps/src/index.ts`, lines 313-332):
```typescript
const ipConnectionCounts = new Map<string, number>();

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const clientIp = req.socket.remoteAddress || 'unknown';
  const totalConnections = clientHandler.clientCount + clientHandler.signalingClientCount;
  if (totalConnections >= CONNECTION_LIMITS.MAX_TOTAL_CONNECTIONS) {
    ws.close(1013, 'Server at capacity');
    return;
  }
  const ipCount = ipConnectionCounts.get(clientIp) || 0;
  if (ipCount >= CONNECTION_LIMITS.MAX_CONNECTIONS_PER_IP) {
    ws.close(1013, 'Too many connections from this IP');
    return;
  }
  ipConnectionCounts.set(clientIp, ipCount + 1);
});
```
These limits are:
- `MAX_TOTAL_CONNECTIONS: 10000` (line 194 in constants.ts)
- `MAX_CONNECTIONS_PER_IP: 50` (line 197 in constants.ts)

However, these limits only apply AFTER the TCP handshake and HTTP upgrade are complete. The Node.js `http` module still accepts the TCP connection, parses the HTTP upgrade request, and buffers it before the WebSocket library's `connection` event fires. An attacker can exhaust Node.js's file descriptor limit or event loop by opening thousands of TCP connections that never upgrade to WebSocket.

**No HTTP endpoint rate limiting**:
The HTTP endpoints (`/health`, `/stats`, `/metrics`, `/admin`) have no rate limiting at all. Only `/stats` and `/metrics` require JWT auth; `/health` is completely open.

**WebSocket message rate limiting** (`packages/server-vps/src/constants.ts`, lines 30-38):
```typescript
export const RATE_LIMIT = {
  WINDOW_MS: 60000,
  MAX_MESSAGES: 100,
  MAX_PAIR_REQUESTS: 10,
};
```
Message-level rate limiting exists in the client handler, but connection-level and TCP-level rate limiting does not.

**PM2 configuration** (`.github/workflows/deploy-vps.yml`, line 144):
```bash
pm2 start start.sh --name zajel-server --interpreter bash \
  --cwd /opt/zajel/server-vps --max-memory-restart 512M \
  --exp-backoff-restart-delay=100
```
- `--max-memory-restart 512M`: PM2 will restart the process if it exceeds 512MB. An attacker can trigger continuous restarts by consuming memory (e.g., opening 10000 WebSocket connections with queued messages).
- `--exp-backoff-restart-delay=100`: Starting at 100ms, exponential backoff on crash restarts. This means rapid crashes lead to increasingly long downtime.
- No cluster mode: Single process, single core.

## Expected Behavior

1. An nginx or caddy reverse proxy should sit in front of Node.js, providing:
   - TLS termination (HTTPS/WSS)
   - Connection rate limiting at the TCP level
   - HTTP request rate limiting
   - WebSocket upgrade validation
   - Proxy protocol for real client IP forwarding
   - Static file serving for the admin dashboard (offloading from Node.js)

2. Firewall rules should limit inbound connections:
   - Only ports 80 (redirect to 443) and 443 (HTTPS/WSS) should be open
   - SSH on a non-standard port
   - All other ports closed

3. fail2ban or similar should monitor for:
   - Repeated failed WebSocket upgrades
   - Excessive connection attempts from a single IP
   - Repeated 4xx/5xx responses

4. TLS should be mandatory for all client-facing traffic.

## Root Cause Analysis

The VPS deployment was designed for rapid iteration during development. The `deploy-vps.yml` workflow prioritizes simplicity: it copies the built `dist/` directory to the server and starts it with PM2. There was no infrastructure provisioning step (Ansible, Terraform, cloud-init) to set up a reverse proxy, firewall, or TLS certificates.

The `ZAJEL_TLS_CERT` and `ZAJEL_TLS_KEY` configuration options exist in the server code, indicating that TLS was planned but never configured in the deployment workflow. The memory notes mention "Let's Encrypt IP certificates" and "WSS with IP Certs" but the deployment workflow still uses `ws://` on port 80.

## Affected Code

| File | Lines | Description |
|------|-------|-------------|
| `.github/workflows/deploy-vps.yml` | 126-173 | Server startup with PM2, no reverse proxy |
| `.github/workflows/deploy-vps.yml` | 137 | `ZAJEL_PORT=80`, `ws://$PUBLIC_IP` -- HTTP, no TLS |
| `packages/server-vps/src/index.ts` | 368-374 | Direct HTTP listen on all interfaces |
| `packages/server-vps/src/index.ts` | 313-332 | Application-level connection limits (post-TCP) |
| `packages/server-vps/src/index.ts` | 89-176 | HTTP request handler -- no rate limiting on HTTP endpoints |
| `packages/server-vps/src/constants.ts` | 192-198 | Connection limit constants |
| `packages/server-vps/src/config.ts` | 42-46 | TLS config (exists but unused in deploy) |

## Reproduction Steps

1. **TCP connection flood**:
   ```bash
   # Open 10000 TCP connections without completing WebSocket upgrade
   for i in $(seq 1 10000); do
     nc -w 0 $VPS_IP 80 &
   done
   # Node.js event loop stalls trying to process all connections
   ```

2. **Slowloris attack**:
   ```bash
   # Send partial HTTP headers, keep connections open
   slowhttptest -c 5000 -H -g -o slowloris -i 10 -r 200 -t GET \
     -u http://$VPS_IP/health
   # Server's file descriptor limit is exhausted
   ```

3. **Memory exhaustion via WebSocket connections**:
   ```bash
   # Open 50 WebSocket connections per IP, from multiple IPs
   # Each connection registers a pairing code and sends messages
   # PM2 kills the process at 512MB, then exponential backoff delays restart
   ```

4. **HTTP endpoint flooding**:
   ```bash
   # No rate limit on /health
   ab -n 100000 -c 1000 http://$VPS_IP/health
   # Node.js is overwhelmed by pure HTTP request volume
   ```

## Impact Assessment

- **Complete server takeover**: Without infrastructure-layer protection, a moderate-volume DDoS attack (thousands of connections) can render the VPS unresponsive.
- **Data in transit exposure**: `ws://` (unencrypted) means all signaling data (pairing codes, public keys, SDP offers/answers, ICE candidates) is visible to network observers between client and server.
- **PM2 restart loop**: Memory exhaustion triggers PM2 restart with exponential backoff, creating predictable and prolonged downtime windows.
- **No forensics**: Without a reverse proxy's access logs, there is no infrastructure-level record of attack traffic for post-incident analysis.
- **Federation disruption**: The VPS server handles both client signaling and server-to-server federation. Taking down one VPS disrupts the entire federation mesh.

## Proposed Fix

### 1. Add nginx reverse proxy configuration

Create `packages/server-vps/deploy/nginx.conf`:
```nginx
upstream zajel_backend {
    server 127.0.0.1:9000;
}

# Rate limiting zones
limit_req_zone $binary_remote_addr zone=http_limit:10m rate=30r/s;
limit_conn_zone $binary_remote_addr zone=conn_limit:10m;

server {
    listen 80;
    server_name _;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name _;

    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Connection limits
    limit_conn conn_limit 20;

    # HTTP request rate limit
    limit_req zone=http_limit burst=50 nodelay;

    # WebSocket upgrade
    location / {
        proxy_pass http://zajel_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeouts
        proxy_connect_timeout 5s;
        proxy_read_timeout 300s;
        proxy_send_timeout 60s;
    }

    # Health check (no rate limit, for monitoring)
    location = /health {
        limit_req off;
        proxy_pass http://zajel_backend;
    }
}
```

### 2. Update deploy-vps.yml

```yaml
- name: Install and configure nginx
  script: |
    sudo apt-get install -y nginx certbot python3-certbot-nginx
    sudo cp /opt/zajel/server-vps/deploy/nginx.conf /etc/nginx/sites-available/zajel
    sudo ln -sf /etc/nginx/sites-available/zajel /etc/nginx/sites-enabled/
    sudo rm -f /etc/nginx/sites-enabled/default
    sudo certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m admin@$DOMAIN
    sudo systemctl restart nginx

- name: Configure firewall
  script: |
    sudo ufw default deny incoming
    sudo ufw default allow outgoing
    sudo ufw allow 80/tcp
    sudo ufw allow 443/tcp
    sudo ufw allow $SSH_PORT/tcp
    sudo ufw --force enable
```

### 3. Update server config to listen on localhost

```bash
# In start.sh:
export ZAJEL_PORT=9000
export ZAJEL_HOST=127.0.0.1
export ZAJEL_PUBLIC_ENDPOINT=wss://$PUBLIC_IP
```

### 4. Add fail2ban jail

```ini
# /etc/fail2ban/jail.d/zajel.conf
[zajel-ws]
enabled = true
port = 443
filter = zajel-ws
logpath = /var/log/nginx/access.log
maxretry = 100
findtime = 60
bantime = 3600
```

### 5. Install and configure rate limiting for WebSocket upgrades

nginx `limit_req` applies to HTTP requests including upgrade requests, which is the right level for WebSocket connection rate limiting.

## Acceptance Criteria

- [ ] nginx is installed and configured as a reverse proxy in the deploy workflow
- [ ] TLS is enabled with auto-renewed certificates (Let's Encrypt or similar)
- [ ] Node.js server listens only on `127.0.0.1:9000` (not externally accessible)
- [ ] `ZAJEL_PUBLIC_ENDPOINT` uses `wss://` (encrypted WebSocket)
- [ ] nginx enforces connection rate limits: max 20 concurrent connections per IP
- [ ] nginx enforces request rate limits: max 30 requests/second per IP
- [ ] UFW firewall is configured: only ports 80, 443, and SSH are open
- [ ] fail2ban is installed and configured with a jail for excessive connection attempts
- [ ] Health check is accessible through the reverse proxy
- [ ] WebSocket upgrade works correctly through the reverse proxy
- [ ] Federation server-to-server WebSocket connections work through the reverse proxy
- [ ] PM2 cluster mode is evaluated (optional, for multi-core utilization)
- [ ] Deploy workflow includes rollback on nginx configuration failure

## Test Requirements

1. **Smoke test after deploy**: Health check at `https://$VPS_IP/health` returns 200
2. **TLS verification**: `openssl s_client -connect $VPS_IP:443` shows valid certificate
3. **WebSocket upgrade test**: Client connects via `wss://$VPS_IP` and receives server info
4. **Rate limit test**: 100 rapid connections from same IP, verify nginx returns 429/503
5. **Direct port test**: Verify port 9000 is not reachable from outside (`nc -zv $VPS_IP 9000` fails)
6. **Firewall test**: Verify only ports 80, 443, and SSH respond to external probes

## Dependencies

- Related: Story 020 (IP Reputation Scoring) -- nginx access logs feed into IP reputation data
- Related: Story 018 (SDP Signing) -- TLS protects SDP in transit at the transport layer, while SDP signing protects at the application layer
- Blocks: None (this is infrastructure, independent of application code changes)
