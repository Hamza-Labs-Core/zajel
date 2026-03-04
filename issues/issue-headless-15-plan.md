# Plan: No file size validation on incoming file transfers

**Issue**: issue-headless-15.md
**Severity**: MEDIUM
**Area**: Headless Client
**Files to modify**:
- `packages/headless-client/zajel/file_transfer.py`

## Analysis

At `file_transfer.py:145-157`, when a `file_start` message is received, the `totalSize` and `totalChunks` values from the remote peer are accepted without any validation:

```python
if msg_type == "file_start":
    file_id = msg["fileId"]
    info = FileTransferProgress(
        file_id=file_id,
        file_name=msg["fileName"],
        total_size=msg["totalSize"],
        total_chunks=msg["totalChunks"],
    )
    self._incoming[file_id] = IncomingTransfer(info=info)
```

Issues:
1. No upper limit on `totalSize` -- a peer could claim terabytes.
2. No validation that `totalChunks > 0` -- zero chunks could cause issues.
3. No validation of `totalSize` vs `totalChunks` consistency.
4. Chunks are accumulated in memory (dict of `chunk_index -> bytes` in `IncomingTransfer.chunks`) until all are received. A large file consumes unbounded memory.
5. The `wait_for_file` method at line 214 has an infinite loop (`while True`) that only breaks when a transfer completes or times out. Aborted/incomplete transfers are never cleaned up from `self._incoming`.

## Fix Steps

1. **Define size limit constants** at the top of `file_transfer.py` (after line 28):
   ```python
   MAX_FILE_SIZE = 100 * 1024 * 1024  # 100 MB
   MAX_CHUNKS = 10000
   MAX_CONCURRENT_TRANSFERS = 10
   TRANSFER_TIMEOUT = 300  # 5 minutes
   ```

2. **Add validation in the `file_start` handler** at lines 145-157:
   ```python
   if msg_type == "file_start":
       file_id = msg["fileId"]
       total_size = msg.get("totalSize", 0)
       total_chunks = msg.get("totalChunks", 0)

       # Validate file size
       if total_size <= 0 or total_size > MAX_FILE_SIZE:
           logger.warning(
               "Rejected file transfer %s: size %d exceeds limit %d",
               file_id, total_size, MAX_FILE_SIZE,
           )
           return

       # Validate chunk count
       if total_chunks <= 0 or total_chunks > MAX_CHUNKS:
           logger.warning(
               "Rejected file transfer %s: %d chunks exceeds limit %d",
               file_id, total_chunks, MAX_CHUNKS,
           )
           return

       # Validate consistency
       if total_size > total_chunks * FILE_CHUNK_SIZE:
           logger.warning(
               "Rejected file transfer %s: size/chunks mismatch",
               file_id,
           )
           return

       # Limit concurrent transfers
       active = sum(1 for t in self._incoming.values() if not t.info.completed)
       if active >= MAX_CONCURRENT_TRANSFERS:
           logger.warning("Rejected file transfer %s: too many concurrent transfers", file_id)
           return

       info = FileTransferProgress(...)
       self._incoming[file_id] = IncomingTransfer(info=info)
   ```

3. **Add chunk-level byte accounting** in the `file_chunk` handler at lines 159-169. Track actual bytes received and reject if they exceed the declared size:
   ```python
   elif msg_type == "file_chunk":
       file_id = msg["fileId"]
       transfer = self._incoming.get(file_id)
       if transfer is None:
           logger.warning("Chunk for unknown file: %s", file_id)
           return

       chunk_data = base64.b64decode(msg["data"])
       transfer.info.bytes_received += len(chunk_data)

       if transfer.info.bytes_received > transfer.info.total_size * 1.1:  # 10% tolerance
           logger.warning(
               "File transfer %s: received bytes (%d) exceed declared size (%d)",
               file_id, transfer.info.bytes_received, transfer.info.total_size,
           )
           del self._incoming[file_id]
           return

       transfer.chunks[msg["chunkIndex"]] = chunk_data
       transfer.info.received_chunks += 1
   ```

4. **Add cleanup for stale transfers** using a periodic check or on each new transfer. Add a method:
   ```python
   def _cleanup_stale_transfers(self) -> None:
       """Remove transfers that have been inactive too long."""
       import time
       now = time.time()
       stale = [
           fid for fid, t in self._incoming.items()
           if not t.info.completed and hasattr(t, '_started_at')
           and now - t._started_at > TRANSFER_TIMEOUT
       ]
       for fid in stale:
           logger.warning("Cleaning up stale transfer: %s", fid)
           del self._incoming[fid]
   ```

   Add `_started_at` to `IncomingTransfer`:
   ```python
   @dataclass
   class IncomingTransfer:
       info: FileTransferProgress
       chunks: dict[int, bytes] = field(default_factory=dict)
       complete_event: asyncio.Event = field(default_factory=asyncio.Event)
       _started_at: float = field(default_factory=time.time)
   ```

## Testing

- Unit test: Send a `file_start` with `totalSize` exceeding `MAX_FILE_SIZE`. Verify it is rejected.
- Unit test: Send a `file_start` with `totalChunks: 0`. Verify it is rejected.
- Unit test: Send a `file_start` with mismatched `totalSize`/`totalChunks`. Verify it is rejected.
- Unit test: Send more bytes than declared and verify the transfer is aborted.
- Integration test: Successful file transfer within limits works as before.
- Run existing file transfer E2E tests.

## Risk Assessment

- Low risk. The limits are generous (100 MB, 10000 chunks) and should not affect legitimate use cases.
- The `FILE_CHUNK_SIZE` is imported from `protocol.py` and is used for the consistency check. If the sender uses a different chunk size, the check might fail. The 10% tolerance on byte counting helps.
- The stale transfer cleanup requires adding a timestamp field to `IncomingTransfer`, which is a minor dataclass change.
