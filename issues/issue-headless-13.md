# [MEDIUM] WebSocket connection uses no TLS certificate verification option

**Area**: Headless Client
**File**: packages/headless-client/zajel/signaling.py:134
**Type**: Security

**Description**: The signaling client connects to the WebSocket server with `websockets.connect(self.url)` using default settings. While `websockets` does verify TLS certificates by default when using `wss://`, there is no explicit configuration to:
1. Pin the signaling server's certificate or public key
2. Set a minimum TLS version
3. Disable fallback to unencrypted `ws://` connections

The `signaling_url` parameter accepts any URL and there is no validation that it uses `wss://`. If a user accidentally configures `ws://` instead of `wss://`, all signaling traffic (including public keys and pairing codes) will be sent in plaintext.

**Impact**: If the signaling URL is configured with `ws://` (no TLS), an attacker on the network path can observe and tamper with all signaling messages, including intercepting public keys during pairing (enabling MITM of the subsequent WebRTC connection). Even with `wss://`, without certificate pinning, a compromised CA could issue a fraudulent certificate.

**Fix**: Validate the URL scheme and warn or reject non-TLS connections:

```python
async def connect(self, public_key_b64: str) -> str:
    if not self.url.startswith("wss://"):
        if self.url.startswith("ws://"):
            logger.warning(
                "INSECURE: Using unencrypted WebSocket connection. "
                "Signaling traffic will be visible to network observers."
            )
        else:
            raise ValueError(f"Invalid signaling URL scheme: {self.url}")
    ...
```
