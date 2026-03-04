# [LOW] Signaling server messages not validated for required fields

**Area**: Headless Client
**File**: packages/headless-client/zajel/signaling.py:404-526
**Type**: Best Practice

**Description**: The `_handle_message` method in `SignalingClient` processes incoming messages from the signaling server using a `match` statement, but accesses message fields directly without validation:

- Line 417: `msg["fromCode"]` -- will raise `KeyError` if missing
- Line 418: `msg["fromPublicKey"]` -- will raise `KeyError` if missing
- Line 427: `msg["peerCode"]` -- will raise `KeyError` if missing
- Line 428: `msg["peerPublicKey"]` -- will raise `KeyError` if missing
- Line 429: `msg["isInitiator"]` -- will raise `KeyError` if missing
- Line 448: `msg["from"]` -- will raise `KeyError` if missing
- Line 449: `msg["payload"]` -- will raise `KeyError` if missing

A malicious or buggy signaling server could send messages with missing fields, causing `KeyError` exceptions. While these would be caught by the outer exception handler in `_receive_loop`, they would log an error and potentially disrupt processing of subsequent messages.

**Impact**: A malformed message from the signaling server can cause an exception in the receive loop. While the exception is caught, it could interfere with message processing flow and generates noisy error logs.

**Fix**: Validate required fields before accessing them:

```python
case "pair_incoming":
    if not all(k in msg for k in ("fromCode", "fromPublicKey")):
        logger.warning("Malformed pair_incoming message: missing fields")
        return
    req = PairRequest(
        from_code=msg["fromCode"],
        from_public_key=msg["fromPublicKey"],
        proposed_name=msg.get("proposedName"),
    )
```
