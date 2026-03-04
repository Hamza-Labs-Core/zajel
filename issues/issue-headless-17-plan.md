# Plan: Unbounded in-memory storage for channels, groups, and chunks

**Issue**: issue-headless-17.md
**Severity**: MEDIUM
**Area**: Headless Client
**Files to modify**:
- `packages/headless-client/zajel/channels.py`
- `packages/headless-client/zajel/groups.py`

## Analysis

Both `ChannelStorage` and `GroupStorage` use in-memory dictionaries with no size limits:

**ChannelStorage** (`channels.py:596-655`):
- `self._channels: dict[str, SubscribedChannel]` at line 600
- Each `SubscribedChannel` has `chunks: dict[str, Chunk]` (line 251) that grows without limit
- `save_chunk` at line 619-623 appends without eviction:
  ```python
  def save_chunk(self, channel_id: str, chunk: Chunk) -> None:
      channel = self._channels.get(channel_id)
      if channel:
          channel.chunks[chunk.chunk_id] = chunk
  ```
- Similarly, `OwnedChannel.chunks` at line 264 grows unboundedly

**GroupStorage** (`groups.py:254-311`):
- `self._messages: dict[str, list[GroupMessage]]` at line 259 grows without limit
- `save_message` at line 284-288 appends without eviction:
  ```python
  def save_message(self, message: GroupMessage) -> None:
      if message.group_id not in self._messages:
          self._messages[message.group_id] = []
      self._messages[message.group_id].append(message)
  ```

For a long-running daemon, these stores grow continuously.

## Fix Steps

1. **Define eviction constants** at the top of `channels.py`:
   ```python
   MAX_CHUNKS_PER_CHANNEL = 1000
   ```

2. **Add eviction logic to `ChannelStorage.save_chunk`** at `channels.py:619-623`:
   ```python
   def save_chunk(self, channel_id: str, chunk: Chunk) -> None:
       """Save a chunk for a channel, evicting oldest if over limit."""
       channel = self._channels.get(channel_id)
       if channel:
           channel.chunks[chunk.chunk_id] = chunk
           # Evict oldest chunks if over limit
           if len(channel.chunks) > MAX_CHUNKS_PER_CHANNEL:
               sorted_ids = sorted(
                   channel.chunks.keys(),
                   key=lambda cid: channel.chunks[cid].sequence,
               )
               excess = len(channel.chunks) - MAX_CHUNKS_PER_CHANNEL
               for old_id in sorted_ids[:excess]:
                   del channel.chunks[old_id]
   ```

3. **Add eviction for owned channel chunks** when publishing. In `client.py` at `publish_channel_message` (around line 617-618), after storing new chunks:
   ```python
   for chunk in chunks:
       channel.chunks[chunk.chunk_id] = chunk
   # Evict old chunks from owned channel
   if len(channel.chunks) > MAX_CHUNKS_PER_CHANNEL:
       sorted_ids = sorted(
           channel.chunks.keys(),
           key=lambda cid: channel.chunks[cid].sequence,
       )
       excess = len(channel.chunks) - MAX_CHUNKS_PER_CHANNEL
       for old_id in sorted_ids[:excess]:
           del channel.chunks[old_id]
   ```
   Alternatively, import `MAX_CHUNKS_PER_CHANNEL` from channels and add an eviction method to `OwnedChannel`.

4. **Define eviction constants** at the top of `groups.py`:
   ```python
   MAX_MESSAGES_PER_GROUP = 5000
   ```

5. **Add eviction logic to `GroupStorage.save_message`** at `groups.py:284-288`:
   ```python
   def save_message(self, message: GroupMessage) -> None:
       """Save a group message, evicting oldest if over limit."""
       if message.group_id not in self._messages:
           self._messages[message.group_id] = []
       self._messages[message.group_id].append(message)
       # Evict oldest messages if over limit
       msgs = self._messages[message.group_id]
       if len(msgs) > MAX_MESSAGES_PER_GROUP:
           # Keep only the most recent messages
           self._messages[message.group_id] = msgs[-MAX_MESSAGES_PER_GROUP:]
   ```

6. **Add a `cleanup_completed_transfers` method** to `FileTransferService` and call it periodically to also limit the `_incoming` dict growth (complementing issue-headless-15).

## Testing

- Unit test: Add more than `MAX_CHUNKS_PER_CHANNEL` chunks to a channel and verify the oldest chunks are evicted.
- Unit test: Add more than `MAX_MESSAGES_PER_GROUP` messages to a group and verify the oldest messages are evicted.
- Unit test: Verify the most recent chunks/messages are retained (not the oldest).
- Integration test: Long-running scenario where many messages flow through. Verify memory usage stays bounded.
- Run existing E2E tests.

## Risk Assessment

- Low risk. The eviction limits are generous and should not affect normal usage.
- The eviction uses sequence number ordering for chunks, which correctly removes the oldest content first.
- For group messages, the list slicing approach (`msgs[-MAX:]`) is simple and correct.
- One edge case: if a subscriber reconnects and re-requests old chunks that have been evicted, they will not be available. This is acceptable for an in-memory store. Future migration to SQLite-backed storage would handle this better.
- The `get_chunks_by_sequence` method in `ChannelStorage` (line 625-633) returns chunks by sequence number. After eviction, old sequences will no longer have chunks, which is the intended behavior.
