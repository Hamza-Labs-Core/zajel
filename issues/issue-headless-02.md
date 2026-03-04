# [CRITICAL] File path traversal in received file names

**Area**: Headless Client
**File**: packages/headless-client/zajel/file_transfer.py:188
**Type**: Security

**Description**: When a file transfer completes, the received file is saved using the file name provided by the remote peer directly: `save_path = self._receive_dir / transfer.info.file_name`. The `file_name` value comes from the `file_start` message sent by the remote peer (line 149: `file_name=msg["fileName"]`). A malicious peer can set `fileName` to a path-traversal payload such as `../../.ssh/authorized_keys` or `../../../etc/cron.d/evil`, causing the file to be written outside the intended receive directory.

**Impact**: Arbitrary file write. A malicious peer can overwrite any file writable by the daemon process owner, potentially achieving remote code execution (e.g., by overwriting `.bashrc`, `.ssh/authorized_keys`, crontab entries, or Python source files that will be imported).

**Fix**: Sanitize the filename by stripping directory components and rejecting path traversal:

```python
import re

def _sanitize_filename(name: str) -> str:
    # Strip directory components
    basename = os.path.basename(name)
    # Remove any remaining path separators or null bytes
    basename = basename.replace("\0", "")
    # Reject empty or dot-only names
    if not basename or basename in (".", ".."):
        basename = f"unnamed_{uuid.uuid4().hex[:8]}"
    return basename

# In handle_file_message, file_start case:
safe_name = self._sanitize_filename(msg["fileName"])
info = FileTransferProgress(
    file_id=file_id,
    file_name=safe_name,
    ...
)

# Also validate the final path resolves inside receive_dir:
save_path = (self._receive_dir / transfer.info.file_name).resolve()
if not str(save_path).startswith(str(self._receive_dir.resolve())):
    raise ValueError("Path traversal detected in file name")
```
