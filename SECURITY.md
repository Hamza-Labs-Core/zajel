# Zajel Security Architecture

This document describes Zajel's security model, threat assumptions, and the cryptographic protections implemented to ensure secure peer-to-peer messaging.

## Overview

Zajel is designed as a privacy-first, ephemeral messaging application. The core security principle is that **the signaling server is treated as an untrusted relay** - it facilitates connection establishment but never has access to decrypted message content.

**Security Audit Status**: A comprehensive security audit was conducted across all 4 packages, identifying 94 issues. All 94 issues have been resolved across 3 waves (CRITICAL+HIGH, MEDIUM, LOW). See the [Security Audit Summary](#security-audit-summary) section for details.

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
3. **HKDF Key Derivation**: Session keys are derived using HKDF with both peer public keys as salt
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

Messages include sequence numbers and nonces to prevent replay attacks:

```typescript
// Sequence number prepended to plaintext before encryption
const seqBytes = new Uint8Array(4);
new DataView(seqBytes.buffer).setUint32(0, seq, false);
```

A sliding window mechanism allows for out-of-order delivery while rejecting:
- Duplicate sequence numbers (replayed messages)
- Sequence numbers too far in the past (old replayed messages)

Additionally, nonce-based replay protection is enforced on encrypted P2P messages in the headless client, and group/channel messages are validated for sequence continuity.

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
5. **Review group invitations** before accepting — invitations now require explicit verification
6. **Monitor file transfers** — transfers are capped at 100 MB and verified with SHA-256 hashes

## Ephemeral by Design

Zajel is designed for ephemeral messaging:

- **Web client**: Keys are generated fresh on each page load and stored only in memory
- **Mobile app**: Keys can be regenerated each session for maximum privacy
- **No message persistence**: Messages are not stored on any server
- **Session-scoped**: When the connection ends, cryptographic material is discarded

## Security Audit Summary

A comprehensive security audit was completed in February 2026, covering all 4 packages in the Zajel project. The audit identified 94 actionable issues (plus 8 previously resolved by architecture changes). All 94 issues were fixed in 3 waves.

### Audit Scope

| Package | Language | Issues Found | Issues Fixed |
|---------|----------|--------------|--------------|
| Headless Client (`packages/headless-client/`) | Python | 38 | 38 |
| CF Worker Server (`packages/server/`) | JavaScript | 25 | 25 |
| VPS Server (`packages/server-vps/`) | TypeScript | 9 | 9 |
| Website (`packages/website/`) | React/TypeScript | 22 | 22 |
| **Total** | | **94** | **94** |

### Fix Waves

| Wave | Severity | Issues | Commit |
|------|----------|--------|--------|
| Wave 1 | CRITICAL + HIGH | 29 | b97ff6e |
| Wave 2 | MEDIUM | 38 | 00fc0c9 |
| Wave 3 | LOW | 27 | 2e5bcc2 |

### Enforced Security Properties

The following security properties are now enforced across the project:

**Cryptographic Hardening**
- HKDF key derivation includes both peer public keys as salt, preventing key confusion attacks
- Pairing codes generated with cryptographic PRNG (`secrets` module / `crypto.randomInt()`)
- Session keys encrypted at rest with ChaCha20-Poly1305
- Constant-time comparison for all secret/HMAC values (timing-safe)
- Sender keys zeroized on group leave
- Nonce-based replay protection on encrypted P2P messages
- Separate signing keys for build tokens vs session tokens

**Input Validation and Bounds**
- File path traversal blocked (basename sanitization + containment checks)
- JSON body size limits on all HTTP endpoints
- 1 MB message size limit on daemon socket; 100 MB file transfer limit
- Bounded in-memory storage (1,000 chunks, 5,000 messages)
- PeerId format validation and consistency verification
- JSON schema validation for group messages
- Strict semver validation, hex input validation, URL scheme validation
- Storage key injection prevention

**Access Control**
- UNIX socket permissions restricted to 0o600 with symlink prevention
- SO_PEERCRED daemon socket authentication
- Authentication required on server registration, deletion, and stats endpoints
- Server deletion requires ownership proof
- CORS origin allowlist (no wildcard)
- Rate limiting at 100 req/min/IP
- Connection limits (10,000 total, 50 per IP)
- Group invitation requires explicit verification

**Information Leakage Prevention**
- Message content redacted from all log output
- Generic error responses — no internal messages or stack traces leaked
- Generic attestation verification messages
- Channel invite links no longer embed private keys
- Tiered error handling across all packages

**Network and Transport Hardening**
- WebSocket URL scheme validation (wss:// enforced)
- Peer identity bound to WebRTC connection during handshake
- Encrypted message delivery uses peer identity lookup (not try-all)
- Exponential backoff reconnection
- WebRTC cleanup on connection failure
- Reliable SCTP delivery (no maxRetransmits cap)
- ICE server configuration validation
- Endpoint URL validation with private IP rejection

**Web Security**
- Content Security Policy and security response headers (HSTS, X-Frame-Options, X-Content-Type-Options)
- DOMPurify SVG sanitization for Mermaid diagrams
- Mermaid securityLevel set to 'strict'
- JSX-escaped dynamic parameters
- Self-hosted fonts (no external CDN dependencies)
- Download URL domain allowlist
- GitHub API response validation
- rel="noopener noreferrer" on external links

**Resource Management**
- Nonce storage bounded with TTL expiry
- Device and server storage growth limits
- Rendezvous registration limits
- Chunk announce array limits
- maxConnections clamped to safe range
- PeerId takeover prevention
- Batch stale server deletion
- Graceful async task cancellation with timeout

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
