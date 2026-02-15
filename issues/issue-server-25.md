# [MEDIUM] No WebSocket message size limit

**Area**: Server
**File**: packages/server/src/durable-objects/relay-registry-do.js:98-111
**Type**: Security

**Description**: The `webSocketMessage` handler in `RelayRegistryDO` and `SignalingRoom` accepts messages of any size. While `handleChunkPush` validates the chunk payload size after parsing, the initial `JSON.parse(message)` call will attempt to parse arbitrarily large messages.

Cloudflare Workers have a default WebSocket message size limit, but it is generous (up to 1MB). Parsing a 1MB JSON message consumes significant CPU and memory.

**Impact**: An attacker can send large WebSocket messages that consume CPU during JSON parsing. Repeated large messages can degrade performance for all peers connected to the same Durable Object.

**Fix**: Add a message size check before parsing:
```js
async webSocketMessage(ws, message) {
  const MAX_MESSAGE_SIZE = 128 * 1024; // 128KB
  if (typeof message === 'string' && message.length > MAX_MESSAGE_SIZE) {
    this.handler.sendError(ws, 'Message too large');
    return;
  }
  // ... proceed with parsing
}
```
