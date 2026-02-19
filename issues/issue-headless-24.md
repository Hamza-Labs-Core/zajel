# [MEDIUM] Async tasks not awaited on cancellation during disconnect

**Area**: Headless Client
**File**: packages/headless-client/zajel/client.py:290-303
**Type**: Bug

**Description**: The `disconnect` method cancels all tasks and clears the list, but never awaits the cancelled tasks:

```python
async def disconnect(self) -> None:
    for task in self._tasks:
        task.cancel()
    self._tasks.clear()
    ...
```

When a task is cancelled, `task.cancel()` merely requests cancellation -- it does not wait for the task to actually finish. The task may still be executing cleanup code when `self._webrtc.close()` and `self._signaling.disconnect()` are called next. This can cause:
1. Cancelled tasks trying to use resources that have been closed
2. Unhandled `CancelledError` exceptions
3. Resource leaks if task cleanup code is not given a chance to run

**Impact**: During disconnect, resource cleanup may occur out of order, causing errors or leaving resources (WebSocket connections, data channels) in an inconsistent state. In a long-running daemon that reconnects, leaked resources accumulate.

**Fix**: Await all cancelled tasks with `asyncio.gather`:

```python
async def disconnect(self) -> None:
    for task in self._tasks:
        task.cancel()
    if self._tasks:
        await asyncio.gather(*self._tasks, return_exceptions=True)
    self._tasks.clear()
    ...
```
