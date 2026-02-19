# [HIGH] No size limits on incoming daemon socket messages enables memory exhaustion

**Area**: Headless Client
**File**: packages/headless-client/zajel/cli/protocol.py:49-57
**Type**: Security

**Description**: The `async_readline` function reads from the socket using `reader.readline()` with no maximum line length. The `read_response` function similarly reads in a loop with `sock.recv(4096)` and accumulates into `buf` with no size limit. A malicious or buggy client can send an arbitrarily large line (gigabytes of data without a newline) causing the daemon to consume unbounded memory.

Similarly, on the client side, `read_response` accumulates data in `buf` indefinitely until a newline is found.

**Impact**: Denial of service. A malicious local user (or compromised CLI client) can crash the daemon by sending a very large message, consuming all available memory.

**Fix**: Set a maximum line length and reject messages that exceed it:

```python
MAX_LINE_LENGTH = 1024 * 1024  # 1 MB

async def async_readline(reader, max_length=MAX_LINE_LENGTH) -> str | None:
    line = await reader.readline()
    if not line:
        return None
    if len(line) > max_length:
        raise ValueError(f"Line exceeds maximum length ({max_length})")
    return line.decode("utf-8").strip()

def read_response(sock: socket.socket, max_length=MAX_LINE_LENGTH) -> dict:
    buf = b""
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("Socket closed before response received")
        buf += chunk
        if len(buf) > max_length:
            raise ValueError(f"Response exceeds maximum length ({max_length})")
        if b"\n" in buf:
            line, _ = buf.split(b"\n", 1)
            return json.loads(line.decode("utf-8"))
```
