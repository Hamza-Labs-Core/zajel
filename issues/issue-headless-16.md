# [MEDIUM] Deprecated asyncio.get_event_loop() usage in sync callbacks

**Area**: Headless Client
**File**: packages/headless-client/zajel/client.py:1253,1415
**Type**: Bug

**Description**: Two locations call `asyncio.get_event_loop().create_task()` from synchronous callbacks:
- Line 1253: `asyncio.get_event_loop().create_task(self._events.emit(...))` in `_receive_group_message_sync`
- Line 1415: `asyncio.get_event_loop().create_task(self._events.emit(...))` in `_on_message_channel_data`

`asyncio.get_event_loop()` is deprecated in Python 3.10+ and will raise a `DeprecationWarning`. In Python 3.12+, it raises a `DeprecationWarning` and may fail in certain contexts. More importantly, if the callback runs on a thread without a running event loop, `get_event_loop()` will either create a new loop (wrong behavior) or raise a RuntimeError.

**Impact**: In Python 3.12+, these calls may emit deprecation warnings or fail outright, causing event handlers to not fire for group messages and regular messages. This means the application's event-driven logic (e.g., `on("message")` handlers) will silently stop working.

**Fix**: Use `asyncio.get_running_loop()` which is the correct replacement, or store a reference to the loop during initialization:

```python
# In __init__ or connect:
self._loop = asyncio.get_running_loop()

# In sync callbacks:
self._loop.create_task(self._events.emit(...))
```

Or better, since these are called from aiortc callbacks which run on the event loop thread:
```python
asyncio.get_running_loop().create_task(self._events.emit(...))
```
