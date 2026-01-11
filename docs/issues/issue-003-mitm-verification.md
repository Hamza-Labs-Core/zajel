# Issue #3: MITM Vulnerability - No Key Verification

**Status**: Partial Implementation
**Severity**: High
**Category**: Security
**Related Files**:
- `/home/meywd/zajel/packages/web-client/src/lib/crypto.ts` (lines 58-99, 101-109)
- `/home/meywd/zajel/packages/web-client/src/App.tsx` (lines 39-42, 120-125, 503-607)
- `/home/meywd/zajel/packages/app/lib/core/crypto/crypto_service.dart`
- `/home/meywd/zajel/packages/web-client/src/lib/webrtc.ts` (lines 143-154)

---

## Current State Analysis

### What is Implemented

#### 1. Fingerprint Generation (Web Client)

The web client has fingerprint generation implemented in `crypto.ts`:

```typescript
// crypto.ts lines 67-72
getPublicKeyFingerprint(): string {
  if (!this.keyPair) throw new Error('CryptoService not initialized');
  const hash = sha256(this.keyPair.publicKey);
  // Use full 256-bit hash for collision resistance
  return formatFingerprint(bytesToHex(hash));
}

// crypto.ts lines 82-98
getPeerPublicKeyFingerprint(peerPublicKeyBase64: string): string {
  // Validates and computes SHA-256 fingerprint of peer's public key
  // Returns formatted hex string (uppercase, space-separated 4-char groups)
}
```

**Fingerprint Format**: `ABCD 1234 EF56 7890 ...` (64 hex characters = 256 bits)

#### 2. UI Display (Web Client)

The `App.tsx` displays fingerprints in two places:

1. **Security Info Panel** (lines 503-536): A hidden panel accessible via lock button
2. **Security Reminder Modal** (lines 540-607): One-time popup on connection

```typescript
// App.tsx line 39-42
const [myFingerprint, setMyFingerprint] = useState('');
const [peerFingerprint, setPeerFingerprint] = useState('');
const [showSecurityInfo, setShowSecurityInfo] = useState(false);
const [showSecurityReminder, setShowSecurityReminder] = useState(false);
```

#### 3. Handshake (Lacks Verification)

The WebRTC handshake does not verify that the key received over WebRTC matches the key from signaling:

```typescript
// App.tsx lines 120-125
onHandshake: (receivedKey) => {
  // Verify the key matches what we got from signaling
  // For simplicity, we trust the signaling server's key exchange
  setState('connected');
  setShowSecurityReminder(true);
},
```

**Critical Issue**: The comment says "For simplicity, we trust the signaling server" - the handshake key is received but never compared to the signaling key.

### What is NOT Implemented

1. **Mobile App (Flutter)**: No fingerprint generation or display in `crypto_service.dart`
2. **Forced Verification Flow**: Users can dismiss the security reminder without action
3. **Safety Numbers**: No cryptographic binding of both parties' keys
4. **QR Code Verification**: No in-person verification mechanism
5. **TOFU (Trust On First Use)**: No key persistence or change detection
6. **Handshake Key Verification**: Keys received in handshake are ignored

---

## Risk Assessment

### Attack Scenario: Compromised Signaling Server

```
Alice                    Eve (MITM)               Bob
  |                         |                      |
  |-- publicKey_A --------->|                      |
  |                         |-- publicKey_E ------>|
  |                         |                      |
  |<-------- publicKey_E ---|                      |
  |                         |<----- publicKey_B ---|
  |                         |                      |
  |== E2E encrypted ========|== E2E encrypted ====|
  |   (with Eve's key)      |   (with Eve's key)  |
```

**Impact**:
- Eve can read ALL messages between Alice and Bob
- Eve can modify messages in transit
- Neither party would know unless they verify fingerprints out-of-band
- The verification UI exists but users are not required to use it

### Likelihood Assessment

| Factor | Rating | Notes |
|--------|--------|-------|
| Server Compromise | Medium | Single point of failure for key exchange |
| User Awareness | Low | Most users will dismiss the security reminder |
| Fingerprint Comparison | Low | Requires separate trusted channel |
| Current Mitigation | Weak | Display-only, no enforcement |

### Overall Risk: **HIGH**

The cryptographic primitives are sound (X25519 + ChaCha20-Poly1305 + SHA-256 fingerprints), but the trust model is broken by relying on the signaling server for key exchange without mandatory verification.

---

## Proposed Solutions

### Solution 1: Verify Handshake Key (Quick Win - Priority: P0)

**Problem**: The WebRTC handshake sends the public key again, but it is never verified against the signaling key.

**Fix**: Compare handshake key with signaling key:

