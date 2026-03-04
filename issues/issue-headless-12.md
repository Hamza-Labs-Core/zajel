# [MEDIUM] Plaintext message content logged at INFO level

**Area**: Headless Client
**File**: packages/headless-client/zajel/client.py:356
**Type**: Security

**Description**: Multiple locations log plaintext message content at INFO level:
- Line 356: `logger.info("Sent message to %s: %s", peer_id, content[:50])` -- logs first 50 chars of every sent message
- Line 999-1001: Logs sent group message content (`content[:50]`)
- Line 1209-1211: Logs received group message content (`message.content[:50]`)

These log entries expose plaintext message content to log files, log aggregation systems, and anyone with access to the daemon's stdout/stderr. For an encrypted messaging application, this defeats the purpose of end-to-end encryption.

**Impact**: Message confidentiality is compromised through logging. Log files typically have weaker access controls than encrypted message stores. On shared systems, CI runners, or cloud deployments, log output may be visible to system administrators, monitoring systems, or other users.

**Fix**: Remove message content from log output, or log only at DEBUG level with a warning that debug logging exposes message content:

```python
logger.info("Sent message to %s (%d chars)", peer_id, len(content))
# Or at debug level only:
logger.debug("Sent message to %s: %s", peer_id, content[:50])
```
