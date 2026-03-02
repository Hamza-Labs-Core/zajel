# RESOLVED -- Dead code removed; VPS enforces maxPayload at WebSocket protocol level

**Status**: RESOLVED
**Resolution**: The original `relay-registry-do.js` was dead code in the CF Worker and has been deleted (commit 366c85d). The VPS server enforces WebSocket message size limits at the protocol level via `maxPayload: WEBSOCKET.MAX_MESSAGE_SIZE` (256KB) on the `WebSocketServer` configuration. Messages exceeding this limit are rejected by the `ws` library with close code 1009 ("Message Too Big") before they reach application code. Additionally, `handleMessage()` has a defense-in-depth size check at handler.ts line 556.
**Original target**: `packages/server/src/durable-objects/relay-registry-do.js` (deleted)
**VPS status**: `packages/server-vps/src/index.ts` lines 153-156 configure `new WebSocketServer({ noServer: true, maxPayload: WEBSOCKET.MAX_MESSAGE_SIZE })` where `WEBSOCKET.MAX_MESSAGE_SIZE = 256 * 1024` (256KB). The handler also has an application-level check at `handler.ts` line 556: `if (data.length > WEBSOCKET.MAX_MESSAGE_SIZE)`.

---

# Plan: No WebSocket message size limit

**Issue**: issue-server-25.md
**Severity**: MEDIUM
**Area**: Server
**Files to modify**: `packages/server/src/durable-objects/relay-registry-do.js`

## Analysis

In `packages/server/src/durable-objects/relay-registry-do.js`, the `webSocketMessage` handler (lines 98-111) parses incoming messages without any size check:

```js
async webSocketMessage(ws, message) {
  try {
    const data = JSON.parse(message);
    // Track peer ID for this WebSocket on registration
    if (data.type === 'register' && data.peerId) {
      this.wsToPeerId.set(ws, data.peerId);
    }
    this.handler.handleMessage(ws, message);
  } catch (e) {
    console.error('WebSocket message error:', e);
    this.handler.sendError(ws, 'Internal server error');
  }
}
```

The `JSON.parse(message)` on line 100 will attempt to parse messages up to the Cloudflare WebSocket limit (1MB). A 1MB JSON parse consumes significant CPU. Additionally, the message is parsed twice: once here on line 100 (to extract `type` and `peerId`), and again in `this.handler.handleMessage` at `websocket-handler.js` line 56.

Note: `RelayRegistryDO` is currently dead code (deleted in wrangler.jsonc migration v3), but this fix is still valuable if the class is ever re-enabled, or as a pattern for other WebSocket handlers.

## Fix Steps

1. **Add a message size constant** at the top of `relay-registry-do.js`, after the imports (after line 11):

```js
/** Maximum allowed WebSocket message size in bytes */
const MAX_MESSAGE_SIZE = 128 * 1024; // 128KB
```

2. **Add a size check** at the beginning of `webSocketMessage` (line 99), before `JSON.parse`:

```js
async webSocketMessage(ws, message) {
  try {
    // Reject oversized messages before parsing
    const messageLength = typeof message === 'string' ? message.length : message.byteLength;
    if (messageLength > MAX_MESSAGE_SIZE) {
      this.handler.sendError(ws, 'Message too large');
      return;
    }

    const data = JSON.parse(message);
    // ... rest of handler
```

3. **Eliminate the double-parse**: Currently the message is parsed on line 100 in `relay-registry-do.js` and again on line 56 in `websocket-handler.js`. Refactor to parse once and pass the parsed object:

   - In `relay-registry-do.js`, change line 107 from `this.handler.handleMessage(ws, message)` to `this.handler.handleMessage(ws, message, data)`.
   - In `websocket-handler.js`, modify `handleMessage` (line 52) to accept an optional pre-parsed object:

   ```js
   handleMessage(ws, rawData, parsedData = null) {
     let message;
     try {
       message = parsedData || JSON.parse(rawData);
     } catch (e) {
       this.sendError(ws, 'Invalid message format: JSON parse error');
       return;
     }
     // ... rest of handler
   }
   ```

## Testing

- Test that messages under 128KB are accepted and processed normally.
- Test that messages over 128KB receive an error response and are not parsed.
- Test with binary WebSocket messages (where `message` is `ArrayBuffer` rather than `string`).
- Verify no regressions in existing WebSocket message handling.

## Risk Assessment

- **Low risk**: The 128KB limit is well above any legitimate message size (signaling messages are typically a few KB, chunk pushes are limited to 64KB by `MAX_TEXT_CHUNK_PAYLOAD`).
- **Dead code caveat**: Since `RelayRegistryDO` is currently deleted in wrangler migrations, this change has no production impact until the class is re-enabled. However, applying the fix now sets the right pattern.
- The double-parse elimination is a minor optimization that slightly reduces CPU usage per message.
