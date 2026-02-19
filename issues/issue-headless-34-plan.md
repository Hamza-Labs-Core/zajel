# Plan: No event name validation allows registering handlers for typos

**Issue**: issue-headless-34.md
**Severity**: LOW
**Area**: Headless Client
**Files to modify**: `packages/headless-client/zajel/hooks.py`

## Analysis

In `hooks.py`, the `EventEmitter.on` decorator (lines 26-41) and `add_handler` method (lines 43-47) accept any string as an event name with no validation:

```python
def on(self, event: str) -> Callable[[EventHandler], EventHandler]:
    def decorator(fn: EventHandler) -> EventHandler:
        if event not in self._handlers:
            self._handlers[event] = []
        self._handlers[event].append(fn)
        return fn
    return decorator

def add_handler(self, event: str, handler: EventHandler) -> None:
    if event not in self._handlers:
        self._handlers[event] = []
    self._handlers[event].append(handler)
```

The module docstring (lines 1-9) documents the known events: `message`, `call_incoming`, `peer_connected`, `peer_disconnected`, `file_received`. However, reviewing the actual `emit` calls in `client.py`, the actual events emitted are:
- `"message"` (line 1416)
- `"call_incoming"` (line 437)
- `"peer_connected"` (line 1347)
- `"channel_content"` (line 822)
- `"group_message"` (lines 1047, 1254)

Note that `"peer_disconnected"` and `"file_received"` are documented but never emitted in the current code. And `"channel_content"` and `"group_message"` are emitted but not documented. This documentation mismatch itself is a problem.

## Fix Steps

1. **Define a `KNOWN_EVENTS` frozenset** at module level (after line 17):
   ```python
   KNOWN_EVENTS = frozenset({
       "message",
       "call_incoming",
       "peer_connected",
       "peer_disconnected",
       "file_received",
       "channel_content",
       "group_message",
   })
   ```

2. **Add validation to `on` decorator** (lines 26-41):
   ```python
   def on(self, event: str) -> Callable[[EventHandler], EventHandler]:
       """Decorator to register an event handler.

       Usage:
           @emitter.on("message")
           async def on_message(peer_id, content):
               print(f"Message from {peer_id}: {content}")
       """
       if event not in KNOWN_EVENTS:
           logger.warning(
               "Registering handler for unknown event '%s'. "
               "Known events: %s",
               event,
               ", ".join(sorted(KNOWN_EVENTS)),
           )

       def decorator(fn: EventHandler) -> EventHandler:
           if event not in self._handlers:
               self._handlers[event] = []
           self._handlers[event].append(fn)
           return fn

       return decorator
   ```

3. **Add same validation to `add_handler`** (lines 43-47):
   ```python
   def add_handler(self, event: str, handler: EventHandler) -> None:
       """Register an event handler programmatically."""
       if event not in KNOWN_EVENTS:
           logger.warning(
               "Registering handler for unknown event '%s'. "
               "Known events: %s",
               event,
               ", ".join(sorted(KNOWN_EVENTS)),
           )
       if event not in self._handlers:
           self._handlers[event] = []
       self._handlers[event].append(handler)
   ```

4. **Update the module docstring** (lines 1-9) to include `channel_content` and `group_message` in the documented events list.

5. **Optionally add validation to `emit`** to warn if an event is emitted that has no known handlers:
   ```python
   async def emit(self, event: str, *args: Any, **kwargs: Any) -> list[Exception]:
       if event not in KNOWN_EVENTS:
           logger.warning("Emitting unknown event: '%s'", event)
       ...
   ```
   This is less critical since `emit` is called from internal code, not user code.

## Testing

- Unit test: Register a handler for `"mesage"` (typo) and verify a warning is logged.
- Unit test: Register a handler for `"message"` (correct) and verify no warning.
- Unit test: Register a handler for a custom event name and verify the warning lists all known events.
- Unit test: Verify all events in `KNOWN_EVENTS` match the events actually emitted in `client.py`.

## Risk Assessment

- This is a warning-only change -- it does not prevent registration of unknown events. This preserves backward compatibility for any code that uses custom event names.
- If future development adds new events, `KNOWN_EVENTS` must be updated. Consider adding a method `register_event(name)` to `EventEmitter` to allow extending the known set programmatically.
- The warning message includes the full list of known events, which helps the user identify the correct event name.
