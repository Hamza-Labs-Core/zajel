# Plan: Deprecated asyncio.get_event_loop() usage in sync callbacks

**Issue**: issue-headless-16.md
**Severity**: MEDIUM
**Area**: Headless Client
**Files to modify**:
- `packages/headless-client/zajel/client.py`

## Analysis

Two locations in `client.py` call `asyncio.get_event_loop().create_task()` from synchronous callbacks:

1. **Line 1253**: In `_receive_group_message_sync`:
   ```python
   asyncio.get_event_loop().create_task(
       self._events.emit("group_message", group.id, message)
   )
   ```

2. **Line 1415**: In `_on_message_channel_data`:
   ```python
   asyncio.get_event_loop().create_task(
       self._events.emit("message", peer_id, plaintext, "text")
   )
   ```

`asyncio.get_event_loop()` is deprecated since Python 3.10 and emits `DeprecationWarning`. In Python 3.12+, if called from a thread without a running event loop, it raises `RuntimeError` instead of creating a new loop.

These callbacks are invoked from `aiortc`'s data channel event handlers, which run on the event loop thread. So `asyncio.get_running_loop()` should work, but it is better to store a reference to the loop during initialization to be safe.

## Fix Steps

1. **Store a reference to the event loop** during `connect()` at `client.py:261`. After the coroutine starts executing, the loop is available:
   ```python
   async def connect(self) -> str:
       self._loop = asyncio.get_running_loop()
       self._crypto.initialize()
       ...
   ```

2. **Initialize `_loop`** in `__init__` (around line 222):
   ```python
   self._loop: Optional[asyncio.AbstractEventLoop] = None
   ```

3. **Replace `asyncio.get_event_loop()` at line 1253** in `_receive_group_message_sync`:
   ```python
   # Before:
   asyncio.get_event_loop().create_task(
       self._events.emit("group_message", group.id, message)
   )
   # After:
   if self._loop and self._loop.is_running():
       self._loop.create_task(
           self._events.emit("group_message", group.id, message)
       )
   ```

4. **Replace `asyncio.get_event_loop()` at line 1415** in `_on_message_channel_data`:
   ```python
   # Before:
   asyncio.get_event_loop().create_task(
       self._events.emit("message", peer_id, plaintext, "text")
   )
   # After:
   if self._loop and self._loop.is_running():
       self._loop.create_task(
           self._events.emit("message", peer_id, plaintext, "text")
       )
   ```

5. **Alternative approach**: If these callbacks are guaranteed to run on the event loop thread (which they are for aiortc callbacks), simply use `asyncio.get_running_loop()` without storing a reference:
   ```python
   asyncio.get_running_loop().create_task(
       self._events.emit("message", peer_id, plaintext, "text")
   )
   ```
   This is simpler but will raise `RuntimeError` if the callback ever runs outside the event loop thread. The stored loop approach (steps 1-4) is more defensive.

## Testing

- Run the daemon with Python 3.12+ and verify no `DeprecationWarning` is emitted.
- Send a message and verify the `"message"` event fires correctly.
- Send a group message and verify the `"group_message"` event fires correctly.
- Run existing E2E tests to confirm no regressions.

## Risk Assessment

- Very low risk. This is a straightforward replacement of a deprecated API with the recommended alternative.
- The stored loop approach is safe because the client is always used within a single event loop.
- If `self._loop` is `None` (client not connected), the event emission is silently skipped, which is the correct behavior since there should be no messages before connection.
