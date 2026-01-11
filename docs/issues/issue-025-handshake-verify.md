# Issue #25: Handshake Verification Missing

## Summary

The WebRTC handshake does not verify that the public key received over the data channel matches the public key provided during the signaling phase. This creates a security vulnerability where a man-in-the-middle (MITM) attacker could potentially intercept the connection.

## Affected Files

- `/home/meywd/zajel/packages/web-client/src/App.tsx` (lines 120-126)
- `/home/meywd/zajel/packages/web-client/src/lib/webrtc.ts` (lines 143-155)
- `/home/meywd/zajel/packages/web-client/src/lib/signaling.ts` (key exchange during pairing)
- `/home/meywd/zajel/packages/web-client/src/lib/crypto.ts` (session establishment)

## Key Exchange Flow Analysis

### Current Flow

1. **Signaling Phase** (signaling.ts):
   - Client A registers with signaling server, providing its public key
   - Client A requests pairing with Client B
   - Client B receives pairing request with Client A's public key via `onPairIncoming(fromCode, fromPublicKey)`
   - On acceptance, both clients receive `pair_matched` event with peer's public key
   - App.tsx `onPairMatched` callback (lines 70-80):
     ```typescript
     onPairMatched: async (peerCode, peerPublicKey, isInitiator) => {
       setPeerCode(peerCode);
       setIncomingRequest(null);
       setState('webrtc_connecting');
       // Establish crypto session and set peer fingerprint
       cryptoService.establishSession(peerCode, peerPublicKey);  // <-- Key stored here
       setPeerFingerprint(cryptoService.getPeerPublicKeyFingerprint(peerPublicKey));
       // Start WebRTC
       await webrtcRef.current?.connect(peerCode, isInitiator);
     }
     ```

2. **WebRTC Phase** (webrtc.ts):
   - After RTCPeerConnection reaches 'connected' state:
     ```typescript
     onStateChange: (rtcState) => {
       if (rtcState === 'connected') {
         setState('handshaking');
         // Send our public key for verification
         webrtc.sendHandshake(cryptoService.getPublicKeyBase64());  // <-- Sends key
       }
     }
     ```
   - Peer receives handshake via message channel (webrtc.ts lines 143-146):
     ```typescript
     if (data.type === 'handshake') {
       this.events.onHandshake(data.publicKey);  // <-- Key passed but not verified
     }
     ```

3. **Handshake Callback** (App.tsx lines 120-126):
   ```typescript
   onHandshake: (receivedKey) => {
     // Verify the key matches what we got from signaling
     // For simplicity, we trust the signaling server's key exchange
     setState('connected');  // <-- NO VERIFICATION PERFORMED
     // Show security reminder on first connection
     setShowSecurityReminder(true);
   }
   ```

### The Problem

The `onHandshake` callback receives the peer's public key sent over WebRTC but:
1. Does NOT compare it with the key received from signaling (`peerPublicKey` from `onPairMatched`)
2. Simply transitions to 'connected' state without any validation
3. The comment even acknowledges this: "For simplicity, we trust the signaling server's key exchange"

## Attack Vector

A compromised or malicious signaling server could:
1. Intercept the pairing request
2. Substitute its own public key during `pair_matched`
3. Perform ECDH key exchange with both parties using different keys
4. Decrypt and re-encrypt all messages between peers

Without handshake verification, even if the WebRTC connection sends the actual peer's key, the receiving client doesn't verify it matches what was received during signaling.

## Proposed Fix

### Option 1: Verify Against Stored Key (Recommended)

Store the expected peer public key and verify during handshake:

**App.tsx changes:**

```typescript
// Add state to track expected peer public key
const [expectedPeerKey, setExpectedPeerKey] = useState<string | null>(null);

// In onPairMatched callback:
onPairMatched: async (peerCode, peerPublicKey, isInitiator) => {
  setPeerCode(peerCode);
  setExpectedPeerKey(peerPublicKey);  // Store expected key
  setIncomingRequest(null);
  setState('webrtc_connecting');
  // ... rest of existing code
}

// In onHandshake callback:
onHandshake: (receivedKey) => {
  // Verify the key matches what we got from signaling
  if (receivedKey !== expectedPeerKey) {
    console.error('Handshake verification failed: key mismatch');
    setError('Security error: Connection key mismatch. Possible MITM attack.');
    handleDisconnect();
    return;
  }
  setState('connected');
  setShowSecurityReminder(true);
}
```

