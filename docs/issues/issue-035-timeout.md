# Issue #35: Pair Request Timeout Too Short

## Summary

The current 60-second timeout for pair requests may be too short for users who need to verify fingerprints out-of-band before accepting a connection.

## Current Implementation

### Location and Value

**File**: `/home/meywd/zajel/packages/server-vps/src/client/handler.ts` (line 153)

```typescript
private static readonly PAIR_REQUEST_TIMEOUT = 60000; // 60 seconds
```

### How It's Used

1. **Server-side timer creation** (lines 621-626):
   ```typescript
   const timerKey = `${requesterCode}:${targetCode}`;
   const timer = setTimeout(() => {
     this.expirePairRequest(requesterCode, targetCode);
     this.pairRequestTimers.delete(timerKey);
   }, ClientHandler.PAIR_REQUEST_TIMEOUT);
   this.pairRequestTimers.set(timerKey, timer);
   ```

2. **Expiration handling** (lines 717-741):
   - Removes the pending request from storage
   - Sends `pair_timeout` message to the requester
   - Logs the expiration

3. **Client-side handling**:
   - **Web client** (`packages/web-client/src/lib/signaling.ts`, lines 214-217):
     ```typescript
     case 'pair_timeout':
       this.setState('registered');
       this.events.onPairTimeout(message.peerCode);
       break;
     ```
   - **Flutter app** (`packages/app/lib/core/network/signaling_client.dart`, lines 235-239):
     ```dart
     case 'pair_timeout':
       _messageController.add(SignalingMessage.pairTimeout(
         peerCode: json['peerCode'] as String,
       ));
       break;
     ```

4. **UI feedback** (`packages/web-client/src/App.tsx`, lines 87-91):
   ```typescript
   onPairTimeout: (_peerCode) => {
     setError('Connection request timed out');
     setState('registered');
   },
   ```

## Problem Analysis

### User Verification Workflow

When a pair request is received, the target user should:

1. See the incoming request with the requester's pairing code
2. Access the security information panel (currently requires clicking the lock icon)
3. View both their own and the peer's key fingerprints
4. Communicate with the peer through an out-of-band channel (phone call, in-person, etc.)
5. Verbally compare fingerprints to verify identity
6. Accept or reject the pairing

### Time Estimates for Verification

| Activity | Estimated Time |
|----------|---------------|
| Notice the incoming request | 5-10 seconds |
| Access security info panel | 2-3 seconds |
| Call peer on phone | 10-30 seconds (if number known) |
| Read fingerprint aloud (32 bytes = 64 hex chars) | 30-60 seconds |
| Peer confirms fingerprint | 15-30 seconds |
| Accept the connection | 2-3 seconds |
| **Total Minimum** | **~65-135 seconds** |

Even in the best case (both users ready, phone numbers known), the verification process takes longer than 60 seconds. If users need to:
- Look up contact information
- Move to a quieter location for the call
- Re-read fingerprints due to errors
- Use alternative verification (video call, in-person meeting)

The time requirement can easily exceed 2-5 minutes.

### Current UX Issues

1. **No countdown indicator**: The `PendingApproval` component shows only "Waiting for [code] to accept..." with no indication of remaining time
2. **No countdown on approval side**: The `ApprovalRequest` component doesn't show how much time the requester has been waiting
3. **Abrupt timeout**: Users experience sudden "Connection request timed out" without warning
4. **No way to extend**: Once expired, users must start the entire process again

## Recommendations

### 1. Make Timeout Configurable

Add environment variable support for the timeout:

```typescript
// In config.ts
client: {
  // ... existing config
  pairRequestTimeout: envNumber('ZAJEL_PAIR_REQUEST_TIMEOUT', 180000), // 3 minutes default
},
```

```typescript
// In handler.ts constructor
private readonly pairRequestTimeout: number;

constructor(/* ... */, config: ClientHandlerConfig) {
  // ...
  this.pairRequestTimeout = config.pairRequestTimeout ?? 180000;
}
```

### 2. Recommended Default Values

| Environment | Recommended Timeout | Rationale |
|-------------|---------------------|-----------|
| Development | 60 seconds | Quick iteration |
| Production | 180 seconds (3 min) | Standard verification |
| High-security | 300 seconds (5 min) | Thorough verification |

### 3. Add UI Countdown Timer

#### Server Changes

Include timeout duration in the `pair_incoming` message:

