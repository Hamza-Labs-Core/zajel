# [HIGH] HKDF key derivation uses empty salt instead of random salt

**Area**: Headless Client
**File**: packages/headless-client/zajel/crypto.py:86-87
**Type**: Security

**Description**: The `perform_key_exchange` method derives the session key using HKDF-SHA256 with `salt=b""` (an empty byte string). While HKDF is designed to be secure even with no salt, using a random salt significantly strengthens the derivation against multi-target attacks and provides better key separation guarantees. The HKDF RFC (5869) explicitly recommends using a random salt.

Additionally, the same shared secret between two peers will always produce the same session key (since salt and info are both fixed). This means there is no forward secrecy between sessions -- if the same two key pairs perform key exchange again, they get the same session key.

**Impact**: Reduced cryptographic strength. The session key is deterministic for a given key pair combination, meaning if a session key is compromised, an attacker can decrypt all past and future sessions between the same key pair. There is no per-session entropy beyond the ephemeral key generation.

**Fix**: Use a random salt and include it alongside the nonce in the encrypted output, or pass both public keys as additional context in the HKDF info parameter to ensure unique derivation per session:

```python
# Option 1: Random salt (requires protocol change)
salt = os.urandom(32)
session_key = HKDF(
    algorithm=SHA256(),
    length=32,
    salt=salt,
    info=HKDF_INFO,
).derive(shared_secret)

# Option 2: Include both public keys in info (backward-compatible)
keys_sorted = sorted([self._public_key_bytes, peer_pub_bytes])
info = HKDF_INFO + keys_sorted[0] + keys_sorted[1]
```

Note: Any change here must be coordinated with the Dart/Flutter app to maintain interoperability.