### Option 2: Use CryptoService for Verification

Leverage the existing cryptoService to verify against the session:

**crypto.ts additions:**

```typescript
// Add method to get stored peer public key
getPeerPublicKey(peerId: string): string | null {
  // Would need to store peerPublicKeyBase64 in establishSession
  return this.peerPublicKeys.get(peerId) || null;
}

// Modify establishSession to store the peer's key
private peerPublicKeys = new Map<string, string>();

establishSession(peerId: string, peerPublicKeyBase64: string): void {
  // ... existing validation code ...

  // Store peer public key for later verification
  this.peerPublicKeys.set(peerId, peerPublicKeyBase64);

  // ... rest of existing code ...
}

// Add verification method
verifyPeerKey(peerId: string, receivedKey: string): boolean {
  const expectedKey = this.peerPublicKeys.get(peerId);
  if (!expectedKey) return false;
  return expectedKey === receivedKey;
}
```

**App.tsx changes:**

```typescript
onHandshake: (receivedKey) => {
  const currentPeerCode = peerCodeRef.current;
  if (!currentPeerCode) {
    setError('Handshake failed: no peer code');
    handleDisconnect();
    return;
  }

  if (!cryptoService.verifyPeerKey(currentPeerCode, receivedKey)) {
    console.error('Handshake verification failed: key mismatch');
    console.error('Expected:', cryptoService.getPeerPublicKey(currentPeerCode));
    console.error('Received:', receivedKey);
    setError('Security error: Key verification failed. Possible MITM attack.');
    handleDisconnect();
    return;
  }

  setState('connected');
  setShowSecurityReminder(true);
}
```

### Option 3: Bidirectional Verification with Challenge-Response

For stronger security, implement a challenge-response protocol:

**webrtc.ts additions:**

```typescript
interface HandshakeChallenge {
  type: 'handshake_challenge';
  publicKey: string;
  challenge: string;  // Random nonce
}

interface HandshakeChallengeResponse {
  type: 'handshake_response';
  publicKey: string;
  challenge: string;      // Echo back the challenge
  signature: string;      // Signature of challenge using private key
}
```

This would require signing capabilities which X25519 doesn't provide directly (would need Ed25519 for signing).

## Recommended Implementation

**Option 2** is recommended because:
1. Centralizes key management in CryptoService
2. Enables future enhancements (key change detection, TOFU)
3. Minimal changes to existing code
4. Maintains separation of concerns

## Testing Requirements

1. **Unit Tests:**
   - Test `verifyPeerKey` with matching keys (should pass)
   - Test `verifyPeerKey` with mismatched keys (should fail)
   - Test `verifyPeerKey` with non-existent peer (should return false)

2. **Integration Tests:**
   - Normal connection flow should complete successfully
   - Simulated MITM (different key during handshake) should disconnect

3. **Manual Testing:**
   - Modify signaling server to substitute different key
   - Verify client detects mismatch and disconnects
   - Verify appropriate error message is shown

## Security Considerations

1. **Timing Attacks**: Use constant-time comparison for keys if possible
2. **Error Messages**: Don't leak information about which key is expected
3. **Logging**: In production, don't log actual key values
4. **Recovery**: After verification failure, clear all session data

## Related Issues

- The existing TODO comment in `crypto.ts` (lines 101-109) acknowledges the need for proper key verification
- Fingerprint display is already implemented for out-of-band verification
- Security reminder UI is shown but verification is not enforced

## Conclusion

The handshake verification gap is a significant security issue. While the application does display fingerprints for manual verification and shows security warnings, the automated verification during handshake is missing. Implementing Option 2 would provide defense-in-depth against MITM attacks by validating that the key received over WebRTC matches the key received during signaling.

---

## Research: How Other Apps Solve This

