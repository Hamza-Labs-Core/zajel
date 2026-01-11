# Issue #3: MITM Warning / Fingerprint Display - Research Document

**Status**: Research Complete
**Date**: 2026-01-11
**Category**: Security / UX
**Related Issue**: `/home/meywd/zajel/docs/issues/issue-003-mitm-verification.md`

---

## Executive Summary

This document provides comprehensive research on fingerprint display and MITM warning implementations across the codebase and industry best practices. The goal is to identify gaps in the current implementation and propose improvements based on how Signal, WhatsApp, Telegram, and other secure messaging apps handle key verification.

---

## 1. Current Implementation Status

### 1.1 Web Client (packages/web-client/src/)

#### Fingerprint Generation (`lib/crypto.ts`)

The web client has a complete fingerprint generation implementation:

```typescript
// Location: /home/meywd/zajel/packages/web-client/src/lib/crypto.ts

// Line 10-16: Format helper
function formatFingerprint(hex: string): string {
  return hex.match(/.{1,4}/g)?.join(' ').toUpperCase() || hex.toUpperCase();
}

// Lines 146-153: Own key fingerprint
getPublicKeyFingerprint(): string {
  if (!this.keyPair) {
    throw new CryptoError('CryptoService not initialized', ErrorCodes.CRYPTO_NOT_INITIALIZED);
  }
  const hash = sha256(this.keyPair.publicKey);
  return formatFingerprint(bytesToHex(hash));
}

// Lines 163-183: Peer key fingerprint
getPeerPublicKeyFingerprint(peerPublicKeyBase64: string): string {
  // Validates key, computes SHA-256, returns formatted hex
}
```

**Format**: `ABCD 1234 EF56 7890 ...` (64 hex characters = 256 bits, 4-char groups)

#### UI Components

**1. FingerprintDisplay Component** (`/home/meywd/zajel/packages/web-client/src/components/FingerprintDisplay.tsx`)

A dedicated component for showing fingerprints with:
- My fingerprint and peer fingerprint display
- Copy to clipboard functionality
- Accessible ARIA labels
- Compact toggle mode
- Verification instructions

**2. ChatView Integration** (`/home/meywd/zajel/packages/web-client/src/components/ChatView.tsx`)

Lines 74-113: Security button in chat header that expands FingerprintDisplay panel.

**3. App.tsx Security Panels** (`/home/meywd/zajel/packages/web-client/src/App.tsx`)

- **Security Info Panel** (lines 593-641): Expandable panel showing fingerprints
- **Security Reminder Modal** (lines 644-734): One-time warning on connection with verification prompts

#### Handshake Key Verification

The web client does verify keys during handshake (`App.tsx` lines 135-155):

```typescript
onHandshake: (receivedKey) => {
  if (!cryptoService.verifyPeerKey(currentPeerCode, receivedKey)) {
    console.error('Handshake verification failed: key mismatch - possible MITM attack!');
    setError('Security error: Key verification failed...');
    handleDisconnect();
    return;
  }
  setState('connected');
  setShowSecurityReminder(true);
}
```

The `verifyPeerKey` method in `crypto.ts` (lines 245-262) uses constant-time comparison.

### 1.2 Flutter App (packages/app/lib/)

#### Fingerprint Generation (`/home/meywd/zajel/packages/app/lib/core/crypto/crypto_service.dart`)

The Flutter app has full fingerprint generation support:

```dart
// Lines 63-75: Own key fingerprint
Future<String> getPublicKeyFingerprint() async {
  final publicKeyBytes = await getPublicKeyBytes();
  final hash = crypto.sha256.convert(publicKeyBytes);
  return _formatFingerprint(hash.toString());
}

// Lines 77-99: Peer key fingerprint
String getPeerPublicKeyFingerprint(String peerPublicKeyBase64) {
  // Validates and formats SHA-256 fingerprint
}

// Lines 104-108: Get peer fingerprint by ID
String? getPeerFingerprintById(String peerId) {
  final publicKey = _peerPublicKeys[peerId];
  if (publicKey == null) return null;
  return getPeerPublicKeyFingerprint(publicKey);
}

// Lines 114-122: Format helper (4-char groups, uppercase)
String _formatFingerprint(String hex) { ... }
```

#### UI Components (`/home/meywd/zajel/packages/app/lib/features/chat/chat_screen.dart`)

**_FingerprintVerificationSection** (lines 643-881):
- Expandable section in peer info bottom sheet
- Loads both own and peer fingerprints
- Instruction banner for verification
- Copy to clipboard for each fingerprint
- Warning when peer fingerprint unavailable
- Success indicator when both fingerprints present

