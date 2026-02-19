# [MEDIUM] No file size validation on incoming file transfers

**Area**: Headless Client
**File**: packages/headless-client/zajel/file_transfer.py:145-157
**Type**: Security

**Description**: When a `file_start` message is received, the `totalSize` and `totalChunks` values from the remote peer are accepted without validation. A malicious peer could:
1. Send `totalSize: 999999999999` (terabytes) -- the system will allocate memory for chunks and eventually write a huge file
2. Send `totalChunks: 0` which could cause division errors or infinite loops
3. Send mismatched `totalSize`/`totalChunks` values (e.g., `totalChunks: 1000000` with `totalSize: 100`) flooding with empty chunks
4. The `wait_for_file` method at line 214 has an infinite loop (`while True`) that only breaks when a transfer completes, but never cleans up aborted transfers

Additionally, individual chunks are accumulated in memory (dict of chunk_index -> bytes) until all are received. A large file will consume unbounded memory.

**Impact**: Denial of service through memory exhaustion or disk exhaustion. A malicious peer can crash the daemon or fill the disk.

**Fix**: Add validation for incoming file metadata and enforce limits:

```python
MAX_FILE_SIZE = 100 * 1024 * 1024  # 100 MB
MAX_CHUNKS = 10000

if msg_type == "file_start":
    total_size = msg["totalSize"]
    total_chunks = msg["totalChunks"]

    if total_size <= 0 or total_size > MAX_FILE_SIZE:
        logger.warning("Rejected file transfer: size %d exceeds limit", total_size)
        return
    if total_chunks <= 0 or total_chunks > MAX_CHUNKS:
        logger.warning("Rejected file transfer: %d chunks exceeds limit", total_chunks)
        return
```
