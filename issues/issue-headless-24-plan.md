# Plan: Async tasks not awaited on cancellation during disconnect

**Issue**: issue-headless-24.md
**Severity**: MEDIUM
**Area**: Headless Client
**Files to modify**: `packages/headless-client/zajel/client.py`

## Analysis

The `disconnect` method at lines 290-303 of `client.py` cancels all tasks and immediately clears the list without awaiting them:

```python
async def disconnect(self) -> None:
    for task in self._tasks:
        task.cancel()
    self._tasks.clear()

    if self._active_call and self._active_call.recorder:
        await self._active_call.recorder.stop()

    await self._webrtc.close()
    await self._signaling.disconnect()
    self._storage.close()
    self._connected_peers.clear()
```

After `task.cancel()` is called, the task's coroutine will receive a `CancelledError` at its next `await` point, but the task has not yet finished running. Immediately calling `self._tasks.clear()` drops all references, and then `self._webrtc.close()` and `self._signaling.disconnect()` may close resources that the still-running tasks are using.

The tasks stored in `self._tasks` include:
- The WebRTC signal loop task (created at line 285 in `connect`)
- ICE candidate loop tasks (created at line 1319 in `_establish_connection`)
- Auto-establish connection tasks (created at line 1268 in `_auto_establish_connection`)

These tasks use `self._signaling` and `self._webrtc` which get closed before the tasks have a chance to clean up.

## Fix Steps

1. **Replace lines 291-294** (the cancel/clear block) with:
   ```python
   async def disconnect(self) -> None:
       """Disconnect from all peers and the signaling server."""
       # Cancel all background tasks
       for task in self._tasks:
           task.cancel()
       # Wait for all tasks to finish cancellation
       if self._tasks:
           await asyncio.gather(*self._tasks, return_exceptions=True)
       self._tasks.clear()

       if self._active_call and self._active_call.recorder:
           await self._active_call.recorder.stop()

       await self._webrtc.close()
       await self._signaling.disconnect()
       self._storage.close()
       self._connected_peers.clear()
       logger.info("Disconnected")
   ```

2. **Ensure `asyncio` is imported** -- it already is at line 14.

3. **Add a timeout to the gather** to prevent hanging if a task does not respect cancellation:
   ```python
   if self._tasks:
       try:
           await asyncio.wait_for(
               asyncio.gather(*self._tasks, return_exceptions=True),
               timeout=5.0,
           )
       except asyncio.TimeoutError:
           logger.warning("Some tasks did not finish within 5s after cancellation")
   ```

## Testing

- Unit test: Create a mock task that performs cleanup on `CancelledError`, call `disconnect`, and verify the cleanup code ran.
- Unit test: Create a task that ignores `CancelledError` (catches and continues) and verify the 5s timeout fires.
- Integration test: Start the daemon, connect to a peer, then disconnect and verify no resource leak warnings in logs.
- Verify the `disconnect` method completes within a reasonable time (< 10s).

## Risk Assessment

- `asyncio.gather(*self._tasks, return_exceptions=True)` will collect any `CancelledError` as a result without propagating it, which is the desired behavior.
- The 5-second timeout prevents `disconnect` from hanging indefinitely if a task is stuck, but could cut short legitimate cleanup in very slow environments (unlikely).
- If `disconnect` is called while tasks are in the middle of WebRTC signaling, awaiting them first gives them a chance to exit cleanly rather than producing errors when resources are yanked away.
- The `_auto_establish_connection` task (line 1268) wraps `_establish_connection` which has no try/except for `CancelledError` currently. It will propagate up cleanly since `asyncio.gather(..., return_exceptions=True)` catches it.
