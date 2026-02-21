# [HIGH] No limit on number of WebSocket connections per Durable Object

**Area**: Server
**File**: packages/server/src/durable-objects/relay-registry-do.js:62-93
**Type**: Security

**Description**: The `RelayRegistryDO` and `SignalingRoom` Durable Objects accept unlimited WebSocket connections. There is no cap on `this.wsConnections.size` or `this.clients.size`. Each accepted WebSocket consumes memory in the Durable Object instance.

**Impact**: An attacker can open thousands of WebSocket connections to a single Durable Object, exhausting its memory (Cloudflare Workers have a 128MB memory limit per isolate). This causes the DO to crash, disconnecting all legitimate peers and disrupting the entire signaling infrastructure. Since there is a single "global" DO instance for `RelayRegistryDO`, this is a single point of failure.

**Fix**:
1. Track the number of active WebSocket connections and reject new connections when a threshold is reached (e.g., 500 connections).
2. Implement per-IP connection limits to prevent a single source from monopolizing capacity.
3. Consider sharding the Durable Object by region or hash prefix instead of using a single "global" instance.
```js
async fetch(request) {
  if (this.wsConnections.size >= MAX_CONNECTIONS) {
    return new Response('Too many connections', { status: 503 });
  }
  // ... proceed with WebSocket upgrade
}
```
