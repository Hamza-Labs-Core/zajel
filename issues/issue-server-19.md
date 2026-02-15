# [MEDIUM] WebSocket message handler double-parses JSON

**Area**: Server
**File**: packages/server/src/durable-objects/relay-registry-do.js:98-111
**Type**: Bug

**Description**: In `RelayRegistryDO.webSocketMessage`, the message is parsed as JSON to extract the `type` and `peerId` for connection tracking:
```js
async webSocketMessage(ws, message) {
  try {
    const data = JSON.parse(message);    // First parse
    if (data.type === 'register' && data.peerId) {
      this.wsToPeerId.set(ws, data.peerId);
    }
    this.handler.handleMessage(ws, message);  // Passes raw string
  } catch (e) { ... }
}
```
Then `WebSocketHandler.handleMessage` parses the same message string again:
```js
handleMessage(ws, data) {
  let message;
  try {
    message = JSON.parse(data);  // Second parse
  } catch (e) { ... }
}
```
This wastes CPU on double JSON parsing for every WebSocket message.

**Impact**: Wasted CPU cycles on every WebSocket message. For high-throughput scenarios with many peers, this doubles the JSON parsing overhead.

**Fix**: Pass the already-parsed object to `handleMessage` instead of the raw string:
```js
this.handler.handleMessage(ws, data);  // Pass parsed object
```
And modify `handleMessage` to accept a pre-parsed object or handle both cases.
