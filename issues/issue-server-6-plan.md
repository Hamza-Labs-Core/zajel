# Plan: No limit on number of WebSocket connections

**Retargeted**: This issue was originally identified in dead CF Worker code (`packages/server/src/durable-objects/relay-registry-do.js` and `packages/server/src/signaling-room.js`). The same vulnerability exists in the VPS server.

**Issue**: issue-server-6.md
**Severity**: HIGH
**Area**: Server (VPS)
**Files to modify**:
- `packages/server-vps/src/index.ts`
- `packages/server-vps/src/client/handler.ts`

## Analysis

In `packages/server-vps/src/index.ts`:
- The `wss.on('connection')` handler (lines 272-295) accepts WebSocket connections without checking any connection count. Every incoming WebSocket upgrade on the default path is accepted and passed to `clientHandler.handleConnection(ws)` at line 277.
- The HTTP upgrade handler (lines 248-269) routes all non-`/federation` and non-`/admin/ws` connections to the client WebSocket server (`wss.handleUpgrade` at line 265) with no limit check.

In `packages/server-vps/src/client/handler.ts`:
- `this.clients` is a `Map<string, ClientInfo>` (line 314) that tracks relay clients -- it grows unbounded.
- `this.pairingCodeToWs` is a `Map<string, WebSocket>` (line 317) that tracks signaling clients -- it also grows unbounded.
- `handleConnection()` (lines 462-480) sends server info and creates attestation sessions without checking total connection count.
- There is no per-IP tracking or per-IP connection limiting anywhere in the codebase.

A Node.js VPS process does not have the 128MB memory limit of CF Workers, but it is still bounded by available system memory. Each WebSocket connection consumes memory for the socket object, send/receive buffers, and associated Map entries. Under a connection flood attack, the server can be exhausted.

## Fix Steps

1. **Define connection limits as constants** in `packages/server-vps/src/constants.ts` (or at the top of `index.ts`):
   ```ts
   const MAX_TOTAL_CONNECTIONS = 10000;
   const MAX_CONNECTIONS_PER_IP = 50;
   ```

2. **Add connection tracking in `index.ts`** before the WebSocket connection handler:
   ```ts
   const ipConnectionCounts = new Map<string, number>();
   ```

3. **Add connection count check in `wss.on('connection')` (index.ts line 272)**:
   ```ts
   wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
     const clientIp = req.socket.remoteAddress || 'unknown';

     // Check total connection limit
     const totalConnections = clientHandler.clientCount + clientHandler.signalingClientCount;
     if (totalConnections >= MAX_TOTAL_CONNECTIONS) {
       ws.close(1013, 'Server at capacity');
       return;
     }

     // Check per-IP connection limit
     const ipCount = ipConnectionCounts.get(clientIp) || 0;
     if (ipCount >= MAX_CONNECTIONS_PER_IP) {
       ws.close(1013, 'Too many connections from this IP');
       return;
     }
     ipConnectionCounts.set(clientIp, ipCount + 1);

     // ... existing connection handling ...

     ws.on('close', async () => {
       // Decrement per-IP count
       const count = ipConnectionCounts.get(clientIp) || 1;
       if (count <= 1) {
         ipConnectionCounts.delete(clientIp);
       } else {
         ipConnectionCounts.set(clientIp, count - 1);
       }
       await clientHandler.handleDisconnect(ws);
       logger.clientConnection('disconnected', clientIp);
     });
   });
   ```

4. **Alternatively, check in the HTTP upgrade handler** (index.ts line 248) to reject before the WebSocket handshake completes, saving resources:
   ```ts
   httpServer.on('upgrade', (request, socket, head) => {
     const totalConnections = clientHandler.clientCount + clientHandler.signalingClientCount;
     if (totalConnections >= MAX_TOTAL_CONNECTIONS) {
       socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
       socket.destroy();
       return;
     }
     // ... existing routing ...
   });
   ```

## Testing

- Verify that connections up to the limit succeed.
- Verify that connection attempts beyond the total limit are rejected with close code 1013.
- Verify that per-IP limits correctly track and limit connections per source.
- Verify that after a connection closes, the count decrements properly and new connections from that IP are allowed.
- Verify that federation WebSocket connections (`/federation`, `/server`) are not affected by client connection limits.

## Risk Assessment

- **Legitimate high-traffic scenarios**: If there are many concurrent peers, the `MAX_TOTAL_CONNECTIONS` limit must be set appropriately for the VPS's available memory. Monitor via the `/stats` endpoint (index.ts line 100) which already exposes `connections` count.
- **Connection cleanup**: The `ws.on('close')` handler at line 287 already calls `clientHandler.handleDisconnect(ws)` which cleans up `clients` and `pairingCodeToWs` maps. The per-IP counter must also be decremented in this handler.
- **Proxy considerations**: If the VPS is behind a reverse proxy (nginx, etc.), `req.socket.remoteAddress` will show the proxy's IP. Use `X-Forwarded-For` header if available, but only when the proxy is trusted. This needs careful configuration.
- **Federation connections should be exempt**: The federation WebSocket server (`federationWss` at line 157) uses a separate upgrade path (`/federation` or `/server` at line 258) and should not count toward client connection limits.
