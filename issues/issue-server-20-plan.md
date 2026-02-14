# Plan: peerId not validated for format or length in WebSocket handler

**Issue**: issue-server-20.md
**Severity**: MEDIUM
**Area**: Server
**Files to modify**:
- `packages/server/src/websocket-handler.js`

## Analysis

In `packages/server/src/websocket-handler.js`:
- `handleRegister()` (lines 111-136): Only checks truthiness at line 114:
  ```js
  if (!peerId) {
    this.sendError(ws, 'Missing required field: peerId');
    return;
  }
  ```
  No type check (could be a number, object, or array), no length check (could be megabytes), no character set check.

The same lack of validation applies to `peerId` in:
- `handleUpdateLoad()` (line 144): Uses `peerId` directly from message without any validation.
- `handleRegisterRendezvous()` (line 162): Uses `peerId` from message destructuring.
- `handleChunkAnnounce()` (lines 241-246): Checks `!peerId` but not type/length.
- `handleChunkRequest()` (line 287): Checks `!peerId || !chunkId` but not type/length.
- `handleHeartbeat()` (line 211): Uses `peerId` directly without validation.

These peerIds are used as Map keys in `wsConnections`, `relayRegistry.peers`, `rendezvousRegistry`, and `chunkIndex.chunkSources`. Very long string keys consume excess memory.

## Fix Steps

1. **Create a validation helper** at the top of `websocket-handler.js` (or in a shared utility):
   ```js
   const PEER_ID_MAX_LENGTH = 128;
   const PEER_ID_PATTERN = /^[\w-]+$/;

   function isValidPeerId(peerId) {
     return (
       typeof peerId === 'string' &&
       peerId.length > 0 &&
       peerId.length <= PEER_ID_MAX_LENGTH &&
       PEER_ID_PATTERN.test(peerId)
     );
   }
   ```

2. **Update `handleRegister()`** (lines 114-117):
   ```js
   if (!isValidPeerId(peerId)) {
     this.sendError(ws, 'Invalid peerId: must be 1-128 alphanumeric characters, hyphens, or underscores');
     return;
   }
   ```

3. **Update `handleUpdateLoad()`** (after line 144):
   ```js
   handleUpdateLoad(ws, message) {
     const { peerId, connectedCount } = message;
     if (!isValidPeerId(peerId)) {
       this.sendError(ws, 'Invalid peerId');
       return;
     }
     // ... rest of method
   }
   ```

4. **Update `handleRegisterRendezvous()`** (after line 162):
   ```js
   if (!isValidPeerId(peerId)) {
     this.sendError(ws, 'Invalid peerId');
     return;
   }
   ```

5. **Update `handleChunkAnnounce()`** (replace line 243-246):
   ```js
   if (!isValidPeerId(peerId)) {
     this.sendError(ws, 'Invalid peerId');
     return;
   }
   ```

6. **Update `handleChunkRequest()`** (replace line 288-290):
   ```js
   if (!isValidPeerId(peerId) || !chunkId || typeof chunkId !== 'string' || chunkId.length > 256) {
     this.sendError(ws, 'Missing or invalid required fields: peerId, chunkId');
     return;
   }
   ```

7. **Update `handleHeartbeat()`** (after line 211):
   ```js
   if (!isValidPeerId(peerId)) {
     this.sendError(ws, 'Invalid peerId');
     return;
   }
   ```

8. **Also validate `connectedCount`** in `handleUpdateLoad()`:
   ```js
   if (typeof connectedCount !== 'number' || connectedCount < 0 || connectedCount > 10000) {
     this.sendError(ws, 'Invalid connectedCount');
     return;
   }
   ```

## Testing

- Verify that valid peerIds (alphanumeric, hyphens, underscores, 1-128 chars) are accepted.
- Verify that invalid peerIds are rejected:
  - Empty string
  - Non-string (number, object, array)
  - String longer than 128 chars
  - String with special characters (spaces, newlines, null bytes)
- Verify that all message types enforce the validation.
- Run existing WebSocket integration tests.

## Risk Assessment

- **Client compatibility**: Verify that the Flutter app generates peerIds matching `[\w-]+` and within 128 chars. Typical peerIds are UUIDs (36 chars) or hex strings (64 chars), both of which match this pattern.
- **Interaction with issue-server-3**: If peerId binding (issue-server-3) is implemented, this validation would only need to run once during registration, since subsequent messages would use the server-verified peerId. However, validating in each handler provides defense-in-depth.
- **Performance**: Regex validation adds negligible overhead per message.
