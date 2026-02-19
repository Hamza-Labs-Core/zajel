# [MEDIUM] Unbounded in-memory storage for channels, groups, and chunks

**Area**: Headless Client
**File**: packages/headless-client/zajel/channels.py:596-655 and packages/headless-client/zajel/groups.py:254-311
**Type**: Security

**Description**: Both `ChannelStorage` and `GroupStorage` use in-memory dictionaries with no size limits:
- `ChannelStorage._channels` accumulates chunks indefinitely (`channel.chunks[chunk.chunk_id] = chunk`)
- `GroupStorage._messages` grows without limit as messages are received
- `OwnedChannel.chunks` accumulates all published chunks forever

For a long-running daemon, these stores will grow continuously. A malicious channel owner could flood a subscriber with chunks. A malicious group peer could send a high volume of messages.

**Impact**: Memory exhaustion over time. A long-running daemon will eventually run out of memory if it receives a steady stream of channel content or group messages. This is particularly dangerous for a daemon designed to run indefinitely.

**Fix**: Implement eviction policies:
1. Limit the number of stored chunks per channel (e.g., keep only the last N sequences)
2. Limit the number of stored messages per group
3. Consider moving to SQLite-backed storage for channels and groups (like peer storage already does)

```python
MAX_CHUNKS_PER_CHANNEL = 1000
MAX_MESSAGES_PER_GROUP = 5000

def save_chunk(self, channel_id: str, chunk: Chunk) -> None:
    channel = self._channels.get(channel_id)
    if channel:
        channel.chunks[chunk.chunk_id] = chunk
        if len(channel.chunks) > MAX_CHUNKS_PER_CHANNEL:
            # Evict oldest chunks by sequence number
            sorted_ids = sorted(channel.chunks.keys(),
                              key=lambda cid: channel.chunks[cid].sequence)
            for old_id in sorted_ids[:len(channel.chunks) - MAX_CHUNKS_PER_CHANNEL]:
                del channel.chunks[old_id]
```
