# Issue #25: Handshake Key Verification - Research Report

## Executive Summary

This document provides a comprehensive analysis of the handshake key verification implementation in Zajel, including the current state, identified gaps, recommended improvements, and comparisons with industry-standard secure messaging applications.

**Status**: Partially Implemented (Core verification complete, advanced features pending)

---

## 1. Current Key Flow Analysis

### 1.1 Key Exchange Overview

The Zajel key exchange follows a three-phase process:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 1: SIGNALING (WebSocket via signaling server)                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Client A                  Signaling Server                 Client B   │
│     │                           │                               │      │
│     │── register(publicKey_A) ─>│                               │      │
│     │                           │<── register(publicKey_B) ─────│      │
│     │                           │                               │      │
│     │── pair_request ──────────>│                               │      │
│     │                           │── pair_incoming(publicKey_A) ─>│      │
│     │                           │                               │      │
│     │                           │<── pair_response(accept) ─────│      │
│     │<── pair_matched ──────────│── pair_matched ───────────────>│      │
│     │   (publicKey_B)           │   (publicKey_A)               │      │
│     │                           │                               │      │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 2: WEBRTC ESTABLISHMENT                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Client A                        STUN/TURN                  Client B   │
│     │                               │                           │      │
│     │── SDP Offer (via signaling) ─>│                           │      │
│     │                               │── SDP Offer ──────────────>│      │
│     │                               │                           │      │
│     │<── SDP Answer (via signaling)─│<── SDP Answer ────────────│      │
│     │                               │                           │      │
│     │<──────────── ICE Candidates ──────────────────────────────>│      │
│     │                               │                           │      │
│     │<═══════════════ DTLS-SRTP Handshake ════════════════════>│      │
│     │                               │                           │      │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 3: APPLICATION HANDSHAKE (Data Channel)                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Client A                    Data Channel                   Client B   │
│     │                            │                              │      │
│     │── {type:'handshake', ─────>│                              │      │
│     │    publicKey: pubKey_A}    │── handshake message ────────>│      │
│     │                            │                              │      │
│     │<─────── handshake ─────────│<── {type:'handshake',        │      │
│     │                            │     publicKey: pubKey_B} ────│      │
│     │                            │                              │      │
│     │     VERIFY: pubKey_B       │     VERIFY: pubKey_A         │      │
│     │     (from handshake)       │     (from handshake)         │      │
│     │       == pubKey_B          │       == pubKey_A            │      │
│     │     (from signaling)       │     (from signaling)         │      │
│     │                            │                              │      │
│     │<═══════════════ E2E Encrypted Messages ══════════════════>│      │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Current Implementation Details

#### Key Storage (crypto.ts)

```typescript
// /home/meywd/zajel/packages/web-client/src/lib/crypto.ts

export class CryptoService {
  private keyPair: KeyPair | null = null;
  private sessionKeys = new Map<string, Uint8Array>();
  // Store peer public keys for handshake verification (prevents MITM attacks)
  private peerPublicKeys = new Map<string, string>();  // LINE 45

  // ...

  establishSession(peerId: string, peerPublicKeyBase64: string): void {
    // ... key validation ...

    // Store peer public key for later handshake verification
    this.peerPublicKeys.set(peerId, peerPublicKeyBase64);  // LINE 216

    // Perform ECDH and derive session key
    // ...
  }
}
```

#### Key Verification (crypto.ts)

```typescript
// /home/meywd/zajel/packages/web-client/src/lib/crypto.ts (lines 245-262)

/**
 * Verifies that a received public key matches the expected key from signaling.
 * This prevents MITM attacks where an attacker substitutes their own key.
 *
 * Uses constant-time comparison to prevent timing attacks.
 */
verifyPeerKey(peerId: string, receivedKey: string): boolean {
  const expectedKey = this.peerPublicKeys.get(peerId);
  if (!expectedKey) {
    return false;
  }

  // Constant-time comparison to prevent timing attacks
  if (expectedKey.length !== receivedKey.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < expectedKey.length; i++) {
    result |= expectedKey.charCodeAt(i) ^ receivedKey.charCodeAt(i);
  }
  return result === 0;
}
```

#### Handshake Verification (App.tsx)