**_FingerprintCard** (lines 885-955):
- Individual fingerprint display card
- Monospace font styling
- Copy button integration

---

## 2. Gap Analysis

### 2.1 What's Implemented

| Feature | Web Client | Flutter App |
|---------|------------|-------------|
| SHA-256 fingerprint generation | Yes | Yes |
| Own key fingerprint display | Yes | Yes |
| Peer key fingerprint display | Yes | Yes |
| Copy to clipboard | Yes | Yes |
| Handshake key verification | Yes | Unknown |
| Security reminder on connect | Yes | No |
| Fingerprint in chat header | Yes | In peer info |
| Accessible labels | Yes | Partial |

### 2.2 What's Missing

| Feature | Gap Description | Priority |
|---------|-----------------|----------|
| **Safety Numbers** | No Signal-style combined fingerprint | High |
| **QR Code Verification** | No in-person scanning option | Medium |
| **Emoji Verification** | No Matrix-style emoji display | Medium |
| **TOFU Key Persistence** | Keys not stored for change detection | High |
| **Key Change Alerts** | No warning when peer key changes | High |
| **Trust Level Indicators** | No Threema-style trust levels | Medium |
| **Verification Badge** | No indicator for verified connections | Medium |
| **Forced Verification** | Users can skip without action | Low |

---

## 3. Industry Best Practices Research

### 3.1 Signal: Safety Numbers

