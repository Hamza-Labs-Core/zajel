# [MEDIUM] Channel chunk sequence number not validated for replay/reorder

**Area**: Headless Client
**File**: packages/headless-client/zajel/client.py:743-832
**Type**: Security

**Description**: In `receive_channel_chunk`, the code verifies the chunk signature and checks that the author is authorized, but does not validate the sequence number:

1. No check that the sequence number is strictly increasing -- a malicious relay or owner could re-broadcast old chunks (replay attack)
2. No check for gaps in sequence numbers -- a censoring relay could skip certain messages
3. Chunks with the same chunk_id overwrite existing ones in storage (line 788: `self._channel_storage.save_chunk(channel_id, chunk)`), so a malicious actor could replace legitimate chunks with different content bearing the same chunk_id but different encrypted payload

The `chunk_id` format (`ch_<random>_<index>`) includes randomness but is not cryptographically bound to the content in a verifiable way.

**Impact**:
1. Message replay: Old channel content can be re-delivered to subscribers
2. Message suppression: Missing sequence numbers are not detected
3. Content replacement: If an attacker can forge a chunk with the same `chunk_id` but different payload (and a valid signature), it overwrites the original

**Fix**: Track the highest seen sequence number per channel and reject chunks with sequence numbers at or below it. Detect and log gaps:

```python
# In ChannelStorage, add:
def get_latest_sequence(self, channel_id: str) -> int:
    ...

# In receive_channel_chunk:
latest_seq = self._channel_storage.get_latest_sequence(channel_id)
if chunk.sequence <= latest_seq:
    logger.warning("Chunk %s has old sequence %d (latest: %d), possible replay",
                   chunk.chunk_id, chunk.sequence, latest_seq)
    return None
if chunk.sequence > latest_seq + 1:
    logger.warning("Sequence gap detected: expected %d, got %d",
                   latest_seq + 1, chunk.sequence)
```
