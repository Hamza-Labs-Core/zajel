# [MEDIUM] WebRTC connection not cleaned up on establishment failure

**Area**: Headless Client
**File**: packages/headless-client/zajel/client.py:1270-1349
**Type**: Bug

**Description**: The `_establish_connection` method creates a WebRTC peer connection, waits for signals, and performs the handshake. If any step fails (e.g., timeout waiting for offer/answer at line 1303 or 1310, timeout waiting for data channel at line 1322), the method raises an exception but never cleans up:

1. The `RTCPeerConnection` is left open (never closed)
2. The ICE candidate loop task (line 1319) is started and never cancelled
3. The peer is left in `_connected_peers` (added at line 1281)
4. The `_webrtc` service retains the stale connection

There is no `try/except/finally` block to ensure cleanup on failure.

**Impact**: Resource leak on failed connections. Each failed connection attempt leaks a WebRTC peer connection (with associated ICE agents, DTLS context, etc.), an asyncio task, and a stale peer entry. After multiple failed attempts, this can exhaust system resources.

**Fix**: Wrap the connection establishment in a try/except/finally:

```python
async def _establish_connection(self, match: PairMatch) -> ConnectedPeer:
    peer = ConnectedPeer(...)
    self._connected_peers[match.peer_code] = peer
    ice_task = None
    try:
        await self._webrtc.create_connection(match.is_initiator)
        # ... signaling exchange ...
        ice_task = asyncio.create_task(self._ice_candidate_loop(match.peer_code))
        self._tasks.append(ice_task)
        await self._webrtc.wait_for_message_channel(timeout=30)
        # ... handshake ...
        return peer
    except Exception:
        self._connected_peers.pop(match.peer_code, None)
        if ice_task:
            ice_task.cancel()
            self._tasks = [t for t in self._tasks if t is not ice_task]
        await self._webrtc.close()
        raise
```
