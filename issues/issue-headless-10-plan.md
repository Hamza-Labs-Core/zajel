# Plan: Daemon socket path uses unsanitized name enabling symlink attacks

**Issue**: issue-headless-10.md
**Severity**: HIGH
**Area**: Headless Client
**Files to modify**:
- `packages/headless-client/zajel/cli/protocol.py`
- `packages/headless-client/zajel/cli/daemon.py`

## Analysis

At `protocol.py:15-17`, the `default_socket_path` function constructs the socket path using the unsanitized `name` parameter:

```python
def default_socket_path(name: str = "default") -> str:
    return f"/tmp/zajel-headless-{name}.sock"
```

There is no validation of the `name` parameter. A value like `../../etc/something` could target unintended locations.

At `daemon.py:284-286`, the daemon unconditionally deletes the file at the socket path before creating the server:

```python
if os.path.exists(socket_path):
    os.unlink(socket_path)
```

This is vulnerable to symlink attacks: an attacker creates a symlink at the socket path pointing to a target file. When the daemon starts, it calls `os.unlink()` on the symlink, deleting the target file.

The cleanup at `daemon.py:312-313` has the same vulnerability:
```python
if os.path.exists(socket_path):
    os.unlink(socket_path)
```

## Fix Steps

1. **Sanitize the name parameter** in `default_socket_path` at `protocol.py:15-17`:
   ```python
   import re

   def default_socket_path(name: str = "default") -> str:
       """Return the default UNIX socket path for a given daemon name."""
       if not re.match(r'^[a-zA-Z0-9_-]+$', name):
           raise ValueError(
               f"Invalid daemon name '{name}': "
               "only alphanumeric characters, hyphens, and underscores allowed"
           )
       runtime_dir = os.environ.get("XDG_RUNTIME_DIR", "/tmp")
       return os.path.join(runtime_dir, f"zajel-headless-{name}.sock")
   ```

2. **Add `import re`** at the top of `protocol.py`.

3. **Add safe socket cleanup** in `daemon.py:284-286`. Replace the unconditional `os.unlink()` with a check that the path is a socket (not a symlink to something else):
   ```python
   import stat

   # Clean up stale socket file
   if os.path.exists(socket_path):
       try:
           st = os.lstat(socket_path)  # lstat does NOT follow symlinks
           if stat.S_ISSOCK(st.st_mode):
               os.unlink(socket_path)
           else:
               raise RuntimeError(
                   f"Path exists and is not a socket: {socket_path} "
                   f"(mode: {oct(st.st_mode)}). Remove it manually."
               )
       except OSError as e:
           raise RuntimeError(
               f"Cannot inspect socket path {socket_path}: {e}"
           ) from e
   ```

4. **Apply the same safe cleanup** at `daemon.py:312-313` (shutdown cleanup):
   ```python
   if os.path.exists(socket_path):
       try:
           st = os.lstat(socket_path)
           if stat.S_ISSOCK(st.st_mode):
               os.unlink(socket_path)
       except OSError:
           pass  # Best effort cleanup on shutdown
   ```

5. **Add `import stat`** to `daemon.py`.

## Testing

- Unit test: Verify `default_socket_path("valid-name_123")` returns a valid path.
- Unit test: Verify `default_socket_path("../../etc/evil")` raises `ValueError`.
- Unit test: Verify `default_socket_path("")` raises `ValueError`.
- Unit test: Verify `default_socket_path("name with spaces")` raises `ValueError`.
- Integration test: Create a symlink at the socket path, start the daemon, and verify it refuses to unlink the symlink (raises `RuntimeError`).
- Run existing E2E tests to confirm no regressions.

## Risk Assessment

- Low risk. The name validation restricts valid daemon names to alphanumeric, hyphens, and underscores, which covers all reasonable use cases.
- The `lstat` + `S_ISSOCK` check prevents the symlink attack. The daemon will refuse to start if a non-socket file exists at the path, which is the correct behavior.
- Combined with issue-headless-01 (using `XDG_RUNTIME_DIR`), this significantly reduces the attack surface on the socket path.
- There is a TOCTOU race between `lstat` and `unlink`, but exploiting it requires the attacker to replace the socket file between the two calls, which is a very narrow window and requires write access to the directory.
