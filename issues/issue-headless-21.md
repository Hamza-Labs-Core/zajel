# [MEDIUM] No authentication on daemon UNIX socket commands

**Area**: Headless Client
**File**: packages/headless-client/zajel/cli/daemon.py:27-88
**Type**: Security

**Description**: The daemon's `handle_connection` function processes any command from any connection to the UNIX socket with no authentication, authorization, or rate limiting. Combined with the world-accessible socket path (issue-headless-01), any connected client can:
- Execute any command in the `COMMANDS` dispatch table
- Read all messages, peers, groups, channels
- Send messages as the authenticated user
- Pair with new peers
- Transfer files
- Disconnect the daemon

Even if the socket permissions are fixed (issue-headless-01), there is no defense-in-depth. A compromised process running as the same user has full control.

**Impact**: No access control within the daemon protocol. Any process that can connect to the socket has unrestricted access to all daemon functionality.

**Fix**: Implement at minimum:
1. Verify the connecting process UID matches the daemon's UID using `SO_PEERCRED` socket option
2. Optionally implement a simple shared-secret token authentication on connection
3. Add rate limiting for sensitive operations

```python
import struct

async def handle_connection(reader, writer, client, dispatch, shutdown_event):
    # Verify peer credentials (Linux-specific)
    sock = writer.get_extra_info("socket")
    if sock:
        creds = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("iII"))
        pid, uid, gid = struct.unpack("iII", creds)
        if uid != os.getuid():
            logger.warning("Rejecting connection from UID %d (expected %d)", uid, os.getuid())
            writer.close()
            return
    ...
```