```typescript
// /home/meywd/zajel/packages/web-client/src/App.tsx (lines 135-155)

onHandshake: (receivedKey) => {
  // Verify the key matches what we got from signaling
  // This prevents MITM attacks where an attacker substitutes their own key
  const currentPeerCode = peerCodeRef.current;
  if (!currentPeerCode) {
    console.error('Handshake verification failed: no peer code');
    setError('Security error: Connection verification failed');
    handleDisconnect();
    return;
  }

  if (!cryptoService.verifyPeerKey(currentPeerCode, receivedKey)) {
    console.error('Handshake verification failed: key mismatch - possible MITM attack!');
    setError('Security error: Key verification failed. The connection may have been intercepted.');
    handleDisconnect();
    return;
  }

  setState('connected');
  // Show security reminder on first connection
  setShowSecurityReminder(true);
}
```

---

## 2. Verification Gap Identified

### 2.1 What IS Protected

| Attack Scenario | Protection Status | Mechanism |
|-----------------|-------------------|-----------|
| Passive signaling server eavesdropping | PROTECTED | E2E encryption (keys never visible to server) |
| Key substitution at signaling time | DETECTED | Handshake verification catches mismatch |
| Replay attacks | PROTECTED | Sequence numbers + sliding window |
| Message tampering | PROTECTED | ChaCha20-Poly1305 AEAD |

### 2.2 What is NOT Protected

| Attack Scenario | Protection Status | Gap |
|-----------------|-------------------|-----|
| MITM controlling both signaling AND TURN | PARTIAL | Only out-of-band fingerprint verification detects |
| Compromised signaling server during initial key exchange | VULNERABLE | Users must manually verify fingerprints |
| Key change detection (returning users) | NOT IMPLEMENTED | No TOFU/key continuity |
| Multi-device attack (impersonation from "new device") | N/A | Single-device model |

### 2.3 Critical Gap: Trust On First Use (TOFU)

The current implementation has a significant limitation:

1. Keys are ephemeral (regenerated each page load)
2. No key persistence across sessions
3. No warning if a "returning" peer has a different key
4. Users must re-verify fingerprints every session

**Impact**: An attacker could perform MITM on a returning connection and the user would have no automated warning.

### 2.4 Fingerprint Verification Gap

While fingerprints are displayed, verification is:
- **Optional**: Users can dismiss the security reminder
- **Manual-only**: No QR code scanning
- **Not recorded**: No way to mark a peer as "verified"

---

## 3. Recommended Verification Approach

### 3.1 Defense-in-Depth Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                    DEFENSE LAYERS                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Layer 1: Transport Security (TLS/WSS)                         │
│  ├── Protects signaling messages in transit                    │
│  └── Server authentication via certificates                    │
│                                                                 │
│  Layer 2: Handshake Key Verification [IMPLEMENTED]             │
│  ├── Compares signaling key with WebRTC handshake key          │
│  └── Detects key substitution by passive MITM                  │
│                                                                 │
│  Layer 3: DTLS-SRTP (WebRTC)                                   │
│  ├── Additional encryption layer for data channels             │
│  └── Certificate fingerprint in SDP                            │
│                                                                 │
│  Layer 4: E2E Encryption (X25519 + ChaCha20-Poly1305)          │
│  ├── Message content encrypted end-to-end                      │
│  └── Only session key holders can decrypt                      │
│                                                                 │
│  Layer 5: Fingerprint Verification [PARTIAL]                   │
│  ├── SHA-256 fingerprints displayed in UI                      │
│  ├── Out-of-band comparison detects active MITM                │
│  └── GAP: No QR code, no verification tracking                 │
│                                                                 │
│  Layer 6: Key Continuity (TOFU) [NOT IMPLEMENTED]              │
│  ├── Store verified keys across sessions                       │
│  ├── Alert on key changes                                      │
│  └── Block connection to changed keys until acknowledged       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Recommended Implementation Phases

#### Phase 1: Immediate (Complete)
- Handshake key verification against signaling key
- Constant-time comparison to prevent timing attacks
- Clear error messaging on verification failure

**Status**: IMPLEMENTED

