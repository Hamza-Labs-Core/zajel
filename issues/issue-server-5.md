# [HIGH] SignalingRoom accepts WebSocket upgrade without verifying Upgrade header

**Area**: Server
**File**: packages/server/src/signaling-room.js:21-33
**Type**: Security

**Description**: The `SignalingRoom.fetch()` method creates a WebSocket pair and accepts the connection for every incoming request, regardless of whether the request actually contains an `Upgrade: websocket` header. Unlike `RelayRegistryDO.fetch()` which correctly checks `request.headers.get('Upgrade') !== 'websocket'`, the SignalingRoom blindly upgrades every request.

**Impact**: Non-WebSocket HTTP requests to the SignalingRoom Durable Object will receive a 101 response with an unusable WebSocket, potentially confusing clients or causing unexpected behavior. While Cloudflare's runtime may handle this gracefully, it violates the WebSocket protocol specification and could lead to resource waste from accidental non-WebSocket requests.

**Fix**: Add the same upgrade header check that `RelayRegistryDO` uses:
```js
async fetch(request) {
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 });
  }
  // ... proceed with WebSocket pair creation
}
```
