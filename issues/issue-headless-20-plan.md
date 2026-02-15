# Plan: Channel chunk sequence number not validated for replay/reorder

**Issue**: issue-headless-20.md
**Severity**: MEDIUM
**Area**: Headless Client
**Files to modify**:
- `packages/headless-client/zajel/client.py`
- `packages/headless-client/zajel/channels.py`

## Analysis

At `client.py:743-832`, the `receive_channel_chunk` method verifies the chunk signature and checks that the author is authorized, but does not validate the sequence number:

```python
chunk = Chunk.from_dict(chunk_data)

# Verify signature
if not self._channel_crypto.verify_chunk_signature(chunk):
    ...
    return None

# Verify author is in manifest (owner or admin)
...

# Store chunk (overwrites existing chunks with same chunk_id)
self._channel_storage.save_chunk(channel_id, chunk)
```

Issues:
1. No check that the sequence number is strictly increasing. Old chunks can be replayed.
2. No check for gaps in sequence numbers (censorship detection).
3. Chunks with the same `chunk_id` overwrite existing ones at `channels.py:619-623`:
   ```python
   def save_chunk(self, channel_id: str, chunk: Chunk) -> None:
       channel = self._channels.get(channel_id)
       if channel:
           channel.chunks[chunk.chunk_id] = chunk
   ```

The `ChannelStorage` already has a `get_latest_sequence` method at lines 636-641:
```python
def get_latest_sequence(self, channel_id: str) -> int:
    channel = self._channels.get(channel_id)
    if not channel or not channel.chunks:
        return 0
    return max(c.sequence for c in channel.chunks.values())
```

This method exists but is never called during chunk reception.

## Fix Steps

1. **Add sequence validation** in `receive_channel_chunk` at `client.py`, after signature verification (around line 787, before `save_chunk`):
   ```python
   # Validate sequence number (replay/reorder detection)
   latest_seq = self._channel_storage.get_latest_sequence(channel_id)

   if chunk.sequence < latest_seq:
       logger.warning(
           "Chunk %s has old sequence %d (latest: %d), possible replay. Discarding.",
           chunk.chunk_id, chunk.sequence, latest_seq,
       )
       return None

   if chunk.sequence > latest_seq + 1:
       logger.warning(
           "Sequence gap detected in channel %s: expected %d, got %d. "
           "Some messages may have been censored or lost.",
           channel_id[:16], latest_seq + 1, chunk.sequence,
       )
       # Still accept the chunk (gaps can occur due to network issues)
   ```

   Note: We use `<` (strictly less than) rather than `<=` because the same sequence number can have multiple chunks (`total_chunks > 1`). Chunks with the same sequence but different `chunk_index` are valid.

2. **Prevent chunk overwriting** in `ChannelStorage.save_chunk` at `channels.py:619-623`. Only allow saving a chunk if the `chunk_id` is new or matches the existing content:
   ```python
   def save_chunk(self, channel_id: str, chunk: Chunk) -> None:
       """Save a chunk for a channel. Rejects duplicate chunk_ids with different content."""
       channel = self._channels.get(channel_id)
       if channel:
           existing = channel.chunks.get(chunk.chunk_id)
           if existing is not None:
               # Only allow if it is the exact same chunk
               if existing.encrypted_payload != chunk.encrypted_payload:
                   logger.warning(
                       "Chunk %s already exists with different payload. "
                       "Rejecting potential content replacement.",
                       chunk.chunk_id,
                   )
                   return
               # Same content, skip (idempotent)
               return
           channel.chunks[chunk.chunk_id] = chunk
   ```

3. **Add an `import` for `logger`** in `channels.py` if not already present (it is -- at line 45).

4. **Track per-channel sequence watermarks** for more efficient lookup. Add a `_latest_sequences` dict to `ChannelStorage`:
   ```python
   def __init__(self):
       self._channels: dict[str, SubscribedChannel] = {}
       self._owned: dict[str, OwnedChannel] = {}
       self._latest_sequences: dict[str, int] = {}

   def save_chunk(self, channel_id: str, chunk: Chunk) -> None:
       ...
       channel.chunks[chunk.chunk_id] = chunk
       # Update watermark
       current = self._latest_sequences.get(channel_id, 0)
       if chunk.sequence > current:
           self._latest_sequences[channel_id] = chunk.sequence

   def get_latest_sequence(self, channel_id: str) -> int:
       """Get the highest sequence number seen for a channel."""
       return self._latest_sequences.get(channel_id, 0)
   ```

   This replaces the current `get_latest_sequence` implementation (which scans all chunks) with an O(1) lookup.

## Testing

- Unit test: Send a chunk with sequence 1, then replay a chunk with sequence 1. Verify the replay is rejected (logged as warning, returns None).
- Unit test: Send chunks with sequence 1, then 3 (gap). Verify the gap is logged as a warning but the chunk is still accepted.
- Unit test: Send a chunk with `chunk_id` "X" and payload A, then another chunk with `chunk_id` "X" and different payload B. Verify B is rejected.
- Unit test: Send a multi-chunk message (total_chunks=2) with the same sequence but different chunk_index values. Verify both are accepted.
- Integration test: Publish and receive channel messages. Verify sequence validation does not interfere with normal flow.
- Run existing channel E2E tests.

## Risk Assessment

- Low risk. The sequence validation is purely additive and rejects only clearly invalid chunks.
- The gap detection is logged but does not reject chunks, so it handles network reordering gracefully.
- The chunk overwrite prevention adds idempotency (same chunk_id with same content is silently accepted) while preventing content substitution.
- The O(1) sequence watermark lookup replaces the existing O(n) scan, improving performance.
- Multi-chunk messages (same sequence, different chunk_index) are correctly handled because the replay check uses `<` (not `<=`) for the sequence number comparison.