#### Phase 2: Short-term (Recommended)
- Improve fingerprint display UX
- Add QR code generation/scanning for in-person verification
- Implement Safety Numbers (like Signal)
- Add verification tracking ("Mark as Verified" button)

**Status**: NOT IMPLEMENTED

#### Phase 3: Medium-term
- Trust On First Use (TOFU) with localStorage persistence
- Key change detection and warning UI
- Key change blocking (require acknowledgment)

**Status**: NOT IMPLEMENTED

#### Phase 4: Long-term
- Ed25519 signing for challenge-response verification
- Cross-device key management (if multi-device added)
- Key Transparency (auditable key log)

**Status**: NOT IMPLEMENTED

---

## 4. Implementation Steps

### 4.1 Phase 2: Enhanced Fingerprint Verification

#### 4.1.1 Safety Numbers Implementation

Add to `/home/meywd/zajel/packages/web-client/src/lib/crypto.ts`:

```typescript
/**
 * Generates a Safety Number that uniquely identifies the key pair.
 * Both parties see the same number (order-independent).
 * Format: 60 digits in groups of 5 (12 groups over 2 lines)
 */
generateSafetyNumber(myPublicKey: Uint8Array, peerPublicKey: Uint8Array): string {
  // Sort keys for order-independence
  const [first, second] = [bytesToHex(myPublicKey), bytesToHex(peerPublicKey)].sort();

  // Combine and hash
  const combined = new TextEncoder().encode(first + second);
  const hash = sha256(sha256(combined)); // Double hash for extra mixing

  // Convert to decimal digits
  const hashBigInt = BigInt('0x' + bytesToHex(hash));
  const digits = hashBigInt.toString().padStart(60, '0').slice(0, 60);

  // Format: "12345 67890 12345 67890 12345 67890\n12345 67890 12345 67890 12345 67890"
  const groups = digits.match(/.{5}/g)!;
  return groups.slice(0, 6).join(' ') + '\n' + groups.slice(6, 12).join(' ');
}
```

#### 4.1.2 QR Code Verification

Add QR code support using a library like `qrcode.react`:

```typescript
// Generate QR data
const qrData = `zajel:v1:${safetyNumber.replace(/[\s\n]/g, '')}`;

// Validation function
function validateQRCode(scanned: string, expected: string): boolean {
  const match = scanned.match(/^zajel:v1:(\d{60})$/);
  if (!match) return false;
  return match[1] === expected.replace(/[\s\n]/g, '');
}
```

### 4.2 Phase 3: TOFU Implementation

#### 4.2.1 Key Storage Interface

```typescript
// /home/meywd/zajel/packages/web-client/src/lib/trustedKeys.ts

interface TrustedPeer {
  peerId: string;
  publicKeyFingerprint: string;
  verifiedAt: Date;
  verificationMethod: 'safety_number' | 'qr_code' | 'manual' | 'tofu';
}

class TrustedKeyStore {
  private readonly STORAGE_KEY = 'zajel_trusted_keys';

  trustKey(peerId: string, publicKeyFingerprint: string, method: string): void {
    const peers = this.loadPeers();
    peers[peerId] = {
      peerId,
      publicKeyFingerprint,
      verifiedAt: new Date(),
      verificationMethod: method,
    };
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(peers));
  }

  checkKey(peerId: string, publicKeyFingerprint: string): 'trusted' | 'new' | 'changed' {
    const peers = this.loadPeers();
    const stored = peers[peerId];

    if (!stored) return 'new';
    if (stored.publicKeyFingerprint === publicKeyFingerprint) return 'trusted';
    return 'changed';
  }

  private loadPeers(): Record<string, TrustedPeer> {
    try {
      return JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '{}');
    } catch {
      return {};
    }
  }
}
```

#### 4.2.2 Key Change Warning Component

A `KeyChangeWarning.tsx` component already exists in the codebase but needs integration:

```typescript
// Integration in App.tsx onPairMatched handler:
const keyStatus = trustedKeyStore.checkKey(peerCode, fingerprint);
if (keyStatus === 'changed') {
  setShowKeyChangeWarning(true);
  setPendingConnection({ peerCode, peerPublicKey, isInitiator });
  return; // Block connection until user acknowledges
}
```

---

## 5. Comparison with Other Secure Messaging Apps

