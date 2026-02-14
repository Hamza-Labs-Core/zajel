# Plan: WebSocket peer identity is self-asserted with no verification

**Retargeted**: This issue was originally identified in dead CF Worker code (`packages/server/src/websocket-handler.js`). The same vulnerability exists in the VPS server.

**Issue**: issue-server-3.md
**Severity**: CRITICAL
**Area**: Server (VPS)
**Files to modify**:
- `packages/server-vps/src/client/handler.ts`
- `packages/server-vps/src/index.ts`

## Analysis

In `packages/server-vps/src/client/handler.ts`:
- `handleRegister()` (lines 726-766): Accepts `peerId` directly from the message body at line 727 (`const { peerId, maxConnections = 20, publicKey } = message`), then stores it at line 746 (`this.clients.set(peerId, info)`) and line 747 (`this.wsToClient.set(ws, peerId)`) with zero verification that the client owns this identity.
- `handleUpdateLoad()` (line 771): Uses `peerId` from the message body at line 772 (`const { peerId, connectedCount } = message`) with no check that the sender owns that peerId.
- `handleRegisterRendezvous()` (line 795): Uses `peerId` from the message body at line 799 (`const { peerId, relayId } = message`).
- `handleChunkAnnounce()` (line 2119): Uses `peerId` from the message body at line 2125 (`const { peerId, channelId, chunks } = message`).
- `handleHeartbeat()` (line 916): Uses `peerId` from the message body at line 917 (`const { peerId } = message`).

In `packages/server-vps/src/index.ts`:
- `wss.on('connection')` (lines 272-295): When a client WebSocket connects, there is no binding between the WebSocket object and the peerId. The handler receives raw messages via `ws.on('message')` at line 280 and passes them to `clientHandler.handleMessage(ws, data.toString())` at line 283. There is no enforcement of peerId consistency across messages from the same WebSocket.

The `wsToClient` Map (line 315 in handler.ts) provides a reverse lookup from WebSocket to peerId, but it is only set during `handleRegister()` and is never used to verify subsequent messages. A client can send a `register` message with peerId "A", then send `update_load` or `heartbeat` messages with peerId "B" and the server will process them for peer "B".

## Fix Steps

1. **Bind peerId to WebSocket on first registration** in `handleRegister()` (handler.ts line 726):
   - After `this.wsToClient.set(ws, peerId)` at line 747, the binding exists. The issue is that subsequent message handlers don't verify the binding.

2. **Add a `getVerifiedPeerId(ws, message)` method** to `ClientHandler`:
   ```ts
   private getVerifiedPeerId(ws: WebSocket, claimedPeerId: string): string | null {
     const boundPeerId = this.wsToClient.get(ws);
     if (!boundPeerId) {
       // Not registered yet - only allowed during register
       return null;
     }
     if (boundPeerId !== claimedPeerId) {
       this.sendError(ws, 'peerId mismatch with registered identity');
       return null;
     }
     return boundPeerId;
   }
   ```

3. **Modify `handleMessage()` (handler.ts line 553)** to inject the verified peerId for all non-register messages:
   - For message types that include a `peerId` field (`update_load`, `register_rendezvous`, `heartbeat`, `chunk_announce`), verify the peerId matches the bound value from `wsToClient.get(ws)`.
   - If mismatch, send an error and return without processing.
   ```ts
   // After parsing, before the switch statement (around line 578):
   if ('peerId' in message && message.type !== 'register') {
     const boundPeerId = this.wsToClient.get(ws);
     if (boundPeerId && (message as { peerId: string }).peerId !== boundPeerId) {
       this.sendError(ws, 'peerId mismatch with registered identity');
       return;
     }
     // Override with bound peerId to prevent spoofing
     if (boundPeerId) {
       (message as { peerId: string }).peerId = boundPeerId;
     }
   }
   ```

4. **For non-register message handlers**, use the server-verified peerId rather than the client-supplied one. After the injection above, all handlers will receive the bound peerId.

5. **Require registration before processing peerId-bearing messages**: For handlers like `handleUpdateLoad()` and `handleHeartbeat()`, add a check:
   ```ts
   if (!this.wsToClient.has(ws)) {
     this.sendError(ws, 'Not registered. Send register message first.');
     return;
   }
   ```

## Testing

- Test that a peer can register with a peerId and subsequent messages work normally.
- Test that after registration, messages with a peerId different from the registered one are rejected.
- Test that messages requiring a peerId (update_load, heartbeat, register_rendezvous, chunk_announce) sent before registration are rejected.
- Test that messages without a peerId field (ping, offer, answer, ice_candidate) still work regardless of registration state.
- Run existing WebSocket integration tests.

## Risk Assessment

- **Breaking change for clients**: If any client sends messages with varying peerIds on the same WebSocket, this will break. Audit the Flutter app to confirm this pattern is not used (it should not be -- each client uses a single peerId per connection).
- **Interaction with issue-server-10**: This fix complements the peerId takeover fix (issue-server-10) -- together they prevent both re-registration and cross-socket impersonation.
- **Two identity systems**: The VPS handler has two identity systems: `peerId` (relay clients, `wsToClient` Map at line 315) and `pairingCode` (signaling clients, `wsToPairingCode` Map at line 318). The pairingCode system already validates identity via `wsToPairingCode.get(ws)` in handlers like `handleSignalingForward()` (line 1514). Only the peerId system needs this fix.
- **Performance**: Adding a Map lookup per message is negligible overhead.
