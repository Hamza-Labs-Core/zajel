# Plan: File transfer has no hash verification for integrity

**Issue**: issue-headless-22.md
**Severity**: MEDIUM
**Area**: Headless Client
**Files to modify**: `packages/headless-client/zajel/file_transfer.py`, `packages/headless-client/zajel/protocol.py`

## Analysis

In `file_transfer.py`, the `send_file` method (lines 72-134) sends a `FileCompleteMessage` at line 129 that contains only the `file_id`. The `FileCompleteMessage` class in `protocol.py` (lines 104-116) has only a `file_id` field and its `to_json` produces `{"type": "file_complete", "fileId": self.file_id}`. There is no hash field.

On the receiver side, in `handle_file_message` (lines 136-205), the file_complete case (lines 171-205) computes a SHA-256 hash at line 192 and stores it in `transfer.info.sha256` at line 196, but this is only for informational/logging purposes. The hash is never compared to any expected value. The receiver has no way to verify the file was received intact.

The sender already reads the entire file into `file_data` at line 92, so computing the hash there is trivial. The `FileCompleteMessage` class needs a `sha256` field.

## Fix Steps

1. **Add `sha256` field to `FileCompleteMessage` in `protocol.py`** (lines 104-116):
   ```python
   @dataclass
   class FileCompleteMessage:
       """Signals the end of a file transfer."""
       file_id: str
       sha256: str = ""

       def to_json(self) -> str:
           d = {"type": "file_complete", "fileId": self.file_id}
           if self.sha256:
               d["sha256"] = self.sha256
           return json.dumps(d)

       @staticmethod
       def from_json(data: str) -> "FileCompleteMessage":
           msg = json.loads(data)
           return FileCompleteMessage(
               file_id=msg["fileId"],
               sha256=msg.get("sha256", ""),
           )
   ```

2. **Compute and send hash in `send_file`** in `file_transfer.py`. After line 92 (`file_data = path.read_bytes()`), compute the hash:
   ```python
   file_hash = hashlib.sha256(file_data).hexdigest()
   ```
   Then at line 129, change the `FileCompleteMessage` construction to:
   ```python
   complete_msg = FileCompleteMessage(file_id=file_id, sha256=file_hash)
   ```

3. **Verify hash on receiver side** in `handle_file_message`. In the `file_complete` case, after computing the hash at line 192, add verification:
   ```python
   sha256 = hashlib.sha256(file_data).hexdigest()
   expected_sha256 = msg.get("sha256", "")
   if expected_sha256 and sha256 != expected_sha256:
       logger.error(
           "File hash mismatch for %s: expected %s, got %s",
           file_id, expected_sha256, sha256,
       )
       # Clean up the failed transfer
       del self._incoming[file_id]
       if save_path.exists():
           save_path.unlink()
       return
   ```
   Move the `save_path.write_bytes(file_data)` call (line 189) to after the hash verification to avoid writing a corrupt file.

## Testing

- Unit test: Send a file and verify the `FileCompleteMessage` contains the correct SHA-256 hash.
- Unit test: Simulate a corrupted transfer (modify a chunk after encryption) and verify the receiver rejects the file.
- Integration test: End-to-end file transfer and verify the saved file hash matches the original.
- Backward compatibility: Verify that a `file_complete` message without a `sha256` field is accepted (graceful degradation).

## Risk Assessment

- Adding an optional `sha256` field is backward-compatible. Old senders that don't include it will still work (the verification is skipped when `expected_sha256` is empty).
- Computing SHA-256 on the sender side is fast for typical file sizes. For very large files (GB+), this adds latency before the transfer starts, but file_data is already fully loaded into memory anyway.
- The hash is computed over the reassembled plaintext data, not the encrypted chunks. This correctly protects against reassembly errors.
