# Plan: UNIX socket created in /tmp with no permission restrictions

**Issue**: issue-headless-01.md
**Severity**: CRITICAL
**Area**: Headless Client
**Files to modify**:
- `packages/headless-client/zajel/cli/daemon.py`
- `packages/headless-client/zajel/cli/protocol.py`

## Analysis

The daemon creates a UNIX domain socket in `/tmp` via `asyncio.start_unix_server(on_connection, path=socket_path)` at `daemon.py:293`. After creation, no `os.chmod()` call restricts the socket file permissions. The default umask (typically `0o022`) means the socket is world-readable and potentially world-writable. Any local user can connect and issue commands.

Additionally, `protocol.py:16-17` defines `default_socket_path()` which hardcodes `/tmp` as the socket directory. This is a suboptimal location because `/tmp` is world-writable and shared among all users.

Current code at `daemon.py:293`:
```python
server = await asyncio.start_unix_server(on_connection, path=socket_path)
```

No permission restriction follows this line.

## Fix Steps

1. **In `daemon.py:293`**: Immediately after `asyncio.start_unix_server()`, add `os.chmod(socket_path, 0o600)` to restrict the socket to owner-only read/write:
   ```python
   server = await asyncio.start_unix_server(on_connection, path=socket_path)
   os.chmod(socket_path, 0o600)
   ```

2. **In `protocol.py:15-17`**: Update `default_socket_path()` to prefer `XDG_RUNTIME_DIR` over `/tmp`. `XDG_RUNTIME_DIR` (e.g., `/run/user/<uid>`) is per-user and already permission-restricted on most Linux systems:
   ```python
   def default_socket_path(name: str = "default") -> str:
       runtime_dir = os.environ.get("XDG_RUNTIME_DIR", "/tmp")
       return os.path.join(runtime_dir, f"zajel-headless-{name}.sock")
   ```

3. **In `daemon.py`**: Add a log message after setting permissions confirming the socket is secured:
   ```python
   logger.info("Socket permissions set to 0600 on %s", socket_path)
   ```

## Testing

- Run the daemon and verify the socket file permissions using `ls -la` on the socket path. It should show `srw-------` (owner-only).
- On a system with `XDG_RUNTIME_DIR` set, verify the socket is created in that directory instead of `/tmp`.
- Verify that a different user on the same system cannot connect to the socket (gets "Permission denied").
- Run the existing E2E tests to confirm no regressions in daemon-CLI communication.

## Risk Assessment

- Low risk. `os.chmod()` after `asyncio.start_unix_server()` has a tiny race window between socket creation and permission setting. This is acceptable for most environments but could be further mitigated by setting a restrictive umask before socket creation and restoring it afterward.
- Changing the default socket path from `/tmp` to `XDG_RUNTIME_DIR` could affect environments where `XDG_RUNTIME_DIR` is not set. The fallback to `/tmp` handles this case.
- Existing tests using hardcoded `/tmp` paths in `--socket-path` arguments will continue to work since the custom path overrides the default.
