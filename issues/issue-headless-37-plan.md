# Plan: Signaling server messages not validated for required fields

**Issue**: issue-headless-37.md
**Severity**: LOW
**Area**: Headless Client
**Files to modify**: `packages/headless-client/zajel/signaling.py`

## Analysis

The `_handle_message` method at lines 404-526 of `signaling.py` processes incoming messages from the signaling server using a `match` statement. Multiple cases access message fields directly without checking for their presence:

- **`pair_incoming`** (lines 415-423): Accesses `msg["fromCode"]` and `msg["fromPublicKey"]` directly. Missing keys raise `KeyError`.
- **`pair_matched`** (lines 425-433): Accesses `msg["peerCode"]`, `msg["peerPublicKey"]`, `msg["isInitiator"]`. Missing keys raise `KeyError`.
- **`pair_rejected`** (line 436): Accesses `msg["peerCode"]`.
- **`offer` | `answer` | `ice_candidate`** (lines 445-453): Accesses `msg["from"]` and `msg["payload"]`.
- **`call_offer` | etc.** (lines 455-463): Same pattern with `msg["from"]` and `msg["payload"]`.

The `_receive_loop` (lines 385-402) catches exceptions broadly:
```python
try:
    msg = json.loads(raw)
    await self._handle_message(msg)
except json.JSONDecodeError:
    logger.warning("Non-JSON message: %s", raw[:100])
```
But `KeyError` from missing fields is NOT caught here -- it falls through to the general `except Exception` at line 397, which logs and continues. While the receive loop does not crash, each malformed message causes an error log and the message is effectively dropped.

The `msg.get()` pattern is already used in some places (e.g., `msg.get("proposedName")` at line 419, `msg.get("peerCode")` at line 439), showing inconsistency.

## Fix Steps

1. **Add field validation to each `match` case** in `_handle_message`. For each case, check required fields before accessing them:

   **`pair_incoming`** (lines 415-423):
   ```python
   case "pair_incoming":
       if not all(k in msg for k in ("fromCode", "fromPublicKey")):
           logger.warning("Malformed pair_incoming: missing required fields")
           return
       req = PairRequest(
           from_code=msg["fromCode"],
           from_public_key=msg["fromPublicKey"],
           proposed_name=msg.get("proposedName"),
       )
       await self._pair_requests.put(req)
       if self._on_pair_request:
           await self._on_pair_request(req)
   ```

   **`pair_matched`** (lines 425-433):
   ```python
   case "pair_matched":
       if not all(k in msg for k in ("peerCode", "peerPublicKey", "isInitiator")):
           logger.warning("Malformed pair_matched: missing required fields")
           return
       match = PairMatch(...)
   ```

   **`pair_rejected`** (line 436):
   ```python
   case "pair_rejected":
       if "peerCode" not in msg:
           logger.warning("Malformed pair_rejected: missing peerCode")
           return
       await self._pair_rejections.put(msg["peerCode"])
   ```

   **`offer` | `answer` | `ice_candidate`** (lines 445-453):
   ```python
   case "offer" | "answer" | "ice_candidate":
       if not all(k in msg for k in ("from", "payload")):
           logger.warning("Malformed %s: missing required fields", msg_type)
           return
       signal = WebRTCSignal(...)
   ```

   **`call_offer` | etc.** (lines 455-463):
   ```python
   case "call_offer" | "call_answer" | "call_reject" | "call_hangup" | "call_ice":
       if not all(k in msg for k in ("from", "payload")):
           logger.warning("Malformed %s: missing required fields", msg_type)
           return
       signal = CallSignal(...)
   ```

2. **Add a general try/except around `_handle_message`** body for defense-in-depth. After line 404:
   ```python
   async def _handle_message(self, msg: dict) -> None:
       msg_type = msg.get("type", "")
       logger.debug("RX: %s", msg_type)
       try:
           # ... match statement ...
       except (KeyError, TypeError, ValueError) as e:
           logger.warning(
               "Error processing %s message: %s", msg_type, e
           )
   ```

## Testing

- Unit test: Send a `pair_incoming` message without `fromCode` and verify it is logged as malformed and does not raise.
- Unit test: Send a `pair_matched` message without `isInitiator` and verify it is handled gracefully.
- Unit test: Send an `offer` message without `payload` and verify it does not crash.
- Unit test: Send a valid `pair_incoming` message and verify it is processed correctly.
- Unit test: Verify the receive loop continues processing after a malformed message.

## Risk Assessment

- The `all(k in msg for k in ...)` check is O(n) where n is the number of required keys (typically 2-3), which is negligible.
- The `return` after a validation failure skips the message entirely. This is appropriate since a partial message cannot be meaningfully processed.
- A malicious signaling server could flood malformed messages to fill the warning log. Consider rate-limiting the warning logs.
- The defense-in-depth try/except catches any remaining `KeyError`/`TypeError` from fields that might be accessed in callback handlers (`_on_pair_request`, etc.).
