# Plan: WebSocket peerId takeover via re-registration

**Retargeted**: This issue was originally identified in dead CF Worker code (`packages/server/src/websocket-handler.js` and `packages/server/src/durable-objects/relay-registry-do.js`). The same vulnerability exists in the VPS server.

**Issue**: issue-server-10.md
**Severity**: HIGH
**Area**: Server (VPS)
**Files to modify**:
- `packages/server-vps/src/client/handler.ts`

## Analysis

In `packages/server-vps/src/client/handler.ts`:
- `handleRegister()` (lines 726-766): At line 746, `this.clients.set(peerId, info)` unconditionally overwrites any existing entry. If WebSocket A registered with peerId "X", and then WebSocket B sends a `register` message with peerId "X", the Map entry for "X" now points to WebSocket B. WebSocket A's messages are lost because `notifyClient()` (line 2407) looks up `this.clients.get(peerId)` and will find WebSocket B.
- At line 747, `this.wsToClient.set(ws, peerId)` creates a reverse mapping from WebSocket B to peerId "X". But WebSocket A still has a stale entry in `wsToClient` pointing to peerId "X".

The `handleDisconnect()` method (lines 2281-2402) creates a cascading failure:
1. Attacker registers with victim's peerId at line 746 -> victim's `clients` entry is overwritten, victim's socket is orphaned.
2. Victim's socket closes -> `handleDisconnect()` is called. At line 2385, `const peerId = this.wsToClient.get(ws)` returns "X" (victim's stale binding).
3. At line 2389, `this.relayRegistry.unregister(peerId)` removes the relay registration.
4. At line 2398, `this.clients.delete(peerId)` removes WebSocket B's (the attacker's) legitimate registration.
5. Both victim and attacker lose connectivity.

This also affects `notifyClient()` at line 2407: after the takeover, messages intended for the victim's peerId are delivered to the attacker's WebSocket.

## Fix Steps

1. **In `handleRegister()` (handler.ts lines 726-766)**, check for existing registration before allowing:
   ```ts
   private async handleRegister(ws: WebSocket, message: RegisterMessage): Promise<void> {
     const { peerId, maxConnections = 20, publicKey } = message;

     if (!peerId) {
       this.sendError(ws, 'Missing required field: peerId');
       return;
     }

     // Check if peerId is already registered by a different WebSocket
     const existingClient = this.clients.get(peerId);
     if (existingClient && existingClient.ws !== ws) {
       // Option A: Reject the new registration (recommended)
       this.sendError(ws, 'Peer ID already in use by another connection');
       return;
     }

     // Check if this WebSocket is already registered with a different peerId
     const existingPeerId = this.wsToClient.get(ws);
     if (existingPeerId && existingPeerId !== peerId) {
       this.sendError(ws, 'Cannot re-register with a different peerId');
       return;
     }

     // Proceed with registration...
     const now = Date.now();
     const info: ClientInfo = {
       peerId,
       ws,
       connectedAt: now,
       lastSeen: now,
       isRelay: true,
     };

     this.clients.set(peerId, info);
     this.wsToClient.set(ws, peerId);
     // ... rest of registration
   }
   ```

2. **Harden `handleDisconnect()` (handler.ts lines 2281-2402)** to prevent stale binding corruption:
   - At line 2385, after getting `peerId` from `wsToClient.get(ws)`, verify the `clients` Map still points to this WebSocket before cleaning up:
   ```ts
   const peerId = this.wsToClient.get(ws);
   if (!peerId) return;

   // Only clean up if this WebSocket is still the registered one for this peerId
   const client = this.clients.get(peerId);
   if (client && client.ws === ws) {
     this.relayRegistry.unregister(peerId);
     await this.distributedRendezvous.unregisterPeer(peerId);
     if (this.chunkRelay) {
       await this.chunkRelay.unregisterPeer(peerId);
     }
     this.clients.delete(peerId);
     this.emit('client-disconnected', peerId);
   }

   // Always clean up the reverse mapping for this WebSocket
   this.wsToClient.delete(ws);
   ```

3. **This fix interacts with issue-server-3**: The peerId binding approach from issue-server-3 (verifying peerId consistency across messages on the same socket) complements this fix (preventing a different socket from taking over an existing peerId). Both should be implemented together.

## Testing

- Test that a second WebSocket trying to register with the same peerId as an existing connection is rejected with an error message.
- Test that after the original connection closes, a new connection can register with that peerId successfully.
- Test that the disconnect handler does not corrupt other connections' state: when WebSocket A is overwritten by WebSocket B (before fix), A's disconnect should not delete B's registration (after fix, this scenario is prevented entirely).
- Test that re-registration on the same WebSocket with the same peerId succeeds (idempotent re-registration).
- Test that re-registration on the same WebSocket with a different peerId is rejected.
- Verify that the `wsToClient` Map does not accumulate stale entries by checking Map sizes after connect/disconnect cycles.

## Risk Assessment

- **Reconnection scenarios**: If a legitimate client disconnects and reconnects quickly (before the server processes the close event), the new connection's registration will be rejected because the old peerId entry still exists. The client should implement retry logic with a small delay (e.g., 1-2 seconds). The VPS `cleanup()` method at line 2507 periodically cleans up stale clients based on heartbeat timeout, so stale entries will eventually be removed.
- **Option A vs Option B**: Rejecting the new registration (Option A) is safer and prevents impersonation. Closing the old connection (Option B) is more user-friendly for legitimate reconnects but allows denial-of-service (an attacker can force-disconnect any peer by registering with their peerId). **Recommend Option A**.
- **No breaking changes for well-behaved clients**: Clients that use unique peerIds per connection are unaffected. The Flutter app generates a unique peerId per device, so this is the expected behavior.
