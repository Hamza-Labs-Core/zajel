# [LOW] RelayRegistryDO stats endpoint accessible without authentication

**Area**: Server
**File**: packages/server/src/durable-objects/relay-registry-do.js:64-75
**Type**: Security

**Description**: The `/stats` endpoint on the `RelayRegistryDO` returns internal operational statistics without any authentication:
```js
if (url.pathname === '/stats') {
  return new Response(JSON.stringify({
    relays: this.relayRegistry.getStats(),
    rendezvous: this.rendezvousRegistry.getStats(),
    chunks: this.chunkIndex.getStats(),
    connections: this.wsConnections.size,
  }), { headers: { 'Content-Type': 'application/json' } });
}
```
Note: This endpoint may not be reachable in the current deployment since `RelayRegistryDO` is marked as a deleted class in wrangler.jsonc migrations. However, if it were ever re-enabled, it would expose internal state.

**Impact**: An attacker learns the number of connected peers, relay capacity, rendezvous points, cached chunks, and pending requests. This information aids in planning targeted attacks and reveals the scale of the infrastructure.

**Fix**: Add authentication to the stats endpoint or remove it if not needed:
```js
if (url.pathname === '/stats') {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || authHeader !== `Bearer ${this.env.ADMIN_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  // ... return stats
}
```
