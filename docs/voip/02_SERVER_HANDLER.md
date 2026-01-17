# Task 02: Server Call Forwarding

## Status: NOT STARTED
## Depends On: 01_PROTOCOL

## Owner Files (Only edit these)
- `packages/server-vps/src/client/handler.ts`

## Task Description
Add call message forwarding to the VPS server handler.

## Requirements

### 1. Forward Call Messages

Add handling for these message types in `handler.ts`:
- `call_offer`
- `call_answer`
- `call_reject`
- `call_hangup`
- `call_ice`

### 2. Implementation Pattern

Follow the existing pattern for `offer`, `answer`, `ice_candidate`:

```typescript
// Example pattern (already exists for WebRTC data channel):
case 'offer':
case 'answer':
case 'ice_candidate':
  // Forward to target peer
  await this.forwardToPeer(message.targetId, message);
  break;
```

Add similar handling:
```typescript
case 'call_offer':
case 'call_answer':
case 'call_reject':
case 'call_hangup':
case 'call_ice':
  await this.forwardToPeer(message.targetId, message);
  break;
```

### 3. Validation

- Verify sender is paired with target before forwarding
- Use existing pairing validation logic

## Acceptance Criteria
- [ ] All 5 call message types forwarded
- [ ] Only forwards between paired peers
- [ ] Existing functionality unchanged
- [ ] Tests for call message forwarding

## Notes
- Server is just a relay - no call state tracking needed
- Same security model as existing message forwarding
- Keep it simple - just forward the messages
