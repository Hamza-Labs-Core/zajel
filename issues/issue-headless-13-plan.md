# Plan: WebSocket connection uses no TLS certificate verification option

**Issue**: issue-headless-13.md
**Severity**: MEDIUM
**Area**: Headless Client
**Files to modify**:
- `packages/headless-client/zajel/signaling.py`

## Analysis

At `signaling.py:134`, the signaling client connects with:
```python
self._ws = await websockets.connect(self.url)
```

While `websockets.connect()` does verify TLS certificates by default when using `wss://`, there are no safeguards:

1. No validation that the URL uses `wss://` (not plain `ws://`).
2. No explicit minimum TLS version configuration.
3. No certificate pinning.

The `self.url` comes from the `--signaling-url` CLI argument (via `daemon.py:329`) and can be any URL. If a user accidentally uses `ws://`, all signaling traffic (public keys, pairing codes) is sent in plaintext.

The `url` parameter is stored at `signaling.py:88`:
```python
def __init__(self, url: str, pairing_code: Optional[str] = None):
    self.url = url
```

## Fix Steps

1. **Add URL scheme validation** in the `connect` method at `signaling.py:124-134`. Before connecting, check the scheme:
   ```python
   async def connect(self, public_key_b64: str) -> str:
       """Connect to the signaling server and register."""
       if self.url.startswith("ws://"):
           logger.warning(
               "INSECURE: Using unencrypted WebSocket connection to %s. "
               "Signaling traffic (including public keys and pairing codes) "
               "will be visible to network observers. Use wss:// in production.",
               self.url,
           )
       elif not self.url.startswith("wss://"):
           raise ValueError(
               f"Invalid signaling URL scheme: {self.url}. "
               "Use wss:// for secure connections or ws:// for local development."
           )

       logger.info("Connecting to %s with code %s", self.url, self.pairing_code)
       self._ws = await websockets.connect(self.url)
       ...
   ```

2. **Add URL validation in `__init__`** at `signaling.py:87-88` for early feedback:
   ```python
   def __init__(self, url: str, pairing_code: Optional[str] = None):
       if not url.startswith(("ws://", "wss://")):
           raise ValueError(
               f"Invalid signaling URL: {url}. Must start with ws:// or wss://"
           )
       self.url = url
   ```

3. **Optionally, add an `allow_insecure` parameter** to explicitly opt into `ws://` connections, making it harder to use insecure connections by accident:
   ```python
   def __init__(self, url: str, pairing_code: Optional[str] = None, allow_insecure: bool = False):
       if url.startswith("ws://") and not allow_insecure:
           raise ValueError(
               "Insecure ws:// URL rejected. Use wss:// or pass allow_insecure=True."
           )
       self.url = url
   ```
   However, this would require plumbing the flag through `ZajelHeadlessClient` and the CLI, so it may be better as a follow-up.

## Testing

- Unit test: Instantiate `SignalingClient` with `ws://` URL and verify a warning is logged during `connect()`.
- Unit test: Instantiate `SignalingClient` with `http://` URL and verify `ValueError` is raised.
- Unit test: Instantiate `SignalingClient` with `wss://` URL and verify no warning.
- Integration test: Run E2E tests with the existing `ws://` URLs (local test server) and verify they still work (with warning).
- The E2E tests currently use `ws://localhost:...` for the local signaling server, so `ws://` must remain functional (with a warning), not blocked.

## Risk Assessment

- Low risk. The warning for `ws://` does not change behavior; it just logs a security notice.
- The validation for invalid schemes (not `ws://` or `wss://`) provides a useful guardrail.
- The E2E test infrastructure uses `ws://` for local signaling servers, so blocking `ws://` entirely would break tests. The warning approach is the right balance.
- Certificate pinning is a more advanced feature that would require configuration management and is recommended as a follow-up.
