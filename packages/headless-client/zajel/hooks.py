"""Event hook system for the headless client.

Provides a decorator-based event system for handling:
- message: Text message received
- call_incoming: Incoming call
- peer_connected: Peer connected
- peer_disconnected: Peer disconnected
- file_received: File transfer completed
"""

import asyncio
import logging
from typing import Any, Callable, Coroutine

logger = logging.getLogger("zajel.hooks")

EventHandler = Callable[..., Coroutine[Any, Any, None]]


class EventEmitter:
    """Simple async event emitter with decorator support."""

    def __init__(self):
        self._handlers: dict[str, list[EventHandler]] = {}

    def on(self, event: str) -> Callable[[EventHandler], EventHandler]:
        """Decorator to register an event handler.

        Usage:
            @emitter.on("message")
            async def on_message(peer_id, content):
                print(f"Message from {peer_id}: {content}")
        """

        def decorator(fn: EventHandler) -> EventHandler:
            if event not in self._handlers:
                self._handlers[event] = []
            self._handlers[event].append(fn)
            return fn

        return decorator

    def add_handler(self, event: str, handler: EventHandler) -> None:
        """Register an event handler programmatically."""
        if event not in self._handlers:
            self._handlers[event] = []
        self._handlers[event].append(handler)

    def remove_handler(self, event: str, handler: EventHandler) -> None:
        """Remove an event handler."""
        if event in self._handlers:
            self._handlers[event] = [h for h in self._handlers[event] if h is not handler]

    async def emit(self, event: str, *args: Any, **kwargs: Any) -> None:
        """Emit an event, calling all registered handlers."""
        handlers = self._handlers.get(event, [])
        for handler in handlers:
            try:
                await handler(*args, **kwargs)
            except Exception as e:
                logger.error("Error in %s handler: %s", event, e, exc_info=True)

    def has_handlers(self, event: str) -> bool:
        """Check if an event has any registered handlers."""
        return bool(self._handlers.get(event))
