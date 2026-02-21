# [MEDIUM] Race condition: peer added to connected_peers before key exchange

**Area**: Headless Client
**File**: packages/headless-client/zajel/client.py:1281
**Type**: Bug

**Description**: In `_establish_connection`, the peer is added to `self._connected_peers` at line 1281, before the WebRTC connection is established and before the cryptographic handshake completes. The comment says this is intentional ("Store peer early so incoming handshake messages can find it"), but it creates a window where:

1. The peer appears in `get_connected_peers()` before the connection is actually established
2. Calls to `send_text()` for this peer will fail because there is no session key yet
3. The `_on_message_channel_data` handler may process messages from other peers during this window

If `_establish_connection` fails at any point after line 1281 (e.g., timeout during WebRTC negotiation), the peer remains in `_connected_peers` even though the connection was never completed.

**Impact**: State corruption. A failed connection attempt leaves stale entries in `_connected_peers`, which can cause confusing behavior: the peer appears connected but messages cannot be sent. The `send_text` method will throw a "No session key" error for peers that appear to be connected.

**Fix**: Use a separate "pending peers" dict during connection setup, and only move to `_connected_peers` after the handshake is complete:

```python
self._pending_peers: dict[str, ConnectedPeer] = {}

async def _establish_connection(self, match: PairMatch) -> ConnectedPeer:
    peer = ConnectedPeer(...)
    self._pending_peers[match.peer_code] = peer
    try:
        # ... WebRTC setup, handshake ...
        # Only after successful key exchange:
        self._connected_peers[match.peer_code] = peer
        del self._pending_peers[match.peer_code]
    except Exception:
        self._pending_peers.pop(match.peer_code, None)
        raise
```
