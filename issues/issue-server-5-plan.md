# Plan: SignalingRoom accepts WebSocket upgrade without verifying Upgrade header

**Issue**: issue-server-5.md
**Severity**: HIGH
**Area**: Server
**Files to modify**:
- `packages/server/src/signaling-room.js`

## Analysis

In `packages/server/src/signaling-room.js`, the `fetch()` method (lines 21-33) unconditionally creates a WebSocket pair and returns a 101 response:

```js
async fetch(request) {
  // Handle WebSocket upgrade
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  this.state.acceptWebSocket(server);
  return new Response(null, { status: 101, webSocket: client });
}
```

There is no check for the `Upgrade: websocket` header. By contrast, `RelayRegistryDO.fetch()` (relay-registry-do.js lines 78-81) correctly checks:

```js
const upgradeHeader = request.headers.get('Upgrade');
if (upgradeHeader !== 'websocket') {
  return new Response('Expected WebSocket', { status: 426 });
}
```

## Fix Steps

1. **Add Upgrade header check to `signaling-room.js` `fetch()` method** (line 21):
   ```js
   async fetch(request) {
     const upgradeHeader = request.headers.get('Upgrade');
     if (upgradeHeader !== 'websocket') {
       return new Response('Expected WebSocket', { status: 426 });
     }

     // Handle WebSocket upgrade
     const pair = new WebSocketPair();
     const [client, server] = Object.values(pair);
     this.state.acceptWebSocket(server);
     return new Response(null, { status: 101, webSocket: client });
   }
   ```

2. The fix is a simple guard clause added before the existing WebSocket pair creation at line 23.

## Testing

- Verify that a standard HTTP GET request to a SignalingRoom DO returns 426 instead of 101.
- Verify that a proper WebSocket upgrade request (with `Upgrade: websocket` header) still succeeds with 101.
- Run existing signaling/pairing tests to ensure no regressions.

## Risk Assessment

- **Very low risk**: This is a straightforward guard clause. The only scenario where this could cause issues is if Cloudflare's runtime internally routes requests to DOs without the Upgrade header -- but this would be a platform bug, not a code issue.
- **No client impact**: All legitimate WebSocket clients will have the Upgrade header set by the browser/HTTP library.
