# Plan: WebRTC data channels configured with maxRetransmits=3 may lose messages

**Issue**: issue-headless-32.md
**Severity**: LOW
**Area**: Headless Client
**Files to modify**: `packages/headless-client/zajel/webrtc.py`

## Analysis

In `webrtc.py`, the `create_connection` method creates data channels at lines 147-154:

```python
if is_initiator:
    msg_ch = self._pc.createDataChannel(
        MESSAGE_CHANNEL_LABEL, ordered=True, maxRetransmits=3
    )
    file_ch = self._pc.createDataChannel(
        FILE_CHANNEL_LABEL, ordered=True, maxRetransmits=3
    )
```

Setting `maxRetransmits=3` changes the channels from reliable (TCP-like, guaranteed delivery) to partially reliable (SCTP partial reliability extension). With this setting:
- If a message fails delivery after 3 retransmission attempts, it is silently dropped.
- The application has no notification that the message was lost.
- For the `messages` channel, a dropped encrypted message is unrecoverable (the recipient never receives it).
- For the `files` channel, a dropped chunk causes file transfer failure at reassembly time (missing chunk at `handle_file_message` line 181-184).

Without `maxRetransmits` or `maxPacketLifeTime`, SCTP data channels use reliable, ordered delivery -- equivalent to TCP semantics. This is the correct behavior for encrypted messaging and file transfer.

## Fix Steps

1. **Remove `maxRetransmits=3` from both `createDataChannel` calls** at lines 147-154:
   ```python
   if is_initiator:
       msg_ch = self._pc.createDataChannel(
           MESSAGE_CHANNEL_LABEL, ordered=True
       )
       file_ch = self._pc.createDataChannel(
           FILE_CHANNEL_LABEL, ordered=True
       )
       self._setup_channel(msg_ch)
       self._setup_channel(file_ch)
   ```

2. **No other changes needed**. The `ordered=True` parameter is kept to ensure in-order delivery (which is important for both message ordering and file chunk sequencing).

## Testing

- Unit test: Verify that `createDataChannel` is called without `maxRetransmits` parameter.
- Integration test: Send messages over a connection and verify all are received (this should pass with or without the fix in a stable network).
- Stress test: Send many rapid messages and verify none are lost (this is where the difference between reliable and partially reliable channels manifests).
- File transfer test: Transfer a large file and verify all chunks arrive (no missing chunks at reassembly).

## Risk Assessment

- Removing `maxRetransmits` makes the channels fully reliable, which increases latency under packet loss (retransmissions continue until delivery or connection failure). This is the correct tradeoff for encrypted messaging.
- Under severe network conditions (very high packet loss), reliable channels may stall rather than drop messages. This is preferable to silent message loss for a messaging application.
- The aiortc library implements SCTP with reliable delivery by default when no partial reliability parameters are set.
- This change affects only the initiator side. The responder's channels are created by the remote peer and received via the `datachannel` event (line 140-143), so their reliability is determined by the initiator's configuration. After this fix, both sides will use reliable channels.
