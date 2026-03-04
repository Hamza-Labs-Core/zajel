# [HIGH] Handshake key exchange is vulnerable to peer identity confusion

**Area**: Headless Client
**File**: packages/headless-client/zajel/client.py:1374-1388
**Type**: Security

**Description**: In `_on_message_channel_data`, when a handshake message arrives, the code iterates over all connected peers and performs the key exchange with the **first peer that does not yet have a session key** (line 1383). This is a dangerous assumption: if multiple peers connect near-simultaneously, a handshake message from peer A could be wrongly attributed to peer B, causing peer A's public key to be associated with peer B's session.

The handshake message contains only `{"publicKey": "..."}` with no peer identification, no authentication, and no binding to the WebRTC connection it arrived on. The code simply searches for any peer missing a session key.

**Impact**: Cryptographic identity confusion. An attacker could exploit a race condition during multi-peer connection setup to have their key associated with a different peer's identity, enabling man-in-the-middle or message interception between two honest peers.

**Fix**: The handshake message should include the sender's peer ID (pairing code) and be validated against the expected peer for that WebRTC connection:

```python
if msg["type"] == "handshake":
    peer_pub_key = msg["publicKey"]
    peer_id = msg.get("peerId")  # sender must include their peer ID
    if peer_id and peer_id in self._connected_peers:
        if not self._crypto.has_session_key(peer_id):
            self._crypto.perform_key_exchange(peer_id, peer_pub_key)
    else:
        logger.warning("Handshake with unknown/missing peer ID")
```

Additionally, the public key received in the handshake should be verified against the public key received during the signaling pairing phase (`match.peer_public_key`) to prevent key substitution.
