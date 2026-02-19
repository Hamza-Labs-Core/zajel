# [MEDIUM] No WebSocket reconnection logic for signaling connection

**Area**: Headless Client
**File**: packages/headless-client/zajel/signaling.py:385-402
**Type**: Bug

**Description**: The `_receive_loop` catches `websockets.ConnectionClosed` and simply logs "WebSocket connection closed", then clears the `_connected` flag and calls the disconnect handler. There is no automatic reconnection logic. When the signaling server restarts, the network hiccups, or the connection times out, the daemon permanently loses its ability to receive new pair requests, relay WebRTC signals, or receive channel chunks.

The heartbeat loop (line 374-383) will also silently stop because `self._connected.is_set()` returns False after disconnection.

**Impact**: Any transient network interruption permanently breaks the daemon's signaling capability. The daemon continues running (the UNIX socket still accepts CLI commands) but cannot pair with new peers or relay signals. For a daemon designed to run unattended, this makes it fragile in real-world network conditions.

**Fix**: Implement exponential backoff reconnection:

```python
async def _receive_loop(self) -> None:
    backoff = 1
    max_backoff = 60
    while True:
        try:
            async for raw in self._ws:
                backoff = 1  # Reset on successful message
                try:
                    msg = json.loads(raw)
                    await self._handle_message(msg)
                except json.JSONDecodeError:
                    logger.warning("Non-JSON message: %s", raw[:100])
        except websockets.ConnectionClosed:
            logger.warning("WebSocket closed, reconnecting in %ds...", backoff)
        except asyncio.CancelledError:
            return
        except Exception as e:
            logger.error("Receive loop error: %s", e)

        self._connected.clear()
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, max_backoff)

        try:
            await self._reconnect()
        except Exception as e:
            logger.error("Reconnect failed: %s", e)
```
