# Plan: CLI protocol discards data after first newline in response

**Issue**: issue-headless-36.md
**Severity**: LOW
**Area**: Headless Client
**Files to modify**: `packages/headless-client/zajel/cli/protocol.py`

## Analysis

The `read_response` function at lines 26-39 of `protocol.py` reads until a newline is found, then splits and discards the remainder:

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

The `_` remainder is discarded. In the current request-response protocol, this is acceptable because each CLI connection sends one request and reads one response. However:

1. If the daemon sends unsolicited messages (e.g., notifications), they are lost.
2. If a CLI client pipelines multiple requests (sends several requests before reading responses), subsequent responses are lost because the recv buffer may contain multiple responses.
3. The `buf += chunk` pattern creates a new bytes object each iteration, which is inefficient for large responses.

The corresponding `async_readline` function (lines 49-57) uses `reader.readline()` which is a proper streaming API that does not lose data.

## Fix Steps

1. **Refactor `read_response` to return remaining data** and use `bytearray` for efficiency. Replace lines 26-39:
   ```python
   def read_response(sock: socket.socket, buf: bytearray | None = None) -> tuple[dict, bytearray]:
       """Read a single JSON-line response from a socket.

       Args:
           sock: The socket to read from.
           buf: Optional buffer containing leftover data from a previous read.

       Returns:
           Tuple of (parsed response dict, remaining buffer data).

       Raises:
           ConnectionError: If the socket closes before a complete response.
       """
       if buf is None:
           buf = bytearray()
       while True:
           if b"\n" in buf:
               idx = buf.index(b"\n")
               line = bytes(buf[:idx])
               del buf[:idx + 1]
               return json.loads(line.decode("utf-8")), buf
           chunk = sock.recv(4096)
           if not chunk:
               raise ConnectionError("Socket closed before response received")
           buf.extend(chunk)
   ```

2. **For backward compatibility**, keep a simple wrapper that matches the old signature:
   ```python
   def read_response_simple(sock: socket.socket) -> dict:
       """Read a single JSON-line response (discards any remaining data).

       For simple request-response usage where pipelining is not needed.
       """
       result, _ = read_response(sock)
       return result
   ```

3. **Update callers of `read_response`**. Search for all callers to determine if they need the new signature. Let me check the CLI client code.

   Since the current protocol is strictly one-request-one-response (as evidenced by the daemon's `handle_connection` which processes one request at a time), existing callers can use the simple wrapper or just ignore the second return value:
   ```python
   response, _ = read_response(sock)
   ```

4. **Document the protocol as strictly request-response** in the module docstring. Add a comment explaining that pipelining is not currently supported but the API is ready for it.

## Testing

- Unit test: Send a response with trailing data after the newline, verify the trailing data is preserved in the returned buffer.
- Unit test: Send two responses in a single `recv`, verify both can be read with successive calls (passing the buffer between calls).
- Unit test: Send a response without a newline, verify it waits for more data.
- Unit test: Verify backward compatibility with the simple wrapper.
- Unit test: Verify `ConnectionError` is raised when socket closes mid-response.

## Risk Assessment

- Changing the return type of `read_response` from `dict` to `tuple[dict, bytearray]` is a breaking change for callers. The backward-compatible wrapper mitigates this.
- Using `bytearray` and `del buf[:idx + 1]` is more memory-efficient than creating new `bytes` objects but modifies the buffer in place.
- The current one-request-one-response protocol makes this issue theoretical. However, the fix prepares the codebase for future features like streaming responses or notifications.
- All existing callers of `read_response` need to be updated. Check for CLI client code that calls this function.
