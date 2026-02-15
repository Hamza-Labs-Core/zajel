# Plan: Group invitation auto-accepted without any peer verification

**Issue**: issue-headless-11.md
**Severity**: HIGH
**Area**: Headless Client
**Files to modify**:
- `packages/headless-client/zajel/client.py`

## Analysis

At `client.py:1090-1181`, the `_handle_group_invitation` method automatically accepts any group invitation received from a connected peer. The method:

1. Parses the invitation JSON (line 1111)
2. Creates the group locally (lines 1141-1148)
3. Imports all sender keys from the invitation (lines 1151-1154)
4. Sets the invitee's own sender key (lines 1157-1159)
5. Persists the group (line 1162)
6. Queues it for consumer code (line 1165)

There is no verification that:
- The inviter (`data["inviterDeviceId"]`) matches the `from_peer_id` (the peer who actually sent the message)
- The sender keys are authentic
- The group members listed are real
- The invitation has not been replayed

The only guard is a duplicate check at lines 1122-1127:
```python
existing = self._group_storage.get_group(group_id)
if existing is not None:
    logger.info("Already in group '%s', ignoring invitation", group_name)
    return
```

## Fix Steps

1. **Add inviter identity verification** at `client.py:1110-1111`. After parsing the JSON, verify the inviter device ID matches the sending peer:
   ```python
   data = json.loads(payload)

   # Verify the inviter is the peer who sent this message
   inviter_device_id = data.get("inviterDeviceId")
   if inviter_device_id != from_peer_id:
       logger.warning(
           "Group invitation inviterDeviceId mismatch: "
           "claimed '%s' but received from '%s'. Rejecting.",
           inviter_device_id, from_peer_id,
       )
       return
   ```

2. **Verify the inviter is listed as a member** of the group they are inviting to:
   ```python
   members_json = data["members"]
   inviter_is_member = any(
       m["device_id"] == inviter_device_id for m in members_json
   )
   if not inviter_is_member:
       logger.warning(
           "Inviter %s is not in the member list of group '%s'. Rejecting.",
           inviter_device_id, data["groupName"],
       )
       return
   ```

3. **Verify the inviter has a sender key in the invitation**:
   ```python
   sender_keys = data["senderKeys"]
   if inviter_device_id not in sender_keys:
       logger.warning(
           "Inviter %s has no sender key in group invitation. Rejecting.",
           inviter_device_id,
       )
       return
   ```

4. **Add a configurable auto-accept flag** for group invitations (similar to `auto_accept_pairs`). In `__init__`, add:
   ```python
   self.auto_accept_group_invitations: bool = True  # Default for backward compatibility
   ```

   In `_handle_group_invitation`, if auto-accept is disabled, queue the invitation for user approval instead of processing immediately:
   ```python
   if not self.auto_accept_group_invitations:
       self._pending_group_invitations.put_nowait((from_peer_id, data))
       logger.info("Group invitation queued for approval: '%s'", group_name)
       return
   ```

5. **Add replay protection** using a set of seen group invitation IDs. At the top of the method, after parsing `group_id`:
   ```python
   invite_key = f"{group_id}:{inviter_device_id}"
   if invite_key in self._seen_group_invitations:
       logger.info("Duplicate group invitation for '%s', ignoring", group_name)
       return
   self._seen_group_invitations.add(invite_key)
   ```

   Initialize `_seen_group_invitations: set[str] = set()` in `__init__`.

## Testing

- Unit test: Send a group invitation where `inviterDeviceId` does not match `from_peer_id`. Verify it is rejected.
- Unit test: Send a group invitation where the inviter is not in the member list. Verify it is rejected.
- Unit test: Replay a group invitation and verify it is ignored.
- Integration test: Valid group invitation is still accepted when auto-accept is enabled.
- Run existing group E2E tests.

## Risk Assessment

- Low risk for the verification steps (1-3). They are pure validation that filters out malformed invitations.
- The auto-accept flag (step 4) is backward compatible since it defaults to `True`.
- The replay protection set (step 5) grows unboundedly over time but at a very slow rate (one entry per group invitation). This is acceptable for a daemon's lifetime.
- These changes do not affect the protocol wire format -- they are purely local validation.