### 5.1 Summary Comparison Table

| Feature | Signal | Wire | Matrix | WhatsApp | Zajel (Current) | Zajel (Proposed) |
|---------|--------|------|--------|----------|-----------------|------------------|
| **Handshake Verification** | X3DH binding | DTLS fingerprint via Proteus | Olm session binding | X3DH binding | Signaling vs WebRTC key match | Same |
| **Fingerprint Format** | 60 digits | Hex per device | 7 emoji | 60 digits | 64 hex chars | 60 digits + emoji option |
| **QR Code Verification** | Yes | Yes | Yes | Yes | No | Proposed |
| **TOFU** | Yes + notifications | Yes + blocking | Yes + cross-signing | Yes + Key Transparency | No | Proposed |
| **Key Change Alert** | Non-blocking notification | Blocks until acknowledged | Recovery passphrase | Optional notification | Not implemented | Proposed (blocking) |
| **Safety Numbers** | Yes (per-conversation) | No (per-device) | No (SAS emoji) | Yes | No | Proposed |

### 5.2 Key Patterns to Adopt

#### From Signal
1. **60-digit numeric Safety Numbers** - Universal, language-independent
2. **Per-conversation number** - Simpler than per-device
3. **Sorted key concatenation** - Ensures both parties see same number

#### From Wire
1. **Block messages to unverified changed keys** - Forces user awareness
2. **Visual shield badge for verified conversations**

#### From Matrix
1. **Emoji verification option** (7 from 64) - More memorable than numbers
2. **Cross-signing for multi-device** (future)

#### From WhatsApp
1. **Key Transparency** - Automated verification at scale (long-term goal)

---

## 6. Security Analysis

### 6.1 Threat Model

| Threat Actor | Capability | Current Mitigation | Gap |
|--------------|------------|-------------------|-----|
| Passive Network Observer | Read encrypted traffic | TLS + E2E encryption | None |
| Active MITM on Network | Modify traffic | TLS + E2E encryption + Handshake verification | Out-of-band verification optional |
| Passive Signaling Server | Read signaling messages | E2E encryption (content), key only used for ECDH | None |
| Active Signaling Server (malicious) | Substitute keys during pairing | Handshake verification catches mismatch, fingerprint verification | Fingerprint verification is manual/optional |
| Compromised CA | Issue fraudulent TLS certs | E2E encryption means content still protected | Fingerprint verification needed |
| Returning Attacker | Impersonate previously-connected peer | None | TOFU not implemented |

### 6.2 Handshake Verification Security Properties

**What it verifies:**
- The public key received over the WebRTC data channel matches the key received during signaling
- Constant-time comparison prevents timing side-channel attacks

**What it does NOT verify:**
- That the signaling server provided the genuine peer's key (requires out-of-band fingerprint check)
- That this is the same peer as previous sessions (requires TOFU)
- That the peer controls the corresponding private key (would require challenge-response)

### 6.3 Constant-Time Comparison Implementation

The current implementation uses XOR accumulation:

```typescript
let result = 0;
for (let i = 0; i < expectedKey.length; i++) {
  result |= expectedKey.charCodeAt(i) ^ receivedKey.charCodeAt(i);
}
return result === 0;
```

**Analysis:**
- Avoids early exit that could leak position of first mismatch
- Uses bitwise OR accumulation (cannot reset to 0)
- Final comparison reveals only match/no-match
- Time is O(n) regardless of mismatch position

**Potential Improvement:** Use `crypto.subtle.timingSafeEqual` when available in browser (not widely supported yet).

---

## 7. Testing Recommendations

### 7.1 Unit Tests

