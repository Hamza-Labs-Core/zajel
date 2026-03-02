# Plan: WebRTC connection not cleaned up on establishment failure

**Issue**: issue-headless-29.md
**Severity**: MEDIUM
**Area**: Headless Client
**Files to modify**: `packages/headless-client/zajel/client.py`

## Analysis

The `_establish_connection` method at lines 1270-1349 of `client.py` performs multiple steps that can fail:

1. Line 1281: Adds peer to `self._connected_peers`
2. Line 1284: `await self._webrtc.create_connection(match.is_initiator)` -- can raise
3. Lines 1297-1316: Signaling exchange (offer/answer) -- `wait_for_webrtc_signal(timeout=30)` can raise `TimeoutError`
4. Line 1319: Creates ICE candidate loop task and appends to `self._tasks`
5. Line 1322: `await self._webrtc.wait_for_message_channel(timeout=30)` -- can raise `TimeoutError`
6. Lines 1325-1326: Sends handshake -- can raise if channel not actually ready
7. Lines 1329-1335: Initializes file transfer service
8. Lines 1338-1345: Saves peer to storage

There is no `try/except/finally` block. If any step fails (e.g., timeout at line 1303, 1310, or 1322), the method raises an exception but:
- The `RTCPeerConnection` created at line 1284 is never closed
- The ICE candidate loop task created at line 1319 is never cancelled
- The peer entry added at line 1281 remains in `_connected_peers`
- The WebRTC service retains the stale connection

Each leaked `RTCPeerConnection` includes DTLS context, ICE agents, and associated sockets.

## Fix Steps

1. **Wrap the entire connection establishment in a try/except** starting after line 1281 (peer added to dict). Replace lines 1270-1349 with:

   ```python
   async def _establish_connection(self, match: PairMatch) -> ConnectedPeer:
       """Establish a WebRTC connection after pairing."""
       peer = ConnectedPeer(
           peer_id=match.peer_code,
           public_key=match.peer_public_key,
           is_initiator=match.is_initiator,
       )

       # Store peer early so incoming handshake messages can find it
       self._connected_peers[match.peer_code] = peer

       ice_task = None
       try:
           # Create WebRTC connection
           await self._webrtc.create_connection(match.is_initiator)

           # Set up data channel handlers
           self._webrtc.on_message_channel_message = self._on_message_channel_data
           self._webrtc.on_file_channel_message = self._on_file_channel_data

           # Set up ICE candidate handler
           async def on_ice(candidate_dict):
               await self._signaling.send_ice_candidate(
                   match.peer_code, candidate_dict
               )
           self._webrtc.on_ice_candidate = on_ice

           if match.is_initiator:
               sdp = await self._webrtc.create_offer()
               await self._signaling.send_offer(match.peer_code, sdp)
               signal = await self._signaling.wait_for_webrtc_signal(timeout=30)
               if signal.signal_type == "answer":
                   await self._webrtc.set_remote_description(
                       signal.payload["sdp"], "answer"
                   )
           else:
               signal = await self._signaling.wait_for_webrtc_signal(timeout=30)
               if signal.signal_type == "offer":
                   await self._webrtc.set_remote_description(
                       signal.payload["sdp"], "offer"
                   )
                   sdp = await self._webrtc.create_answer()
                   await self._signaling.send_answer(match.peer_code, sdp)

           # Process ICE candidates in background
           ice_task = asyncio.create_task(self._ice_candidate_loop(match.peer_code))
           self._tasks.append(ice_task)

           # Wait for data channel
           await self._webrtc.wait_for_message_channel(timeout=30)

           # Send handshake (key exchange)
           handshake = HandshakeMessage(public_key=self._crypto.public_key_base64)
           await self._webrtc.send_message(handshake.to_json())

           # Initialize file transfer service
           self._file_transfer = FileTransferService(
               crypto=self._crypto,
               send_fn=lambda data: self._webrtc._channels.file_channel.send(data)
               if self._webrtc._channels.file_channel
               else None,
               receive_dir=str(self.receive_dir),
           )

           # Save to storage
           from datetime import datetime
           self._storage.save_peer(StoredPeer(
               peer_id=match.peer_code,
               display_name=peer.display_name or match.peer_code,
               public_key=match.peer_public_key,
               trusted_at=datetime.utcnow(),
               last_seen=datetime.utcnow(),
           ))

           await self._events.emit("peer_connected", peer.peer_id, peer.public_key)
           logger.info("Connected to peer %s", match.peer_code)
           return peer

       except Exception:
           # Clean up on failure
           logger.error(
               "Failed to establish connection with %s, cleaning up",
               match.peer_code,
           )
           self._connected_peers.pop(match.peer_code, None)
           if ice_task is not None:
               ice_task.cancel()
               self._tasks = [t for t in self._tasks if t is not ice_task]
           try:
               await self._webrtc.close()
           except Exception as close_err:
               logger.debug("Error closing WebRTC during cleanup: %s", close_err)
           raise
   ```

## Testing

- Unit test: Mock `wait_for_webrtc_signal` to raise `TimeoutError` and verify the peer is removed from `_connected_peers` and `_webrtc.close()` is called.
- Unit test: Mock `wait_for_message_channel` to raise `TimeoutError` and verify the ICE task is cancelled.
- Unit test: Verify that a successful connection still works correctly with the try/except in place.
- Integration test: Force a connection timeout (e.g., by not responding to the offer) and verify no resource leaks.

## Risk Assessment

- The `except Exception` block re-raises the original exception after cleanup, so callers see the same error behavior as before.
- `await self._webrtc.close()` in the cleanup path may fail if the connection was never fully created, so it is wrapped in its own try/except.
- The ICE task removal from `self._tasks` uses a list comprehension to create a new list, which is safe even if called concurrently (Python's GIL protects the reference assignment).
- The `_auto_establish_connection` wrapper (line 1265-1268) creates a task from `_establish_connection`. If it fails, the task will have an exception that is logged but not propagated, which is acceptable for auto-established connections.
