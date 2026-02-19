# [LOW] CLI protocol discards data after first newline in response

**Area**: Headless Client
**File**: packages/headless-client/zajel/cli/protocol.py:26-39
**Type**: Bug

**Description**: The `read_response` function reads until a newline is found, then splits and returns only the first line:

```python
def read_response(sock: socket.socket) -> dict:
    buf = b""
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("Socket closed before response received")
        buf += chunk
        if b"\n" in buf:
            line, _ = buf.split(b"\n", 1)
            return json.loads(line.decode("utf-8"))
```

The remainder after the newline (`_`) is discarded. If the daemon sends multiple JSON-line responses (e.g., for streaming or due to a race condition), only the first is processed. This is also a concern for pipelining: if a CLI client sends multiple requests before reading responses, subsequent responses are lost.

**Impact**: If the protocol ever needs to support streaming responses or if the daemon sends unsolicited notifications, they will be silently dropped. This is a minor issue with the current request-response protocol but will become a problem if the protocol evolves.

**Fix**: Return any remaining data so the caller can process subsequent messages, or document that the protocol is strictly one-request-one-response:

```python
def read_response(sock: socket.socket, buf: bytearray = None) -> tuple[dict, bytes]:
    if buf is None:
        buf = bytearray()
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("Socket closed before response received")
        buf.extend(chunk)
        if b"\n" in buf:
            line, remaining = buf.split(b"\n", 1)
            return json.loads(line.decode("utf-8")), bytes(remaining)
```
