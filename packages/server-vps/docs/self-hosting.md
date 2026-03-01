# Self-Hosting a Zajel VPS Server

This guide covers deploying your own Zajel federated signaling server. A self-hosted server participates in the Zajel federation, providing signaling relay, peer discovery, and rendezvous services for Zajel clients.

## Prerequisites

- **Node.js** >= 20.0.0
- **npm** (comes with Node.js)
- **SQLite** (bundled via `better-sqlite3`; no separate installation needed)
- A VPS or server with a public IP address
- A domain name with DNS pointing to your server (recommended)
- TLS termination via a reverse proxy (nginx, Caddy, etc.) for production

## Installation

```bash
# Clone the repository
git clone https://github.com/your-org/zajel.git
cd zajel/packages/server-vps

# Install dependencies
npm ci

# Build the TypeScript source
npm run build

# Run database migrations
npm run migrate
```

## Configuration

The server is configured via environment variables. Create a `.env` file in the `packages/server-vps/` directory:

```bash
# --- Network ---
# Host to bind to (0.0.0.0 for all interfaces)
ZAJEL_HOST=0.0.0.0

# Port to listen on
ZAJEL_PORT=9000

# Public WebSocket endpoint that clients use to connect.
# Must be reachable from the internet. Use wss:// in production.
ZAJEL_PUBLIC_ENDPOINT=wss://your-domain.example.com

# Optional region tag (for client-side server selection)
ZAJEL_REGION=us-east

# --- Identity ---
# Path to the server's Ed25519 private key file.
# Generated automatically on first run if the file doesn't exist.
ZAJEL_KEY_PATH=./data/server.key

# Prefix for the human-readable ephemeral server ID
ZAJEL_ID_PREFIX=srv

# --- Bootstrap (Federation) ---
# URL of the Cloudflare Workers bootstrap server.
# Your server registers here so other servers and clients can discover it.
ZAJEL_BOOTSTRAP_URL=https://signal.zajel.hamzalabs.dev

# How often to send a heartbeat to the bootstrap server (ms)
ZAJEL_BOOTSTRAP_HEARTBEAT=60000

# --- Storage ---
# Path to the SQLite database file
ZAJEL_DB_PATH=./data/zajel.db

# --- Client Limits ---
# Max WebSocket connections per peer
ZAJEL_MAX_CONNECTIONS_PER_PEER=20

# WebSocket heartbeat interval / timeout (ms)
ZAJEL_HEARTBEAT_INTERVAL=30000
ZAJEL_HEARTBEAT_TIMEOUT=60000

# --- Cleanup ---
# How often to run the cleanup job (ms)
ZAJEL_CLEANUP_INTERVAL=300000

# TTL for daily rendezvous points (ms, default 48 hours)
ZAJEL_DAILY_POINT_TTL=172800000

# TTL for hourly tokens (ms, default 3 hours)
ZAJEL_HOURLY_TOKEN_TTL=10800000

# --- Admin Dashboard (optional) ---
# JWT secret shared with the CF Workers admin dashboard.
# Leave empty to disable the admin API.
ZAJEL_ADMIN_JWT_SECRET=

# CF admin dashboard URL for CORS headers
# ZAJEL_CF_ADMIN_URL=https://admin.zajel.example.com

# --- Gossip Protocol (advanced) ---
# ZAJEL_GOSSIP_INTERVAL=1000
# ZAJEL_SUSPICION_TIMEOUT=2000
# ZAJEL_FAILURE_TIMEOUT=5000

# --- DHT (advanced) ---
# ZAJEL_REPLICATION_FACTOR=3
# ZAJEL_WRITE_QUORUM=2
# ZAJEL_READ_QUORUM=1
# ZAJEL_VIRTUAL_NODES=150
```

All settings have sensible defaults. The only values you **must** configure for production are:

| Variable | Why |
|---|---|
| `ZAJEL_PUBLIC_ENDPOINT` | Clients and other servers use this to connect to you |
| `ZAJEL_PORT` | Must match your reverse proxy upstream |
| `ZAJEL_BOOTSTRAP_URL` | To join the federation (or omit to run standalone) |

## Running the Server

### Development

```bash
# Watch mode with auto-reload
npm run dev
```

### Production

