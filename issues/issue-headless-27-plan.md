# Plan: Exception details leaked to CLI clients in error responses

**Issue**: issue-headless-27.md
**Severity**: MEDIUM
**Area**: Headless Client
**Files to modify**: `packages/headless-client/zajel/cli/daemon.py`

## Analysis

In `daemon.py`, the exception handler at lines 67-72 sends the full exception message back to the CLI client:

```python
except Exception as e:
    logger.error("Command %s failed: %s", cmd, e, exc_info=True)
    await async_send(writer, {
        "id": req_id,
        "error": str(e),
    })
```

Python exception messages can contain sensitive information. For example:
- `RuntimeError(f"No session key for peer {peer_id}")` from `crypto.py` line 105 leaks the peer ID.
- `FileNotFoundError(f"File not found: {file_path}")` from `file_transfer.py` line 90 leaks the full file path.
- `RuntimeError(f"Group not found: {group_id}")` from `client.py` line 911 leaks the group ID.
- Database errors could leak connection strings or schema details.

The detailed error is already logged server-side with `exc_info=True` (which includes the full traceback in the log), so the CLI client does not need the raw exception string for debugging.

## Fix Steps

1. **Create a custom exception class for user-facing errors** at the top of `daemon.py` (after line 24):
   ```python
   class UserFacingError(Exception):
       """Exception whose message is safe to return to CLI clients."""
       pass
   ```

2. **Replace the catch-all error handler** at lines 67-72 with a tiered approach:
   ```python
   except KeyError as e:
       error_id = uuid.uuid4().hex[:8]
       logger.error("Command %s failed [%s]: missing key %s", cmd, error_id, e, exc_info=True)
       await async_send(writer, {
           "id": req_id,
           "error": f"Missing required argument: {e}",
       })
   except (ValueError, UserFacingError) as e:
       error_id = uuid.uuid4().hex[:8]
       logger.error("Command %s failed [%s]: %s", cmd, error_id, e, exc_info=True)
       await async_send(writer, {
           "id": req_id,
           "error": str(e),
       })
   except Exception as e:
       error_id = uuid.uuid4().hex[:8]
       logger.error("Command %s failed [%s]: %s", cmd, error_id, e, exc_info=True)
       await async_send(writer, {
           "id": req_id,
           "error": f"Internal error (ref: {error_id}). Check daemon logs.",
       })
   ```

3. **The `uuid` module is already imported** at line 18, so `uuid.uuid4().hex[:8]` is available.

4. **Review and convert known safe `RuntimeError` messages** to `UserFacingError` where appropriate. For example, in `client.py`:
   - "Not connected to peer {peer_id}" -- this leaks peer_id but is needed for user debugging. Keep as is but consider sanitizing.
   - "File transfer not initialized (not connected)" -- safe, no sensitive data.
   - "Group not found: {group_id}" -- leaks group_id but the user sent it, so it is safe.

   For now, let `RuntimeError` fall into the generic `Exception` handler. If specific `RuntimeError` messages should be user-visible, convert them to `UserFacingError` in the command handlers.

## Testing

- Unit test: Trigger a `KeyError` (missing argument) and verify the error response contains `"Missing required argument"`.
- Unit test: Trigger a `ValueError` and verify the error response contains the value error message.
- Unit test: Trigger a generic `Exception` (e.g., `OSError`) and verify the error response is generic with a reference ID.
- Unit test: Verify the reference ID in the error response matches the one in the log output.
- Integration test: Send a malformed command and verify no internal paths or state are leaked.

## Risk Assessment

- The tiered approach is more complex than the original catch-all but provides better security and user experience.
- `KeyError` messages for missing dict keys are safe to expose since they contain the key name that the user should have provided.
- `ValueError` messages may sometimes contain sensitive data (e.g., if a downstream library raises a `ValueError` with path info). Review each case.
- The error reference ID allows correlation between user reports and server logs, which aids debugging without exposing details.
