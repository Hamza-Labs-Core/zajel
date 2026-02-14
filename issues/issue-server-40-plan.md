# Plan: RelayRegistryDO stats endpoint accessible without authentication

**Issue**: issue-server-40.md
**Severity**: LOW
**Area**: Server
**Files to modify**: `packages/server/src/durable-objects/relay-registry-do.js`

## Analysis

In `packages/server/src/durable-objects/relay-registry-do.js`, the `/stats` endpoint (lines 64-75) returns internal operational statistics without any authentication:

```js
if (url.pathname === '/stats') {
  return new Response(JSON.stringify({
    relays: this.relayRegistry.getStats(),
    rendezvous: this.rendezvousRegistry.getStats(),
    chunks: this.chunkIndex.getStats(),
    connections: this.wsConnections.size,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
```

The stats reveal:
- `relays`: `totalPeers`, `totalCapacity`, `totalConnected`, `availableRelays` (from relay-registry.js lines 125-130)
- `rendezvous`: `dailyPoints`, `hourlyTokens`, `totalEntries`, `dailyEntries`, `hourlyEntries` (from rendezvous-registry.js lines 209-216)
- `chunks`: `trackedChunks`, `totalSources`, `cachedChunks`, `pendingRequests` (from chunk-index.js lines 349-354)
- `connections`: number of active WebSocket connections

Note: `RelayRegistryDO` is currently dead code (deleted in wrangler.jsonc migration v3, no binding exists). The `/stats` endpoint is not reachable in the current deployment.

## Fix Steps

1. **Add authentication to the `/stats` endpoint** in `relay-registry-do.js` (lines 64-75). Require an admin secret:

```js
if (url.pathname === '/stats') {
  // Require admin authentication
  const authHeader = request.headers.get('Authorization');
  if (!this.env.ADMIN_SECRET || !authHeader || authHeader !== `Bearer ${this.env.ADMIN_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({
    relays: this.relayRegistry.getStats(),
    rendezvous: this.rendezvousRegistry.getStats(),
    chunks: this.chunkIndex.getStats(),
    connections: this.wsConnections.size,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
```

2. **If the stats endpoint is not needed, remove it entirely**. Since `RelayRegistryDO` is dead code, the simplest approach is to remove the endpoint:

```js
// Remove lines 64-75 entirely
```

3. **If keeping the endpoint**, add `ADMIN_SECRET` to the environment variables configuration. In `wrangler.jsonc`, this would be a secret set via `wrangler secret put ADMIN_SECRET`.

## Testing

- If authentication is added:
  - Test that `/stats` without auth returns 401.
  - Test that `/stats` with wrong secret returns 401.
  - Test that `/stats` with correct `ADMIN_SECRET` returns the stats JSON.
- If removed:
  - Test that `/stats` returns the appropriate fallback (426 "Expected WebSocket" since it falls through to the WebSocket upgrade handler).

## Risk Assessment

- **Zero production risk**: `RelayRegistryDO` is dead code with no binding or route. The endpoint is unreachable in the current deployment.
- **Future risk**: If `RelayRegistryDO` is re-enabled without this fix, the stats endpoint would expose internal state to unauthenticated users.
- **Low complexity**: The fix is a simple auth check, straightforward to implement.