```bash
# Build and start
npm run build
npm start
```

### Using a process manager (recommended for production)

With **systemd**:

```ini
# /etc/systemd/system/zajel.service
[Unit]
Description=Zajel VPS Server
After=network.target

[Service]
Type=simple
User=zajel
WorkingDirectory=/opt/zajel/packages/server-vps
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now zajel
```

With **pm2**:

```bash
pm2 start dist/index.js --name zajel
pm2 save
pm2 startup
```

## Reverse Proxy (TLS Termination)

Zajel clients expect `wss://` connections in production. Use a reverse proxy to handle TLS.

### Nginx example

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.example.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:9000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket timeout (keep connections alive)
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

### Caddy example (automatic TLS)

```
your-domain.example.com {
    reverse_proxy localhost:9000
}
```

## Connecting Clients

### Mobile/Desktop App

In the Zajel app settings, add your server's public endpoint. The app discovers servers through the bootstrap server, but you can also connect directly:

Build the app with a custom signaling URL:

```bash
flutter run --dart-define=SIGNALING_URL=wss://your-domain.example.com
```

Or set a custom bootstrap URL to use your own bootstrap server:

```bash
flutter run --dart-define=BOOTSTRAP_URL=https://your-bootstrap.example.com
```

### Standalone Mode (No Federation)

To run without joining the global federation, omit `ZAJEL_BOOTSTRAP_URL` or set it to empty. Clients will need to connect directly using `--dart-define=SIGNALING_URL=...`.

## Health Check and Monitoring

The server exposes HTTP endpoints for monitoring:

| Endpoint | Description |
|---|---|
| `GET /health` | Basic health check (returns JSON with status, uptime, version) |
| `GET /stats` | Connection statistics (relay count, signaling count, active codes) |
| `GET /metrics` | Detailed metrics including pairing code entropy |

Example:

```bash
curl http://localhost:9000/health
# {"status":"healthy","serverId":"ed25519:...","uptime":3600,...}

curl http://localhost:9000/stats
# {"connections":5,"relayConnections":3,"signalingConnections":2,...}
```

## Security Considerations

1. **TLS is mandatory in production.** Never expose the raw WebSocket port to the internet. Always terminate TLS at a reverse proxy.

2. **Firewall rules.** Only expose the reverse proxy port (443). The Zajel server port (default 9000) should only be accessible from localhost or the reverse proxy.

3. **Server identity key.** The file at `ZAJEL_KEY_PATH` (default `./data/server.key`) contains the server's Ed25519 private key. Protect it with appropriate file permissions (`chmod 600`). Back it up -- losing this key changes the server's identity in the federation.

4. **Database.** The SQLite database at `ZAJEL_DB_PATH` contains rendezvous points and peer metadata. It does **not** contain message content (messages are end-to-end encrypted and relayed, not stored). Protect it with appropriate file permissions.

5. **Admin dashboard.** If you enable the admin API (`ZAJEL_ADMIN_JWT_SECRET`), use a strong random secret and restrict access to trusted networks.

6. **Rate limiting.** The server limits connections per peer (`ZAJEL_MAX_CONNECTIONS_PER_PEER`). For additional protection, configure rate limiting at the reverse proxy level.

7. **Updates.** Keep the server updated to get security patches. The federation protocol is designed to handle rolling upgrades gracefully.

## Data Directory Structure

```
data/
  server.key      # Ed25519 private key (auto-generated on first run)
  zajel.db        # SQLite database (auto-created on first run)
  zajel.db-wal    # SQLite write-ahead log
  zajel.db-shm    # SQLite shared memory
```

## Troubleshooting

**Server won't start: "EADDRINUSE"**
Another process is using the port. Change `ZAJEL_PORT` or stop the other process.

**Federation: "Bootstrap registration failed"**
The bootstrap server may be unreachable. Check your network, DNS, and `ZAJEL_BOOTSTRAP_URL`. The server will continue to retry in the background.

**Clients can't connect**
Verify that `ZAJEL_PUBLIC_ENDPOINT` matches the URL clients use, including the `wss://` scheme. Check that your reverse proxy correctly upgrades WebSocket connections.

**Database errors after upgrade**
Run `npm run migrate` to apply any new database migrations.
