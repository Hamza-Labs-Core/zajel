# Plan: No replay protection for encrypted P2P messages

**Issue**: issue-headless-19.md
**Severity**: MEDIUM
**Area**: Headless Client
**Files to modify**:
- `packages/headless-client/zajel/crypto.py`

## Analysis

At `crypto.py:93-133`, the `encrypt` and `decrypt` methods use random 12-byte nonces with ChaCha20-Poly1305 but implement no replay protection:

**encrypt** (lines 93-111):
```python
def encrypt(self, peer_id: str, plaintext: str) -> str:
    key = self._session_keys.get(peer_id)
    if key is None:
        raise RuntimeError(f"No session key for peer {peer_id}")
    nonce = os.urandom(NONCE_SIZE)
    aead = ChaCha20Poly1305(key)
    ciphertext = aead.encrypt(nonce, plaintext.encode(), None)
    return base64.b64encode(nonce + ciphertext).decode()
```

**decrypt** (lines 113-133):
```python
def decrypt(self, peer_id: str, ciphertext_b64: str) -> str:
    key = self._session_keys.get(peer_id)
    if key is None:
        raise RuntimeError(f"No session key for peer {peer_id}")
    raw = base64.b64decode(ciphertext_b64)
    nonce = raw[:NONCE_SIZE]
    ciphertext = raw[NONCE_SIZE:]
    aead = ChaCha20Poly1305(key)
    plaintext = aead.decrypt(nonce, ciphertext, None)
    return plaintext.decode()
```

AEAD guarantees integrity and authenticity but not protection against replay. The same ciphertext can be decrypted multiple times and will produce the same plaintext each time.

While WebRTC data channels use DTLS (making interception harder), the threat model should account for a compromised signaling server or malicious peer replaying their own messages.

**Important constraint**: Any change here must maintain interoperability with the Dart/Flutter app.

## Fix Steps

1. **Add nonce tracking for replay detection**. Add tracking state to `CryptoService.__init__` at line 38:
   ```python
   def __init__(self):
       self._private_key: Optional[X25519PrivateKey] = None
       self._public_key_bytes: Optional[bytes] = None
       self._session_keys: dict[str, bytes] = {}
       self._peer_public_keys: dict[str, bytes] = {}
       # Replay protection: track seen nonces per peer
       self._seen_nonces: dict[str, set[bytes]] = {}
       # Sliding window size for nonce tracking
       self._max_nonce_history = 10000
   ```

2. **Add replay detection in `decrypt`** at line 113. After extracting the nonce, check if it has been seen before:
   ```python
   def decrypt(self, peer_id: str, ciphertext_b64: str) -> str:
       key = self._session_keys.get(peer_id)
       if key is None:
           raise RuntimeError(f"No session key for peer {peer_id}")

       raw = base64.b64decode(ciphertext_b64)
       nonce = raw[:NONCE_SIZE]
       ciphertext = raw[NONCE_SIZE:]

       # Replay detection: check for previously seen nonces
       if peer_id not in self._seen_nonces:
           self._seen_nonces[peer_id] = set()
       if nonce in self._seen_nonces[peer_id]:
           raise ValueError(f"Replay detected: duplicate nonce from peer {peer_id}")

       aead = ChaCha20Poly1305(key)
       plaintext = aead.decrypt(nonce, ciphertext, None)

       # Record the nonce after successful decryption
       self._seen_nonces[peer_id].add(nonce)

       # Evict oldest nonces if the set is too large
       if len(self._seen_nonces[peer_id]) > self._max_nonce_history:
           # Convert to list, remove oldest half
           nonce_list = list(self._seen_nonces[peer_id])
           self._seen_nonces[peer_id] = set(nonce_list[len(nonce_list) // 2:])

       return plaintext.decode()
   ```

3. **Handle the replay error in the caller** (`_on_message_channel_data` at `client.py:1394-1420`). The existing `except Exception` at line 1419 already catches this, but a more specific handler would be clearer:
   ```python
   try:
       plaintext = self._crypto.decrypt(peer_id, msg["data"])
       ...
   except ValueError as e:
       if "Replay detected" in str(e):
           logger.warning("Replay attack detected from peer %s: %s", peer_id, e)
       else:
           logger.debug("Decrypt failed for %s: %s", peer_id, e)
   except Exception as e:
       logger.debug("Decrypt failed for %s: %s", peer_id, e)
   ```

4. **Clear nonce history** when a session key changes or peer disconnects. Add to `perform_key_exchange` at line 90:
   ```python
   self._session_keys[peer_id] = session_key
   self._seen_nonces[peer_id] = set()  # Reset for new session
   ```

## Testing

- Unit test: Encrypt a message, decrypt it, then try to decrypt the same ciphertext again. Verify `ValueError` is raised on the second attempt.
- Unit test: Encrypt two different messages and decrypt both. Verify both succeed (different nonces).
- Unit test: Verify nonce history is cleared when a new session key is established.
- Unit test: Verify the nonce set eviction works when exceeding `_max_nonce_history`.
- Run existing E2E tests to confirm no regressions.

## Risk Assessment

- Low risk. The nonce tracking is purely additive -- it only rejects messages with previously seen nonces.
- The nonce set approach (vs. counter-based) is compatible with the current random nonce generation. No protocol changes needed.
- Memory usage: Each nonce is 12 bytes. With `_max_nonce_history = 10000`, that is ~120 KB per peer, which is acceptable.
- The eviction strategy (drop oldest half) is simple but effective. A more sophisticated sliding window could be implemented later.
- **Interop concern**: The Dart app does not need to change -- it still sends random nonces. The replay protection is purely on the receiver side.
