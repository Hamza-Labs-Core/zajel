# Plan: WebSocket message handler double-parses JSON

**Issue**: issue-server-19.md
**Severity**: MEDIUM
**Area**: Server
**Files to modify**:
- `packages/server/src/durable-objects/relay-registry-do.js`
- `packages/server/src/websocket-handler.js`

## Analysis

In `packages/server/src/durable-objects/relay-registry-do.js`:
- `webSocketMessage()` (lines 98-111): Parses the message as JSON on line 100:
  ```js
  const data = JSON.parse(message);
  ```
  Then passes the raw `message` string (not the parsed object) to the handler on line 107:
  ```js
  this.handler.handleMessage(ws, message);
  ```

In `packages/server/src/websocket-handler.js`:
- `handleMessage()` (lines 52-104): Parses the same message string again on line 56:
  ```js
  message = JSON.parse(data);
  ```

Every WebSocket message is parsed twice: once in the DO layer and once in the handler. For high-throughput scenarios with many peers, this doubles the CPU cost of JSON parsing.

## Fix Steps

1. **Pass the parsed object from `relay-registry-do.js`** to the handler (line 107):
   ```js
   this.handler.handleMessage(ws, data);  // Pass parsed object instead of raw string
   ```

2. **Update `handleMessage()` signature in `websocket-handler.js`** (lines 52-60):
   ```js
   /**
    * Handle incoming WebSocket message
    * @param {WebSocket} ws - WebSocket connection
    * @param {Object} data - Parsed message object
    */
   handleMessage(ws, data) {
     const message = data;
     const { type } = message;
     // ... rest of the switch statement (line 62 onwards, unchanged)
   ```

   Or more cleanly, rename the parameter:
   ```js
   handleMessage(ws, message) {
     const { type } = message;

     switch (type) {
       // ... all cases remain the same
     }
   }
   ```

3. **Remove the try/catch JSON.parse wrapper** in `handleMessage()` (lines 55-60):
   Since parsing now happens in the DO layer, the error handling for invalid JSON is already covered by the try/catch in `webSocketMessage()` (relay-registry-do.js line 108-110).

4. **Update the JSDoc comment** for `handleMessage()` to reflect the new signature:
   ```js
   /**
    * Handle incoming WebSocket message
    * @param {WebSocket} ws - WebSocket connection
    * @param {Object} message - Pre-parsed message object
    */
   ```

5. **Note on interaction with issue-server-3**: The fix for issue-server-3 also modifies the `webSocketMessage()` method to inject verified peerIds. These changes are complementary: the DO layer parses the message, verifies/injects the peerId, and passes the parsed+verified object to the handler.

## Testing

- Verify that all WebSocket message types (register, update_load, register_rendezvous, get_relays, chunk_announce, chunk_request, chunk_push, ping, heartbeat) still work correctly.
- Verify that invalid JSON messages are still rejected (by the DO layer's try/catch).
- Performance test: Measure CPU time per message before and after the change to confirm the improvement.
- Run existing WebSocket integration tests.

## Risk Assessment

- **Very low risk**: This is a straightforward refactor that eliminates redundant parsing. The control flow is identical; only the data format passed between layers changes from string to object.
- **Interaction with other fixes**: If issue-server-3 (peerId binding) is implemented, the DO layer will already be working with the parsed object. This fix is a prerequisite or co-requisite for that change.
- **Backward compatibility**: The `handleMessage()` method is internal to the server and not part of any external API. No backward compatibility concerns.
