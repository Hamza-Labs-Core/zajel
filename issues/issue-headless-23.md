# [MEDIUM] Group message sequence numbers not validated for gaps or replays

**Area**: Headless Client
**File**: packages/headless-client/zajel/client.py:1019-1056 and packages/headless-client/zajel/groups.py:300-306
**Type**: Security

**Description**: Group messages use a sequence number (`sequence_number`) for ordering, and duplicate detection uses the message ID (which is `author_device_id:sequence_number`). However:

1. The sequence number in the outgoing path is generated locally via `get_next_sequence` (incrementing counter), but the incoming path has no validation that sequence numbers are monotonically increasing from a given author.
2. A malicious peer could forge a message with an arbitrary sequence number (e.g., a very high number to "skip" messages, or a negative number).
3. The `is_duplicate` check (line 1034) prevents replays of the exact same `author_device_id:sequence_number` pair, but a malicious peer could send multiple messages with different sequence numbers from the "same" author if they have the sender key.

The duplicate detection iterates over all messages for a group (`any(m.id == message_id for m in msgs)`), which is O(n) and becomes expensive as message count grows.

**Impact**:
1. A peer with a stolen/shared sender key could inject messages with arbitrary sequence numbers
2. No detection of missed/dropped messages
3. Linear-time duplicate detection degrades performance over time

**Fix**:
1. Track the last seen sequence number per author per group and reject out-of-order messages
2. Use a set for O(1) duplicate detection

```python
# In GroupStorage:
self._seen_message_ids: dict[str, set[str]] = {}  # group_id -> set of message IDs

def is_duplicate(self, group_id: str, message_id: str) -> bool:
    return message_id in self._seen_message_ids.get(group_id, set())

def mark_seen(self, group_id: str, message_id: str) -> None:
    if group_id not in self._seen_message_ids:
        self._seen_message_ids[group_id] = set()
    self._seen_message_ids[group_id].add(message_id)
```