```typescript
// In handlePairRequest
this.send(targetWs, {
  type: 'pair_incoming',
  fromCode: requesterCode,
  fromPublicKey: requesterPublicKey,
  expiresIn: this.pairRequestTimeout,  // Add this
});
```

#### Web Client Changes

Update `ApprovalRequest` component:

```tsx
interface ApprovalRequestProps {
  peerCode: string;
  expiresIn: number;  // milliseconds
  onAccept: () => void;
  onReject: () => void;
}

export function ApprovalRequest({ peerCode, expiresIn, onAccept, onReject }: ApprovalRequestProps) {
  const [remaining, setRemaining] = useState(Math.ceil(expiresIn / 1000));

  useEffect(() => {
    const interval = setInterval(() => {
      setRemaining(r => Math.max(0, r - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const timeDisplay = minutes > 0
    ? `${minutes}:${seconds.toString().padStart(2, '0')}`
    : `${seconds}s`;

  return (
    <div class="approval-overlay">
      <div class="approval-dialog">
        <h3>Connection Request</h3>
        <p>
          <span class="code">{peerCode}</span> wants to connect
        </p>
        <p class="timeout-indicator" style={{
          color: remaining < 30 ? 'var(--warning)' : 'inherit'
        }}>
          Time remaining: {timeDisplay}
        </p>
        {/* ... buttons ... */}
      </div>
    </div>
  );
}
```

Update `PendingApproval` component similarly to show countdown to the requester.

#### Flutter App Changes

Similar countdown implementation in the approval dialog with a `Timer.periodic` for UI updates.

### 4. Add Warning Before Expiration

Send a `pair_expiring` message 30 seconds before timeout:

```typescript
// Schedule expiration warning
const warningTimer = setTimeout(() => {
  this.send(targetWs, {
    type: 'pair_expiring',
    fromCode: requesterCode,
    remainingSeconds: 30,
  });
}, this.pairRequestTimeout - 30000);
```

### 5. Future Enhancement: Request Extension

Allow the target to request more time (would require protocol changes):

```typescript
// New message type
interface ExtendPairRequestMessage {
  type: 'extend_pair_request';
  requesterCode: string;
  additionalTime: number;  // milliseconds
}
```

## Implementation Priority

| Change | Priority | Effort | Impact |
|--------|----------|--------|--------|
| Increase default to 180s | High | Low | High |
| Add environment variable | High | Low | Medium |
| Add UI countdown (approval side) | High | Medium | High |
| Add UI countdown (requester side) | Medium | Medium | Medium |
| Add expiring warning | Low | Medium | Low |
| Request extension feature | Low | High | Low |

## Testing Considerations

1. Update existing tests that mock the timeout:
   - `packages/server-vps/tests/unit/client-handler-pairing.test.ts` (lines 378-396)

2. Add tests for:
   - Configurable timeout values
   - `expiresIn` field in `pair_incoming` message
   - `pair_expiring` warning message
   - Countdown UI behavior

## Related Files

| File | Relevance |
|------|-----------|
| `packages/server-vps/src/client/handler.ts` | Server timeout logic |
| `packages/server-vps/src/config.ts` | Configuration management |
| `packages/web-client/src/lib/signaling.ts` | Web client message handling |
| `packages/web-client/src/lib/protocol.ts` | Message type definitions |
| `packages/web-client/src/App.tsx` | UI state management |
| `packages/web-client/src/components/ApprovalRequest.tsx` | Approval UI |
| `packages/web-client/src/components/PendingApproval.tsx` | Pending UI |
| `packages/app/lib/core/network/signaling_client.dart` | Flutter client |
| `packages/app/lib/core/network/connection_manager.dart` | Flutter connection handling |

## References

- NIST SP 800-63B recommends allowing sufficient time for cryptographic verification
- Signal Protocol uses indefinite waiting with user-initiated cancellation
- WhatsApp Web pairing has no visible timeout (uses QR code refresh instead)

## Research: How Other Apps Solve This

### Signal Messenger