**Source**: [Signal Safety Numbers Blog](https://signal.org/blog/safety-number-updates/)

#### How It Works

Signal generates a "Safety Number" that:
- Combines both parties' identity keys
- Uses SHA-512 with ~5200 iterations for hash stretching
- Includes phone number to prevent pre-computation attacks
- Produces 60 decimal digits (12 groups of 5 digits)

#### Display Format

```
12345 67890 12345 67890 12345 67890
12345 67890 12345 67890 12345 67890
```

#### Key Design Decisions

1. **Numeric encoding** - Works across all languages/alphabets
2. **5-digit groups** - Match natural reading patterns
3. **Sorted concatenation** - Both parties see identical number
4. **QR code + numeric dual display** - Flexibility for verification methods

#### TOFU Implementation

- Safety number changes when identity key changes (device switch, reinstall)
- Non-blocking notification: "Safety number with X has changed"
- Previous verification status cleared
- User must re-verify to restore verified status

### 3.2 WhatsApp: Security Code + Key Transparency

**Source**: [WhatsApp Security](https://blog.whatsapp.com/new-security-features-account-protect-device-verification-automatic-security-codes)

#### How It Works

WhatsApp uses the Signal Protocol and displays:
- 60-digit numeric code (identical to Signal)
- QR code for in-person verification
- Based on both parties' identity keys

#### Key Transparency Enhancement (2023)

Added automated verification via append-only Merkle tree:
- Server maintains (user -> public_key) mappings
- Client receives inclusion proofs
- Third-party auditors verify tree consistency
- Prevents server from giving different keys to different users

#### Security Code Change Notifications

- Optional setting: "Security Notifications"
- Alerts when contact's encryption key changes
- Key Transparency provides cryptographic assurance

### 3.3 Telegram: Secret Chat Key Visualization

**Source**: [Telegram E2E API](https://core.telegram.org/api/end-to-end)

#### How It Works

Telegram uses a hybrid hash approach:
```
Key Visualization = SHA1(initial_key)[0:128 bits] || SHA256(layer_46_key)[0:160 bits]
```

This produces 288 bits of fingerprint data, displayed as:
1. **Visual Identicon** - Unique geometric pattern/image
2. **Textual Representation** - Hex string in newer versions

#### Key Design Decisions

1. **Visual comparison** - Images are easier for some users
2. **288 bits** - Higher entropy than Signal's 60 digits (~199 bits)
3. **Separate protocol fingerprint vs. user visualization** - Clean separation

#### Perfect Forward Secrecy

- Secret chats use PFS with re-keying
- Initial key visualization persists
- Re-keying happens transparently

### 3.4 Matrix/Element: Emoji Verification

**Source**: [Matrix Cross-Signing Docs](https://matrix.org/docs/older/e2ee-cross-signing/)

#### How It Works

Matrix uses Short Authentication String (SAS) protocol:
1. Both parties generate ephemeral ECDH keypairs
2. Exchange public keys
3. Derive shared secret
4. Generate 7 emoji (from pool of 64)

#### Emoji Display

```
[Dog] [Heart] [Rocket] [Key] [Lock] [Sun] [Star]
```

- 7 emoji from 64 options = 64^7 = 2^42 combinations
- Emoji selected to be distinguishable and easily described

#### Cross-Signing Hierarchy

```
Master Key (MSK)
├── Self-Signing Key (SSK) → Signs user's own devices
└── User-Signing Key (USK) → Signs other users' master keys
```

Benefits:
- Verify a user once, trust all their devices
- Recovery passphrase for self-verification

### 3.5 Threema: Trust Level Indicators

**Source**: [Threema Trust Levels](https://threema.com/en/faq/levels-expl)

#### Trust Level System

| Level | Color | Meaning |
|-------|-------|---------|
| 1 | Red | Key from server, no verification |
| 2 | Orange | Phone/email matched from address book |
| 3 | Green | QR code scanned in person |

This provides progressive trust from anonymous to fully verified.

---

## 4. Recommendations for Zajel

### 4.1 Immediate Improvements (P0)

#### 4.1.1 Implement Safety Numbers

Replace individual fingerprints with combined Safety Numbers:

```typescript
// packages/web-client/src/lib/crypto.ts

/**
 * Generate a Safety Number combining both parties' keys.
 * Both parties will see the identical number.
 */
generateSafetyNumber(peerPublicKeyBase64: string): string {
  if (!this.keyPair) {
    throw new CryptoError('CryptoService not initialized', ErrorCodes.CRYPTO_NOT_INITIALIZED);
  }

  const myKey = bytesToHex(this.keyPair.publicKey);
  const peerKey = bytesToHex(this.decodePeerKey(peerPublicKeyBase64));

  // Sort keys for order-independence
  const [first, second] = [myKey, peerKey].sort();

  // Combine and hash with iterations for stretching
  let hash = sha256(hexToBytes(first + second));
  for (let i = 0; i < 5200; i++) {
    hash = sha256(hash);
  }

  // Convert to 60 decimal digits
  const hashNum = BigInt('0x' + bytesToHex(hash));
  const digits = hashNum.toString().padStart(60, '0').slice(0, 60);

  // Format: 12 groups of 5 digits
  return digits.match(/.{5}/g)!.join(' ');
}
```

#### 4.1.2 Add TOFU Key Persistence

Store verified keys and detect changes:

```typescript
// packages/web-client/src/lib/trustedKeys.ts

interface TrustedKey {
  peerId: string;
  fingerprint: string;
  verifiedAt: number;
  verificationMethod: 'safety_number' | 'qr_code' | 'unverified';
}

class TrustedKeyStore {
  private readonly STORAGE_KEY = 'zajel_trusted_keys';

  checkKey(peerId: string, publicKey: string): 'new' | 'trusted' | 'changed' {
    const stored = this.get(peerId);
    if (!stored) return 'new';

    const currentFingerprint = cryptoService.getPeerPublicKeyFingerprint(publicKey);
    return stored.fingerprint === currentFingerprint ? 'trusted' : 'changed';
  }

  trustKey(peerId: string, publicKey: string, method: string): void {
    // Store in localStorage with fingerprint
  }
}
```

### 4.2 Short-term Improvements (P1)

#### 4.2.1 Key Change Warning Dialog

Show blocking dialog when key changes:

```tsx
// packages/web-client/src/components/KeyChangeWarning.tsx

<div role="alertdialog" aria-modal="true">
  <h2>Security Warning</h2>
  <p><strong>{peerCode}'s</strong> encryption key has changed.</p>

  <p>This could mean:</p>
  <ul>
    <li>They reinstalled the app</li>
    <li>They are using a new device</li>
    <li class="danger">Someone may be intercepting your messages</li>
  </ul>

  <div class="actions">
    <button onClick={onBlock}>Block Connection</button>
    <button onClick={onAccept}>Accept New Key (Risky)</button>
  </div>
</div>
```

#### 4.2.2 QR Code Verification

Add QR scanning for in-person verification:

```typescript
// QR data format: zajel:1:<safety-number-no-spaces>
const qrData = `zajel:1:${safetyNumber.replace(/\s/g, '')}`;

// Scanning validates match
function validateQR(scanned: string, expected: string): boolean {
  const match = scanned.match(/^zajel:1:(\d{60})$/);
  if (!match) return false;
  return match[1] === expected.replace(/\s/g, '');
}
```

### 4.3 Medium-term Improvements (P2)

#### 4.3.1 Trust Level Indicators

Add Threema-style visual trust levels:

| Level | Icon | Color | Meaning |
|-------|------|-------|---------|
| 1 | Shield outline | Red | Not verified |
| 2 | Shield half | Orange | TOFU trusted (first use) |
| 3 | Shield filled | Green | Manually verified |

#### 4.3.2 Emoji Verification Option

Add Matrix-style emoji alternative:

```typescript
const EMOJI_POOL = [
  '🐶', '❤️', '🚀', '🔑', '🔒', '☀️', '⭐', '🌙',
  '🌈', '🔥', '🌸', '🍎', '🎵', '💎', '🎈', '🏆',
  // ... 64 total emoji
];

function safetyNumberToEmoji(safetyNumber: string): string[] {
  const hash = sha256(safetyNumber);
  const indices = [];
  for (let i = 0; i < 7; i++) {
    indices.push(hash[i] % 64);
  }
  return indices.map(i => EMOJI_POOL[i]);
}
```

### 4.4 Long-term Improvements (P3)

#### 4.4.1 Key Transparency

Implement append-only key log with Merkle tree proofs (like WhatsApp).

#### 4.4.2 Cross-Signing

If multi-device support is added, implement Matrix-style cross-signing.

---

## 5. Implementation Priority Matrix

| Priority | Feature | Effort | Impact | Status |
|----------|---------|--------|--------|--------|
| **P0** | Safety Numbers | 2 days | High | Not started |
| **P0** | TOFU Key Persistence | 2 days | High | Not started |
| **P1** | Key Change Warning | 1 day | High | Not started |
| **P1** | QR Code Verification | 2 days | Medium | Not started |
| **P2** | Trust Level Indicators | 1 day | Medium | Not started |
| **P2** | Emoji Verification | 1 day | Low | Not started |
| **P3** | Key Transparency | 2 weeks | High | Not started |

---

## 6. Comparison with Current State

### Current Implementation Strengths

1. **Solid cryptographic foundation** - SHA-256 fingerprints, X25519 + ChaCha20-Poly1305
2. **Handshake verification exists** - Keys compared between signaling and WebRTC
3. **UI components exist** - FingerprintDisplay, security panels, chat integration
4. **Both platforms covered** - Web and Flutter have fingerprint support
5. **Accessible implementation** - ARIA labels, screen reader support

### Current Implementation Weaknesses

1. **No combined Safety Number** - Users must compare two separate fingerprints
2. **No key persistence** - Cannot detect key changes between sessions
3. **Verification is optional** - Users can skip without consequence
4. **No QR code** - In-person verification is cumbersome
5. **No visual trust indicators** - Verified vs unverified looks the same
6. **Format is hex, not numbers** - Less universal than Signal's numeric format

---

## 7. Security Considerations

### 7.1 Attack Scenarios Addressed

| Scenario | Current Protection | With Recommendations |
|----------|-------------------|---------------------|
| Passive signaling MITM | Handshake verification | Same |
| Active signaling MITM | Manual fingerprint check | Safety Numbers + TOFU |
| Key substitution over time | None | TOFU with alerts |
| Social engineering | Warning prompts | Trust levels + blocking |

### 7.2 Usability vs Security Trade-offs

Signal and WhatsApp research shows:
- Most users ignore "safety number changed" warnings
- Warning fatigue leads to weaker security
- **Recommendation**: Block messages to unverified changed keys until acknowledged

---

## 8. References

### Official Documentation
- [Signal Safety Numbers Blog](https://signal.org/blog/safety-number-updates/)
- [Signal Support: What is a Safety Number](https://support.signal.org/hc/en-us/articles/360007060632)
- [WhatsApp Security Features](https://blog.whatsapp.com/new-security-features-account-protect-device-verification-automatic-security-codes)
- [WhatsApp Security Code Change Notifications](https://faq.whatsapp.com/1524220618005378)
- [Telegram E2E Encryption API](https://core.telegram.org/api/end-to-end)
- [Telegram Tech FAQ](https://core.telegram.org/techfaq)
- [Matrix Cross-Signing](https://matrix.org/docs/older/e2ee-cross-signing/)
- [Threema Trust Levels](https://threema.com/en/faq/levels-expl)

### Security Research
- [TOFU (Trust On First Use) - Wikipedia](https://en.wikipedia.org/wiki/Trust_on_first_use)
- [TOFU Security Model - Double Octopus](https://doubleoctopus.com/security-wiki/protocol/trust-on-first-use/)
- [Improving TOFU with Transparency - Dan Lorenc](https://dlorenc.medium.com/improving-tofu-with-transparency-da674aa2879d)
- [EFF: How to Use Signal](https://ssd.eff.org/module/how-to-use-signal)

### User Experience
- [Using Emoji for Fingerprint Verification - FSFE Blog](http://blogs.fsfe.org/vanitasvitae/2017/05/06/using-emoji-for-fingerprint-verification/)
- [How to Verify Signal Contact Identity](https://www.howtogeek.com/709733/how-to-verify-a-signal-contacts-identity-using-the-safety-number/)

---

## 9. Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-01-11 | Claude | Initial research document created |
