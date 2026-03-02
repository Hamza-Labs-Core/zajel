# [LOW] Event emitter silently swallows handler exceptions

**Area**: Headless Client
**File**: packages/headless-client/zajel/hooks.py:54-61
**Type**: Best Practice

**Description**: The `EventEmitter.emit` method catches all exceptions from event handlers and only logs them:

```python
async def emit(self, event: str, *args: Any, **kwargs: Any) -> None:
    handlers = self._handlers.get(event, [])
    for handler in handlers:
        try:
            await handler(*args, **kwargs)
        except Exception as e:
            logger.error("Error in %s handler: %s", event, e, exc_info=True)
```

This means:
1. A failing handler does not prevent subsequent handlers from running (which could be desired)
2. But the caller of `emit` never knows that a handler failed
3. Critical handler failures (e.g., in `peer_connected` or `message` handlers) are silently ignored
4. If user code depends on handler side effects, silent failures cause hard-to-debug issues

**Impact**: Application logic that depends on event handlers completing successfully will silently malfunction when handlers raise exceptions. Errors are logged but never surfaced to the application.

**Fix**: Consider adding an option to propagate exceptions or at minimum emit a meta-event for handler failures:

```python
async def emit(self, event: str, *args: Any, **kwargs: Any) -> list[Exception]:
    """Emit an event. Returns a list of any exceptions raised by handlers."""
    errors = []
    handlers = self._handlers.get(event, [])
    for handler in handlers:
        try:
            await handler(*args, **kwargs)
        except Exception as e:
            logger.error("Error in %s handler: %s", event, e, exc_info=True)
            errors.append(e)
    return errors
```
