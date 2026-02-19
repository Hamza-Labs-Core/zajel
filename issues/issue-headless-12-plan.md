# Plan: Plaintext message content logged at INFO level

**Issue**: issue-headless-12.md
**Severity**: MEDIUM
**Area**: Headless Client
**Files to modify**:
- `packages/headless-client/zajel/client.py`

## Analysis

Multiple locations in `client.py` log plaintext message content at INFO level:

1. **Line 356**: `logger.info("Sent message to %s: %s", peer_id, content[:50])` -- logs first 50 chars of every sent P2P message.

2. **Lines 998-1000**: `logger.info("Sent group message to '%s' (%d/%d peers): %s", group.name, sent_count, len(group.other_members), content[:50])` -- logs first 50 chars of every sent group message.

3. **Lines 1206-1211**: `logger.info("Received group message from %s in '%s': %s", from_peer_id, group.name, message.content[:50])` -- logs first 50 chars of every received group message.

For an end-to-end encrypted messaging application, logging plaintext content defeats the purpose of encryption. Log files may be visible to system administrators, monitoring systems, CI runners, or other users on shared systems.

## Fix Steps

1. **Line 356**: Replace content logging with length-only logging:
   ```python
   # Before:
   logger.info("Sent message to %s: %s", peer_id, content[:50])
   # After:
   logger.info("Sent message to %s (%d chars)", peer_id, len(content))
   ```

2. **Lines 998-1000**: Replace content logging with length-only logging:
   ```python
   # Before:
   logger.info(
       "Sent group message to '%s' (%d/%d peers): %s",
       group.name, sent_count, len(group.other_members), content[:50],
   )
   # After:
   logger.info(
       "Sent group message to '%s' (%d/%d peers, %d chars)",
       group.name, sent_count, len(group.other_members), len(content),
   )
   ```

3. **Lines 1206-1211**: Replace content logging with length-only logging:
   ```python
   # Before:
   logger.info(
       "Received group message from %s in '%s': %s",
       from_peer_id,
       group.name,
       message.content[:50],
   )
   # After:
   logger.info(
       "Received group message from %s in '%s' (%d chars)",
       from_peer_id,
       group.name,
       len(message.content),
   )
   ```

4. **Optionally, add DEBUG-level logging** for developers who need to see message content during development:
   ```python
   logger.debug("Message content preview: %s", content[:50])
   ```
   This ensures content is only visible when explicitly running at DEBUG level, and add a comment warning about this:
   ```python
   # WARNING: DEBUG logging exposes plaintext message content
   ```

5. **Audit other log statements** in the file for any additional content leakage. Check for file names, channel content, etc. The channel content logging at line 826-831 logs `payload.content_type` (not content itself), which is fine.

## Testing

- Run the daemon at INFO level and send a message. Verify the log output shows message length but not content.
- Run the daemon at DEBUG level and send a message. If debug logging was added, verify content appears at DEBUG only.
- Run existing E2E tests and verify log output does not contain message content.

## Risk Assessment

- Very low risk. This is a logging-only change with no impact on functionality or protocol.
- Developers who relied on seeing message content in logs can switch to DEBUG level.
- The change improves security posture with zero functional impact.
