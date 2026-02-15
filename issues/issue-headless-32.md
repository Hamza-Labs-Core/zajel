# [LOW] WebRTC data channels configured with maxRetransmits=3 may lose messages

**Area**: Headless Client
**File**: packages/headless-client/zajel/webrtc.py:147-152
**Type**: Best Practice

**Description**: The message and file data channels are created with `maxRetransmits=3`:

```python
msg_ch = self._pc.createDataChannel(
    MESSAGE_CHANNEL_LABEL, ordered=True, maxRetransmits=3
)
file_ch = self._pc.createDataChannel(
    FILE_CHANNEL_LABEL, ordered=True, maxRetransmits=3
)
```

Setting `maxRetransmits` changes the channel from reliable (TCP-like) to partially reliable (like SCTP partial reliability). With `maxRetransmits=3`, if a message fails to be delivered after 3 retransmission attempts, it is silently dropped. The application layer has no notification that a message was lost.

For encrypted messages, a dropped message means the recipient never receives it. For file transfers, a dropped chunk means the file transfer will fail (missing chunk at reassembly time).

**Impact**: Under poor network conditions (high packet loss, congestion), messages and file transfer chunks can be silently dropped. The encrypted messaging use case requires reliable delivery -- lost encrypted messages are unrecoverable.

**Fix**: Use reliable data channels for both message and file transfer:

```python
msg_ch = self._pc.createDataChannel(
    MESSAGE_CHANNEL_LABEL, ordered=True
    # No maxRetransmits or maxPacketLifeTime = reliable delivery
)
```

If partial reliability is desired for performance, add application-level acknowledgments and retransmission.
