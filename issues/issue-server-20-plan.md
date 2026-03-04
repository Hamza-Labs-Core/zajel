# Plan: peerId not validated for format or length in WebSocket handler

**Retargeted**: This issue was originally identified in dead CF Worker code. The same vulnerability exists in the VPS server.

**Issue**: issue-server-20.md
**Severity**: MEDIUM
**Area**: Server (VPS)
**Files to modify**:
- `packages/server-vps/src/client/handler.ts`

## Analysis

In `packages/server-vps/src/client/handler.ts`:

- `handleRegister()` (lines 726-766): Only checks truthiness at lines 729-732:
  ```ts
  const { peerId, maxConnections = 20, publicKey } = message;

  if (!peerId) {
    this.sendError(ws, 'Missing required field: peerId');
    return;
  }
  ```
  No type check (could be a number, object, or array due to JSON.parse), no length check (could be megabytes), no character set check.

The same lack of validation applies to `peerId` in:
- `handleUpdateLoad()` (line 772): Uses `peerId` directly from message without any validation.
- `handleRegisterRendezvous()` (line 799): Uses `peerId` from message destructuring.
- `handleHeartbeat()` (line 917): Uses `peerId` directly without validation.
- `handleChunkAnnounce()` (lines 2125-2129): Checks `!peerId` but not type/length.
- `handleGetRelays()` (line 903): Uses `peerId` from message without validation.

These peerIds are used as Map keys in `clients`, `wsToClient`, `relayRegistry.peers`, and passed to `distributedRendezvous`. Very long string keys consume excess memory and could be used for DoS.

## Fix Steps

1. **Create a validation helper** at the top of `handler.ts` (or in a shared utility file like `packages/server-vps/src/utils/validation.ts`):
   ```ts
   const PEER_ID_MAX_LENGTH = 128;
   const PEER_ID_PATTERN = /^[\w-]+$/;

   function isValidPeerId(peerId: unknown): peerId is string {
     return (
       typeof peerId === 'string' &&
       peerId.length > 0 &&
       peerId.length <= PEER_ID_MAX_LENGTH &&
       PEER_ID_PATTERN.test(peerId)
     );
   }
   ```

2. **Update `handleRegister()`** (replace lines 729-732):
   ```ts
   if (!isValidPeerId(peerId)) {
     this.sendError(ws, 'Invalid peerId: must be 1-128 alphanumeric characters, hyphens, or underscores');
     return;
   }
   ```

3. **Update `handleUpdateLoad()`** (after line 772):
   ```ts
   private handleUpdateLoad(ws: WebSocket, message: UpdateLoadMessage): void {
     const { peerId, connectedCount } = message;

     if (!isValidPeerId(peerId)) {
       this.sendError(ws, 'Invalid peerId');
       return;
     }
     // ... rest of method
   }
   ```

4. **Update `handleRegisterRendezvous()`** (after line 799):
   ```ts
   if (!isValidPeerId(peerId)) {
     this.sendError(ws, 'Invalid peerId');
     return;
   }
   ```

5. **Update `handleGetRelays()`** (after line 903):
   ```ts
   if (!isValidPeerId(peerId)) {
     this.sendError(ws, 'Invalid peerId');
     return;
   }
   ```

6. **Update `handleHeartbeat()`** (after line 917):
   ```ts
   if (!isValidPeerId(peerId)) {
     this.sendError(ws, 'Invalid peerId');
     return;
   }
   ```

7. **Update `handleChunkAnnounce()`** (replace lines 2127-2129):
   ```ts
   if (!isValidPeerId(peerId)) {
     this.sendError(ws, 'Invalid peerId');
     return;
   }
   ```

8. **Also validate `connectedCount`** in `handleUpdateLoad()` (line 780):
   ```ts
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
