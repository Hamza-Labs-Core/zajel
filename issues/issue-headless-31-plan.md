# Plan: Event emitter silently swallows handler exceptions

**Issue**: issue-headless-31.md
**Severity**: LOW
**Area**: Headless Client
**Files to modify**: `packages/headless-client/zajel/hooks.py`

## Analysis

The `EventEmitter.emit` method at lines 54-61 of `hooks.py` catches all exceptions from event handlers and only logs them:

```python
async def emit(self, event: str, *args: Any, **kwargs: Any) -> None:
    """Emit an event, calling all registered handlers."""
    handlers = self._handlers.get(event, [])
    for handler in handlers:
        try:
            await handler(*args, **kwargs)
        except Exception as e:
            logger.error("Error in %s handler: %s", event, e, exc_info=True)
```

The return type is `None`, so callers have no way to know if any handler failed. The design decision to catch exceptions and continue to the next handler is reasonable (one failing handler should not block others), but the caller should have the option to inspect failures.

The `emit` method is called from multiple places in `client.py`:
- Line 437: `await self._events.emit("call_incoming", ...)`
- Line 822: `await self._events.emit("channel_content", ...)`
- Line 1047: `await self._events.emit("group_message", ...)`
- Line 1347: `await self._events.emit("peer_connected", ...)`
- Line 1253: `asyncio.get_event_loop().create_task(self._events.emit("group_message", ...))` -- this one is fire-and-forget via a task, so errors would be fully silent.
- Line 1415: `asyncio.get_event_loop().create_task(self._events.emit("message", ...))` -- same.

## Fix Steps

1. **Change the return type of `emit` to `list[Exception]`** at line 54:
   ```python
   async def emit(self, event: str, *args: Any, **kwargs: Any) -> list[Exception]:
       """Emit an event, calling all registered handlers.

       Returns a list of exceptions raised by handlers. Empty list means
       all handlers succeeded.
       """
       errors: list[Exception] = []
       handlers = self._handlers.get(event, [])
       for handler in handlers:
           try:
               await handler(*args, **kwargs)
           except Exception as e:
               logger.error("Error in %s handler: %s", event, e, exc_info=True)
               errors.append(e)
       return errors
   ```

2. **No changes needed to existing callers** -- the return value is simply ignored if not used, and this is backward-compatible. Callers that care can check the return value:
   ```python
   errors = await self._events.emit("peer_connected", peer.peer_id, peer.public_key)
   if errors:
       logger.warning("Some peer_connected handlers failed: %d errors", len(errors))
   ```

3. **For the fire-and-forget emit calls** (lines 1253 and 1415 in `client.py`), consider wrapping in a helper that logs any returned errors:
   ```python
   async def _emit_logged(self, event: str, *args, **kwargs) -> None:
       """Emit an event and log any handler errors."""
       errors = await self._events.emit(event, *args, **kwargs)
       if errors:
           logger.warning("%d handler(s) failed for event '%s'", len(errors), event)
   ```
   Then replace:
   ```python
   asyncio.get_event_loop().create_task(
       self._events.emit("group_message", group.id, message)
   )
   ```
   with:
   ```python
   asyncio.get_event_loop().create_task(
       self._emit_logged("group_message", group.id, message)
   )
   ```

## Testing

- Unit test: Register a handler that raises `ValueError`, call `emit`, and verify the returned list contains the `ValueError`.
- Unit test: Register two handlers (first raises, second succeeds), call `emit`, and verify both ran (the second handler's side effect is present) and the error list has one entry.
- Unit test: Register no handlers, call `emit`, and verify an empty list is returned.
- Unit test: Verify backward compatibility -- existing callers that ignore the return value still work.

## Risk Assessment

- Changing the return type from `None` to `list[Exception]` is backward-compatible since callers that ignore the return value are unaffected.
- The errors are still logged with `exc_info=True`, so no diagnostic information is lost.
- The `_emit_logged` helper is optional but recommended for the fire-and-forget paths where task exceptions would otherwise be silently ignored by asyncio.
- This does not address the question of whether handler failures should stop subsequent handlers -- the current "continue on error" behavior is preserved, which is appropriate for an event system.
