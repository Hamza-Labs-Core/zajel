# Plan: Group message sequence numbers not validated for gaps or replays

**Issue**: issue-headless-23.md
**Severity**: MEDIUM
**Area**: Headless Client
**Files to modify**: `packages/headless-client/zajel/groups.py`, `packages/headless-client/zajel/client.py`

## Analysis

### Duplicate detection (O(n) performance)
In `groups.py`, `GroupStorage.is_duplicate` (lines 308-311) performs a linear scan over all messages for a group:
```python
def is_duplicate(self, group_id: str, message_id: str) -> bool:
    msgs = self._messages.get(group_id, [])
    return any(m.id == message_id for m in msgs)
```
This is O(n) where n is the total number of messages in the group. As message count grows (hundreds or thousands), this becomes increasingly expensive.

### No sequence validation
In `client.py`, `receive_group_message` (lines 1004-1056) and `_receive_group_message_sync` (lines 1226-1256) check for duplicates and verify the author matches, but do not validate that sequence numbers are monotonically increasing per author. A malicious peer with a stolen sender key could inject messages with arbitrary sequence numbers (very large, negative, or out-of-order).

The `get_next_sequence` method (lines 300-306) correctly increments a counter for outgoing messages, but the incoming path has no corresponding validation.

### Message ID format
The message ID is `f"{self.author_device_id}:{self.sequence_number}"` (line 122-123 in `groups.py`). This is used for duplicate detection but not for sequence gap detection.

## Fix Steps

1. **Add a `_seen_message_ids` set to `GroupStorage.__init__`** (after line 260):
   ```python
   self._seen_message_ids: dict[str, set[str]] = {}  # group_id -> set of message IDs
   self._last_seen_sequence: dict[str, dict[str, int]] = {}  # group_id -> {device_id -> last_seq}
   ```

2. **Replace `is_duplicate` with O(1) set lookup** (lines 308-311):
   ```python
   def is_duplicate(self, group_id: str, message_id: str) -> bool:
       return message_id in self._seen_message_ids.get(group_id, set())
   ```

3. **Update `save_message` to maintain the seen set** (lines 284-288). After appending to the messages list, add:
   ```python
   if message.group_id not in self._seen_message_ids:
       self._seen_message_ids[message.group_id] = set()
   self._seen_message_ids[message.group_id].add(message.id)
   ```

4. **Add sequence validation method to `GroupStorage`**:
   ```python
   def validate_sequence(self, group_id: str, author_device_id: str, sequence_number: int) -> bool:
       """Validate that a sequence number is reasonable (non-negative, not excessively ahead).

       Logs a warning if sequence gaps are detected.
       Returns False if the sequence number is invalid.
       """
       if sequence_number < 0:
           return False

       last_seen = self._last_seen_sequence.get(group_id, {}).get(author_device_id, 0)

       # Allow sequence numbers that are ahead by at most a reasonable gap
       MAX_SEQ_GAP = 100
       if sequence_number > last_seen + MAX_SEQ_GAP:
           logger.warning(
               "Sequence gap too large from %s in group %s: last=%d, received=%d",
               author_device_id, group_id[:8], last_seen, sequence_number,
           )
           return False

       # Update last seen
       if group_id not in self._last_seen_sequence:
           self._last_seen_sequence[group_id] = {}
       if sequence_number > last_seen:
           self._last_seen_sequence[group_id][author_device_id] = sequence_number

       return True
   ```

5. **Call `validate_sequence` in `receive_group_message` in `client.py`** (after line 1031, after `GroupMessage.from_bytes`):
   ```python
   if not self._group_storage.validate_sequence(
       group_id, message.author_device_id, message.sequence_number
   ):
       logger.warning(
           "Invalid sequence number %d from %s in group %s",
           message.sequence_number, message.author_device_id, group_id[:8],
       )
       return None
   ```

6. **Apply same validation in `_receive_group_message_sync`** (after line 1237).

7. **Clean up `_seen_message_ids` and `_last_seen_sequence` in `delete_group`** (lines 278-282):
   ```python
   self._seen_message_ids.pop(group_id, None)
   self._last_seen_sequence.pop(group_id, None)
   ```

8. **Initialize the sets in `save_group`** (lines 262-268):
   ```python
   if group.id not in self._seen_message_ids:
       self._seen_message_ids[group.id] = set()
   if group.id not in self._last_seen_sequence:
       self._last_seen_sequence[group.id] = {}
   ```

## Testing

- Unit test: Verify `is_duplicate` returns True for a previously seen message ID (O(1) check).
- Unit test: Verify `validate_sequence` rejects negative sequence numbers.
- Unit test: Verify `validate_sequence` rejects sequence numbers that jump more than MAX_SEQ_GAP ahead.
- Unit test: Verify `validate_sequence` accepts monotonically increasing sequences.
- Performance test: Verify `is_duplicate` with 10,000 messages is fast (< 1ms).

## Risk Assessment

- The `MAX_SEQ_GAP` of 100 is a heuristic. If legitimate messages are lost (e.g., due to network issues), and a peer catches up, the gap could be larger. This threshold should be configurable or generous enough.
- The `_seen_message_ids` set grows unboundedly for long-lived groups. Consider adding a TTL or max-size eviction policy for production use.
- The sequence validation must be applied in both `receive_group_message` and `_receive_group_message_sync` to cover all code paths.
