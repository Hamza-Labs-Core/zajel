# [HIGH] Daemon socket path uses unsanitized name enabling symlink attacks

**Area**: Headless Client
**File**: packages/headless-client/zajel/cli/protocol.py:16-17
**Type**: Security

**Description**: The `default_socket_path` function constructs the socket path as `/tmp/zajel-headless-{name}.sock` where `name` comes from the `--name` CLI argument. There is no validation of the `name` parameter. A malicious value like `../../etc/something` could cause the socket to be created at an unexpected location. More critically, in the daemon (line 285-286), if a file already exists at the socket path, it is unconditionally deleted with `os.unlink(socket_path)`.

In `/tmp`, this is vulnerable to symlink attacks: an attacker creates a symlink at `/tmp/zajel-headless-myname.sock` pointing to a target file. When the daemon starts, it calls `os.unlink()` on the symlink, which deletes the target file. Then `asyncio.start_unix_server` creates a new socket at that path.

**Impact**:
1. Arbitrary file deletion via symlink race: An attacker can trick the daemon into deleting any file the daemon user has write access to.
2. With path traversal in the name parameter, the socket or file operations could target unintended locations.

**Fix**:
1. Sanitize the name parameter to only allow alphanumeric characters and hyphens.
2. Before unlinking, verify the path is a socket (not a symlink to something else).
3. Use `XDG_RUNTIME_DIR` instead of `/tmp`.

```python
import re
import stat

def default_socket_path(name: str = "default") -> str:
    if not re.match(r'^[a-zA-Z0-9_-]+$', name):
        raise ValueError(f"Invalid daemon name: {name}")
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR", "/tmp")
    return os.path.join(runtime_dir, f"zajel-headless-{name}.sock")

# Before unlinking in daemon.py:
if os.path.exists(socket_path):
    st = os.lstat(socket_path)
    if stat.S_ISSOCK(st.st_mode):
        os.unlink(socket_path)
    else:
        raise RuntimeError(f"Path exists and is not a socket: {socket_path}")
```
