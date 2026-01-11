# Issue #41: Pairing Code Entropy Analysis

## Summary

Analysis of the pairing code entropy and collision probability in the Zajel signaling system.

## Current Implementation

**Location**: `/home/meywd/zajel/packages/web-client/src/lib/signaling.ts`

```typescript
const PAIRING_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIRING_CODE_LENGTH = 6;
```

**Server Handler**: `/home/meywd/zajel/packages/server-vps/src/client/handler.ts`

```typescript
private static readonly PAIR_REQUEST_TIMEOUT = 60000; // 60 seconds
private static readonly MAX_PENDING_REQUESTS_PER_TARGET = 10;
```

## Entropy Calculation

### Character Set Analysis

- **Alphabet size**: 32 characters (A-Z excluding I and O, plus 2-9)
- **Code length**: 6 characters
- **Total possible codes**: 32^6 = 1,073,741,824 (approximately 1.07 billion)

### Bits of Entropy

```
Entropy = log2(32^6) = 6 * log2(32) = 6 * 5 = 30 bits
```

**Exact entropy: 30 bits**

### Code Generation Method

The client generates codes using `crypto.getRandomValues()`:

```typescript
private generatePairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes)
    .map((b) => PAIRING_CODE_CHARS[b % PAIRING_CODE_CHARS.length])
    .join('');
}
```

**Note**: Using `b % 32` introduces slight bias since 256 is not evenly divisible by 32. Each byte value 0-255 maps to 32 possible characters, but 256/32 = 8, so the distribution is actually uniform in this case.

## Birthday Paradox Collision Analysis

The birthday problem formula for collision probability:

```
P(collision) ≈ 1 - e^(-n^2 / (2 * N))
```

Where:
- n = number of active codes
- N = total possible codes (32^6 = 1,073,741,824)

### Collision Probability at Various Scales

| Active Codes (n) | Collision Probability | Notes |
|-----------------|----------------------|-------|
| 100 | 0.00000047% | Negligible |
| 1,000 | 0.000047% | Very low |
| 10,000 | 0.0047% | Low |
| 33,000 | 0.05% (~1 in 2000) | Birthday threshold |
| 36,300 | 0.06% | 50% approximation point |
| 50,000 | 0.12% | Small risk |
| 100,000 | 0.46% | Moderate risk |
| 500,000 | 10.4% | High risk |
| 1,000,000 | 37% | Very high risk |

### Birthday Bound (50% Collision Probability)

The 50% collision point occurs at approximately:

```
n_50 = sqrt(2 * N * ln(2)) ≈ sqrt(1.386 * 1,073,741,824) ≈ 38,581 codes
```

**At ~38,600 concurrent active codes, there is a 50% chance of at least one collision.**

The reviewer's estimate of ~33k is derived from the simpler approximation:

```
n ≈ 1.177 * sqrt(N) ≈ 1.177 * sqrt(1,073,741,824) ≈ 38,600
```

Or using the sqrt(N) rule of thumb:

```
n ≈ sqrt(1,073,741,824) ≈ 32,768
```

## Current Mitigations

### 1. 60-Second Timeout (PAIR_REQUEST_TIMEOUT)

```typescript
private static readonly PAIR_REQUEST_TIMEOUT = 60000; // 60 seconds
```

Codes only need to remain unique during the active pairing window:
- Codes are generated on `connect()`
- Pair requests expire after 60 seconds
- Users typically complete pairing within seconds

**Effective window**: The critical window is approximately 60-120 seconds (request timeout + typical pairing duration).

### 2. Request Limits Per Target

```typescript
private static readonly MAX_PENDING_REQUESTS_PER_TARGET = 10;
```

Limits denial-of-service attacks via flooding.

### 3. Rate Limiting

```typescript
private static readonly RATE_LIMIT_WINDOW_MS = 60000; // 1 minute window
private static readonly RATE_LIMIT_MAX_MESSAGES = 100; // Max 100 messages per minute
```

Prevents brute-force code enumeration attempts.