#### Key Verification UX
Signal uses "safety numbers" instead of "fingerprints" for identity verification. [User studies showed](https://signal.org/blog/safety-number-updates/) that "fingerprint" as a metaphor doesn't carry well outside the cryptography community. Safety numbers simplify verification by reducing two comparisons to one, or two QR code scans to a single scan.

#### Verification Approach
- Signal uses **indefinite waiting** with user-initiated cancellation for key verification
- No hard timeout - users can take as long as needed to verify fingerprints out-of-band
- Key changes are flagged but don't block communication (trust-on-first-use model)
- [Research shows](https://arxiv.org/html/2306.04574) that Signal/WhatsApp's 60-digit fingerprints have "poor usability" for manual verification

#### Call Connection (RingRTC)
Signal's [RingRTC library](https://github.com/signalapp/ringrtc) handles voice/video calls:
- Built on WebRTC with standard ICE timeouts
- Ring timeout behavior: calls that aren't answered result in "missed call" notifications
- No publicly documented ring timeout value, but follows standard VoIP patterns

---

### Telegram

#### QR Code Login
[Telegram's API documentation](https://core.telegram.org/api/qr-login) specifies:
- **Login token expiration**: ~30 seconds (must regenerate QR code automatically)
- Some sources report 5 minutes for overall QR validity
- `AUTH_TOKEN_EXPIRED` error if token expires before scanning

#### API/SDK Timeouts
From [Telegram Bot SDK documentation](https://telegram-bot-sdk.com/docs/advanced/timeouts/):
- **Connection timeout**: 10 seconds (default)
- **Response timeout**: 60 seconds (default)
- Both configurable via `setTimeOut()` and `setConnectTimeOut()`

#### Session Handling
- Sessions persist across reconnections
- Automatic session refresh in background
- Users may need to re-authenticate if tokens expire before refresh

---

### WhatsApp Web

#### QR Code Behavior
[WhatsApp Web pairing](https://sheetwa.com/blogs/whatsapp-login-qr-code-for-all-devices/) uses a sophisticated refresh approach:
- **QR code refresh**: Every ~20 seconds
- **Page timeout**: ~2 minutes before requiring page reload
- **Pairing code timeout**: ~3 minutes (alternative to QR)

#### Why This Works
- No visible countdown creates less pressure on users
- Automatic refresh is seamless
- Security: expired QR codes cannot be reused
- User simply needs to scan "the current code"

---

### Discord (WebRTC Voice)

#### Voice Connection Timeouts
From [Discord.js documentation](https://github.com/discordjs/discord.js/issues/2979):
- **Voice connection timeout**: 15 seconds
- Error: `VOICE_CONNECTION_TIMEOUT: Connection not established within 15 seconds`

#### RTC Connecting States
- "RTC Connecting" status indicates WebRTC handshake in progress
- If stuck for more than 1 minute, indicates a blocking issue
- Discord requires UDP support; VPNs without UDP cause failures

---

### Element/Matrix

#### Device Verification
[Element's cross-signed device verification](https://element.io/en/features/device-verification):
- Users compare on-screen emojis or scan QR codes
- Verification extends trust across all linked devices
- Based on Double Ratchet protocol (Olm/Megolm)
- No hard timeout documented - verification is user-driven

---

### WebRTC Standards (RFC)

#### ICE Timeout Values
Per [RFC 7675 - ICE Consent Freshness](https://bugzilla.mozilla.org/show_bug.cgi?id=929977):
- **Consent timeout**: 30 seconds (peer unreachable detection)
- **STUN transaction timeout**: 6 seconds (375ms x 16 retries)

#### ICE Gathering Timeouts
From [WebRTC implementation research](https://bugs.chromium.org/p/webrtc/issues/detail?id=4699):
- **Per-interface timeout**: 10 seconds (Chrome)
- Multiple interfaces compound: 2 unreachable interfaces = 20 seconds
- **Disconnected state detection**: ~5 seconds (Chrome)
- **Failed state**: ~30 seconds

#### Firefox Specific
- `media.peerconnection.ice.trickle_grace_period` preference controls timeout
- [5-second timeout](https://bugzilla.mozilla.org/show_bug.cgi?id=1647289) for answer transmission can cause failures

#### Recommendations
- [Increasing ICE timeouts by 25%](https://moldstud.com/articles/p-troubleshooting-webrtc-ice-candidates-common-issues-and-solutions-explained) can reduce failed connections by 35%
- Use TURN over TCP/443 for restrictive networks
- Implement trickle ICE for faster candidate exchange

---

### NFC/Bluetooth Pairing (for comparison)

#### NFC
- **Connection time**: <0.1 seconds
- [One-touch pairing](https://www.design-reuse.com/articles/47133/enabling-bluetooth-out-of-band-pairing-through-nfc.html) with no manual configuration

#### Bluetooth OOB Pairing
- Recommended timeout: 1-2 seconds for security level establishment
- [Nordic documentation](https://devzone.nordicsemi.com/f/nordic-q-a/108804/two-step-nfc-oob-pairing-and-immediate-pairing) suggests disconnecting if security not achieved

---

### UX Research: User Patience Thresholds

#### Response Time Limits ([Nielsen Norman Group](https://www.nngroup.com/articles/website-response-times/))
| Threshold | User Perception |
|-----------|-----------------|
| 0.1 seconds | Instantaneous - feels like direct manipulation |
| 1 second | Flow maintained - user notices delay but feels in control |
| 10 seconds | Attention limit - users want to do other tasks |

#### Abandonment Data
- [47% of users](https://www.hobo-web.co.uk/your-website-design-should-load-in-4-seconds/) expect pages to load in 2 seconds or less
- [53% mobile abandonment](https://www.tandfonline.com/doi/full/10.1080/10447318.2025.2573834) if load takes >3 seconds
- 2-second delay can result in 87% abandonment

#### Skeleton Screens Research ([NN/G](https://www.nngroup.com/articles/skeleton-screens/))
- Users perceive loading as shorter with skeleton screens vs spinners
- Left-to-right wave animations perceived as faster than pulsing
- Best for waits under 10 seconds; use progress bars beyond that
- Active waiting (seeing progress) feels faster than passive waiting

---

### Retry and Backoff Patterns

#### Exponential Backoff Best Practices ([AWS](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/))
1. **Base retry sequence**: 1s, 2s, 4s, 8s, 16s, 32s...
2. **Add jitter**: Randomize delays (e.g., 0.9s, 2.3s, 4.1s) to prevent thundering herd
3. **Cap maximum backoff**: Prevent excessively long waits
4. **Minimum interval**: Wait at least 10 seconds before first retry
5. **Set retry limits**: Don't retry indefinitely (60-minute max suggested)
6. **Circuit breaker**: Stop retrying entirely after threshold failures

---

### Summary: Industry Timeout Values

| App/Standard | Timeout Type | Duration | Notes |
|--------------|--------------|----------|-------|
| WhatsApp Web | QR refresh | 20 seconds | Auto-refresh, no countdown |
| WhatsApp Web | Page timeout | 2 minutes | Requires reload |
| Telegram | QR token | 30 seconds | Auto-regenerate |
| Telegram | API response | 60 seconds | Configurable |
| Discord | Voice connection | 15 seconds | Hard failure |
| WebRTC (RFC) | ICE consent | 30 seconds | Peer unreachable |
| WebRTC | Disconnected detection | 5 seconds | Chrome |
| WebRTC | Failed state | 30 seconds | Chrome |
| Signal | Key verification | Indefinite | User-initiated cancel |

---

### Recommendations Based on Research

#### 1. Increase Default Timeout
Current 60 seconds is reasonable for simple connections but insufficient for security verification workflows. Recommended: **180 seconds (3 minutes)** based on:
- WhatsApp's 2-minute page timeout
- Telegram's 60-second response timeout
- User verification requiring 65-135+ seconds

#### 2. Progressive Disclosure for Long Waits
Apply [progressive disclosure principles](https://www.interaction-design.org/literature/topics/progressive-disclosure):
- Show simple "Waiting..." initially
- After 30 seconds: Add countdown timer
- After 60 seconds: Show "Verify security" prompt
- Before expiration: Offer "Request more time" option

#### 3. Adopt WhatsApp's No-Countdown Approach (Alternative)
Instead of showing pressure-inducing countdowns:
- Auto-extend requests silently if both peers are online
- Only timeout if target is genuinely unavailable
- Show "Still waiting, they may be verifying security" after 60 seconds

#### 4. Implement Retry with Backoff
If connection fails:
- First retry: Immediate (user-initiated)
- Subsequent retries: 10s, 20s, 40s, 80s (capped)
- Add jitter to prevent synchronized retries
- Show clear "Retry" button rather than auto-retry

#### 5. Improve Feedback Quality
Based on UX research:
- Use skeleton/shimmer loading indicators (perceived as faster)
- Show progress stages: "Connecting...", "Exchanging keys...", "Waiting for approval..."
- Provide cancel option for waits over 10 seconds
- Include "Why is this taking time?" tooltip explaining verification

#### 6. Handle Different Scenarios
| Scenario | Recommended Timeout | Rationale |
|----------|---------------------|-----------|
| Quick chat connection | 60 seconds | Standard case, users ready |
| Security verification | 180-300 seconds | Out-of-band verification needed |
| First-time pairing | 300 seconds | Building trust, new users |
| Reconnection | 30 seconds | Users expect speed |