```typescript
// App.tsx - Updated onHandshake handler
onHandshake: (receivedKey) => {
  const signalingKey = /* stored from onPairMatched */;

  if (receivedKey !== signalingKey) {
    // Keys don't match - possible MITM attack
    setError('Security Alert: Key mismatch detected. Connection may be compromised.');
    handleDisconnect();
    return;
  }

  // Keys match - connection is secure against passive signaling server
  setState('connected');
  setShowSecurityReminder(true);
},
```

**Note**: This only protects against passive eavesdropping by the signaling server. An active MITM controlling both signaling and WebRTC relay (TURN) could still substitute keys in both channels. This is why fingerprint verification remains essential.

### Solution 2: Safety Numbers (Priority: P1)

Implement Signal-style Safety Numbers that cryptographically bind both parties' keys:

```typescript
// crypto.ts - New method
/**
 * Generate a Safety Number that uniquely identifies the key pair.
 * Both parties should see the same number (order-independent).
 *
 * @param myPublicKey - Our public key
 * @param theirPublicKey - Peer's public key
 * @returns A formatted safety number string
 */
generateSafetyNumber(myPublicKey: Uint8Array, theirPublicKey: Uint8Array): string {
  // Sort keys to ensure both parties generate the same number
  const [first, second] = [myPublicKey, theirPublicKey]
    .map(k => bytesToHex(k))
    .sort();

  // Combine and hash
  const combined = hexToBytes(first + second);
  const hash = sha256(combined);

  // Format as 60 digits (6 groups of 5 digits each, 2 rows)
  // Signal uses this format for readability
  const hashNum = BigInt('0x' + bytesToHex(hash));
  let digits = hashNum.toString().padStart(60, '0').slice(0, 60);

  // Format: "12345 67890 12345 67890 12345 67890\n12345 67890 12345 67890 12345 67890"
  return digits.match(/.{5}/g)!.join(' ').replace(/(.{35}) /, '$1\n');
}
```

**UI Component** (React):

```tsx
// components/SafetyNumber.tsx
interface SafetyNumberProps {
  safetyNumber: string;
  peerName: string;
  onVerified: () => void;
  onClose: () => void;
}

export function SafetyNumber({ safetyNumber, peerName, onVerified, onClose }: SafetyNumberProps) {
  const [verified, setVerified] = useState(false);

  return (
    <div class="safety-number-modal">
      <h2>Verify Security with {peerName}</h2>

      <p class="instructions">
        Compare this number with {peerName} using a trusted channel
        (voice call, video chat, or in person). If they match, your
        connection is secure.
      </p>

      <div class="safety-number">
        <code>{safetyNumber}</code>
      </div>

      <div class="verification-options">
        <label>
          <input
            type="checkbox"
            checked={verified}
            onChange={(e) => setVerified(e.target.checked)}
          />
          I have verified this number matches
        </label>
      </div>

      <div class="actions">
        <button class="btn-secondary" onClick={onClose}>
          Skip (Not Recommended)
        </button>
        <button
          class="btn-primary"
          disabled={!verified}
          onClick={onVerified}
        >
          Mark as Verified
        </button>
      </div>
    </div>
  );
}
```

### Solution 3: QR Code Verification (Priority: P2)

For in-person verification, generate a QR code containing the Safety Number:

```typescript
// crypto.ts
generateVerificationQRData(safetyNumber: string): string {
  // Simple format: zajel:<version>:<safety-number-no-spaces>
  return `zajel:1:${safetyNumber.replace(/[\s\n]/g, '')}`;
}

// QR scanning validates the number matches what we computed locally
validateVerificationQR(scannedData: string, expectedSafetyNumber: string): boolean {
  const match = scannedData.match(/^zajel:1:(\d{60})$/);
  if (!match) return false;

  const scannedNumber = match[1];
  const expectedNumber = expectedSafetyNumber.replace(/[\s\n]/g, '');

  return scannedNumber === expectedNumber;
}
```

**Mobile Implementation** (Flutter):

```dart
// lib/features/security/qr_verification_screen.dart
class QRVerificationScreen extends StatelessWidget {
  final String safetyNumber;
  final String peerName;

  Future<void> _scanAndVerify(BuildContext context) async {
    final result = await BarcodeScanner.scan();

    if (result.type == ResultType.Barcode) {
      final isValid = _validateQRData(result.rawContent, safetyNumber);

      if (isValid) {
        _showVerificationSuccess(context);
      } else {
        _showVerificationFailed(context);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('Verify with $peerName')),
      body: Column(
        children: [
          // QR code display
          QrImageView(
            data: 'zajel:1:${safetyNumber.replaceAll(RegExp(r'\s'), '')}',
            size: 200,
          ),

          // Safety number display
          Text(safetyNumber, style: const TextStyle(fontFamily: 'monospace')),

          // Scan button
          ElevatedButton.icon(
            icon: const Icon(Icons.qr_code_scanner),
            label: const Text('Scan Partner\'s Code'),
            onPressed: () => _scanAndVerify(context),
          ),
        ],
      ),
    );
  }
}
```