### 4. Generic Error Messages

The server uses generic error messages to prevent code enumeration:

```typescript
this.send(ws, {
  type: 'pair_error',
  error: 'Pair request could not be processed',
});
```

## Risk Assessment

### Current Risk Level: LOW

For typical usage patterns (< 10,000 concurrent users attempting to pair):
- Collision probability: < 0.005%
- Expected collisions: Near zero

### Scaling Thresholds

| Concurrent Pairing Users | Risk Level | Action Needed |
|-------------------------|------------|---------------|
| < 10,000 | Very Low | No action |
| 10,000 - 30,000 | Low | Monitor metrics |
| 30,000 - 50,000 | Medium | Consider extending |
| > 50,000 | High | Extend code length |

## Recommendations

### Immediate (No Action Required for Current Scale)

The current implementation is adequate for:
- Small to medium deployments (< 30,000 concurrent pairing attempts)
- Typical consumer app usage patterns
- The 60-second timeout significantly reduces the active code pool

### Monitoring Recommendations

Add server-side metrics to track:

1. **Active pairing code count**: `pairingCodeToWs.size`
2. **Peak concurrent pairing attempts**: Track high-water mark
3. **Registration failures**: Monitor for collision-related failures
4. **Code generation collisions**: Check if code exists before registration

Suggested metrics:

```typescript
// In ClientHandler class
private metrics = {
  peakActiveCodes: 0,
  totalRegistrations: 0,
  collisionAttempts: 0,
};

// In handlePairingCodeRegister:
if (this.pairingCodeToWs.has(pairingCode)) {
  this.metrics.collisionAttempts++;
  // Regenerate code logic
}
this.metrics.peakActiveCodes = Math.max(
  this.metrics.peakActiveCodes,
  this.pairingCodeToWs.size
);
```

### Future Scaling Options

If monitoring shows approach to 30,000+ concurrent codes:

#### Option 1: Increase Code Length (Recommended)

Increase from 6 to 8 characters:

```typescript
const PAIRING_CODE_LENGTH = 8;
```

- New entropy: 40 bits
- Total codes: 32^8 = 1,099,511,627,776 (1.1 trillion)
- 50% collision point: ~1.25 million concurrent codes
- Still human-readable and easy to communicate verbally

#### Option 2: Reduce Timeout

Reduce `PAIR_REQUEST_TIMEOUT` from 60s to 30s:
- Reduces active code window by 50%
- May impact user experience on slow networks

#### Option 3: Server-Side Collision Detection

Check for existing codes during registration:

```typescript
private handlePairingCodeRegister(ws: WebSocket, message: SignalingRegisterMessage): void {
  const { pairingCode, publicKey } = message;

  // Check for collision
  if (this.pairingCodeToWs.has(pairingCode)) {
    this.send(ws, {
      type: 'error',
      message: 'Code collision - please reconnect',
    });
    return;
  }
  // ... rest of registration
}
```

This would alert clients to regenerate codes when collisions occur.

## Conclusion

The current 30-bit entropy with 6-character codes is **sufficient for typical usage** with < 30,000 concurrent pairing attempts. The 60-second timeout provides significant mitigation by limiting the window during which codes must remain unique.

**Key takeaways:**
- Collision becomes concerning at ~33,000+ concurrent active codes
- Current timeout-based approach is effective for most scenarios
- Monitoring should be added to detect approach to scaling limits
- Increasing to 8 characters provides ample headroom if needed

## References

- Birthday Problem: https://en.wikipedia.org/wiki/Birthday_problem
- Cryptographic Random Number Generation: Web Crypto API specification
- PR Review Issue #41

---

## Research: How Other Apps Solve This

This section documents how major messaging and collaboration apps handle pairing codes, session codes, and similar short-lived identifiers, with a focus on entropy, user experience tradeoffs, and security mitigations.

### 1. Signal: Safety Numbers (60 Digits)

**Purpose**: Identity verification between contacts (not pairing)

