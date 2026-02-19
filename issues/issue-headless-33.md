# [LOW] No validation of ICE server configuration beyond type checking

**Area**: Headless Client
**File**: packages/headless-client/zajel/client.py:146-208
**Type**: Best Practice

**Description**: The ICE server conversion in `__init__` attempts to construct `RTCIceServer` objects from the provided dicts but only catches `TypeError` and `ValueError`. It does not validate:

1. That TURN server credentials are present (`username` and `credential` fields)
2. That URLs use valid schemes (`stun:`, `turn:`, `turns:`)
3. That port numbers are valid
4. That the `credential` field is not empty or a placeholder

If TURN credentials are misconfigured (e.g., expired or wrong), the `RTCIceServer` construction will succeed but the TURN server will reject authentication at runtime, causing silent connectivity failures.

**Impact**: Misconfigured ICE servers will cause hard-to-diagnose connectivity failures. The daemon will start successfully and appear to be working, but peers behind NAT will be unable to connect.

**Fix**: Add validation for TURN server credentials:

```python
if entry_is_turn:
    if isinstance(s, dict):
        if not s.get("username") or not s.get("credential"):
            logger.warning(
                "TURN server at index %d is missing username/credential; "
                "TURN authentication will fail",
                i,
            )
```
