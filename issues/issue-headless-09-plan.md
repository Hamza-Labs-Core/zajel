# Plan: No size limits on incoming daemon socket messages enables memory exhaustion

**Issue**: issue-headless-09.md
**Severity**: HIGH
**Area**: Headless Client
**Files to modify**:
- `packages/headless-client/zajel/cli/protocol.py`

## Analysis

In `protocol.py:49-57`, the `async_readline` function reads from the socket using `reader.readline()` with no maximum line length:

```python
async def async_readline(reader) -> str | None:
    line = await reader.readline()
    if not line:
        return None
    return line.decode("utf-8").strip()
```

The `read_response` function at lines 26-39 similarly accumulates data into `buf` without any size limit:

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

A malicious client (or a compromised process with access to the socket) can send an arbitrarily large message without a newline, causing unbounded memory consumption.

Note: `asyncio.StreamReader.readline()` has a default limit of 64 KiB (`_DEFAULT_LIMIT = 2 ** 16`), after which it raises `asyncio.LimitOverrunError`. So the async side has a default protection, but it is not explicitly configured and the error is not handled. The sync `read_response` has no protection at all.

## Fix Steps

1. **Define a maximum message size constant** at the top of `protocol.py`:
   ```python
   MAX_MESSAGE_SIZE = 1024 * 1024  # 1 MB
   ```

2. **Update `async_readline` at line 49-57** to enforce a size limit and handle `LimitOverrunError`:
   ```python
   async def async_readline(reader) -> str | None:
       """Read a single line from an asyncio StreamReader.

       Returns None on EOF.
       Raises ValueError if the line exceeds MAX_MESSAGE_SIZE.
       """
       try:
           line = await reader.readline()
       except asyncio.LimitOverrunError:
           raise ValueError(
               f"Message exceeds maximum size ({MAX_MESSAGE_SIZE} bytes)"
           )
       if not line:
           return None
       if len(line) > MAX_MESSAGE_SIZE:
           raise ValueError(
               f"Message exceeds maximum size ({MAX_MESSAGE_SIZE} bytes)"
           )
       return line.decode("utf-8").strip()
   ```

3. **Update `read_response` at line 26-39** to enforce a size limit:
   ```python
   def read_response(sock: socket.socket) -> dict:
       buf = b""
       while True:
           chunk = sock.recv(4096)
           if not chunk:
               raise ConnectionError("Socket closed before response received")
           buf += chunk
           if len(buf) > MAX_MESSAGE_SIZE:
               raise ValueError(
                   f"Response exceeds maximum size ({MAX_MESSAGE_SIZE} bytes)"
               )
           if b"\n" in buf:
               line, _ = buf.split(b"\n", 1)
               return json.loads(line.decode("utf-8"))
   ```

4. **Handle the error in `daemon.py`** at the connection handler (`handle_connection`, line 38-41). The `async_readline` call at line 39 should catch `ValueError` and send an error response:
   ```python
   try:
       line = await async_readline(reader)
   except ValueError as e:
       await async_send(writer, {"error": str(e)})
       break
   ```

5. **Add `import asyncio`** to `protocol.py` if not already imported (checking: it is not imported -- but `async_readline` and `async_send` are async functions. They work because they are coroutines, but `asyncio.LimitOverrunError` needs the import). Add the import.

## Testing

- Unit test: Send a message larger than 1 MB to `read_response` and verify `ValueError` is raised.
- Unit test: Send a message larger than 1 MB to `async_readline` and verify `ValueError` is raised.
- Unit test: Verify normal-sized messages (under 1 MB) still work correctly.
- Integration test: Connect to the daemon socket and send a large payload; verify the daemon does not crash.
- Run existing E2E tests to confirm no regressions.

## Risk Assessment

- Very low risk. The 1 MB limit is generous for JSON-line protocol messages (typical commands are a few KB).
- File transfer commands do not go through the daemon socket (they use WebRTC data channels), so the limit does not affect file transfers.
- The only concern is if channel content or group invitations with many members exceed 1 MB in the serialized form. This is extremely unlikely given the 15-member group limit and typical message sizes.
