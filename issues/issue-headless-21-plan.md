# Plan: No authentication on daemon UNIX socket commands

**Issue**: issue-headless-21.md
**Severity**: MEDIUM
**Area**: Headless Client
**Files to modify**: `packages/headless-client/zajel/cli/daemon.py`

## Analysis

The `handle_connection` function at line 27-88 of `daemon.py` processes any command from any connection to the UNIX socket with zero authentication. The function reads JSON requests, looks up the command in the `COMMANDS` dispatch table (line 53), and executes it unconditionally. There is no peer credential verification at any point -- the only information captured about the caller is `writer.get_extra_info("peername")` at line 35, which is logged but not used for access control.

The `COMMANDS` dict (lines 237-263) contains 24 commands including sensitive operations like `send_text`, `pair_with`, `send_file`, `block_peer`, and `disconnect`. Any process that can connect to the UNIX socket has unrestricted access to all of these.

The `run_daemon` function (line 266) creates the server socket at line 293 via `asyncio.start_unix_server` with no socket permission restrictions, and the socket path defaults to `/tmp/zajel-headless-<name>.sock` (from `protocol.py` line 17).

## Fix Steps

1. **Add `import struct` and `import socket` to daemon.py imports** (line 12 area). The `socket` module is needed for `SOL_SOCKET` and `SO_PEERCRED` constants; `struct` is needed to unpack the credentials structure.

2. **Create a peer credential verification function** before `handle_connection`:
   ```python
   def _verify_peer_uid(writer: asyncio.StreamWriter) -> bool:
       """Verify the connecting process runs as the same UID as the daemon.

       Uses SO_PEERCRED (Linux) to get the peer's PID, UID, and GID.
       Returns True if the UID matches or if credential checking is unavailable.
       """
       sock = writer.get_extra_info("socket")
       if sock is None:
           logger.warning("Cannot verify peer credentials: no socket info")
           return False
       try:
           creds = sock.getsockopt(
               socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("iII")
           )
           pid, uid, gid = struct.unpack("iII", creds)
           if uid != os.getuid():
               logger.warning(
                   "Rejecting connection from UID %d (pid %d), expected UID %d",
                   uid, pid, os.getuid(),
               )
               return False
           logger.debug("Accepted connection from UID %d (pid %d)", uid, pid)
           return True
       except (OSError, AttributeError):
           # SO_PEERCRED not available (non-Linux) -- log and allow
           logger.warning("SO_PEERCRED not available; skipping UID check")
           return True
   ```

3. **Add UID check at the start of `handle_connection`** (after line 36, before the `try/while` block):
   ```python
   if not _verify_peer_uid(writer):
       writer.close()
       try:
           await writer.wait_closed()
       except Exception:
           pass
       return
   ```

4. **Set socket file permissions in `run_daemon`** after the `asyncio.start_unix_server` call at line 293. Add:
   ```python
   os.chmod(socket_path, 0o600)  # Owner-only read/write
   ```

## Testing

- Unit test: Mock a `StreamWriter` with a socket that returns crafted `SO_PEERCRED` data for a mismatched UID and verify the connection is rejected.
- Unit test: Mock a matching UID and verify the connection proceeds.
- Integration test: Start the daemon and verify that connecting from the same user works while connecting from a different user is rejected (requires multi-user test environment).
- Verify on macOS/non-Linux that the fallback path (allow with warning) works correctly.

## Risk Assessment

- `SO_PEERCRED` is Linux-specific. On macOS, `LOCAL_PEERCRED` would be needed. The fallback to allowing connections with a warning is a reasonable tradeoff.
- The `struct.calcsize("iII")` format assumes the standard Linux `ucred` struct layout (pid as int, uid and gid as unsigned int). This is stable across Linux versions.
- Adding `os.chmod(socket_path, 0o600)` could break existing workflows where multiple users share the socket intentionally, but this is unlikely for a headless client daemon.
