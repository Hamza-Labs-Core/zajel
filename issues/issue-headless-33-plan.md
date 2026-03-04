# Plan: No validation of ICE server configuration beyond type checking

**Issue**: issue-headless-33.md
**Severity**: LOW
**Area**: Headless Client
**Files to modify**: `packages/headless-client/zajel/client.py`

## Analysis

In `client.py`, the ICE server conversion at lines 146-208 in `__init__` processes the `ice_servers` list. For each entry:

1. It extracts URLs (lines 156-161) to detect TURN entries.
2. It tries to construct `RTCIceServer(**s)` (line 171), catching `TypeError` and `ValueError`.
3. It logs a summary (lines 184-208).
4. It raises `ValueError` if TURN servers were provided but none converted (lines 202-208).

However, the validation does not check:
- Whether TURN server entries have `username` and `credential` fields (these are required for TURN authentication but `RTCIceServer` construction succeeds without them).
- Whether URLs use valid schemes (`stun:`, `turn:`, `turns:`).
- Whether the `credential` field is empty or a placeholder like `"password"`.

If TURN credentials are misconfigured, the `RTCIceServer` is created successfully but the TURN server will reject authentication at runtime, causing silent connectivity failures for peers behind symmetric NAT.

The current validation already detects when URLs are present (lines 156-167) and when entries are TURN (lines 162-167). It just does not validate the credentials.

## Fix Steps

1. **Add credential validation for TURN servers** after the `entry_is_turn` detection (after line 167), before the `try` block at line 169:
   ```python
   if entry_is_turn and isinstance(s, dict):
       username = s.get("username")
       credential = s.get("credential")
       if not username or not credential:
           logger.warning(
               "TURN server at index %d is missing username and/or credential; "
               "TURN authentication will fail at runtime. URLs: %s",
               i, entry_urls,
           )
       elif credential in ("password", "test", "changeme", ""):
           logger.warning(
               "TURN server at index %d appears to have a placeholder credential; "
               "verify TURN credentials are correct.",
               i,
           )
   ```

2. **Add URL scheme validation** before the `try` block. After the URL extraction (lines 156-161):
   ```python
   valid_schemes = ("stun:", "stuns:", "turn:", "turns:")
   for url in entry_urls:
       if not any(url.startswith(scheme) for scheme in valid_schemes):
           logger.warning(
               "ICE server at index %d has URL with unknown scheme: %s "
               "(expected stun:, stuns:, turn:, or turns:)",
               i, url,
           )
   ```

3. **No changes to the error-raising logic** (lines 191-208) -- it already correctly handles the case where all TURN servers fail to convert. The new warnings are informational and do not prevent construction.

## Testing

- Unit test: Pass a TURN server entry without `username` and verify the warning is logged.
- Unit test: Pass a TURN server entry with `credential: "changeme"` and verify the warning is logged.
- Unit test: Pass a STUN server entry (no username/credential needed) and verify no warnings.
- Unit test: Pass a URL with scheme `http:` and verify the unknown scheme warning is logged.
- Integration test: Pass valid TURN credentials and verify no warnings.

## Risk Assessment

- These are warning-level log messages only -- they do not change behavior. Misconfigured TURN servers will still be constructed and used (they will fail at runtime, same as before).
- The placeholder credential check (`"password"`, `"test"`, `"changeme"`) is a heuristic and may produce false positives for legitimate credentials that happen to match. The warning text makes it clear this is advisory.
- STUN servers do not require authentication, so the credential check is only applied when `entry_is_turn` is True.
- This fix is low-risk and purely additive (no behavioral changes to success paths).