```typescript
describe('CryptoService.verifyPeerKey', () => {
  it('should return true for matching keys', async () => {
    const service = new CryptoService();
    await service.initialize();

    const peerKey = 'SGVsbG9Xb3JsZA=='; // Example base64 key
    service.establishSession('peer-1', peerKey);

    expect(service.verifyPeerKey('peer-1', peerKey)).toBe(true);
  });

  it('should return false for mismatched keys', async () => {
    const service = new CryptoService();
    await service.initialize();

    service.establishSession('peer-1', 'SGVsbG9Xb3JsZA==');

    expect(service.verifyPeerKey('peer-1', 'DIFFERENT-KEY==')).toBe(false);
  });

  it('should return false for unknown peer', async () => {
    const service = new CryptoService();
    await service.initialize();

    expect(service.verifyPeerKey('unknown-peer', 'anykey')).toBe(false);
  });

  it('should use constant-time comparison', async () => {
    // This test verifies timing characteristics
    const service = new CryptoService();
    await service.initialize();

    const longKey = 'A'.repeat(1000);
    service.establishSession('peer-1', longKey);

    // Measure time for early vs late mismatch
    const earlyMismatch = 'B' + 'A'.repeat(999);
    const lateMismatch = 'A'.repeat(999) + 'B';

    const iterations = 10000;

    const startEarly = performance.now();
    for (let i = 0; i < iterations; i++) {
      service.verifyPeerKey('peer-1', earlyMismatch);
    }
    const earlyTime = performance.now() - startEarly;

    const startLate = performance.now();
    for (let i = 0; i < iterations; i++) {
      service.verifyPeerKey('peer-1', lateMismatch);
    }
    const lateTime = performance.now() - startLate;

    // Times should be roughly equal (within 20% variance)
    const ratio = earlyTime / lateTime;
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.2);
  });
});
```

### 7.2 Integration Tests

```typescript
describe('Handshake Verification Flow', () => {
  it('should complete connection when keys match', async () => {
    // Setup two clients
    // Connect and pair
    // Verify both reach 'connected' state
  });

  it('should reject connection when handshake key differs from signaling key', async () => {
    // Setup client with mocked WebRTC
    // Inject different key in handshake message
    // Verify error state and disconnection
  });

  it('should display security reminder after successful handshake', async () => {
    // Complete connection
    // Verify security reminder modal is shown
  });
});
```

### 7.3 Manual Testing Scenarios

1. **Normal Flow**: Connect two clients, verify both complete handshake
2. **MITM Simulation**: Modify signaling server to substitute key, verify rejection
3. **Fingerprint Comparison**: Compare displayed fingerprints between clients
4. **Error Recovery**: Trigger handshake failure, verify clean disconnect and error message

---

## 8. Conclusion

### 8.1 Current State Summary

The Zajel web client has implemented the core handshake key verification mechanism:

| Component | Status |
|-----------|--------|
| Peer key storage during session establishment | IMPLEMENTED |
| Constant-time key comparison | IMPLEMENTED |
| Handshake verification in App.tsx | IMPLEMENTED |
| Error handling on verification failure | IMPLEMENTED |
| Fingerprint display in UI | IMPLEMENTED |
| QR code verification | NOT IMPLEMENTED |
| Safety Numbers | NOT IMPLEMENTED |
| TOFU (key persistence) | NOT IMPLEMENTED |
| Key change detection/warning | NOT IMPLEMENTED |

### 8.2 Priority Recommendations

| Priority | Feature | Effort | Security Impact |
|----------|---------|--------|-----------------|
| P0 (DONE) | Handshake key verification | Low | High - Prevents passive MITM |
| P1 | Safety Numbers implementation | Medium | High - Industry-standard verification |
| P1 | QR code scanning | Low | Medium - Easier in-person verification |
| P1 | TOFU with key change warnings | Medium | High - Detects key substitution on reconnection |
| P2 | Verification status tracking | Low | Medium - UI feedback for verified peers |
| P3 | Ed25519 challenge-response | High | Medium - Proves key ownership |
| P3 | Key Transparency | High | High - Automated verification at scale |

### 8.3 References

- [Signal X3DH Specification](https://signal.org/docs/specifications/x3dh/)
- [RFC 8827 - WebRTC Security Architecture](https://datatracker.ietf.org/doc/html/rfc8827)
- [RFC 6189 - ZRTP](https://datatracker.ietf.org/doc/html/rfc6189)
- [Matrix Cross-Signing](https://matrix.org/docs/older/e2ee-cross-signing/)
- [Wire Security Whitepaper](https://wire.com/en/security)
- [WhatsApp Key Transparency](https://engineering.fb.com/2023/04/13/security/whatsapp-key-transparency/)

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-01-11 | Claude | Initial research document creation |
