# Task 01: Call Protocol Types

## Status: NOT STARTED

## Owner Files (Only edit these)
- `packages/web-client/src/lib/protocol.ts`
- `packages/web-client/src/lib/validation.ts`
- `packages/web-client/src/lib/constants.ts`

## Task Description
Add call signaling message types, validators, and constants for VoIP.

## Requirements

### 1. Add to `protocol.ts`

Add these message types to the existing `ClientMessage` union:

```typescript
// Call signaling message types
interface CallOfferMessage {
  type: 'call_offer';
  callId: string;        // UUID for this call
  targetId: string;      // Peer to call
  sdp: string;           // WebRTC SDP offer
  withVideo: boolean;    // Audio-only or video call
}

interface CallAnswerMessage {
  type: 'call_answer';
  callId: string;
  targetId: string;
  sdp: string;           // WebRTC SDP answer
}

interface CallRejectMessage {
  type: 'call_reject';
  callId: string;
  targetId: string;
  reason?: 'busy' | 'declined' | 'timeout';
}

interface CallHangupMessage {
  type: 'call_hangup';
  callId: string;
  targetId: string;
}

interface CallIceMessage {
  type: 'call_ice';
  callId: string;
  targetId: string;
  candidate: string;     // JSON stringified RTCIceCandidate
}
```

### 2. Add to `validation.ts`

Add validators for each call message type:
- Validate callId is valid UUID
- Validate targetId is non-empty string
- Validate sdp is non-empty string for offer/answer
- Validate candidate is valid JSON for ice messages

### 3. Add to `constants.ts`

```typescript
export const CALL = {
  RINGING_TIMEOUT_MS: 60000,      // 60s to answer
  ICE_GATHERING_TIMEOUT_MS: 10000, // 10s for ICE
  RECONNECT_TIMEOUT_MS: 30000,    // 30s reconnect window
} as const;
```

## Acceptance Criteria
- [ ] All 5 call message types added to protocol.ts
- [ ] Types exported and added to ClientMessage union
- [ ] Validators created for each message type
- [ ] Constants exported
- [ ] Existing tests still pass
- [ ] New tests for validators

## Notes
- Follow existing patterns in protocol.ts
- Keep validators consistent with existing style
- This is the foundation - other tasks depend on these types
