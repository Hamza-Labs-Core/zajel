# Plan: HKDF key derivation uses empty salt instead of random salt

**Issue**: issue-headless-04.md
**Severity**: HIGH
**Area**: Headless Client
**Files to modify**:
- `packages/headless-client/zajel/crypto.py`

## Analysis

At `crypto.py:83-88`, the `perform_key_exchange` method derives the session key using HKDF-SHA256 with an empty salt (`salt=b""`):
```python
session_key = HKDF(
    algorithm=SHA256(),
    length=32,
    salt=b"",
    info=HKDF_INFO,
).derive(shared_secret)
```

`HKDF_INFO` is defined as `b"zajel_session"` at line 28. Since both `salt` and `info` are static, the same shared secret (from the same two key pairs) will always derive the same session key. This means key exchange between the same pair of keys is deterministic.

However, since the headless client generates a fresh X25519 key pair on each `initialize()` call (line 48), the shared secret changes each session. The real concern is:
1. RFC 5869 recommends a random salt for defense-in-depth.
2. Including both public keys in the HKDF info would add per-session uniqueness even if the same keys were reused.

**Important constraint**: Any change here must be coordinated with the Dart/Flutter app to maintain interoperability. Option 2 (including public keys in info) is the safest backward-compatible approach since it does not require transmitting additional data.

## Fix Steps

1. **Preferred approach -- Include both public keys sorted in the HKDF info** at `crypto.py:83-88`. This binds the key derivation to the specific session participants without requiring protocol changes:
   ```python
   # Sort public keys for deterministic derivation regardless of role
   peer_pub_bytes = base64.b64decode(peer_public_key_b64)
   keys_sorted = sorted([self._public_key_bytes, peer_pub_bytes])
   info = HKDF_INFO + keys_sorted[0] + keys_sorted[1]

   session_key = HKDF(
       algorithm=SHA256(),
       length=32,
       salt=b"",
       info=info,
   ).derive(shared_secret)
   ```

2. **Move `peer_pub_bytes` decoding** before the HKDF call (it is already decoded at line 76, so use the existing variable):
   The current code already has `peer_pub_bytes = base64.b64decode(peer_public_key_b64)` at line 76. So at line 83, construct the info parameter using the already-decoded bytes:
   ```python
   keys_sorted = sorted([self._public_key_bytes, peer_pub_bytes])
   info = HKDF_INFO + keys_sorted[0] + keys_sorted[1]
   ```

3. **Coordinate with Dart app**: The Dart counterpart must implement the same `info` construction. This requires a matching change in the Dart/Flutter `CryptoService`.

4. **Alternative (deferred)**: Adding a random salt requires a protocol change to transmit the salt alongside the handshake. This can be implemented later if needed.

## Testing

- Unit test: Perform key exchange between two `CryptoService` instances (A and B). Verify the derived session key is the same on both sides.
- Unit test: Perform key exchange with the same key pairs but verify (conceptually) the info parameter now includes both public keys.
- Cross-platform test: After the Dart app is updated, verify Python and Dart derive the same session key for the same key pairs.
- Run existing E2E pairing and messaging tests to verify no regressions.

## Risk Assessment

- **Breaking change**: This changes the derived session key for the same inputs. It MUST be coordinated with the Dart/Flutter app. Deploying the Python change alone will break interoperability.
- Medium risk overall due to the cross-platform coordination requirement. Consider a feature flag or version negotiation to support both old and new derivation during a transition period.
- The empty salt is not a vulnerability in itself (HKDF is secure with empty salt per RFC 5869), but including public keys in info is a defense-in-depth improvement.
