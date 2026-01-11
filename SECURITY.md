# Zajel Security Architecture

This document describes Zajel's security model, threat assumptions, and the cryptographic protections implemented to ensure secure peer-to-peer messaging.

## Overview

Zajel is designed as a privacy-first, ephemeral messaging application. The core security principle is that **the signaling server is treated as an untrusted relay** - it facilitates connection establishment but never has access to decrypted message content.

## Cryptographic Primitives

| Purpose | Algorithm | Implementation |
|---------|-----------|----------------|
| Key Exchange | X25519 (Curve25519 ECDH) | @noble/curves (web), cryptography package (Flutter) |
| Key Derivation | HKDF-SHA256 | @noble/hashes (web), cryptography package (Flutter) |
| Symmetric Encryption | ChaCha20-Poly1305 AEAD | @noble/ciphers (web), cryptography package (Flutter) |
| Fingerprinting | SHA-256 | @noble/hashes (web), cryptography package (Flutter) |

## Security Layers

### Layer 1: Transport Security (TLS/WSS)

All communication with the signaling server uses WSS (WebSocket Secure) with standard TLS.

**What TLS Protects:**
- Confidentiality of signaling messages in transit
- Integrity of signaling data
- Server authentication via certificate chain

**What TLS Does NOT Protect:**
- Content from the signaling server itself (server can read signaling data)
- Against compromised Certificate Authorities
- Against MITM with valid certificates (e.g., corporate proxies)

**Certificate Pinning Status:**

Certificate pinning is NOT implemented. This is a deliberate design decision:

1. **Browser Limitation**: The browser's WebSocket API does not expose certificate information to JavaScript. There is no `getPeerCertificate()` or equivalent API.

2. **Flutter Web Limitation**: Certificate pinning via `SecurityContext` is not available on the web platform.

3. **HPKP Deprecated**: HTTP Public Key Pinning was deprecated in 2017 and removed from browsers in 2018.

4. **Operational Risk**: Certificate pinning requires coordinating certificate rotation with app updates, risking user lockouts.

See "Why E2E Encryption is the Primary Security" below for why this is acceptable.

### Layer 2: End-to-End Encryption (E2E)

All message content is encrypted end-to-end using:

1. **X25519 Key Exchange**: Each client generates an ephemeral key pair
2. **ECDH Shared Secret**: Clients derive a shared secret from their private key and peer's public key
3. **HKDF Key Derivation**: Session keys are derived using HKDF with peer-specific info
4. **ChaCha20-Poly1305**: Messages are encrypted with authenticated encryption

```
Client A                    Signaling Server                    Client B
   |                              |                                 |
   |-- Register (publicKey_A) --->|                                 |
   |                              |<--- Register (publicKey_B) -----|
   |                              |                                 |
   |<-- Pair (publicKey_B) -------|                                 |
   |                              |------- Pair (publicKey_A) ----->|
   |                              |                                 |
   | sessionKey = HKDF(ECDH(privA, pubB))                           |
   |                              |       sessionKey = HKDF(ECDH(privB, pubA))
   |                              |                                 |
   |== E2E Encrypted Messages (ChaCha20-Poly1305) =================>|
```

**What E2E Protects:**
- Message content from signaling server
- Message content from network observers
- Message content from MITM attackers (if keys are verified)

### Layer 3: Key Fingerprint Verification

Users can verify each other's public keys through out-of-band channels:

```typescript
getPublicKeyFingerprint(): string {
  const hash = sha256(this.keyPair.publicKey);
  return formatFingerprint(bytesToHex(hash));
}
```

The fingerprint is a SHA-256 hash of the public key, formatted as uppercase hex with spaces for readability (e.g., `A1B2 C3D4 E5F6 ...`).

**Verification Process:**
1. Alice and Bob connect via Zajel
2. Each displays their fingerprint in the UI
3. Alice calls Bob on the phone and reads her fingerprint
4. Bob compares what Alice reads to what his app shows for Alice
5. They repeat in reverse
6. If fingerprints match, no MITM is present

### Layer 4: WebRTC DTLS-SRTP

Once WebRTC is established, an additional encryption layer protects data channels:

1. **DTLS Handshake**: Establishes encrypted channel between peers
2. **Certificate Fingerprints**: Exchanged in SDP and verified during DTLS
3. **SRTP**: Encrypts media and data channel content

This provides defense-in-depth: even if the application-layer E2E encryption had a flaw, DTLS-SRTP would still protect the data.

### Layer 5: Replay Protection

Messages include sequence numbers to prevent replay attacks:

```typescript
// Sequence number prepended to plaintext before encryption
const seqBytes = new Uint8Array(4);
new DataView(seqBytes.buffer).setUint32(0, seq, false);
```

A sliding window mechanism allows for out-of-order delivery while rejecting:
- Duplicate sequence numbers (replayed messages)
- Sequence numbers too far in the past (old replayed messages)

## Why E2E Encryption is the Primary Security

