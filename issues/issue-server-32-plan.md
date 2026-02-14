# Plan: SignalingRoom broadcasts peer_joined to ALL connected peers

**Issue**: issue-server-32.md
**Severity**: MEDIUM
**Area**: Server
**Files to modify**: `packages/server/src/signaling-room.js`

## Analysis

In `packages/server/src/signaling-room.js`, the `broadcastPeerJoined` method (lines 160-175) sends a `peer_joined` message containing the new peer's pairing code to ALL other connected clients:

```js
broadcastPeerJoined(pairingCode) {
  const message = JSON.stringify({
    type: 'peer_joined',
    pairingCode,
  });

  for (const [code, client] of this.clients.entries()) {
    if (code !== pairingCode) {
      try {
        client.send(message);
      } catch (e) {
        // Client may have disconnected
      }
    }
  }
}
```

Similarly, `broadcastPeerLeft` (lines 177-189) broadcasts departures to all clients.

The `clients` Map (line 16) stores all connected peers keyed by pairing code. Every connected client learns about every other peer's pairing code, even if they are not the intended pairing partner.

Note: `SignalingRoom` is currently dead code (deleted in wrangler.jsonc migration v3, no binding or route exists for it).

## Fix Steps

1. **Replace broadcast with targeted notification** in `broadcastPeerJoined` (line 160). In a pairing scenario, only the peer with the matching pairing code should be notified. Replace:

```js
broadcastPeerJoined(pairingCode) {
  // Only notify the peer with the same pairing code, if one exists.
  // In the current model, each pairing code maps to exactly one WebSocket.
  // When two peers pair, they both register with the same code.
  // Since the Map only stores the latest registrant per code,
  // the first peer is already overwritten.

  // Instead, check if there's a peer waiting with the same code.
  // This requires changing the data model to support multiple
  // connections per pairing code.
}
```

Since the current design uses `this.clients.set(pairingCode, ws)` (line 109), which overwrites any existing connection with the same code, the broadcast model is the only way for the first peer to learn about the second. The fundamental issue is that both peers register with the same code but only one can be stored.

**Recommended approach**: Change the data model to support two peers per pairing code:

```js
// In constructor, change:
this.clients = new Map(); // pairingCode -> [ws1, ws2] (max 2 per code)
```

Then in `handleRegister`:
```js
async handleRegister(ws, message) {
  const { pairingCode } = message;

  if (!pairingCode || typeof pairingCode !== 'string') {
    this.sendError(ws, 'Invalid pairing code');
    return;
  }

  // Remove old registration for this websocket
  for (const [code, clients] of this.clients.entries()) {
    const idx = clients.indexOf(ws);
    if (idx >= 0 && code !== pairingCode) {
      clients.splice(idx, 1);
      if (clients.length === 0) this.clients.delete(code);
      break;
    }
  }

  if (!this.clients.has(pairingCode)) {
    this.clients.set(pairingCode, []);
  }

  const clients = this.clients.get(pairingCode);

  // Max 2 peers per pairing code
  if (clients.length >= 2 && !clients.includes(ws)) {
    this.sendError(ws, 'Pairing code already has maximum peers');
    return;
  }

  if (!clients.includes(ws)) {
    clients.push(ws);
  }

  ws.send(JSON.stringify({ type: 'registered', pairingCode }));

  // Only notify the OTHER peer(s) with the same pairing code
  for (const client of clients) {
    if (client !== ws) {
      try {
        client.send(JSON.stringify({ type: 'peer_joined', pairingCode }));
      } catch (e) {}
    }
  }
}
```

2. **Update `broadcastPeerLeft`** similarly to only notify peers with the same pairing code.

3. **Update `handleSignaling`** to find peers within the same pairing code group instead of using the `target` field to look up across all codes.

4. **Update `webSocketClose`** to handle the array-based client tracking.

## Testing

- Test that when peer A registers with code X, no notification is sent (no match yet).
- Test that when peer B registers with code X, only peer A (same code) receives `peer_joined`.
- Test that peer C registered with code Y does NOT receive `peer_joined` for code X.
- Test that signaling messages (offer/answer/ice_candidate) only route between peers sharing the same code.
- Test that a 3rd peer trying to register with code X (already has 2 peers) is rejected.

## Risk Assessment

- **Dead code**: `SignalingRoom` is deleted in wrangler migrations and has no binding. This fix has zero production impact currently.
- **Significant refactor**: Changing the data model from `Map<string, WebSocket>` to `Map<string, WebSocket[]>` requires updating all methods that interact with `this.clients`.
- **If re-enabled**: The fix is critical for privacy. Broadcasting pairing codes to all connected clients is a significant information leak.
