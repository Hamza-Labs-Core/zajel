# [HIGH] Encrypted message decryption tries all peers without binding to source

**Area**: Headless Client
**File**: packages/headless-client/zajel/client.py:1390-1420
**Type**: Security

**Description**: When an encrypted message arrives on the WebRTC data channel, the code iterates over ALL connected peers and attempts decryption with each session key until one succeeds (lines 1392-1420). Since the WebRTC data channel does not carry sender identification, and ChaCha20-Poly1305 authentication will reject incorrect keys (with high probability), this "try all keys" approach means:

1. A message from peer A could accidentally be attributed to peer B if peer B's key also happens to produce valid decryption (extremely unlikely with AEAD, but architecturally wrong).
2. More importantly, it means the system architecture has no binding between the transport layer (which WebRTC connection sent this data) and the cryptographic layer (which peer's key to use).

With a single WebRTC connection (current design), this works by coincidence but will break silently if the architecture ever supports multiple simultaneous WebRTC connections.

**Impact**: Message attribution is based on trial decryption rather than authenticated source binding. This is an architectural weakness that could lead to message misattribution in edge cases or during future code evolution.

**Fix**: Track which peer is associated with each WebRTC connection. When the data channel delivers a message, look up the peer ID from the connection context rather than trying all keys:

```python
# Store peer_id per WebRTC connection
self._webrtc_peer_id = match.peer_code

def _on_message_channel_data(self, data: str) -> None:
    peer_id = self._webrtc_peer_id
    if peer_id and self._crypto.has_session_key(peer_id):
        plaintext = self._crypto.decrypt(peer_id, msg["data"])
        ...
```
