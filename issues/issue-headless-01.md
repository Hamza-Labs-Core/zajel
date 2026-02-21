# [CRITICAL] UNIX socket created in /tmp with no permission restrictions

**Area**: Headless Client
**File**: packages/headless-client/zajel/cli/daemon.py:293
**Type**: Security

**Description**: The daemon creates a UNIX domain socket at `/tmp/zajel-headless-<name>.sock` using `asyncio.start_unix_server(on_connection, path=socket_path)` without setting restrictive file permissions. On a multi-user system, the default umask (typically 0o022) means the socket file will be world-readable and potentially world-writable. Any local user can connect to the socket and issue commands -- including sending messages as the authenticated user, reading messages, accessing private keys, disconnecting the session, or performing any operation the daemon exposes.

**Impact**: Local privilege escalation. Any unprivileged user on the same machine can fully control the messaging client: read decrypted messages, send messages on behalf of the user, pair with arbitrary peers, access cryptographic keys, transfer files, and disconnect the session. This completely breaks the security model of the encrypted P2P messaging app for any shared system (CI runners, containers, dev servers).

**Fix**: Set socket file permissions to `0o600` (owner-only) immediately after creation. Additionally, consider using `XDG_RUNTIME_DIR` (which is per-user and already permission-restricted) instead of `/tmp`:

```python
server = await asyncio.start_unix_server(on_connection, path=socket_path)
os.chmod(socket_path, 0o600)
```

For `default_socket_path`, use:
```python
def default_socket_path(name: str = "default") -> str:
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR", "/tmp")
    return os.path.join(runtime_dir, f"zajel-headless-{name}.sock")
```
