# [HIGH] Group invitation auto-accepted without any peer verification

**Area**: Headless Client
**File**: packages/headless-client/zajel/client.py:1090-1181
**Type**: Security

**Description**: The `_handle_group_invitation` method automatically accepts any group invitation received from any connected peer. There is no verification that:
1. The inviter is authorized to invite new members to the group
2. The sender keys provided in the invitation are authentic
3. The group members listed in the invitation are real
4. The invitation has not been replayed from a previous session

The method parses arbitrary JSON from the peer, creates a group, imports all sender keys from the invitation payload, and stores them locally. A malicious peer could:
- Create a fake group with forged member lists
- Provide their own key as another member's sender key (key substitution)
- Replay an old invitation to re-add a member who was removed

**Impact**: A malicious connected peer can inject arbitrary groups and sender keys into the client's storage. This could enable message spoofing within groups (by substituting sender keys) or trick the user into thinking they are communicating with specific people when they are not.

**Fix**:
1. Add an explicit accept/reject flow for group invitations (similar to pair requests).
2. Verify that the inviter's device_id matches the sending peer's identity.
3. Verify sender keys against known public keys of members.
4. Add replay protection using a nonce or timestamp check.

```python
# Instead of auto-accepting:
self._group_invitation_queue.put_nowait((from_peer_id, data))
# Let the application decide whether to accept

# Verify inviter identity:
inviter_device_id = data.get("inviterDeviceId")
if inviter_device_id != from_peer_id:
    logger.warning("Inviter device_id mismatch: claimed %s, actual %s",
                   inviter_device_id, from_peer_id)
    return
```
