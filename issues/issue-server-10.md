# [HIGH] WebSocket peerId takeover via re-registration

**Area**: Server
**File**: packages/server/src/websocket-handler.js:119-121
**Type**: Security

**Description**: When a client sends a `register` message with a `peerId`, the handler unconditionally overwrites the `wsConnections` entry: `this.wsConnections.set(peerId, ws)`. If another WebSocket was previously registered with the same `peerId`, it is silently replaced. The old connection is not closed, not notified, and not cleaned up from `wsToPeerId`.

In `relay-registry-do.js:103`, `this.wsToPeerId.set(ws, data.peerId)` is set, but the old WebSocket that was mapped to the same peerId in `wsConnections` is orphaned -- when it disconnects, `wsToPeerId` will resolve its peerId and call `handleDisconnect`, which will delete the **new** legitimate connection's peerId from `wsConnections`.

**Impact**:
1. **Session hijacking**: An attacker registers with a victim's peerId, immediately taking over their identity.
2. **Cascading disconnection**: When the victim's old WebSocket eventually closes, `handleDisconnect` removes the peerId from all registries, disconnecting the attacker too -- but also cleaning up the victim's rendezvous and chunk registrations.
3. **Dangling state**: The old WebSocket remains in `wsToPeerId` pointing to a peerId now owned by a different socket.

**Fix**:
1. Before accepting a new registration for an existing peerId, close the old WebSocket and clean up its state.
2. Better yet, require cryptographic proof of peerId ownership so impersonation is impossible.
3. At minimum, check if a different WebSocket already owns the peerId and reject the registration:
```js
const existingWs = this.wsConnections.get(peerId);
if (existingWs && existingWs !== ws) {
  this.sendError(ws, 'Peer ID already in use');
  return;
}
```
