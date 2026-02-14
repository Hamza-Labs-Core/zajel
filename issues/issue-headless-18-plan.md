# Plan: No WebSocket reconnection logic for signaling connection

**Issue**: issue-headless-18.md
**Severity**: MEDIUM
**Area**: Headless Client
**Files to modify**:
- `packages/headless-client/zajel/signaling.py`

## Analysis

At `signaling.py:385-402`, the `_receive_loop` catches `websockets.ConnectionClosed` and simply logs it, clears the `_connected` flag, and calls the disconnect handler. There is no reconnection logic:

```python
async def _receive_loop(self) -> None:
    try:
        async for raw in self._ws:
            try:
                msg = json.loads(raw)
                await self._handle_message(msg)
            except json.JSONDecodeError:
                logger.warning("Non-JSON message: %s", raw[:100])
    except websockets.ConnectionClosed:
        logger.info("WebSocket connection closed")
    except asyncio.CancelledError:
        pass
    except Exception as e:
        logger.error("Receive loop error: %s", e)
    finally:
        self._connected.clear()
        if self._on_disconnect:
            await self._on_disconnect()
```

When the connection drops, the daemon continues running (UNIX socket still works) but permanently loses signaling capability: no new pairings, no WebRTC signal relay, no channel chunk relay. For a daemon designed to run unattended, this makes it fragile.

The heartbeat loop at lines 374-383 also stops because `self._connected.is_set()` returns `False`.

## Fix Steps

1. **Store the public key** during `connect()` so it can be reused during reconnection. It is already available as the parameter to `connect()` at line 124. Store it:
   ```python
   async def connect(self, public_key_b64: str) -> str:
       self._public_key_b64 = public_key_b64
       ...
   ```

2. **Add `_public_key_b64`** initialization in `__init__`:
   ```python
   self._public_key_b64: Optional[str] = None
   ```

3. **Add a `_reconnect` method** to `SignalingClient`:
   ```python
   async def _reconnect(self) -> None:
       """Reconnect to the signaling server and re-register."""
       if self._public_key_b64 is None:
           raise RuntimeError("Cannot reconnect: no stored public key")

       logger.info("Reconnecting to %s...", self.url)
       self._ws = await websockets.connect(self.url)
       self._connected.set()

       # Re-register with the same pairing code
       await self._send({
           "type": "register",
           "pairingCode": self.pairing_code,
           "publicKey": self._public_key_b64,
       })

       # Restart heartbeat
       if self._heartbeat_task:
           self._heartbeat_task.cancel()
       self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

       logger.info("Reconnected and re-registered as %s", self.pairing_code)
   ```

4. **Refactor `_receive_loop`** at lines 385-402 to include reconnection with exponential backoff:
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
               return  # Intentional shutdown
           except Exception as e:
               logger.error("Receive loop error: %s, reconnecting in %ds...", e, backoff)

           self._connected.clear()

           await asyncio.sleep(backoff)
           backoff = min(backoff * 2, max_backoff)

           try:
               await self._reconnect()
           except asyncio.CancelledError:
               return
           except Exception as e:
               logger.error("Reconnect failed: %s", e)
               continue
   ```

5. **Remove the `_on_disconnect` callback** from the `finally` block since the loop no longer exits (unless cancelled). Instead, fire the callback only on intentional disconnect in the `disconnect()` method.

6. **Update `disconnect()`** at lines 153-165 to properly break the reconnection loop by cancelling the receive task:
   ```python
   async def disconnect(self) -> None:
       if self._heartbeat_task:
           self._heartbeat_task.cancel()
           self._heartbeat_task = None
       if self._receive_task:
           self._receive_task.cancel()
           try:
               await self._receive_task
           except asyncio.CancelledError:
               pass
           self._receive_task = None
       if self._ws:
           await self._ws.close()
           self._ws = None
       self._connected.clear()
   ```

## Testing

- Unit test: Simulate a WebSocket disconnect and verify reconnection is attempted with exponential backoff.
- Unit test: Verify the backoff resets to 1 after a successful reconnection.
- Unit test: Verify `CancelledError` properly terminates the loop (no infinite reconnection after intentional shutdown).
- Integration test: Kill the signaling server process, restart it, and verify the daemon reconnects and can receive new pair requests.
- Run existing E2E tests.

## Risk Assessment

- Medium risk. The reconnection logic changes the control flow of the receive loop significantly.
- The main risk is infinite reconnection attempts if the server is permanently down. The exponential backoff (max 60 seconds) mitigates this but does not eliminate it. Consider adding a maximum retry count or total retry duration.
- Re-registration after reconnection sends the same pairing code, which should work if the server supports it. If the server assigns a new code on re-register, the daemon's pairing code would need to be updated.
- Existing peer connections and channel subscriptions need to be re-registered after reconnection. The channel owner/subscriber registrations (`send_channel_owner_register`, `send_channel_subscribe`) are not replayed during reconnection. This is a follow-up concern.
