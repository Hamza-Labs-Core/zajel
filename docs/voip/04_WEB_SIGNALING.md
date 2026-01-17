# Task 04: Web Call Signaling

## Status: NOT STARTED
## Depends On: 01_PROTOCOL

## Owner Files (Only edit these)
- `packages/web-client/src/lib/signaling.ts`

## Task Description
Add call signaling methods to the existing SignalingService.

## Requirements

### 1. Add Call Methods to SignalingService

```typescript
// Add these methods to the existing SignalingService class:

/**
 * Send call offer to peer
 */
sendCallOffer(callId: string, targetId: string, sdp: string, withVideo: boolean): void {
  this.send({
    type: 'call_offer',
    callId,
    targetId,
    sdp,
    withVideo,
  });
}

/**
 * Send call answer to peer
 */
sendCallAnswer(callId: string, targetId: string, sdp: string): void {
  this.send({
    type: 'call_answer',
    callId,
    targetId,
    sdp,
  });
}

/**
 * Reject incoming call
 */
sendCallReject(callId: string, targetId: string, reason?: 'busy' | 'declined' | 'timeout'): void {
  this.send({
    type: 'call_reject',
    callId,
    targetId,
    reason,
  });
}

/**
 * End current call
 */
sendCallHangup(callId: string, targetId: string): void {
  this.send({
    type: 'call_hangup',
    callId,
    targetId,
  });
}

/**
 * Send ICE candidate for call
 */
sendCallIce(callId: string, targetId: string, candidate: RTCIceCandidate): void {
  this.send({
    type: 'call_ice',
    callId,
    targetId,
    candidate: JSON.stringify(candidate),
  });
}
```

### 2. Add Event Handling

Add handlers for incoming call messages:
```typescript
// In the message handler switch statement:
case 'call_offer':
  this.emit('call:offer', message);
  break;
case 'call_answer':
  this.emit('call:answer', message);
  break;
case 'call_reject':
  this.emit('call:reject', message);
  break;
case 'call_hangup':
  this.emit('call:hangup', message);
  break;
case 'call_ice':
  this.emit('call:ice', message);
  break;
```

### 3. Type Safety

Ensure all methods use types from protocol.ts (Task 01).

## Acceptance Criteria
- [ ] All 5 send methods added
- [ ] All 5 event handlers added
- [ ] Methods use correct types from protocol.ts
- [ ] Existing functionality unchanged
- [ ] Tests for new methods

## Notes
- Follow existing patterns in signaling.ts
- This extends the existing service, doesn't replace it
- VoIPService (Task 05) will use these methods
