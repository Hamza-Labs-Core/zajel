# [MEDIUM] Sender keys stored in memory are never zeroized on group leave

**Area**: Headless Client
**File**: packages/headless-client/zajel/groups.py:206-208
**Type**: Security

**Description**: When `clear_group_keys` is called (via `leave_group`), the sender keys are removed from the dictionary:

```python
def clear_group_keys(self, group_id: str) -> None:
    self._sender_keys.pop(group_id, None)
```

This removes the dictionary reference but does not zeroize the key bytes in memory. Python's garbage collector will eventually free the memory, but:
1. The key bytes may remain in memory for an indefinite period
2. Memory could be swapped to disk
3. A core dump or memory forensics tool could recover the keys
4. Python's memory allocator may reuse the memory without clearing it, but fragments may persist

The same issue affects session keys in `CryptoService._session_keys` -- they are never explicitly zeroized.

**Impact**: Cryptographic key material persists in memory after it is no longer needed, increasing the window for memory-based key recovery attacks (cold boot attacks, memory forensics, core dumps).

**Fix**: Zeroize key material before releasing references:

```python
def clear_group_keys(self, group_id: str) -> None:
    keys = self._sender_keys.pop(group_id, {})
    for device_id, key_bytes in keys.items():
        # Zeroize key material
        if isinstance(key_bytes, bytearray):
            for i in range(len(key_bytes)):
                key_bytes[i] = 0
    # Note: Python bytes are immutable, so true zeroization requires
    # using bytearray instead of bytes for key storage

def remove_sender_key(self, group_id: str, device_id: str) -> None:
    if group_id in self._sender_keys:
        key = self._sender_keys[group_id].pop(device_id, None)
        if isinstance(key, bytearray):
            for i in range(len(key)):
                key[i] = 0
```

To enable zeroization, store keys as `bytearray` instead of `bytes`:
```python
self._sender_keys[group_id][device_id] = bytearray(key_bytes)
```