**Format**: 60 decimal digits displayed as 12 groups of 5 digits

```
12345 67890 12345 67890 12345 67890
12345 67890 12345 67890 12345 67890
```

**Entropy Calculation**:
- Each user contributes 30 digits (half the safety number)
- Possible fingerprints per user: 10^30
- **Bits of entropy**: log2(10^30) = ~100 bits per user

**Key Design Decisions**:

1. **Numeric encoding for internationalization**: Signal chose decimal digits over hex/base32/base64 because numbers are easily localized across all alphabets. Hexadecimal is "not compatible with all alphabets" ([Signal Blog](https://signal.org/blog/safety-number-updates/)).

2. **Sorted concatenation**: The safety number combines both users' fingerprints, making it symmetric - both parties see the same number regardless of who initiated contact.

3. **Hash includes phone number**: The fingerprint hashes both the public key AND phone number to strengthen against pre-computed attacks and "unknown key share" attacks.

4. **QR code alternative**: For in-person verification, users can scan a QR code instead of comparing 60 digits visually.

**Security Considerations**:
- Research indicates 60 digits provides sufficient long-term security for identity verification ([ArXiv Study](https://arxiv.org/html/2306.04574))
- Truncated hashes trade some collision resistance for usability - a 30-digit fingerprint has ~100 bits vs the full 256-bit hash

**Relevance to Zajel**: Signal's safety numbers serve a different purpose (long-term identity verification vs. short-term pairing), but the numeric encoding choice is relevant - it's universally readable across locales.

---

### 2. Telegram: Login Codes (5 Digits)

**Purpose**: Account authentication on new devices

**Format**: 5 decimal digits (e.g., `12345`)

**Entropy Calculation**:
- Possible codes: 10^5 = 100,000
- **Bits of entropy**: log2(100,000) = ~16.6 bits

**This is very low entropy!** How does Telegram make it work?

**Mitigations**:

1. **Strict rate limiting**: Each phone number is limited to approximately 5 login attempts per day. After exceeding this, the API returns a FLOOD error ([Telegram API](https://core.telegram.org/api/auth)).

2. **Short expiration**: Codes expire quickly (typically 2-5 minutes).

3. **Delivery channel security**: Codes are sent via SMS or in-app notification to the registered phone number - the attacker must intercept the delivery channel.

4. **Two-factor authentication option**: Users can add a password requirement, making code interception alone insufficient ([Telegram TFA](https://core.telegram.org/api/srp)).

5. **Device binding**: New sessions are tied to device identifiers.

**Key Insight**: Telegram accepts extremely low entropy (16.6 bits) because:
- The code is only valid for the specific phone number requesting it
- Rate limiting makes enumeration impractical
- The code delivery channel (SMS/in-app) acts as a second factor

---

### 3. WhatsApp: QR Codes and Linking Codes

**Purpose**: Device linking (adding computers/tablets to account)

**QR Code Format**:
- Encodes URL like `https://web.whatsapp.com/qr?code=<session-id>`
- Contains Curve25519 one-time pre-keys
- Session identifier is cryptographically random

**Numeric Pairing Code**:
- 8 decimal digits
- **Bits of entropy**: log2(10^8) = ~26.5 bits

**Security Architecture**:

1. **Cryptographic key exchange**: The QR code initiates a Curve25519 key exchange, not just a session ID lookup.

2. **Local-only secrets**: The linking companion key (Lcompanion) is "never sent to WhatsApp's servers and is only stored locally."

3. **Account signature**: Mobile device signs: `CURVE25519_SIGN(I_primary, ACCOUNT_SIGNATURE_PREFIX || Lmetadata || Icompanion)`

4. **User confirmation required**: The primary device must approve the pairing, preventing silent device additions.

**Vulnerability: GhostPairing Attack (2024)**:
Security researchers discovered that attackers can trick users into completing the pairing flow, adding attacker devices as linked sessions ([Malwarebytes](https://www.malwarebytes.com/blog/news/2025/12/the-ghosts-of-whatsapp-how-ghostpairing-hijacks-accounts)). Key points:
- "The attacker never breaks encryption, they simply convince the user to invite them in"
- Mitigation: Regularly check Settings > Linked Devices

**Relevance to Zajel**: WhatsApp's 8-digit code (26.5 bits) is similar to Zajel's 30-bit entropy. The key difference is WhatsApp requires explicit user confirmation on the primary device.

---

### 4. Discord: Invite Codes

**Purpose**: Server/channel access invitation

**Format**: 7-8 alphanumeric characters (case-sensitive)

**Character Set**:
- Uppercase A-Z (26)
- Lowercase a-z (26)
- Digits 0-9 (10)
- **Total**: 62 characters

**Entropy Calculation**:
- 7 characters: 62^7 = 3.5 trillion combinations
- **Bits of entropy**: log2(62^7) = ~41.7 bits

**Key Properties**:

1. **Case sensitivity matters**: `27sbuy3G` and `27sBUy3G` are different codes ([Discord](https://support.discord.com/hc/en-us/articles/208866998-Invites-101)).

2. **Configurable expiration**: Options range from 30 minutes to never.

3. **Usage limits**: Can set maximum number of uses.

4. **Potential recycling issue**: Security researchers found that expired invite codes can sometimes be re-registered by attackers ([Check Point Research](https://research.checkpoint.com/2025/from-trust-to-threat-hijacked-discord-invites-used-for-multi-stage-malware-delivery/)):
   - ~0.44% of codes (lowercase + digits only) may become available after deletion
   - Attackers can hijack expired community links to redirect users to malicious servers

**Relevance to Zajel**: Discord shows how permanent/long-lived codes require higher entropy and careful lifecycle management. Zajel's 60-second expiration is a significant advantage.

---

### 5. Zoom: Meeting IDs (9-11 Digits)

**Purpose**: Meeting access

**Format**: 9, 10, or 11 decimal digits (e.g., `123 456 7890`)

**Entropy Calculation**:
- 9 digits: 10^9 = 1 billion combinations
- 10 digits: 10^10 = 10 billion combinations
- **Bits of entropy**: ~30-33 bits (comparable to Zajel!)

**Historical Vulnerabilities (2020)**:

1. **Predictable IDs**: Researchers found ~4% of IDs were predictable, not truly random.

2. **War dialing attacks**: Tools like "zWarDial" could find ~100 meetings per hour with 14% success rate ([Krebs on Security](https://krebsonsecurity.com/2020/04/war-dialing-tool-exposes-zooms-password-problems/)).

3. **Weak passwords**: Default 6-digit numeric passwords (only ~20 bits) could be brute-forced "in just a few minutes" using cloud servers ([Bitdefender](https://www.bitdefender.com/en-us/blog/hotforsecurity/zoom-bug-meant-attackers-could-brute-force-their-way-into-password-protected-meetings)).

**Post-Incident Fixes**:

1. **Cryptographically strong IDs**: Replaced predictable generation with proper CSPRNG.

2. **Mandatory passwords**: All meetings now require passwords by default.

3. **Rate limiting**: Device blocking after repeated scan attempts.

4. **Waiting rooms**: Manual participant admission option.

**Key Lesson for Zajel**: Similar entropy levels (~30 bits) required multiple layers of protection:
- Password requirement
- Rate limiting
- Waiting room/manual approval

---

### 6. TOTP (Google Authenticator): 6-Digit Codes

**Purpose**: Two-factor authentication

**Format**: 6 decimal digits, refreshed every 30 seconds (RFC 6238)

**Entropy Calculation**:
- Possible codes: 10^6 = 1,000,000
- **Bits of entropy**: log2(10^6) = ~20 bits

**This is even lower than Telegram!** Security relies on:

1. **30-second window**: Codes expire quickly, limiting attack time.

2. **Rate limiting required**: "If we have a 6-digit token, it only requires a few thousand guesses every 30 seconds... rate limiting needs to be implemented" ([Medium](https://medium.com/concerning-pharo/the-code-behind-google-authenticator-9c59c606a572)).

3. **Secret key entropy**: The shared secret must be at least 128-160 bits (RFC 4226 requirement), even though the output is only 20 bits.

4. **One-time use**: "Accept a valid token only once" prevents replay attacks.

**NIST Guidelines (SP 800-63B)**:
- OTP outputs MAY be as few as 6 digits (~20 bits)
- If entropy < 64 bits, rate limiting is REQUIRED
- Time-based OTPs must have lifetime < 2 minutes
- Maximum 100 failed attempts before lockout ([NIST](https://pages.nist.gov/800-63-3/sp800-63b.html))

---

### Summary: Entropy Comparison Table

| Application | Code Format | Bits of Entropy | Expiration | Key Mitigations |
|-------------|-------------|-----------------|------------|-----------------|
| **Zajel** | 6 chars (32 charset) | **30 bits** | 60 seconds | Rate limiting, generic errors |
| Signal Safety # | 60 digits | ~100 bits | Permanent | Manual verification, different use case |
| Telegram Login | 5 digits | ~16.6 bits | 2-5 min | Strict rate limit (5/day), SMS delivery |
| WhatsApp Link | 8 digits | ~26.5 bits | Minutes | User confirmation, crypto key exchange |
| Discord Invite | 7-8 chars (62 charset) | ~42 bits | Configurable | Usage limits, case sensitivity |
| Zoom Meeting ID | 9-11 digits | ~30-33 bits | Meeting duration | Password required, waiting room |
| TOTP (6-digit) | 6 digits | ~20 bits | 30 seconds | Rate limiting, one-time use, secret key |

---

### Key Takeaways for Zajel

1. **30 bits is within industry norms** for short-lived codes when combined with:
   - Short expiration (60 seconds is excellent)
   - Rate limiting
   - Generic error messages (prevents enumeration)

2. **Telegram and TOTP prove low entropy can work** with proper mitigations:
   - Telegram: 16.6 bits + rate limiting + delivery channel security
   - TOTP: 20 bits + 30-second expiration + rate limiting

3. **Expiration is the primary defense** at low entropy levels:
   - NIST requires < 2 minutes for OTPs
   - Zajel's 60 seconds is appropriately aggressive

4. **Consider additional mitigations at scale**:
   - User confirmation on receiver side (like WhatsApp)
   - Per-IP rate limiting (not just per-connection)
   - Exponential backoff on failures

5. **Code format tradeoffs**:
   - Numeric (Telegram, TOTP): Universal, easy to communicate
   - Alphanumeric (Discord): Higher entropy density
   - Case-insensitive alphanumeric (Zajel): Good balance of entropy and usability

6. **If scaling beyond 30,000 concurrent codes**, increasing to 8 characters provides:
   - 40 bits of entropy
   - Still easy to communicate verbally
   - ~1 trillion possible codes

---

### References for This Section

- [Signal Blog: Safety Number Updates](https://signal.org/blog/safety-number-updates/)
- [ArXiv: Effect of Length on Key Fingerprint Verification](https://arxiv.org/html/2306.04574)
- [Telegram API: User Authorization](https://core.telegram.org/api/auth)
- [Telegram API: Two-Factor Authentication](https://core.telegram.org/api/srp)
- [Malwarebytes: GhostPairing WhatsApp Attack](https://www.malwarebytes.com/blog/news/2025/12/the-ghosts-of-whatsapp-how-ghostpairing-hijacks-accounts)
- [Discord Support: Invites 101](https://support.discord.com/hc/en-us/articles/208866998-Invites-101)
- [Check Point Research: Discord Invite Hijacking](https://research.checkpoint.com/2025/from-trust-to-threat-hijacked-discord-invites-used-for-multi-stage-malware-delivery/)
- [Check Point Research: Zoom Vulnerabilities](https://research.checkpoint.com/2020/zoom-zoom-we-are-watching-you/)
- [Krebs on Security: Zoom War Dialing](https://krebsonsecurity.com/2020/04/war-dialing-tool-exposes-zooms-password-problems/)
- [Bitdefender: Zoom Brute Force](https://www.bitdefender.com/en-us/blog/hotforsecurity/zoom-bug-meant-attackers-could-brute-force-their-way-into-password-protected-meetings)
- [NIST SP 800-63B: Digital Identity Guidelines](https://pages.nist.gov/800-63-3/sp800-63b.html)
- [OWASP: Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [RFC 6238: TOTP](https://datatracker.ietf.org/doc/html/rfc6238)
- [Medium: The Code Behind Google Authenticator](https://medium.com/concerning-pharo/the-code-behind-google-authenticator-9c59c606a572)

---

## Implementation Notes (2026-01-11)

### Changes Made

Based on the research above, the following entropy monitoring has been implemented:

#### 1. Collision Detection (`handler.ts`)

When a pairing code collision is detected during registration:
- The collision count is incremented
- A warning is logged
- The client receives a `code_collision` message type
- The client should reconnect with a new pairing code

```typescript
// In handlePairingCodeRegister
if (this.pairingCodeToWs.has(pairingCode)) {
  this.entropyMetrics.collisionAttempts++;
  logger.warn(`Pairing code collision detected: ${pairingCode}`);
  this.send(ws, {
    type: 'code_collision',
    message: 'Pairing code already in use. Please reconnect with a new code.',
  });
  return;
}
```

#### 2. Entropy Metrics Tracking

The server now tracks:
- `activeCodes`: Current number of active pairing codes
- `peakActiveCodes`: High-water mark for active codes
- `totalRegistrations`: Total number of code registrations (lifetime)
- `collisionAttempts`: Total number of collision attempts detected
- `collisionRisk`: Risk level based on thresholds (low/medium/high)

#### 3. Threshold Warnings

Log warnings are emitted at threshold crossings:
- `10,000` active codes: "Approaching collision threshold" (INFO)
- `20,000` active codes: "MEDIUM collision risk" (WARN)
- `30,000` active codes: "HIGH collision risk - consider extending code length" (WARN)

#### 4. Metrics Endpoint (`GET /metrics`)

A new HTTP endpoint provides real-time entropy metrics:

```json
{
  "serverId": "abc123",
  "uptime": 3600.5,
  "connections": {
    "relay": 50,
    "signaling": 100
  },
  "pairingCodeEntropy": {
    "activeCodes": 100,
    "peakActiveCodes": 250,
    "totalRegistrations": 1500,
    "collisionAttempts": 0,
    "collisionRisk": "low"
  }
}
```

#### 5. Constants Centralization (`constants.ts`)

Entropy thresholds are defined in the centralized constants file:

```typescript
export const ENTROPY = {
  COLLISION_LOW_THRESHOLD: 10000,
  COLLISION_MEDIUM_THRESHOLD: 20000,
  COLLISION_HIGH_THRESHOLD: 30000,
} as const;
```

### Files Modified

1. `packages/server-vps/src/client/handler.ts`
   - Added `EntropyMetrics` interface
   - Added collision detection in `handlePairingCodeRegister()`
   - Added `getEntropyMetrics()` method
   - Added metrics tracking variables

2. `packages/server-vps/src/index.ts`
   - Added `/metrics` HTTP endpoint

3. `packages/server-vps/src/constants.ts`
   - Added `ENTROPY` constants for collision thresholds

### Client-Side Handling

Clients receiving a `code_collision` message should:
1. Disconnect from the current WebSocket connection
2. Generate a new pairing code
3. Reconnect to the signaling server

The client-side `signaling.ts` already uses `crypto.getRandomValues()` for code generation, which provides cryptographically secure random codes.

### Future Considerations

If monitoring shows approach to 30,000+ concurrent codes:
1. **Extend code length** from 6 to 8 characters (40-bit entropy)
2. **Reduce timeout** from 2 minutes to 30 seconds
3. **Add client-side retry** with exponential backoff on collision
