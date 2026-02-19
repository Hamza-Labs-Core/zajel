# [LOW] File transfer wait_for_file has potential busy-wait loop

**Area**: Headless Client
**File**: packages/headless-client/zajel/file_transfer.py:207-227
**Type**: Bug

**Description**: The `wait_for_file` method has a `while True` loop that iterates over all incoming transfers. If no transfers are pending (the `_incoming` dict is empty), it busy-waits with `await asyncio.sleep(0.1)`:

```python
async def wait_for_file(self, timeout: float = 60) -> FileTransferProgress:
    while True:
        for transfer in self._incoming.values():
            if not transfer.info.completed:
                try:
                    await asyncio.wait_for(
                        transfer.complete_event.wait(), timeout=timeout
                    )
                    return transfer.info
                except asyncio.TimeoutError:
                    raise TimeoutError("File transfer timed out")
        # No pending transfers, wait briefly
        await asyncio.sleep(0.1)
```

Issues:
1. If there are no incoming transfers, this loops every 100ms indefinitely (no overall timeout for this outer loop)
2. If there are multiple incomplete transfers, it only waits for the first one (dict iteration order)
3. The `timeout` parameter only applies to the inner `wait_for` on a specific transfer, not to the overall wait

**Impact**: If called before any file transfer starts, this method can loop indefinitely (the timeout only applies once a transfer starts). CPU usage is elevated due to polling.

**Fix**: Use an asyncio.Event to signal when a new transfer starts, and apply the timeout to the overall wait:

```python
async def wait_for_file(self, timeout: float = 60) -> FileTransferProgress:
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            raise TimeoutError("File transfer timed out")

        for transfer in self._incoming.values():
            if not transfer.info.completed:
                try:
                    await asyncio.wait_for(
                        transfer.complete_event.wait(), timeout=remaining
                    )
                    return transfer.info
                except asyncio.TimeoutError:
                    raise TimeoutError("File transfer timed out")

        await asyncio.sleep(min(0.1, remaining))
```
