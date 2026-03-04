# Plan: Handshake key exchange is vulnerable to peer identity confusion

**Issue**: issue-headless-05.md
**Severity**: HIGH
**Area**: Headless Client
**Files to modify**:
- `packages/headless-client/zajel/client.py`

## Analysis

At `client.py:1374-1388`, the `_on_message_channel_data` method handles handshake messages. When a handshake arrives, the code iterates over all connected peers and performs key exchange with the **first peer that lacks a session key**:

```python
if msg["type"] == "handshake":
    peer_pub_key = msg["publicKey"]
    for peer_id, peer in self._connected_peers.items():
        if not self._crypto.has_session_key(peer_id):
            self._crypto.perform_key_exchange(peer_id, peer_pub_key)
            logger.info("Key exchange completed with %s", peer_id)
            break
    else:
        logger.warning("No peer found for handshake")
```

The handshake message contains only `{"publicKey": "..."}` with no peer identification. If multiple peers connect near-simultaneously, peer A's public key could be attributed to peer B.

Currently, the architecture uses a single WebRTC connection at a time (the `_webrtc` service manages one `RTCPeerConnection`). However, the code in `_connected_peers` can have multiple entries if peers are added before the key exchange completes (see issue-headless-13 about early peer addition at line 1281).

Additionally, the public key from the handshake is not verified against the public key received during the signaling pairing phase (`match.peer_public_key`), which would prevent key substitution.

## Fix Steps

1. **Track the current WebRTC peer ID** in the client. After `_establish_connection` sets up the WebRTC connection, store the peer code associated with it:
   ```python
   # In _establish_connection, after line 1284:
   self._webrtc_peer_id = match.peer_code
   ```

2. **Use the tracked peer ID in the handshake handler** at `client.py:1378-1388`:
   ```python
   if msg["type"] == "handshake":
       peer_pub_key = msg["publicKey"]
       peer_id = self._webrtc_peer_id
       if peer_id and peer_id in self._connected_peers:
           if not self._crypto.has_session_key(peer_id):
               # Verify the handshake public key matches what we received during pairing
               expected_pub = self._connected_peers[peer_id].public_key
               if expected_pub and peer_pub_key != expected_pub:
                   logger.warning(
                       "Handshake public key mismatch for %s: "
                       "expected %s, got %s",
                       peer_id, expected_pub[:16], peer_pub_key[:16],
                   )
               self._crypto.perform_key_exchange(peer_id, peer_pub_key)
               logger.info("Key exchange completed with %s", peer_id)
           else:
               logger.warning("Already have session key for %s", peer_id)
       else:
           logger.warning("Handshake from unknown WebRTC peer")
   ```

3. **Initialize `_webrtc_peer_id`** in `__init__` at the State section (around line 218):
   ```python
   self._webrtc_peer_id: Optional[str] = None
   ```

4. **Clear `_webrtc_peer_id`** on disconnect at `disconnect()` around line 302:
   ```python
   self._webrtc_peer_id = None
   ```

## Testing

- Unit test: Verify that a handshake message is attributed to the correct peer (the one associated with the WebRTC connection).
- Unit test: Verify that a handshake with a mismatched public key logs a warning.
- Integration test: Connect two peers simultaneously and verify no identity confusion occurs.
- Run existing E2E pairing and messaging tests.

## Risk Assessment

- Low risk for the peer ID tracking change. The architecture currently supports one WebRTC connection at a time, so `_webrtc_peer_id` is always well-defined.
- The public key verification (comparing handshake key vs. pairing key) adds defense but may need adjustment if the protocol legitimately supports key rotation between pairing and handshake.
- If the architecture evolves to support multiple simultaneous WebRTC connections, this fix establishes the right pattern (binding transport to crypto identity).
