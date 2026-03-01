# [MEDIUM] SignalingRoom broadcasts peer_joined to ALL connected peers

**Area**: Server
**File**: packages/server/src/signaling-room.js:160-175
**Type**: Security

**Description**: When a peer registers with a pairing code, `broadcastPeerJoined` notifies ALL other connected clients about the new peer's pairing code:
```js
broadcastPeerJoined(pairingCode) {
  const message = JSON.stringify({ type: 'peer_joined', pairingCode });
  for (const [code, client] of this.clients.entries()) {
    if (code !== pairingCode) {
      try { client.send(message); } catch (e) {}
    }
  }
}
```
This means every connected client learns every pairing code in use, even if they are not the intended pairing partner.

**Impact**: Information leakage of active pairing codes. An attacker can connect to the signaling room and passively collect all active pairing codes. If pairing codes have low entropy or are predictable, this aids targeted attacks. Even with high-entropy codes, broadcasting them to all peers violates the principle of least privilege.

**Fix**: Only notify the specific peer that shares the same pairing intent. In a 1-to-1 pairing scenario, only the peer with the matching pairing code should be notified. If pairing is done by code exchange, both peers register with the same code and should only see each other. Consider making the SignalingRoom per-pairing-code (each code gets its own DO instance) rather than broadcasting globally.