This section documents how major secure messaging applications and protocols handle key verification during connection establishment, with a focus on binding signaling-layer keys to transport-layer keys and detecting key substitution attacks.

### 1. Signal Protocol

Signal uses a multi-layered approach combining the [X3DH (Extended Triple Diffie-Hellman)](https://signal.org/docs/specifications/x3dh/) key agreement protocol with the [Double Ratchet algorithm](https://signal.org/docs/specifications/doubleratchet/).

#### Key Types and Binding

- **Identity Key Pair**: Long-term Curve25519 key pair generated at registration, used to verify user identity
- **Signed Pre-Key Pair**: Medium-term keys that allow asynchronous session establishment
- **One-Time Pre-Keys**: Ephemeral keys used once and discarded
- **Ephemeral Keys**: Generated per-operation for forward secrecy

#### Session Establishment (X3DH)

The X3DH protocol establishes a shared secret between two parties who mutually authenticate based on their identity public keys:

1. Alice obtains Bob's Pre Key Bundle from the server (containing Bob's identity key, signed pre-key, and optionally a one-time pre-key)
2. Alice generates an ephemeral key pair
3. Alice computes four DH calculations to derive a shared secret
4. The shared secret is fed into the Double Ratchet for ongoing message encryption

#### Identity Verification

From the [X3DH specification](https://signal.org/docs/specifications/x3dh/x3dh.pdf):
> "Before or after an X3DH key agreement, the parties may compare their identity public keys IKA and IKB through some authenticated channel. For example, they may compare public key fingerprints manually, or by scanning a QR code."

Signal implements this through **Safety Numbers**:
- A per-conversation number (not per-user) derived from both parties' identity keys
- [Simplified from traditional "fingerprints"](https://signal.org/blog/safety-number-updates/) because user studies showed "fingerprint" metaphor confused non-technical users
- Actually a "sorted concatenation of two 30-digit individual numeric fingerprints"
- Can be verified via QR code scanning or verbal comparison

#### Call Security Evolution

Signal originally used [ZRTP for voice calls](https://en.wikipedia.org/wiki/Signal_(software)), but as of March 2017, Signal transitioned to WebRTC-based calling that uses the **Signal Protocol channel for authentication instead of ZRTP**. This means:
- Call encryption keys are negotiated through the already-authenticated Signal Protocol session
- The identity binding is inherited from the messaging session
- No need for separate SAS verification during calls

**Key Lesson for Zajel**: Signal binds call security to the messaging session's established identity. If the messaging session is verified (via Safety Numbers), calls inherit that trust.

---

### 2. ZRTP Protocol

[ZRTP](https://datatracker.ietf.org/doc/html/rfc6189) (RFC 6189) is a cryptographic key-agreement protocol for VoIP calls, developed by Phil Zimmermann.

#### Core Mechanism

ZRTP performs key exchange directly on the **media path** (multiplexed on the same port as RTP), independent of signaling. This is critical because:
- No reliance on PKI or certificates
- No trust in signaling infrastructure required
- End-to-end key agreement happens between endpoints only

#### Short Authentication String (SAS)

The primary MITM defense is the [Short Authentication String](https://www.voip-info.org/zrtp/):

1. Both parties perform Diffie-Hellman key exchange
2. A cryptographic hash of the DH values is computed
3. This hash is displayed as a **word pair** (from PGP word list) or 4-character string
4. Users verbally compare the SAS over the call itself
5. Probability of attacker guessing correct SAS: 1 in 65,536

Example: Alice sees "apple banana", Bob sees "apple banana" - they're secure.

#### Key Continuity

ZRTP provides a second layer of protection through **key continuity** (similar to SSH's known_hosts):
- Hashed key information from each call is cached
- Mixed into the next call's DH shared secret
- If MITM wasn't present in the first call, they're locked out of subsequent calls
- Even if SAS is never verified, most MITM attacks are stopped

**Key Lesson for Zajel**: ZRTP's dual approach (SAS + key continuity) provides defense-in-depth. The key continuity pattern is directly applicable - store key hashes and verify against them on reconnection.

---

### 3. DTLS-SRTP and WebRTC

WebRTC uses [DTLS-SRTP](https://datatracker.ietf.org/doc/html/rfc5763) for securing media streams, with fingerprint binding defined in the [WebRTC Security Architecture](https://datatracker.ietf.org/doc/html/rfc8827).

#### How Fingerprint Binding Works

1. **SDP Offer/Answer Exchange**: Each party includes a fingerprint of their DTLS certificate in the SDP:
   ```
   a=fingerprint:sha-256 D1:2C:BE:AD:C4:F6:64:5C:25:16:11:9C:AF:E7:0F:73:...
   ```

2. **DTLS Handshake**: Performed on the media path, certificates are exchanged

3. **Verification**: The received certificate's fingerprint is compared against the fingerprint from SDP

From [WebRTC for the Curious](https://webrtcforthecurious.com/docs/04-securing/):
> "After the handshake is complete, this certificate is compared to the certificate hash in the Session Description. This is to ensure that the handshake happened with the WebRTC Agent you expected."

#### Security Limitations

The [WebRTC Security Architecture (RFC 8827)](https://rtcweb-wg.github.io/security-arch/) notes:
> "If HTTPS is not used to secure communications to the signaling server, and the identity mechanism used in Section 7 is not used, then any on-path attacker can replace the DTLS-SRTP fingerprints in the handshake and thus substitute its own identity."

This means fingerprint binding **only protects the media plane** - the signaling channel must also be secured.

#### Unknown Key-Share Attacks (RFC 8844)

[RFC 8844](https://www.rfc-editor.org/rfc/rfc8844.html) describes attacks where:
> "An endpoint that can acquire the certificate fingerprint of another entity can advertise that fingerprint as their own in SDP. An attacker can use a copy of that fingerprint to cause a victim to communicate with another unaware victim."

Mitigation requires binding the DTLS certificate to an authenticated identity, not just the fingerprint.

**Key Lesson for Zajel**: The current approach of sending the public key over WebRTC and comparing to signaling is similar to DTLS-SRTP fingerprint verification. However, we must ensure the signaling channel itself is trusted, OR provide out-of-band verification (like fingerprint display).

---

### 4. Matrix/Olm/Megolm

Matrix uses [Olm](https://matrix.org/docs/matrix-concepts/end-to-end-encryption/) (based on Double Ratchet) for 1:1 encryption and Megolm for group encryption.

#### Device Key Management

Each Matrix device has:
- **Curve25519 Identity Key**: Long-lived, used for Olm session establishment
- **Ed25519 Fingerprint Key**: Used to sign the identity key and other keys
- **One-time Keys**: Claimed for establishing new Olm sessions

#### Cross-Signing System

Matrix implements [cross-signing](https://matrix.org/docs/older/e2ee-cross-signing/) to reduce the verification burden:

1. **Master Key**: Top-level key representing user identity
2. **Self-signing Key**: Signs your own device keys
3. **User-signing Key**: Signs other users' master keys

This creates a hierarchy:
```
Master Key (user identity)
    |
    +-- Self-signing Key --> Device A, Device B, ...
    |
    +-- User-signing Key --> Bob's Master Key, Carol's Master Key, ...
```

#### SAS (Short Authentication String) Verification

Matrix uses [emoji-based verification](https://element.io/blog/e2e-encryption-by-default-cross-signing-is-here/) similar to ZRTP:

1. Both parties generate ephemeral key pairs
2. ECDH produces a shared secret
3. If no MITM, the derived hash matches
4. Hash is displayed as 7 emoji or a number sequence
5. Users compare emoji out-of-band

The protocol flow:
```
Alice -> Bob: m.key.verification.start (parameters)
Bob -> Alice: m.key.verification.accept
[Both compute shared secret]
Alice <-> Bob: Compare emoji/numbers
Alice -> Bob: m.key.verification.mac (MAC of keys to verify)
Bob -> Alice: m.key.verification.done
```

#### Session Binding and Vulnerabilities

Research from [Nebuchadnezzar](https://nebuchadnezzar-megolm.github.io/) found vulnerabilities where:
> "A malicious homeserver can use a lack of domain separation to convince their target to cryptographically sign (and thus verify) a cross-signing identity controlled by the homeserver."

This highlights the importance of:
- Clear domain separation between different key types
- Not confusing device IDs with cross-signing key IDs
- Proper binding of Megolm sessions to verified Olm identities

**Key Lesson for Zajel**: Matrix's cross-signing reduces verification friction by creating a trust hierarchy. The SAS/emoji verification pattern is a well-tested approach for out-of-band verification that could supplement automated checks.

---

### 5. Wire

[Wire](https://wire.com/en/security) uses the Proteus protocol (based on Axolotl/Double Ratchet) for messaging and DTLS-SRTP for calls.

#### Proteus Protocol

From [Wire's Proteus implementation](https://github.com/wireapp/proteus):
> "Proteus is an implementation of the axolotl protocol (later renamed to Double Ratchet Algorithm) without header keys."

Uses: Curve25519, ChaCha20, HMAC-SHA256

#### Call Security and Key Binding

Wire's approach to binding call security to messaging identity:

1. SRTP encryption keys are negotiated via DTLS handshake
2. **Critical**: Expected DTLS fingerprints are sent over the authenticated Proteus session
3. During DTLS handshake, fingerprints are compared against what was received via Proteus

From Wire documentation:
> "The authenticity of the clients is also verified during the handshake by sending the expected fingerprints over the existing authenticated Proteus session."

This means:
- If the Proteus session is verified, call security inherits that trust
- MITM on the call requires compromising the already-established messaging session

#### Device Verification

Wire allows fingerprint-based verification:
- Each device has a unique key fingerprint
- Users can compare fingerprints out-of-band
- After verification, alerts are shown if new devices appear

#### Migration to MLS

Wire is [migrating to Messaging Layer Security (MLS)](https://support.wire.com/hc/en-us/articles/18666343787293-Migration-from-Proteus-to-MLS-protocol):
- MLS provides more efficient group encryption
- Supports automatic verification with X.509 certificates
- Represents the evolution of secure group messaging

**Key Lesson for Zajel**: Wire's pattern of sending DTLS fingerprints over the authenticated messaging channel is directly applicable. This is essentially what Zajel should do - verify the key received over WebRTC matches the key received during signaling.

---

### 6. WhatsApp

WhatsApp uses the Signal Protocol with additional features.

#### Security Code Verification

Each chat has a unique [security code](https://faq.whatsapp.com/820124435853543):
- Displayed as QR code and 60-digit number
- Derived from both parties' identity keys
- Comparison confirms end-to-end encryption integrity

#### Key Transparency

WhatsApp has deployed [Key Transparency](https://engineering.fb.com/2023/04/13/security/whatsapp-key-transparency/):
- Public key consistency mechanism
- Automatically verifies keys haven't been substituted
- Complements (doesn't replace) QR code verification
- Especially useful for large group scenarios

**Key Lesson**: Key Transparency provides automated verification at scale, reducing reliance on manual out-of-band checks.

---

### 7. Telegram Secret Chats

Telegram uses custom MTProto protocol with optional [Secret Chats](https://core.telegram.org/api/end-to-end) for E2E encryption.

#### Key Visualization

After DH key exchange, Telegram generates a [visual fingerprint](https://core.telegram.org/techfaq):
- Displayed as an image (identicon)
- Also shown as numbers and emoji
- Uses 128 bits of SHA-1 + 160 bits of SHA-256 = 288 fingerprint bits
- High collision resistance

From Telegram FAQ:
> "By comparing key visualizations users can make sure no MITM attack had taken place."

**Key Lesson**: Visual key representations (identicons) provide an intuitive verification mechanism that's harder to misremember than raw fingerprints.

---

### Channel Binding Patterns (RFC 5056, 5929, 9266)

[RFC 5056](https://datatracker.ietf.org/doc/html/rfc5056) defines channel binding for securing multi-layer protocols:

> "The critical security problem to solve is ensuring that there is no man-in-the-middle (MITM) from the application's point of view at the lower network layer."

#### TLS Channel Binding Types

From [RFC 5929](https://www.rfc-editor.org/rfc/rfc5929.html) and [RFC 9266](https://datatracker.ietf.org/doc/rfc9266/):

1. **tls-unique**: Binds to TLS Finished messages (deprecated for TLS 1.3)
2. **tls-server-end-point**: Hash of server certificate
3. **tls-exporter**: Uses TLS Exported Keying Material (EKM) - preferred for TLS 1.3

The key insight is that channel binding material should be:
- Unique to the specific connection
- Dependent on the keying material
- Not guessable by an MITM

**Key Lesson for Zajel**: Channel binding ensures the application-layer identity matches the transport-layer identity. For WebRTC, this means binding the signaling-phase public key to the WebRTC data channel.

---

### Summary Table

| App/Protocol | Identity Binding | MITM Detection | Out-of-Band Verification |
|-------------|------------------|----------------|--------------------------|
| **Signal** | X3DH + Double Ratchet | Keys inherited by calls | Safety Numbers (QR/numeric) |
| **ZRTP** | DH on media path | SAS verbal comparison | SAS word pairs |
| **DTLS-SRTP** | Fingerprint in SDP | Compare to signaling | Requires secure signaling |
| **Matrix** | Olm + Cross-signing | SAS emoji verification | Emoji/number comparison |
| **Wire** | Proteus + DTLS | Fingerprint via Proteus | Device fingerprints |
| **WhatsApp** | Signal Protocol | Key Transparency | Security codes (QR/60-digit) |
| **Telegram** | MTProto DH | Key visualization | Identicon/emoji/numbers |

---

### Recommendations for Zajel

Based on this research, the following patterns should be considered:

#### Immediate (Required)

1. **Verify signaling key against WebRTC key** (as proposed in Options 1/2)
   - This is equivalent to DTLS-SRTP fingerprint verification
   - Detect key substitution by malicious signaling server

2. **Use constant-time comparison** for key verification
   - Prevent timing attacks during comparison

#### Short-term (Recommended)

3. **Add key continuity** (TOFU - Trust On First Use)
   - Cache peer key hashes locally
   - Alert user if key changes on reconnection
   - Similar to ZRTP's key continuity and SSH known_hosts

4. **Improve fingerprint display**
   - Consider emoji representation (like Matrix)
   - Or visual identicon (like Telegram)
   - More memorable than hex strings

#### Long-term (Nice to have)

5. **Challenge-response verification**
   - Add Ed25519 signing capability alongside X25519
   - Sign a challenge to prove key ownership
   - Stronger than just comparing keys

6. **Cross-device verification** (if multi-device is added)
   - Implement cross-signing hierarchy
   - Allow verifying a user once across all their devices

---

### References

- [Signal X3DH Specification](https://signal.org/docs/specifications/x3dh/)
- [Signal Double Ratchet Specification](https://signal.org/docs/specifications/doubleratchet/)
- [RFC 6189 - ZRTP](https://datatracker.ietf.org/doc/html/rfc6189)
- [RFC 8827 - WebRTC Security Architecture](https://datatracker.ietf.org/doc/html/rfc8827)
- [RFC 5763 - DTLS-SRTP Framework](https://datatracker.ietf.org/doc/html/rfc5763)
- [RFC 8844 - Unknown Key-Share Attacks](https://www.rfc-editor.org/rfc/rfc8844.html)
- [RFC 5056 - Channel Bindings](https://datatracker.ietf.org/doc/html/rfc5056)
- [RFC 5929 - TLS Channel Bindings](https://www.rfc-editor.org/rfc/rfc5929.html)
- [Matrix E2EE Implementation Guide](https://matrix.org/docs/matrix-concepts/end-to-end-encryption/)
- [Matrix Cross-Signing](https://matrix.org/docs/older/e2ee-cross-signing/)
- [Wire Security Whitepaper](https://wire.com/en/security)
- [Wire Proteus Implementation](https://github.com/wireapp/proteus)
- [WhatsApp Key Transparency](https://engineering.fb.com/2023/04/13/security/whatsapp-key-transparency/)
- [Telegram End-to-End Encryption](https://core.telegram.org/api/end-to-end)
- [Nebuchadnezzar - Matrix Vulnerabilities](https://nebuchadnezzar-megolm.github.io/)
