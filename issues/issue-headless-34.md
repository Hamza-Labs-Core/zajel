# [LOW] No event name validation allows registering handlers for typos

**Area**: Headless Client
**File**: packages/headless-client/zajel/hooks.py:26-41
**Type**: Best Practice

**Description**: The `EventEmitter.on` decorator and `add_handler` method accept any string as an event name. There is no validation against a list of known events. If a user registers a handler for `"mesage"` (typo) instead of `"message"`, the handler is silently registered and will never fire.

The documented events are: `message`, `call_incoming`, `peer_connected`, `peer_disconnected`, `file_received`, `channel_content`, `group_message`. But there is nothing preventing registration for non-existent events.

**Impact**: Typos in event names cause handlers to silently not fire, leading to difficult-to-debug issues where the application appears to not receive events.

**Fix**: Add a known-events set and warn on registration of unknown events:

```python
KNOWN_EVENTS = frozenset({
    "message", "call_incoming", "peer_connected", "peer_disconnected",
    "file_received", "channel_content", "group_message",
})

def on(self, event: str) -> Callable[[EventHandler], EventHandler]:
    if event not in KNOWN_EVENTS:
        logger.warning("Registering handler for unknown event '%s'. "
                       "Known events: %s", event, ", ".join(sorted(KNOWN_EVENTS)))
    ...
```
