# Plan: Encrypted message decryption tries all peers without binding to source

**Issue**: issue-headless-06.md
**Severity**: HIGH
**Area**: Headless Client
**Files to modify**:
- `packages/headless-client/zajel/client.py`

## Analysis

At `client.py:1390-1420`, when an encrypted message arrives on the WebRTC data channel, the code iterates over ALL connected peers and attempts decryption with each session key until one succeeds:

```python
elif msg["type"] == "encrypted_text":
    for peer_id in self._connected_peers:
        if self._crypto.has_session_key(peer_id):
            try:
                plaintext = self._crypto.decrypt(peer_id, msg["data"])
                # ... process message ...
                break
            except Exception as e:
                logger.debug("Decrypt failed for %s: %s", peer_id, e)
```

The same pattern exists in `_on_file_channel_data` at lines 1422-1434, and in `_handle_group_data` at lines 1183-1224.

Since the WebRTC connection is already bound to a specific peer (established during `_establish_connection`), the code should directly use that peer's session key rather than trial-decrypting with all keys.

## Fix Steps

1. **This fix depends on issue-headless-05's `_webrtc_peer_id` field**. With that field available, directly look up the peer ID for decryption.

2. **Update `_on_message_channel_data` at lines 1390-1420** to use the tracked peer ID:
   ```python
   elif msg["type"] == "encrypted_text":
       peer_id = self._webrtc_peer_id
       if peer_id and self._crypto.has_session_key(peer_id):
           try:
               plaintext = self._crypto.decrypt(peer_id, msg["data"])

               if plaintext.startswith("ginv:"):
                   self._handle_group_invitation(peer_id, plaintext[5:])
               elif plaintext.startswith("grp:"):
                   self._handle_group_data(peer_id, plaintext[4:])
               else:
                   received = ReceivedMessage(peer_id=peer_id, content=plaintext)
                   self._message_queue.put_nowait(received)
                   asyncio.get_event_loop().create_task(
                       self._events.emit("message", peer_id, plaintext, "text")
                   )
           except Exception as e:
               logger.error("Decrypt failed for peer %s: %s", peer_id, e)
       else:
           logger.warning("No session key for WebRTC peer %s", peer_id)
   ```

3. **Update `_on_file_channel_data` at lines 1422-1434** similarly:
   ```python
   def _on_file_channel_data(self, data: str) -> None:
       peer_id = self._webrtc_peer_id
       if peer_id and self._crypto.has_session_key(peer_id):
           try:
               plaintext = self._crypto.decrypt(peer_id, data)
               msg = json.loads(plaintext)
               if self._file_transfer:
                   self._file_transfer.handle_file_message(peer_id, msg)
           except Exception as e:
               logger.error("File channel decrypt failed for %s: %s", peer_id, e)
       else:
           logger.warning("No session key for file channel peer %s", peer_id)
   ```

## Testing

- Unit test: Verify that messages are decrypted with the correct peer's key, not by trial.
- Unit test: If `_webrtc_peer_id` is None or missing a session key, verify a warning is logged and no crash occurs.
- Integration test: Send and receive messages between two peers and verify correct attribution.
- Run existing E2E messaging and file transfer tests.

## Risk Assessment

- Low risk. This is a cleanup of an architectural shortcut. The current trial-decryption approach works correctly (AEAD will reject wrong keys with overwhelming probability), but it is semantically wrong.
- This fix has a dependency on issue-headless-05 (the `_webrtc_peer_id` field). Both should be implemented together.
- If the architecture ever supports multiple simultaneous WebRTC connections, the fix will need to be extended to track peer IDs per connection/channel. But this establishes the correct pattern.
