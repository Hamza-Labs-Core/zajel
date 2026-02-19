# Plan: Sender keys stored in memory are never zeroized on group leave

**Issue**: issue-headless-28.md
**Severity**: MEDIUM
**Area**: Headless Client
**Files to modify**: `packages/headless-client/zajel/groups.py`

## Analysis

In `groups.py`, the `GroupCryptoService` stores sender keys as `bytes` objects in the `_sender_keys` dict (line 170):
```python
self._sender_keys: dict[str, dict[str, bytes]] = {}
```

Keys are stored at line 189:
```python
self._sender_keys[group_id][device_id] = key_bytes
```

Where `key_bytes = base64.b64decode(sender_key_b64)` at line 181. The `base64.b64decode` function returns `bytes`, which is immutable in Python.

The `clear_group_keys` method (lines 206-208):
```python
def clear_group_keys(self, group_id: str) -> None:
    self._sender_keys.pop(group_id, None)
```

And `remove_sender_key` (lines 201-204):
```python
def remove_sender_key(self, group_id: str, device_id: str) -> None:
    if group_id in self._sender_keys:
        self._sender_keys[group_id].pop(device_id, None)
```

Both simply remove dictionary references without zeroizing the underlying key bytes. Since Python `bytes` objects are immutable, they cannot be zeroized in place. The key material remains in memory until the garbage collector frees it, and even then the memory is not necessarily zeroed.

The same issue applies to `CryptoService._session_keys` in `crypto.py` (line 42), but that is a broader issue not scoped to this fix.

## Fix Steps

1. **Change key storage to use `bytearray` instead of `bytes`** in `set_sender_key` at line 181-189:
   ```python
   def set_sender_key(
       self, group_id: str, device_id: str, sender_key_b64: str
   ) -> None:
       """Store a sender key for a member in a group."""
       key_bytes = bytearray(base64.b64decode(sender_key_b64))
       if len(key_bytes) != SENDER_KEY_SIZE:
           raise ValueError(
               f"Invalid sender key length: expected {SENDER_KEY_SIZE}, "
               f"got {len(key_bytes)}"
           )
       if group_id not in self._sender_keys:
           self._sender_keys[group_id] = {}
       self._sender_keys[group_id][device_id] = key_bytes
   ```

2. **Update the type annotation** on line 170:
   ```python
   self._sender_keys: dict[str, dict[str, bytearray]] = {}
   ```

3. **Add a `_zeroize` helper method**:
   ```python
   @staticmethod
   def _zeroize(key: bytearray) -> None:
       """Overwrite key material with zeros."""
       for i in range(len(key)):
           key[i] = 0
   ```

4. **Update `clear_group_keys`** (lines 206-208):
   ```python
   def clear_group_keys(self, group_id: str) -> None:
       """Remove all sender keys for a group, zeroizing key material."""
       keys = self._sender_keys.pop(group_id, {})
       for key_bytes in keys.values():
           self._zeroize(key_bytes)
   ```

5. **Update `remove_sender_key`** (lines 201-204):
   ```python
   def remove_sender_key(self, group_id: str, device_id: str) -> None:
       """Remove a member's sender key, zeroizing key material."""
       if group_id in self._sender_keys:
           key = self._sender_keys[group_id].pop(device_id, None)
           if key is not None:
               self._zeroize(key)
   ```

6. **Update `get_sender_key` return type** (lines 191-195). Change return type annotation:
   ```python
   def get_sender_key(
       self, group_id: str, device_id: str
   ) -> Optional[bytearray]:
   ```

7. **Verify `ChaCha20Poly1305` accepts `bytearray`**. The `cryptography` library's `ChaCha20Poly1305` constructor accepts `bytes | bytearray`, so the `encrypt` and `decrypt` methods (lines 210-248) will work without changes since `bytearray` is a subtype of `bytes` for most purposes.

## Testing

- Unit test: Generate a sender key, store it, then call `clear_group_keys` and verify the bytearray is all zeros.
- Unit test: Store a sender key, call `remove_sender_key`, and verify the bytearray is zeroed.
- Unit test: Verify that encryption and decryption still work with `bytearray` keys.
- Unit test: Verify that `set_sender_key` rejects keys of wrong length.

## Risk Assessment

- `bytearray` is mutable and behaves like `bytes` for most operations. The `ChaCha20Poly1305` constructor in the `cryptography` library accepts both `bytes` and `bytearray`.
- Python's garbage collector may create copies of the key bytes during operations (e.g., when passing to C extensions). True zeroization in Python is best-effort, not guaranteed. The `ctypes.memset` approach could be used for stronger guarantees but adds complexity.
- After zeroization, any code that retains a reference to the key bytearray will see zeros, which is the desired behavior (use-after-free becomes a decryption failure rather than a security leak).
- This change does not address session key zeroization in `CryptoService` -- that should be a separate issue/fix.
