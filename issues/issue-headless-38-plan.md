# Plan: Private key material accessible via public crypto property

**Issue**: issue-headless-38.md
**Severity**: LOW
**Area**: Headless Client
**Files to modify**: `packages/headless-client/zajel/client.py`, `packages/headless-client/zajel/crypto.py`

## Analysis

In `client.py`, the `crypto` property at lines 248-250 exposes the full `CryptoService` instance:

```python
@property
def crypto(self) -> CryptoService:
    return self._crypto
```

The `CryptoService` class in `crypto.py` exposes:
- `get_session_key(peer_id)` (line 139-141): Returns raw session key bytes for any peer.
- `set_session_key(peer_id, key)` (line 143-145): Allows injection of arbitrary session keys.
- `_private_key` (line 39): The X25519 private key (accessible despite underscore convention).
- `_session_keys` (line 42): Dict of all session keys for all peers.
- `_peer_public_keys` (line 44): Dict of all peer public keys.

Any code with a reference to the `ZajelHeadlessClient` object can call `client.crypto.get_session_key(peer_id)` to extract session keys, or `client.crypto._private_key` to get the identity private key.

However, searching for usage of the `crypto` property to understand its necessity:
- The property is used internally within `_establish_connection` (line 1325) to access `self._crypto.public_key_base64`.
- The property is used in `send_text` (line 354) for `self._crypto.encrypt(peer_id, content)`.
- The property is used in `send_group_message` (line 983-985) for encryption.
- These internal uses access `self._crypto` directly (not via the property), so the property is primarily for external consumers.

The E2E tests or daemon code may use `client.crypto` to access `public_key_base64`. Let me verify.

The daemon code in `daemon.py` does not use `client.crypto` directly. It uses `client.send_text`, `client.send_file`, etc.

## Fix Steps

1. **Replace the `crypto` property with a restricted interface** in `client.py` (lines 248-250):
   ```python
   @property
   def public_key_base64(self) -> str:
       """Get our public key as base64 (read-only, no key material exposed)."""
       return self._crypto.public_key_base64

   @property
   def crypto(self) -> CryptoService:
       """Access the crypto service.

       WARNING: This exposes key material. Prefer using public_key_base64
       or the high-level send/receive methods instead. This property may
       be removed in a future version.

       Kept for backward compatibility and testing.
       """
       return self._crypto
   ```

2. **Add a `has_session_key` convenience method** to `ZajelHeadlessClient`:
   ```python
   def has_session_key(self, peer_id: str) -> bool:
       """Check if we have a session key for a peer."""
       return self._crypto.has_session_key(peer_id)
   ```

3. **Search for external usage of `client.crypto`** and update callers to use the restricted interface where possible. Common patterns:
   - `client.crypto.public_key_base64` -> `client.public_key_base64`
   - `client.crypto.has_session_key(pid)` -> `client.has_session_key(pid)`

4. **Consider adding `__slots__` or property guards to `CryptoService`** in the future to make the internal state less accessible. For now, the Python convention of underscore-prefixed attributes provides a soft boundary.

5. **For a stronger boundary in the future**, create a `CryptoInfo` read-only view:
   ```python
   @dataclass(frozen=True)
   class CryptoInfo:
       """Read-only cryptographic information (no key material)."""
       public_key: str
       peer_count: int
       has_keys_for: frozenset[str]

   @property
   def crypto_info(self) -> CryptoInfo:
       return CryptoInfo(
           public_key=self._crypto.public_key_base64,
           peer_count=len(self._crypto._session_keys),
           has_keys_for=frozenset(self._crypto._session_keys.keys()),
       )
   ```

## Testing

- Unit test: Verify `client.public_key_base64` returns the same value as `client.crypto.public_key_base64`.
- Unit test: Verify `client.has_session_key(peer_id)` returns correct values.
- Grep test: Search the codebase for `client.crypto.` and update all external callers.
- Verify the deprecation warning in the `crypto` property docstring is visible in IDE hover documentation.

## Risk Assessment

- Removing the `crypto` property entirely would be a breaking change for any external code or tests that use it. The deprecation approach (keep it, add a warning docstring) is safer.
- The `public_key_base64` convenience property is a non-breaking addition.
- Python does not enforce access control (there are no private fields), so this is defense-in-depth: make it harder to accidentally access key material, not impossible.
- E2E tests may need `set_session_key` for test setup. If so, the `crypto` property should remain available for test code, possibly behind a `_test_crypto` name to signal it is for testing only.
