# Plan: No limit on number of WebSocket connections per Durable Object

**Issue**: issue-server-6.md
**Severity**: HIGH
**Area**: Server
**Files to modify**:
- `packages/server/src/durable-objects/relay-registry-do.js`
- `packages/server/src/signaling-room.js`

## Analysis

In `packages/server/src/durable-objects/relay-registry-do.js`:
- The `fetch()` method (lines 62-93) accepts WebSocket connections without checking `this.wsConnections.size`.
- `wsConnections` is a `Map<string, WebSocket>` (line 24) that grows unbounded.
- The single "global" instance of `RelayRegistryDO` (created via `env.RELAY_REGISTRY.idFromName('global')` in the routing layer) means all connections share one DO.

In `packages/server/src/signaling-room.js`:
- The `fetch()` method (lines 21-33) accepts WebSocket connections without checking `this.clients.size`.
- `clients` is a `Map<string, WebSocket>` (line 16) with no size cap.

Cloudflare Workers isolates have a 128MB memory limit. Each WebSocket connection consumes memory for the socket object, buffers, and associated Map entries.

## Fix Steps

1. **Define connection limits as constants** at the top of each file:
   ```js
   const MAX_CONNECTIONS = 500;
   ```

2. **Add connection count check in `relay-registry-do.js` `fetch()`** (after the `upgradeHeader` check at line 79, before WebSocketPair creation at line 83):
   ```js
   if (this.wsConnections.size >= MAX_CONNECTIONS) {
     return new Response('Too many connections', { status: 503 });
   }
   ```

3. **Add connection count check in `signaling-room.js` `fetch()`** (after adding the Upgrade header check from issue-server-5, before WebSocketPair creation):
   ```js
   if (this.clients.size >= MAX_CONNECTIONS) {
     return new Response('Too many connections', { status: 503 });
   }
   ```
   Note: For SignalingRoom, the limit can be lower (e.g., 100) since each room handles a specific pairing session.

4. **Add per-IP connection tracking** (optional, higher effort):
   - Maintain a `Map<string, number>` mapping IP to connection count.
   - Read IP from `request.headers.get('CF-Connecting-IP')`.
   - Limit to e.g., 10 connections per IP.
   - Decrement on WebSocket close.

## Testing

- Verify that connections up to the limit succeed.
- Verify that connection attempts beyond the limit return 503.
- Verify that after a connection closes, a new connection can be accepted (count decrements properly).
- Test that the per-IP limit (if implemented) correctly tracks and limits per source.

## Risk Assessment

- **Legitimate high-traffic scenarios**: If there are genuinely hundreds of concurrent peers, the limit must be set high enough. Monitor `wsConnections.size` via the `/stats` endpoint (relay-registry-do.js line 66) to calibrate.
- **Sharding consideration**: For long-term scalability, the single "global" DO instance should be sharded (e.g., by region or hash prefix). This is out of scope for this fix but worth noting.
- **Connection cleanup**: Ensure `webSocketClose` and `webSocketError` handlers properly decrement counts. The current code at lines 117-135 already handles cleanup via `this.wsToPeerId.delete(ws)` and `this.handler.handleDisconnect()`, which calls `this.wsConnections.delete(peerId)`.