Certificate pinning would protect against:
- Compromised Certificate Authorities
- Corporate/government SSL interception proxies
- MITM attacks with fraudulently issued certificates

However, E2E encryption with fingerprint verification provides **equivalent or better protection**:

| Attack Scenario | Cert Pinning | E2E + Fingerprints |
|-----------------|--------------|-------------------|
| Compromised CA issues fake cert | Blocks | Protected (key verification detects) |
| Corporate SSL proxy | Blocks | Protected (key verification detects) |
| MITM substitutes public keys | N/A (still vulnerable) | Protected (fingerprints don't match) |
| Compromised signaling server | Vulnerable | Protected (server can't decrypt) |
| Network eavesdropping | Protected | Protected |

**Key insight**: Certificate pinning protects the signaling channel, but a compromised signaling channel is already handled by E2E encryption. The only remaining attack (key substitution during pairing) is detected by fingerprint verification.

## Threat Model

### Trusted Components

| Component | Trust Level | Rationale |
|-----------|-------------|-----------|
| User's device | Fully trusted | Has access to private keys |
| Zajel app code | Fully trusted | Runs cryptographic operations |
| Browser/WebView | Trusted | Provides crypto APIs |

### Untrusted Components

| Component | Trust Level | Mitigations |
|-----------|-------------|-------------|
| Signaling server | Untrusted | E2E encryption, fingerprints |
| Network path | Untrusted | TLS, E2E encryption |
| Certificate Authorities | Untrusted | E2E encryption, fingerprints |

### Attack Scenarios

#### Passive Network Adversary
**Threat**: Observes all network traffic
**Mitigation**: TLS encrypts signaling, E2E encrypts content. Adversary sees encrypted blobs only.

#### Active Network Adversary (MITM)
**Threat**: Intercepts and modifies traffic
**Mitigation**: TLS prevents modification of signaling. E2E encryption prevents reading content. Fingerprint verification detects key substitution.

#### Compromised Signaling Server
**Threat**: Server operator reads/modifies signaling messages
**Mitigation**: E2E encryption means server only sees encrypted content. Key substitution is detected by fingerprints.

#### Compromised Certificate Authority
**Threat**: CA issues fraudulent certificates enabling MITM
**Mitigation**: E2E encryption protects content. Fingerprint verification detects MITM.

#### Key Substitution Attack
**Threat**: Attacker substitutes their own public key during pairing
**Mitigation**: Out-of-band fingerprint verification detects this attack.

## Recommendations for High-Security Use

1. **Always verify fingerprints** for sensitive communications
2. **Use trusted network** when possible (avoid public WiFi for initial pairing)
3. **Verify peer identity** through known channels before pairing
4. **Keep app updated** for latest security patches

## Ephemeral by Design

Zajel is designed for ephemeral messaging:

- **Web client**: Keys are generated fresh on each page load and stored only in memory
- **Mobile app**: Keys can be regenerated each session for maximum privacy
- **No message persistence**: Messages are not stored on any server
- **Session-scoped**: When the connection ends, cryptographic material is discarded

## Future Security Enhancements

### Short-term (Recommended)

1. **Enhanced Fingerprint UI**: More prominent display during pairing with QR codes
2. **Trust On First Use (TOFU)**: Store peer public keys and warn on changes
3. **Safety Numbers**: Combined fingerprints for mutual verification (Signal-style)

### Medium-term (Native Mobile Only)

1. **Certificate Pinning (Mobile)**: Implement on native Android/iOS builds
   - Android: Network Security Configuration or OkHttp CertificatePinner
   - iOS: TrustKit or custom URLSession delegate

### Long-term

1. **Server-Signed Identity**: TOFU model with server attestation
2. **Key Transparency**: Public log of key bindings for auditability

## Comparison with Other Messaging Apps

| Feature | Signal | Telegram | WhatsApp | Zajel |
|---------|--------|----------|----------|-------|
| E2E Encryption | Yes | Opt-in (Secret Chats) | Yes | Yes |
| Certificate Pinning | Yes (own root) | Custom protocol | Yes | No (browser limitation) |
| Key Verification | Safety Numbers | Key visualization | Security code | Fingerprints |
| Web Support | Desktop app | Web app | Web app | Progressive Web App |
| Ephemeral Design | Optional | Optional | Optional | Default |

## Security Contact

If you discover a security vulnerability, please report it responsibly:

1. Do NOT open a public GitHub issue
2. Email security details to the maintainers
3. Allow reasonable time for a fix before disclosure

## References

- [WebRTC Security - WebRTC for the Curious](https://webrtcforthecurious.com/docs/04-securing/)
- [X25519 - RFC 7748](https://tools.ietf.org/html/rfc7748)
- [ChaCha20-Poly1305 - RFC 8439](https://tools.ietf.org/html/rfc8439)
- [HKDF - RFC 5869](https://tools.ietf.org/html/rfc5869)
- [Signal Protocol](https://signal.org/docs/)
- [OWASP Certificate Pinning](https://owasp.org/www-community/controls/Certificate_and_Public_Key_Pinning)