### Solution 4: Trust On First Use (TOFU) with Key Change Detection (Priority: P1)

Store verified keys and warn on changes:

```typescript
// lib/trustedKeys.ts
interface TrustedKey {
  peerId: string;
  peerName: string;
  publicKeyFingerprint: string;
  verifiedAt: Date;
  verificationMethod: 'safety_number' | 'qr_code' | 'manual';
}

class TrustedKeyStore {
  private keys: Map<string, TrustedKey> = new Map();

  // Store a verified key
  trustKey(peerId: string, publicKey: string, method: string): void {
    const fingerprint = cryptoService.getPeerPublicKeyFingerprint(publicKey);
    this.keys.set(peerId, {
      peerId,
      peerName: '', // Set later
      publicKeyFingerprint: fingerprint,
      verifiedAt: new Date(),
      verificationMethod: method as any,
    });
    this.persist();
  }

  // Check if a key has changed
  checkKey(peerId: string, publicKey: string): 'trusted' | 'new' | 'changed' {
    const stored = this.keys.get(peerId);
    if (!stored) return 'new';

    const currentFingerprint = cryptoService.getPeerPublicKeyFingerprint(publicKey);
    if (stored.publicKeyFingerprint === currentFingerprint) {
      return 'trusted';
    }
    return 'changed';
  }
}
```

**Key Change Warning UI**:

```tsx
// components/KeyChangeWarning.tsx
export function KeyChangeWarning({ peerName, oldFingerprint, newFingerprint, onAccept, onReject }) {
  return (
    <div class="warning-modal critical">
      <div class="warning-icon">
        <span class="icon-warning-large" />
      </div>

      <h2>Security Warning</h2>

      <p class="warning-text">
        <strong>{peerName}'s</strong> encryption key has changed.
        This could mean:
      </p>

      <ul>
        <li>They reinstalled the app or cleared data</li>
        <li>They are using a new device</li>
        <li class="danger">Someone may be intercepting your messages</li>
      </ul>

      <div class="fingerprint-comparison">
        <div class="old">
          <label>Previous Key:</label>
          <code>{oldFingerprint}</code>
        </div>
        <div class="new">
          <label>New Key:</label>
          <code>{newFingerprint}</code>
        </div>
      </div>

      <p class="recommendation">
        Contact {peerName} through another channel to verify this change.
      </p>

      <div class="actions">
        <button class="btn-danger" onClick={onReject}>
          Block Connection
        </button>
        <button class="btn-warning" onClick={onAccept}>
          Accept New Key (Risky)
        </button>
      </div>
    </div>
  );
}
```

### Solution 5: Mobile App Fingerprint Implementation (Priority: P1)

The Flutter app lacks fingerprint generation. Add to `crypto_service.dart`:

```dart
// lib/core/crypto/crypto_service.dart

import 'package:crypto/crypto.dart' as crypto;

/// Generate a SHA-256 fingerprint of our public key.
///
/// Returns a formatted string suitable for display and comparison.
Future<String> getPublicKeyFingerprint() async {
  final publicKeyBytes = await getPublicKeyBytes();
  final hash = crypto.sha256.convert(publicKeyBytes);
  return _formatFingerprint(hash.toString());
}

/// Generate a SHA-256 fingerprint of a peer's public key.
String getPeerPublicKeyFingerprint(String publicKeyBase64) {
  final publicKeyBytes = base64Decode(publicKeyBase64);
  if (publicKeyBytes.length != 32) {
    throw CryptoException('Invalid peer public key: expected 32 bytes');
  }
  final hash = crypto.sha256.convert(publicKeyBytes);
  return _formatFingerprint(hash.toString());
}

/// Generate a Safety Number for verification.
Future<String> generateSafetyNumber(String peerPublicKeyBase64) async {
  final myKey = await getPublicKeyBytes();
  final peerKey = base64Decode(peerPublicKeyBase64);

  // Sort keys for order-independence
  final keys = [myKey, peerKey];
  keys.sort((a, b) => _compareBytes(a, b));

  // Combine and hash
  final combined = Uint8List(64);
  combined.setAll(0, keys[0]);
  combined.setAll(32, keys[1]);

  final hash = crypto.sha256.convert(combined);

  // Format as 60 digits in 5-digit groups
  final hashBigInt = BigInt.parse(hash.toString(), radix: 16);
  final digits = hashBigInt.toString().padLeft(60, '0').substring(0, 60);

  // Format: "12345 67890 12345 67890 12345 67890"
  final groups = <String>[];
  for (var i = 0; i < 60; i += 5) {
    groups.add(digits.substring(i, i + 5));
  }

  return '${groups.sublist(0, 6).join(' ')}\n${groups.sublist(6, 12).join(' ')}';
}

String _formatFingerprint(String hex) {
  // Format as "ABCD 1234 EF56 ..."
  final buffer = StringBuffer();
  for (var i = 0; i < hex.length; i += 4) {
    if (i > 0) buffer.write(' ');
    buffer.write(hex.substring(i, (i + 4).clamp(0, hex.length)).toUpperCase());
  }
  return buffer.toString();
}

int _compareBytes(Uint8List a, Uint8List b) {
  for (var i = 0; i < a.length && i < b.length; i++) {
    if (a[i] != b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
```

