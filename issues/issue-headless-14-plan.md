# Plan: Race condition: peer added to connected_peers before key exchange

**Issue**: issue-headless-14.md
**Severity**: MEDIUM
**Area**: Headless Client
**Files to modify**:
- `packages/headless-client/zajel/client.py`

## Analysis

At `client.py:1270-1281`, the `_establish_connection` method adds the peer to `self._connected_peers` before the WebRTC connection is established and before the key exchange completes:

```python
async def _establish_connection(self, match: PairMatch) -> ConnectedPeer:
    peer = ConnectedPeer(
        peer_id=match.peer_code,
        public_key=match.peer_public_key,
        is_initiator=match.is_initiator,
    )

    # Store peer early so incoming handshake messages can find it
    self._connected_peers[match.peer_code] = peer
```

The comment explains the rationale: "Store peer early so incoming handshake messages can find it (the app sends its handshake as soon as the data channel opens, which can arrive before we finish _establish_connection)."

This creates problems:
1. If `_establish_connection` fails after line 1281 (e.g., timeout on WebRTC negotiation), the peer remains in `_connected_peers` as a stale entry.
2. `get_connected_peers()` returns peers that have no session key yet.
3. `send_text()` will fail with "No session key" for such peers.

## Fix Steps

1. **Add a `_pending_peers` dict** in `__init__` (around line 218):
   ```python
   self._pending_peers: dict[str, ConnectedPeer] = {}
   ```

2. **Refactor `_establish_connection`** at lines 1270-1349 to use `_pending_peers` during setup and only move to `_connected_peers` after success:
   ```python
   async def _establish_connection(self, match: PairMatch) -> ConnectedPeer:
       peer = ConnectedPeer(
           peer_id=match.peer_code,
           public_key=match.peer_public_key,
           is_initiator=match.is_initiator,
       )

       # Store in pending so handshake handler can find it
       self._pending_peers[match.peer_code] = peer
       self._webrtc_peer_id = match.peer_code

       try:
           # ... WebRTC setup (lines 1283-1322) ...

           # Send handshake
           handshake = HandshakeMessage(public_key=self._crypto.public_key_base64)
           await self._webrtc.send_message(handshake.to_json())

           # ... file transfer setup, storage save (lines 1328-1345) ...

           # Move from pending to connected after everything succeeds
           self._connected_peers[match.peer_code] = peer
           del self._pending_peers[match.peer_code]

           await self._events.emit("peer_connected", peer.peer_id, peer.public_key)
           logger.info("Connected to peer %s", match.peer_code)
           return peer
       except Exception:
           self._pending_peers.pop(match.peer_code, None)
           raise
   ```

3. **Update the handshake handler** (`_on_message_channel_data` at line 1374-1388) to look in both `_connected_peers` and `_pending_peers`:
   ```python
   if msg["type"] == "handshake":
       peer_pub_key = msg["publicKey"]
       peer_id = self._webrtc_peer_id
       # Check both connected and pending peers
       if peer_id and (peer_id in self._connected_peers or peer_id in self._pending_peers):
           if not self._crypto.has_session_key(peer_id):
               self._crypto.perform_key_exchange(peer_id, peer_pub_key)
               logger.info("Key exchange completed with %s", peer_id)
       else:
           logger.warning("Handshake from unknown peer")
   ```

4. **Update decryption handler** to also check `_pending_peers` when looking for peers (since messages might arrive during the pending window):
   The encrypted message handler at line 1390 iterates `self._connected_peers`. If using the `_webrtc_peer_id` approach from issue-05/06, this is already handled correctly.

## Testing

- Unit test: Simulate a connection failure during `_establish_connection` (e.g., WebRTC timeout). Verify the peer is NOT in `_connected_peers` afterward.
- Unit test: Verify `get_connected_peers()` only returns peers with completed connections.
- Unit test: Simulate a handshake message arriving during the pending window. Verify key exchange succeeds.
- Integration test: Successful connection results in the peer being in `_connected_peers` with a valid session key.
- Run existing E2E pairing and messaging tests.

## Risk Assessment

- Medium risk. The "early store" pattern exists for a reason (handshake messages need to find the peer). The `_pending_peers` approach preserves this functionality while properly handling failures.
- The main risk is edge cases where the handshake message arrives and is processed but the connection subsequently fails. In this case, we have a session key for a peer that is not connected. The cleanup in the `except` block should also clear the session key.
- This fix interacts with issues 05 and 06 (peer identification). They should be coordinated.
