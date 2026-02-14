# Plan: WebSocket peer identity is self-asserted with no verification

**Issue**: issue-server-3.md
**Severity**: CRITICAL
**Area**: Server
**Files to modify**:
- `packages/server/src/websocket-handler.js`
- `packages/server/src/durable-objects/relay-registry-do.js`

## Analysis

In `packages/server/src/websocket-handler.js`:
- `handleRegister()` (lines 111-136): Accepts `peerId` directly from the message body at line 112 (`const { peerId, maxConnections = 20, publicKey } = message`), then stores it at line 120 (`this.wsConnections.set(peerId, ws)`) with zero verification.
- `handleUpdateLoad()` (line 143): Uses `peerId` from message body with no check that the sender owns that peerId.
- `handleRegisterRendezvous()` (line 160): Uses `peerId` from message body.
- `handleChunkAnnounce()` (line 235): Uses `peerId` from message body.
- `handleChunkRequest()` (line 280): Uses `peerId` from message body.
- `handleHeartbeat()` (line 210): Uses `peerId` from message body.

In `packages/server/src/durable-objects/relay-registry-do.js`:
- `webSocketMessage()` (lines 98-111): Parses the message, sets `this.wsToPeerId.set(ws, data.peerId)` at line 104, then passes the raw `message` string to `this.handler.handleMessage(ws, message)` at line 107.
- There is no binding between the WebSocket object and the peerId after initial registration.

## Fix Steps

1. **Bind peerId to WebSocket on first registration** in `relay-registry-do.js`:
   - After `this.wsToPeerId.set(ws, data.peerId)` on line 104, this binding should be enforced.
   - On subsequent messages, if `wsToPeerId.has(ws)`, verify that any `peerId` in the message matches the bound value.

2. **Add a `getVerifiedPeerId(ws, message)` method** to `WebSocketHandler`:
   ```js
   getVerifiedPeerId(ws) {
     // This will be set by the DO layer after registration
     return this._wsPeerBindings?.get(ws) || null;
   }
   ```

3. **Modify `relay-registry-do.js` `webSocketMessage()`** (lines 98-111):
   - After the initial registration, for all subsequent messages containing a `peerId`, verify it matches `this.wsToPeerId.get(ws)`.
   - If mismatch, send an error and return without processing.
   ```js
   async webSocketMessage(ws, message) {
     try {
       const data = JSON.parse(message);
       const boundPeerId = this.wsToPeerId.get(ws);

       if (data.type === 'register' && data.peerId) {
         if (boundPeerId && boundPeerId !== data.peerId) {
           this.handler.sendError(ws, 'Cannot re-register with a different peerId');
           return;
         }
         this.wsToPeerId.set(ws, data.peerId);
       } else if (data.peerId && boundPeerId && data.peerId !== boundPeerId) {
         this.handler.sendError(ws, 'peerId mismatch with registered identity');
         return;
       }

       // Inject the verified peerId for non-register messages
       if (boundPeerId && data.type !== 'register') {
         data.peerId = boundPeerId;
       }

       this.handler.handleMessage(ws, data);
     } catch (e) {
       console.error('WebSocket message error:', e);
       this.handler.sendError(ws, 'Internal server error');
     }
   }
   ```

4. **Update `handleMessage()` in `websocket-handler.js`** (line 52): Change signature to accept a parsed object instead of a raw string (also addresses issue-server-19 double-parse). Remove the internal `JSON.parse(data)` call.

5. **For non-register message handlers**, use the server-verified peerId rather than the client-supplied one. The DO layer injects the correct peerId before passing to the handler.

## Testing

- Test that a peer can register with a peerId and subsequent messages work normally.
- Test that a second registration attempt with a different peerId on the same WebSocket is rejected.
- Test that messages with a peerId different from the registered one are rejected.
- Test that messages without a peerId (for handlers that require it) still fail with the existing validation.
- Run existing WebSocket integration tests.

## Risk Assessment

- **Breaking change for clients**: If any client sends messages with varying peerIds on the same WebSocket, this will break. Audit client code to confirm this pattern is not used.
- **Interaction with issue-server-10**: This fix complements the peerId takeover fix (issue-server-10) -- together they prevent both re-registration and cross-socket impersonation.
- **Performance**: Adding a Map lookup per message is negligible overhead.
