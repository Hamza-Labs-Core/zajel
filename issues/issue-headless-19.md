# [MEDIUM] No replay protection for encrypted P2P messages

**Area**: Headless Client
**File**: packages/headless-client/zajel/crypto.py:93-133
**Type**: Security

**Description**: The `encrypt` and `decrypt` methods in `CryptoService` use random 12-byte nonces with ChaCha20-Poly1305 but implement no replay protection. An attacker who can intercept encrypted messages on the WebRTC data channel (or a malicious signaling server that can replay messages) can re-send previously captured ciphertext, and the recipient will decrypt and process it again as a new message.

The AEAD construction (ChaCha20-Poly1305) guarantees integrity and authenticity of individual messages but does NOT prevent replay -- the same ciphertext will always decrypt to the same plaintext.

While WebRTC data channels provide DTLS encryption at the transport layer (making interception harder), the threat model should account for:
- A compromised signaling server
- A malicious peer replaying their own messages
- Future protocol changes that might relay messages through intermediaries

**Impact**: An attacker could replay previously sent messages, causing the recipient to see duplicate messages or re-execute previously triggered actions (e.g., duplicate file transfers, duplicate group invitations).

**Fix**: Implement a message counter (sequence number) or track seen nonces:

```python
def encrypt(self, peer_id: str, plaintext: str) -> str:
    key = self._session_keys.get(peer_id)
    if key is None:
        raise RuntimeError(f"No session key for peer {peer_id}")

    # Use counter-based nonce for replay protection
    counter = self._nonce_counters.get(peer_id, 0)
    self._nonce_counters[peer_id] = counter + 1
    nonce = counter.to_bytes(12, 'big')

    aead = ChaCha20Poly1305(key)
    ciphertext = aead.encrypt(nonce, plaintext.encode(), None)
    return base64.b64encode(nonce + ciphertext).decode()

def decrypt(self, peer_id: str, ciphertext_b64: str) -> str:
    # ... existing decrypt logic ...
    # Check nonce is strictly increasing
    nonce_int = int.from_bytes(nonce, 'big')
    last_nonce = self._last_seen_nonces.get(peer_id, -1)
    if nonce_int <= last_nonce:
        raise ValueError("Replay detected: nonce not increasing")
    self._last_seen_nonces[peer_id] = nonce_int
```

Note: Counter-based nonces must be coordinated with the Dart app if interop is needed. If random nonces are required for compatibility, use a sliding window of seen nonces instead.
