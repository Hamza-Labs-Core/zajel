# Plan: File transfer wait_for_file has potential busy-wait loop

**Issue**: issue-headless-35.md
**Severity**: LOW
**Area**: Headless Client
**Files to modify**: `packages/headless-client/zajel/file_transfer.py`

## Analysis

The `wait_for_file` method at lines 207-226 of `file_transfer.py`:

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
1. **No overall timeout**: If no transfers exist in `self._incoming`, the outer `while True` loop with `asyncio.sleep(0.1)` runs indefinitely. The `timeout` parameter only applies to the inner `asyncio.wait_for` once a transfer is found.
2. **Polling**: The 100ms sleep creates a polling loop that wastes CPU when waiting for a transfer to start.
3. **First-found bias**: If multiple incomplete transfers exist, only the first one encountered in dict iteration order is waited on.

## Fix Steps

1. **Add an event to signal new incoming transfers** in `FileTransferService.__init__` (after line 70):
   ```python
   self._new_transfer_event: asyncio.Event = asyncio.Event()
   ```

2. **Signal the event when a new transfer starts** in `handle_file_message`, in the `file_start` case (after line 153):
   ```python
   self._incoming[file_id] = IncomingTransfer(info=info)
   self._new_transfer_event.set()
   ```

3. **Replace the `wait_for_file` method** (lines 207-226):
   ```python
   async def wait_for_file(self, timeout: float = 60) -> FileTransferProgress:
       """Wait for a file transfer to complete.

       Args:
           timeout: Maximum time to wait in seconds (applies to overall wait).

       Returns:
           The completed file transfer progress info.

       Raises:
           TimeoutError: If no file transfer completes within the timeout.
       """
       deadline = asyncio.get_event_loop().time() + timeout
       while True:
           remaining = deadline - asyncio.get_event_loop().time()
           if remaining <= 0:
               raise TimeoutError("File transfer timed out")

           # Check for any incomplete transfers
           for transfer in self._incoming.values():
               if not transfer.info.completed:
                   try:
                       await asyncio.wait_for(
                           transfer.complete_event.wait(),
                           timeout=remaining,
                       )
                       return transfer.info
                   except asyncio.TimeoutError:
                       raise TimeoutError("File transfer timed out")

           # No pending transfers -- wait for a new one to arrive
           self._new_transfer_event.clear()
           try:
               await asyncio.wait_for(
                   self._new_transfer_event.wait(),
                   timeout=remaining,
               )
           except asyncio.TimeoutError:
               raise TimeoutError(
                   "File transfer timed out (no transfer started)"
               )
   ```

## Testing

- Unit test: Call `wait_for_file(timeout=1)` with no transfers and verify it raises `TimeoutError` after ~1 second.
- Unit test: Start a transfer, then call `wait_for_file`, complete the transfer, and verify it returns the progress info.
- Unit test: Call `wait_for_file(timeout=5)`, then start a transfer after 1 second, and verify it picks up the new transfer.
- Unit test: Verify the overall timeout applies even when a transfer is in progress (transfer starts but never completes).
- Performance test: Verify no CPU spike while waiting (no busy-wait polling).

## Risk Assessment

- The `asyncio.Event` approach eliminates the 100ms polling loop, reducing CPU usage during idle waits.
- The `asyncio.get_event_loop().time()` call is used for deadline tracking, which is compatible with the event loop's monotonic clock.
- The `_new_transfer_event` must be `clear()`-ed before `wait()` to avoid a race condition where a transfer starts between the for loop and the wait call. The sequence `clear()` then `wait()` handles this correctly because if `set()` is called between `clear()` and `wait()`, the `wait()` returns immediately.
- This is backward-compatible: the method signature and return type are unchanged, only the timeout behavior is corrected.
