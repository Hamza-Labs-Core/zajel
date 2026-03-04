# Plan: File path traversal in received file names

**Issue**: issue-headless-02.md
**Severity**: CRITICAL
**Area**: Headless Client
**Files to modify**:
- `packages/headless-client/zajel/file_transfer.py`

## Analysis

In `file_transfer.py:188`, the received file is saved using the unsanitized `file_name` from the remote peer:
```python
save_path = self._receive_dir / transfer.info.file_name
save_path.write_bytes(file_data)
```

The `file_name` is assigned at line 149 directly from the incoming message:
```python
file_name=msg["fileName"],
```

A malicious peer can set `fileName` to `../../.ssh/authorized_keys` or similar path-traversal payloads, writing files outside the intended `receive_dir`. The `pathlib` `/` operator does not strip directory components or reject traversal sequences.

## Fix Steps

1. **Add a `_sanitize_filename` static method to `FileTransferService`** (after line 69):
   ```python
   @staticmethod
   def _sanitize_filename(name: str) -> str:
       """Strip directory components and reject path traversal."""
       # Use os.path.basename to strip all directory parts
       basename = os.path.basename(name)
       # Remove null bytes
       basename = basename.replace("\0", "")
       # Reject empty or dot-only names
       if not basename or basename in (".", ".."):
           basename = f"unnamed_{uuid.uuid4().hex[:8]}"
       return basename
   ```

2. **Sanitize the filename in `handle_file_message` at line 149** when creating the `FileTransferProgress`:
   ```python
   if msg_type == "file_start":
       file_id = msg["fileId"]
       safe_name = self._sanitize_filename(msg["fileName"])
       info = FileTransferProgress(
           file_id=file_id,
           file_name=safe_name,
           total_size=msg["totalSize"],
           total_chunks=msg["totalChunks"],
       )
   ```

3. **Add path-resolution validation at line 188** before writing the file:
   ```python
   save_path = (self._receive_dir / transfer.info.file_name).resolve()
   if not str(save_path).startswith(str(self._receive_dir.resolve())):
       logger.error(
           "Path traversal detected in file name: %s",
           transfer.info.file_name,
       )
       return
   save_path.write_bytes(file_data)
   ```

This is defense-in-depth: `_sanitize_filename` strips directory components, and the path-resolution check catches any edge cases.

## Testing

- Unit test: Call `_sanitize_filename("../../etc/passwd")` and verify it returns `"passwd"`.
- Unit test: Call `_sanitize_filename("../../../.ssh/authorized_keys")` and verify it returns `"authorized_keys"`.
- Unit test: Call `_sanitize_filename("")` and verify it returns a generated name like `"unnamed_<hex>"`.
- Unit test: Call `_sanitize_filename(".")` and `_sanitize_filename("..")` and verify they return generated names.
- Integration test: Simulate a file transfer with a traversal path and verify the file is saved inside `receive_dir` only.
- Run existing file transfer E2E tests to ensure no regression.

## Risk Assessment

- Very low risk. Stripping directory components and validating resolved paths are standard security practices.
- If a remote peer sends a file with the same basename as an existing file in `receive_dir`, it will overwrite it. This is pre-existing behavior and not a security concern (the directory is under the daemon user's control).
- No protocol changes needed; this is purely a local validation fix.
