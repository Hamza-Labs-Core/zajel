# Plan: send_file CLI command passes arbitrary file paths without validation

**Issue**: issue-headless-26.md
**Severity**: MEDIUM
**Area**: Headless Client
**Files to modify**: `packages/headless-client/zajel/cli/daemon.py`, `packages/headless-client/zajel/file_transfer.py`

## Analysis

The `cmd_send_file` handler at lines 201-203 of `daemon.py` passes the `file_path` argument directly to `client.send_file`:

```python
async def cmd_send_file(client: ZajelHeadlessClient, args: dict):
    file_id = await client.send_file(args["peer_id"], args["file_path"])
    return {"file_id": file_id}
```

`client.send_file` at lines 492-500 of `client.py` delegates to `self._file_transfer.send_file(peer_id, file_path)`.

`FileTransferService.send_file` at lines 72-134 of `file_transfer.py` reads the file at line 92:
```python
path = Path(file_path)
if not path.exists():
    raise FileNotFoundError(f"File not found: {file_path}")
file_data = path.read_bytes()
```

There is no restriction on which files can be read. A malicious CLI client (or any process that can connect to the daemon socket) can read any file the daemon process can access and exfiltrate it by sending it to a peer. Examples: `/etc/passwd`, `~/.ssh/id_rsa`, the SQLite database itself.

The client has a `media_dir` attribute (line 136 of `client.py`, defaults to `./test_media`) and a `receive_dir` attribute (line 137, defaults to `./received_files`). File sends should be restricted to an allowed directory.

## Fix Steps

1. **Add path validation in `cmd_send_file` in `daemon.py`** (lines 201-203):
   ```python
   async def cmd_send_file(client: ZajelHeadlessClient, args: dict):
       file_path = Path(args["file_path"]).resolve()
       allowed_dir = Path(client.media_dir).resolve()
       if not file_path.is_relative_to(allowed_dir):
           raise ValueError(
               f"File path must be within the media directory: {allowed_dir}"
           )
       file_id = await client.send_file(args["peer_id"], str(file_path))
       return {"file_id": file_id}
   ```
   Note: `Path.is_relative_to()` is available in Python 3.9+. If earlier Python support is needed, use `str(file_path).startswith(str(allowed_dir) + os.sep)`.

2. **Add `from pathlib import Path` import to `daemon.py`** (it is not currently imported).

3. **Also add validation in `FileTransferService.send_file`** as defense-in-depth (lines 88-90 of `file_transfer.py`):
   ```python
   path = Path(file_path).resolve()
   if not path.exists():
       raise FileNotFoundError(f"File not found: {file_path}")
   # Restrict to receive_dir parent to prevent arbitrary file reads
   allowed = self._receive_dir.resolve().parent
   if not path.is_relative_to(allowed):
       raise ValueError(f"File path not within allowed directory: {allowed}")
   ```

4. **Consider also validating file size** to prevent the daemon from reading extremely large files into memory. Add a max file size check after line 92:
   ```python
   MAX_FILE_SIZE = 100 * 1024 * 1024  # 100 MB
   if len(file_data) > MAX_FILE_SIZE:
       raise ValueError(f"File too large: {len(file_data)} bytes (max {MAX_FILE_SIZE})")
   ```

## Testing

- Unit test: Verify that `cmd_send_file` with a path inside `media_dir` succeeds.
- Unit test: Verify that `cmd_send_file` with `/etc/passwd` raises `ValueError`.
- Unit test: Verify that `cmd_send_file` with `../../etc/passwd` (path traversal) raises `ValueError`.
- Unit test: Verify that symlinks pointing outside `media_dir` are rejected (since `resolve()` follows symlinks).

## Risk Assessment

- `Path.is_relative_to()` requires Python 3.9+. The project should document this minimum version requirement, or use a string prefix comparison as fallback.
- Using `resolve()` follows symlinks, which is the correct behavior -- a symlink inside `media_dir` that points to `/etc/shadow` should be rejected.
- The validation is applied at the daemon command level, so direct API callers (`client.send_file`) are not restricted. The defense-in-depth validation in `FileTransferService` covers this gap.
- The default `media_dir` is `./test_media` which may not exist. The daemon should ensure this directory exists on startup or make it configurable via CLI args.
