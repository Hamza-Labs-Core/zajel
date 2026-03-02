# [MEDIUM] Exception details leaked to CLI clients in error responses

**Area**: Headless Client
**File**: packages/headless-client/zajel/cli/daemon.py:67-72
**Type**: Security

**Description**: When a command handler raises an exception, the full exception message is sent back to the CLI client:

```python
except Exception as e:
    logger.error("Command %s failed: %s", cmd, e, exc_info=True)
    await async_send(writer, {
        "id": req_id,
        "error": str(e),
    })
```

Python exception messages can contain sensitive information including:
- File paths on the system
- Database connection strings
- Internal state details
- Stack trace information (though `str(e)` only gets the message, not the full traceback)

For example, `RuntimeError(f"No session key for peer {peer_id}")` leaks peer IDs, and `FileNotFoundError` leaks file paths.

**Impact**: Information disclosure. Internal error details help attackers understand the system's internals, file structure, and state. While this is a local socket (so the attacker already has some system access), defense-in-depth principles dictate minimal information disclosure.

**Fix**: Return generic error messages and keep detailed errors in server logs only:

```python
except Exception as e:
    error_id = str(uuid.uuid4())[:8]
    logger.error("Command %s failed [%s]: %s", cmd, error_id, e, exc_info=True)
    await async_send(writer, {
        "id": req_id,
        "error": f"Command failed (ref: {error_id})",
    })
```

Alternatively, categorize errors into user-facing classes:
```python
except KeyError as e:
    await async_send(writer, {"id": req_id, "error": f"Missing required argument: {e}"})
except RuntimeError as e:
    await async_send(writer, {"id": req_id, "error": str(e)})  # These are intentional user messages
except Exception:
    await async_send(writer, {"id": req_id, "error": "Internal error"})
```