---

## Implementation Priority

| Priority | Solution | Effort | Impact |
|----------|----------|--------|--------|
| **P0** | Verify handshake key matches signaling key | Low (1 day) | Prevents passive MITM |
| **P1** | Safety Numbers implementation | Medium (3-5 days) | Industry-standard verification |
| **P1** | TOFU with key change detection | Medium (3-5 days) | Detects key substitution |
| **P1** | Mobile fingerprint support | Low (2 days) | Parity with web client |
| **P2** | QR code verification | Medium (3-5 days) | In-person verification |

---

## Testing Plan

### Unit Tests

```typescript
// crypto.test.ts additions
describe('Safety Numbers', () => {
  it('should generate same number regardless of key order', async () => {
    const service1 = new CryptoService();
    const service2 = new CryptoService();
    await service1.initialize();
    await service2.initialize();

    const sn1 = service1.generateSafetyNumber(
      service1.getPublicKeyBytes(),
      service2.getPublicKeyBytes()
    );
    const sn2 = service2.generateSafetyNumber(
      service2.getPublicKeyBytes(),
      service1.getPublicKeyBytes()
    );

    expect(sn1).toBe(sn2);
  });

  it('should generate different numbers for different key pairs', async () => {
    const service1 = new CryptoService();
    const service2 = new CryptoService();
    const service3 = new CryptoService();
    await Promise.all([
      service1.initialize(),
      service2.initialize(),
      service3.initialize(),
    ]);

    const sn12 = service1.generateSafetyNumber(
      service1.getPublicKeyBytes(),
      service2.getPublicKeyBytes()
    );
    const sn13 = service1.generateSafetyNumber(
      service1.getPublicKeyBytes(),
      service3.getPublicKeyBytes()
    );

    expect(sn12).not.toBe(sn13);
  });
});

describe('Key Change Detection', () => {
  it('should detect when peer key changes', () => {
    const store = new TrustedKeyStore();
    const oldKey = 'base64-encoded-old-key...';
    const newKey = 'base64-encoded-new-key...';

    store.trustKey('peer-1', oldKey, 'safety_number');

    expect(store.checkKey('peer-1', oldKey)).toBe('trusted');
    expect(store.checkKey('peer-1', newKey)).toBe('changed');
    expect(store.checkKey('peer-2', newKey)).toBe('new');
  });
});
```

### E2E Tests

1. **MITM Detection Test**: Simulate signaling server substituting keys, verify warning is shown
2. **Safety Number Consistency**: Verify both clients generate identical safety numbers
3. **Key Change Warning**: Verify warning appears when peer key changes
4. **QR Verification Flow**: Test camera scanning and validation

---

## References

