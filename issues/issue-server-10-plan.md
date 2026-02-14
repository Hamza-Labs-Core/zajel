# Plan: WebSocket peerId takeover via re-registration

**Issue**: issue-server-10.md
**Severity**: HIGH
**Area**: Server
**Files to modify**:
- `packages/server/src/websocket-handler.js`
- `packages/server/src/durable-objects/relay-registry-do.js`

## Analysis

In `packages/server/src/websocket-handler.js`:
- `handleRegister()` (line 120): `this.wsConnections.set(peerId, ws)` unconditionally overwrites any existing entry. If WebSocket A registered with peerId "X", and then WebSocket B registers with peerId "X", the Map entry for "X" now points to WebSocket B. WebSocket A's messages are lost.

In `packages/server/src/durable-objects/relay-registry-do.js`:
- `webSocketMessage()` (line 104): `this.wsToPeerId.set(ws, data.peerId)` creates a reverse mapping from WebSocket B to peerId "X". But WebSocket A still has a stale entry in `wsToPeerId` pointing to peerId "X".
- `webSocketClose()` (lines 117-123): When WebSocket A eventually closes, `this.wsToPeerId.get(ws)` returns "X", and `this.handler.handleDisconnect(ws, peerId)` is called, which at websocket-handler.js line 409 calls `this.wsConnections.delete(peerId)` -- deleting WebSocket B's legitimate registration.

This creates a cascading failure:
1. Attacker registers with victim's peerId -> victim's socket is orphaned.
2. Victim's socket closes -> disconnect handler removes attacker's registration too.
3. Both victim and attacker lose connectivity.

## Fix Steps

1. **In `handleRegister()` (websocket-handler.js line 111-136)**, check for existing registration:
   ```js
   handleRegister(ws, message) {
     const { peerId, maxConnections = 20, publicKey } = message;

     if (!peerId) {
       this.sendError(ws, 'Missing required field: peerId');
       return;
     }

     // Check if peerId is already registered by a different WebSocket
     const existingWs = this.wsConnections.get(peerId);
     if (existingWs && existingWs !== ws) {
       // Option A: Reject the new registration
       this.sendError(ws, 'Peer ID already in use by another connection');
       return;

       // Option B (alternative): Close the old connection first
       // try { existingWs.close(4000, 'Superseded by new connection'); } catch(e) {}
       // this.handleDisconnect(existingWs, peerId);
     }

     // Proceed with registration...
     this.wsConnections.set(peerId, ws);
     // ...
   }
   ```

2. **Clean up stale reverse mappings in `relay-registry-do.js`** `webSocketMessage()` (around line 103):
   - When a `register` message is processed, also clean up any old `wsToPeerId` entries that point to the same peerId from a different WebSocket:
   ```js
   if (data.type === 'register' && data.peerId) {
     // Clean up old reverse mapping if a different WS was registered with this peerId
     for (const [oldWs, oldPeerId] of this.wsToPeerId.entries()) {
       if (oldPeerId === data.peerId && oldWs !== ws) {
         this.wsToPeerId.delete(oldWs);
         break;
       }
     }
     this.wsToPeerId.set(ws, data.peerId);
   }
   ```

3. **This fix interacts with issue-server-3**: The peerId binding approach from issue-server-3 (preventing re-registration with a different peerId on the same socket) complements this fix (preventing a different socket from taking over an existing peerId). Both should be implemented together.

## Testing

- Test that a second WebSocket trying to register with the same peerId as an existing connection is rejected.
- Test that after the original connection closes, a new connection can register with that peerId.
- Test that the disconnect handler does not corrupt other connections' state.
- Verify that the `wsToPeerId` map does not accumulate stale entries.

## Risk Assessment

- **Reconnection scenarios**: If a legitimate client disconnects and reconnects quickly (before the server processes the close event), the new connection's registration will be rejected. The client should implement retry logic with a small delay.
- **Option A vs Option B**: Rejecting the new registration (Option A) is safer and prevents impersonation. Closing the old connection (Option B) is more user-friendly for legitimate reconnects but allows denial-of-service (an attacker can force-disconnect any peer by registering with their peerId). **Recommend Option A**.
- **No breaking changes for well-behaved clients**: Clients that use unique peerIds per connection are unaffected.
