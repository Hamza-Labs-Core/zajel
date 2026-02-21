# [MEDIUM] File transfer has no hash verification for integrity

**Area**: Headless Client
**File**: packages/headless-client/zajel/file_transfer.py:171-202
**Type**: Security

**Description**: When a file transfer completes, the receiver computes the SHA-256 hash of the received data (line 192) and stores it in the progress info, but this hash is never verified against anything. The sender never communicates an expected hash, so the receiver has no way to verify that the reassembled file matches what the sender intended to send.

While individual chunks are encrypted and authenticated (via ChaCha20-Poly1305), the reassembly process could be affected by:
1. Missing chunks (checked at line 182-184, but only by index count)
2. Duplicate or reordered chunks (chunks dict uses index as key, so duplicates overwrite)
3. Truncated chunks (no individual chunk size validation)

The `FileCompleteMessage` class carries no hash or final size, making it impossible to verify end-to-end integrity of the transferred file.

**Impact**: A corrupted file transfer could go undetected. While AEAD encryption protects individual chunks, protocol-level errors (skipped chunks, reordered chunks due to race conditions) could produce corrupt output that is silently accepted.

**Fix**: Include the file's SHA-256 hash in the `file_start` or `file_complete` message and verify it after reassembly:

```python
# Sender - in send_file:
file_hash = hashlib.sha256(file_data).hexdigest()
complete_msg = FileCompleteMessage(file_id=file_id, sha256=file_hash)

# Receiver - in handle_file_message, file_complete case:
sha256 = hashlib.sha256(file_data).hexdigest()
if msg.get("sha256") and sha256 != msg["sha256"]:
    logger.error("File hash mismatch: expected %s, got %s", msg["sha256"], sha256)
    return  # Reject corrupt file
```