- [Signal Safety Numbers Documentation](https://signal.org/docs/specifications/x3dh/)
- [WhatsApp Security Whitepaper](https://www.whatsapp.com/security/WhatsApp-Security-Whitepaper.pdf)
- [TOFU in SSH](https://en.wikipedia.org/wiki/Trust_on_first_use)
- [WebRTC Security Considerations](https://www.w3.org/TR/webrtc/#security-considerations)

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-01-11 | Claude | Initial analysis and proposal |
| 2026-01-11 | Claude | Added research on how other apps solve MITM verification |

---

## Research: How Other Apps Solve This

This section documents how major secure messaging applications implement MITM key verification, providing implementation patterns and UX insights that can inform Zajel's approach.

### 1. Signal: Safety Numbers

**Source**: [Signal Safety Numbers Blog](https://signal.org/blog/safety-number-updates/) | [Signal Protocol Docs](https://signal.org/docs/)

#### Fingerprint Generation Algorithm

Signal uses the `NumericFingerprintGenerator` class with the following approach:

```java
// Simplified from libsignal-protocol-java
public class NumericFingerprintGenerator {
    private final int iterations;

    public NumericFingerprintGenerator(int iterations) {
        this.iterations = iterations;  // Typically 5200 for >112 bits security
    }

    private byte[] getFingerprint(byte[] publicKey, byte[] stableIdentifier) {
        MessageDigest digest = MessageDigest.getInstance("SHA-512");

        // Initial hash: version + public key + identifier (phone number)
        byte[] hash = digest.digest(concat(VERSION, publicKey, stableIdentifier));

        // Iterate to increase computational cost
        for (int i = 0; i < iterations; i++) {
            digest.update(hash);
            hash = digest.digest(publicKey);
        }

        return hash;
    }
}
```

**Key Technical Details**:
- Uses **SHA-512** for hashing
- Includes **phone number** in hash input to prevent pre-computation attacks
- Uses **5200 iterations** for >112 bits of security
- Outputs **60 decimal digits** formatted as 12 groups of 5 digits
- Safety number = sorted concatenation of two 30-digit individual fingerprints

**Security Level by Iterations**:
| Iterations | Security Level |
|------------|----------------|
| 1024 | ~109.7 bits |
| 1400 | >110 bits |
| 5200 | >112 bits |

#### Display Format

```
12345 67890 12345 67890 12345 67890
12345 67890 12345 67890 12345 67890
```

The format was chosen because:
- **Numeric encoding is universal** - works across all alphabets/languages
- **Easier to compare** than hexadecimal (half the comparison length)
- **5-digit groups** match natural reading patterns

#### Verification UX Flow

1. User taps contact name > "View Safety Number"
2. Both users see identical 60-digit number + QR code
3. **In-person**: Scan QR code for instant verification
4. **Remote**: Read numbers aloud over voice/video call
5. Once verified, option to "Mark as Verified"
6. Verified contacts show a checkmark badge

#### Key Change Handling (TOFU)

- Safety Numbers change when **identity key changes** (new device, reinstall)
- Signal shows a **non-blocking notification**: "Safety number changed"
- User can tap to view and re-verify
- Previous verification status is cleared

**Weakness**: Research shows most users ignore "safety number changed" warnings due to warning fatigue.

#### Unique Approach Worth Adopting

- **Iteration-based hash stretching** increases brute-force resistance
- **Phone number binding** prevents rainbow table attacks
- **QR code + numeric dual mode** accommodates different verification scenarios

---

### 2. Telegram: Secret Chat Key Visualization

**Source**: [Telegram E2E API](https://core.telegram.org/api/end-to-end) | [Telegram Tech FAQ](https://core.telegram.org/techfaq)

#### Fingerprint Generation

Telegram uses a **hybrid hash approach** combining SHA-1 and SHA-256:

```
Key Visualization = SHA1(initial_key)[0:128 bits] || SHA256(layer_46_key)[0:160 bits]
```

This produces **288 bits** of fingerprint data, displayed as:

1. **Visual Identicon**: A unique geometric pattern/image
2. **Textual Representation**: Shown in newer app versions alongside the image

#### Technical Implementation

```python
# Pseudocode for key visualization
def generate_key_visualization(initial_key, current_key):
    sha1_part = sha1(initial_key)[:16]    # First 128 bits
    sha256_part = sha256(current_key)[:20] # First 160 bits
    return sha1_part + sha256_part         # 288 bits total
```

**Important Distinction**:
- `key_fingerprint` (64 bits of SHA-1) = internal protocol sanity check
- `key_visualization` (288 bits) = user-facing authentication

#### Verification UX Flow

1. Open Secret Chat > Tap contact name > "Encryption Key"
2. View the **identicon image** and/or text representation
3. Compare with partner via secure channel (in person is safest)
4. If images match, the chat is secure from MITM

#### Key Change Handling

- Secret chats use **Perfect Forward Secrecy** with re-keying
- The initial key visualization persists (uses original DH key)
- Re-keying happens transparently without changing the visualization
- If visualization changes, it indicates a new secret chat

#### Verification Mandatory?

**No** - Telegram does not force verification. Users must proactively check.

#### Unique Approach Worth Adopting

- **Visual identicons** are easier to compare than numbers for some users
- **Hybrid hash** (SHA-1 + SHA-256) provides 288 bits vs Signal's 60 decimal digits (~199 bits)
- **Separation of protocol fingerprint vs. user visualization** is clean design

---

### 3. WhatsApp: Security Code Verification (Signal Protocol)

**Source**: [WhatsApp Key Transparency](https://engineering.fb.com/2023/04/13/security/whatsapp-key-transparency/) | [WhatsApp Security](https://www.whatsapp.com/security/)

#### Fingerprint Generation

WhatsApp uses the **Signal Protocol** and displays security codes identically:

- **60-digit numeric code** (same as Signal)
- **QR code** for scanning
- Based on both parties' identity keys

#### Key Transparency Enhancement

WhatsApp added **Key Transparency** (2023) on top of TOFU:

```
Key Transparency Architecture:
1. Server maintains append-only Merkle tree of (user → public_key) mappings
2. Client receives inclusion proofs asserting key exists in directory
3. Third-party auditors can verify tree consistency
4. Prevents server from giving different keys to different users
```

**Implementation**: Based on academic work (CONIKS, SEEMless, Parakeet) → Rust `AKD` crate

#### Verification UX Flow

1. Open chat > Tap contact name > "Encryption"
2. View 60-digit security code and QR code
3. Compare via trusted channel or scan QR
4. System automatically validates via Key Transparency

#### Key Change Notification

- When a contact's key changes, WhatsApp shows notification
- User can enable "Security Notifications" in settings for alerts
- Key Transparency provides cryptographic assurance of key consistency

#### Unique Approach Worth Adopting

- **Key Transparency** provides automated verification without user action
- **Auditable append-only log** prevents server from lying about key history
- **Inclusion proofs** allow clients to verify without trusting server

---

### 4. Wire: Device Fingerprints

**Source**: [Wire Security](https://wire.com/en/security) | [Wire Medium Blog](https://wireapp.medium.com/making-your-conversations-secure-dab207ab77fd)

#### Fingerprint Generation

Wire uses the **Proteus protocol** (their Double Ratchet implementation):

- Each **device** has a unique key pair
- Fingerprint derived from device's public key
- Format: Hexadecimal groups

#### Multi-Device Architecture

Wire is unique in supporting **true multi-device** with per-device keys:

```
User Alice
├── Phone (fingerprint: ABC DEF 123 ...)
├── Laptop (fingerprint: XYZ 789 456 ...)
└── Tablet (fingerprint: QRS TUV 321 ...)
```

**Implication**: Users must verify **each device separately**.

#### Verification UX Flow

1. Open conversation > Tap username > "Devices"
2. See list of all user's devices with fingerprints
3. Verify each device via external channel
4. After verification, **blue shield icon** appears
5. Alerts shown when contact adds new device

#### Key Change Handling

- New device login triggers notification to contacts
- Must re-verify new devices to maintain "verified" status
- Verification is **unidirectional** (Alice verifying Bob doesn't verify Alice for Bob)

#### Modern Enhancement: ID Shield

Wire introduced **ID Shield** with automatic certificate-based verification:
- Removes need for manual fingerprint comparison
- Based on organizational certificates (enterprise feature)
- Automatic identity validation

#### Verification Mandatory?

**No** - But Wire blocks messages to new unverified devices until user acknowledges.

#### Unique Approach Worth Adopting

- **Per-device fingerprints** provide granular verification
- **Blocking new device messages** forces user awareness
- **Visual shield indicator** clearly shows verification status

---

### 5. Matrix/Element: Cross-Signing & Emoji Verification

**Source**: [Matrix Cross-Signing Docs](https://matrix.org/docs/older/e2ee-cross-signing/) | [Element Device Verification](https://element.io/en/features/device-verification)

#### Key Architecture: Cross-Signing

Matrix uses a **three-key hierarchy**:

```
Master Key (MSK)
├── Self-Signing Key (SSK) → Signs user's own devices
└── User-Signing Key (USK) → Signs other users' master keys
```

**Benefits**:
- Verify a user **once**, trust all their current/future devices
- If SSK or USK compromised, can replace without losing MSK
- Trust chains: Device → SSK → MSK → (other user's) MSK → SSK → Device

#### SAS Emoji Verification Protocol

**Short Authentication String (SAS)** protocol:

```python
# Simplified SAS flow
def sas_verification(alice, bob):
    # 1. Both generate ephemeral ECDH keypairs
    alice_ephemeral = generate_keypair()
    bob_ephemeral = generate_keypair()

    # 2. Exchange public keys
    exchange(alice_ephemeral.public, bob_ephemeral.public)

    # 3. Derive shared secret via ECDH
    shared_secret = ecdh(alice_ephemeral.private, bob_ephemeral.public)

    # 4. Generate emoji/number representation
    sas_bytes = hkdf(shared_secret, info="SAS")

    # 5. Display 7 emoji (6 bytes needed, 42 bits of entropy)
    emoji = bytes_to_emoji(sas_bytes[:6])

    # 6. Users compare emoji, confirm match
    return user_confirms_match()
```

#### Emoji Display

- **7 emoji** chosen from pool of **64** carefully selected emoji
- Total possibilities: 64^7 = 2^42 (4 trillion combinations)
- Emoji selected to be **distinguishable** and **easily described**

Example display:
```
[Dog] [Heart] [Rocket] [Key] [Lock] [Sun] [Star]
```

#### Verification UX Flow

1. User A initiates verification with User B
2. Both see **same 7 emoji** or **3 numbers** (each 1000-9999)
3. Compare via any trusted channel
4. Both click "They match!" to confirm
5. Devices exchange signed verification certificates
6. Future sessions auto-trusted via cross-signing chain

#### Key Change Handling

- New device must be verified against existing device
- Or: Enter **recovery passphrase/key** to prove ownership
- Cross-signing propagates trust to new device automatically

#### Unique Approach Worth Adopting

- **Emoji verification** is more memorable than numbers
- **Cross-signing** eliminates per-device verification burden
- **7 emoji from 64** balances security (42 bits) with usability
- **Recovery passphrase** allows self-verification without another device

---

### 6. Keybase: Social Proofs & Device Verification

**Source**: [Keybase Key Model](https://keybase.io/blog/keybase-new-key-model) | [Keybase Docs](https://book.keybase.io/account)

#### Identity Verification via Social Proofs

Keybase's unique approach: **link cryptographic keys to social identities**:

```
User "alice"
├── Twitter: @alice (signed proof posted as tweet)
├── GitHub: alice (signed proof in gist)
├── Website: alice.com (signed proof at /.well-known/keybase.txt)
├── Bitcoin: 1ABC... (signed wallet address)
└── Devices: Phone, Laptop (device-specific keys)
```

**How Social Proofs Work**:
1. User signs a statement: "I am @alice on Twitter and my Keybase key is XYZ"
2. Posts signed statement publicly on that platform
3. Keybase client fetches and verifies signature
4. Proof is publicly auditable by anyone

#### Device-Specific Keys (NaCl)

Each device has its own **NaCl key pair**:

```
Device Provisioning (KEX Protocol):
1. Old device generates shared secret (displayed as word pairs)
2. User enters secret on new device
3. Devices establish encrypted channel via server
4. New device generates keypair, sends public key to old device
5. Old device signs new device's key
6. New device added to user's sigchain
```

#### Paper Keys

Backup recovery mechanism:
- **24 BIP39 mnemonic words** encoding a NaCl keypair
- First 2 words are public label
- Can provision new devices if all other devices lost
- Publicly announced in sigchain (allows revocation)

#### Sigchain: Auditable Key History

Every key operation is recorded in an **append-only sigchain**:

```json
{
  "seqno": 5,
  "prev": "hash_of_link_4",
  "sig_type": "device_add",
  "payload": { "device_name": "My Laptop", "public_key": "..." },
  "signature": "..."
}
```

- Published to Keybase's **Merkle tree**
- Root hash committed to **Bitcoin blockchain** (timestamped)
- Third parties can audit entire history

#### Verification UX Flow

1. Look up user by username or social identity
2. View their **sigchain** showing all linked identities
3. Each identity shows verification status
4. Device list shows all provisioned devices
5. Revoked devices/identities clearly marked

#### Unique Approach Worth Adopting

- **Social proofs** provide identity verification without in-person meeting
- **Sigchain + Merkle tree** prevents server from lying about key history
- **Paper keys** provide secure recovery mechanism
- **Bitcoin timestamping** adds tamper evidence

---

### 7. Threema: Three-Level Trust Indicators

**Source**: [Threema Trust Levels](https://threema.com/en/faq/levels-expl)

#### Trust Level System

Threema uses a **visual dot system** for trust:

| Level | Color | Meaning |
|-------|-------|---------|
| 1 | Red | Key from server, no verification |
| 2 | Orange | Phone/email matched from address book |
| 3 | Green | QR code scanned in person |

#### Fingerprint Generation

```python
fingerprint = sha256(public_key)[:16]  # First 128 bits
# Displayed as hex: "AB12 CD34 EF56 ..."
```

#### Anonymous Identity

- **8-character Threema ID** generated locally (not tied to phone/email)
- Can be 100% anonymous
- Verification levels help establish trust progressively

#### Unique Approach Worth Adopting

- **Three-level trust visualization** clearly communicates verification status
- **Color coding** (red/orange/green) is intuitive
- **Progressive trust** from anonymous to fully verified

---

### 8. Session: Decentralized Identity

**Source**: [Session FAQ](https://getsession.org/faq) | [Session ID vs Phone Numbers](https://getsession.org/blog/session-id-vs-phone-numbers)

#### Decentralized Key Architecture

- **66-character Session ID** = Ed25519 public key
- No phone number or email required
- Messages routed through **onion routing** (3 random nodes)
- **Swarm architecture** for message storage (5-7 nodes per user)

#### Verification Challenge

Without central identity, verification must be:
- Done via external secure channel
- Or: Trust the out-of-band method used to share Session ID

#### Trade-offs

- **No Perfect Forward Secrecy** (by design, for decentralization)
- Simpler protocol, but higher risk if long-term key compromised
- Recovery: Generate new Session ID (lose message history)

#### Unique Approach Worth Adopting

- **No phone number requirement** eliminates metadata linkage
- **Decentralized swarm** prevents central point of compromise
- **Simple ID = public key** is elegant design

---

### Summary: Comparison Matrix

| App | Fingerprint Format | Algorithm | Verification Method | TOFU | Key Change Alert | Unique Feature |
|-----|-------------------|-----------|---------------------|------|------------------|----------------|
| **Signal** | 60 digits (12x5) | SHA-512, 5200 iterations | QR code + numeric | Yes | Non-blocking notification | Phone number binding |
| **Telegram** | Visual identicon | SHA-1 + SHA-256 (288 bits) | Image comparison | Yes | Secret chat restart | Visual identicons |
| **WhatsApp** | 60 digits (Signal) | Signal Protocol | QR code + numeric | Yes + Key Transparency | Optional notification | Append-only key log |
| **Wire** | Hex per device | Proteus (Double Ratchet) | Per-device comparison | Yes | Blocks until acknowledged | Multi-device native |
| **Matrix** | 7 emoji | ECDH + HKDF (42 bits) | Emoji/number comparison | Yes + Cross-signing | Recovery passphrase | Cross-signing hierarchy |
| **Keybase** | Social proofs | NaCl + sigchain | Social identity links | Implicit | Sigchain visible | Blockchain timestamping |
| **Threema** | Hex (128 bits) | SHA-256 truncated | QR code + levels | 3-level trust | Color change | Anonymous IDs + trust levels |
| **Session** | 66-char ID | Ed25519 public key | External channel | Single identity | New ID required | Decentralized + no phone |

---

### Recommendations for Zajel

Based on this research, here are prioritized recommendations:

#### Adopt from Signal
1. **60-digit numeric Safety Numbers** with sorted key concatenation
2. **QR code + numeric dual display** for flexibility
3. **SHA-512 with ~5000 iterations** for hash stretching

#### Adopt from Matrix
4. **Emoji verification option** (7 from 64) for user-friendly comparison
5. **Cross-signing** if multi-device support is added later

#### Adopt from Wire
6. **Block messages to unverified new devices** until acknowledged
7. **Visual verification badge** (shield icon)

#### Adopt from WhatsApp
8. **Key Transparency** for automated trust (future enhancement)

#### Adopt from Threema
9. **Three-level trust indicators** (red/orange/green)
10. **Progressive trust** from untrusted → address book → verified

#### Implementation Priority

| Priority | Feature | Complexity | Impact |
|----------|---------|------------|--------|
| P0 | Safety Numbers (Signal-style) | Medium | High |
| P0 | QR code verification | Low | High |
| P1 | Trust level indicators | Low | Medium |
| P1 | Key change blocking alert | Medium | High |
| P2 | Emoji verification | Medium | Medium |
| P3 | Key Transparency | High | High |

---

### Additional References

- [Signal NumericFingerprintGenerator (GitHub)](https://github.com/signalapp/libsignal-protocol-java/blob/master/java/src/main/java/org/whispersystems/libsignal/fingerprint/NumericFingerprintGenerator.java)
- [Matrix Cross-Signing Proposal](https://github.com/matrix-org/matrix-doc/blob/master/proposals/1756-cross-signing.md)
- [Keybase Protocol Security Review (NCC Group)](https://keybase.io/docs-assets/blog/NCC_Group_Keybase_KB2018_Public_Report_2019-02-27_v1.3.pdf)
- [Trust on First Use (Wikipedia)](https://en.wikipedia.org/wiki/Trust_on_first_use)
- [CONIKS Key Transparency Paper](https://www.usenix.org/conference/usenixsecurity15/technical-sessions/presentation/melara)
- [Matrix SAS Emoji Verification Security Analysis](https://www.uhoreg.ca/blog/20190514-1146)
