# [MEDIUM] send_file CLI command passes arbitrary file paths without validation

**Area**: Headless Client
**File**: packages/headless-client/zajel/cli/daemon.py:201-203
**Type**: Security

**Description**: The `cmd_send_file` handler passes the `file_path` argument directly from the CLI client to `client.send_file()`:

```python
async def cmd_send_file(client: ZajelHeadlessClient, args: dict):
    file_id = await client.send_file(args["peer_id"], args["file_path"])
```

The `send_file` method in `file_transfer.py` reads the file at the given path with no restrictions. A CLI user (or a malicious process connecting to the daemon socket) can read and exfiltrate any file readable by the daemon process:
- `/etc/shadow` (if daemon runs as root)
- `~/.ssh/id_rsa`
- The SQLite database containing session keys
- Any other sensitive file on the system

Since the file content is encrypted and sent to a peer, this is essentially a "read any local file and send it to a remote peer" primitive.

**Impact**: Arbitrary file read and exfiltration. Combined with the socket permission issue (issue-headless-01), any local user can read any file the daemon can access and send it to a remote peer they control.

**Fix**: Restrict file transfers to an allowed directory:

```python
async def cmd_send_file(client: ZajelHeadlessClient, args: dict):
    file_path = Path(args["file_path"]).resolve()
    allowed_dir = Path(client.media_dir).resolve()
    if not str(file_path).startswith(str(allowed_dir)):
        raise ValueError(f"File must be within {allowed_dir}")
    file_id = await client.send_file(args["peer_id"], str(file_path))
```
