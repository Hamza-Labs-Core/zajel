# [LOW] Private key material accessible via public crypto property

**Area**: Headless Client
**File**: packages/headless-client/zajel/client.py:248-250
**Type**: Security

**Description**: The `ZajelHeadlessClient` exposes the `CryptoService` instance via a public property:

```python
@property
def crypto(self) -> CryptoService:
    return self._crypto
```

The `CryptoService` class exposes:
- `get_session_key(peer_id)` -- returns raw session key bytes
- `set_session_key(peer_id, key)` -- allows injection of arbitrary session keys
- `_private_key` -- the X25519 private key (Python naming convention marks it private, but it is accessible)
- `_session_keys` -- all session keys for all peers

Any code with a reference to the client object can extract all cryptographic material. While this may be needed for testing, exposing the full `CryptoService` in production violates the principle of least privilege.

**Impact**: A bug or vulnerability in any consumer code that has access to the client object could extract all private keys and session keys, compromising all encrypted communications.

**Fix**: Either remove the `crypto` property or provide a restricted interface that does not expose key material:

```python
@property
def crypto_info(self) -> dict:
    """Read-only crypto information (no key material)."""
    return {
        "public_key": self._crypto.public_key_base64,
        "has_keys": {pid: True for pid in self._crypto._session_keys},
    }
```
