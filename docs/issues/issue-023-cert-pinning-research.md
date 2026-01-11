# Issue #23: Certificate Pinning Research

## Executive Summary

This document provides comprehensive research into certificate pinning for the Zajel web client, including browser API limitations, HPKP deprecation history, alternative approaches, and comparisons with other web messaging applications.

**Conclusion**: Certificate pinning is technically impossible for browser-based web applications due to fundamental platform limitations. Zajel's current security model (E2E encryption + fingerprint verification) provides equivalent or better protection against the threats that certificate pinning would address.

---

## Table of Contents

1. [Technical Limitations](#1-technical-limitations)
2. [HPKP Deprecation History](#2-hpkp-deprecation-history)
3. [Alternative Approaches for Web Apps](#3-alternative-approaches-for-web-apps)
4. [Comparison with Other Messaging Apps](#4-comparison-with-other-messaging-apps)
5. [Why E2E Encryption Mitigates This](#5-why-e2e-encryption-mitigates-this)
6. [Recommendation](#6-recommendation)
7. [References](#7-references)

---

## 1. Technical Limitations

### Browser WebSocket API Certificate Access

The browser's WebSocket API fundamentally cannot support certificate pinning because:

1. **No Certificate Access API**: After connecting to a WSS (WebSocket Secure) connection, there is no way to get any of the certificates - including the root of the certificate chain - that was used to validate the connection. JavaScript has no access to `getPeerCertificate()` or any equivalent API.

2. **No Custom Options**: Unlike Node.js WebSocket implementations that provide additional parameters for TLS options (such as specifying certificates or additional certificate roots), browser WebSocket constructors accept no such parameters.

3. **Opaque TLS Negotiation**: All TLS/SSL negotiation happens at the browser level, completely opaque to JavaScript. The browser deliberately hides certificate details from web applications as part of its security sandbox model.

4. **Poor Error Specification**: There is no way to catch WebSocket connection failures or get any information about why a connection failed. The browser may log an exception to the development console, but no information is passed to the error or close handler.

**Source**: [Mozilla Bugzilla #594502](https://bugzilla.mozilla.org/show_bug.cgi?id=594502), [WHATWG HTML Issue #4420](https://github.com/whatwg/html/issues/4420)

### Feature Request Status

A feature request exists on the WHATWG HTML specification (Issue #4420) to extend the WebSocket interface to access and use certificates, but it has not been implemented. Even browser DevTools provide minimal information about certificates used for WSS connections compared to HTTPS connections.

### Common Workarounds

Current workarounds for WebSocket certificate issues include:
- Using properly signed certificates from trusted CAs
- Placing a proxy like nginx in front of WebSocket servers
- Automating SSL/TLS certificate renewal

None of these workarounds enable certificate pinning in browser JavaScript.

---

## 2. HPKP Deprecation History

### What Was HPKP?

HTTP Public Key Pinning (HPKP) was a browser security feature that allowed websites to send an HTTP header specifying which public keys should be trusted for their domain. This was the only web-based mechanism for certificate pinning.

### Deprecation Timeline

| Date | Event |
|------|-------|
| 2017 | Google announced deprecation of HPKP |
| May 2018 | Chrome 67 removed HPKP support |
| 2019 | Peak adoption dropped from ~3,500 sites to ~650 |
| December 2019 | Firefox 72 removed HPKP support (final browser) |

### Reasons for Deprecation

1. **Low Adoption**: At peak, only 3,500 of the top 1 million websites used HPKP - a 0.35% adoption rate.

2. **Self-Inflicted DoS Risk ("HPKP Suicide")**: A small misconfiguration could render a website completely inaccessible. System administrators could accidentally "brick" their websites by:
   - Pinning keys that were later lost
   - Failing to include backup pins
   - Not coordinating certificate rotation with pin updates

3. **RansomPKP Attack**: Attackers who compromised a website could set malicious HPKP headers, locking legitimate owners out of their own domains.

4. **Operational Complexity**: Building a pin-set guaranteed to work was extremely difficult, and the risks of hostile pinning made it impractical.

**Source**: [Cloudflare: Why Certificate Pinning Is Outdated](https://blog.cloudflare.com/why-certificate-pinning-is-outdated/), [Scott Helme: HPKP is no more!](https://scotthelme.co.uk/hpkp-is-no-more/)

### Browser Support History

| Browser | HPKP Support Status |
|---------|---------------------|
| Chrome | Supported, removed in Chrome 67 (May 2018) |
| Firefox | Partially supported, removed in Firefox 72 |
| Safari | Never supported |
| Edge/IE | Never supported |
| Opera | Followed Chrome's lead |

---

## 3. Alternative Approaches for Web Apps

### Certificate Transparency (CT)

Certificate Transparency is the modern alternative to HPKP for detecting certificate misissuance:

**How CT Works**:
- All certificates must be logged in public, append-only logs
- Google Chrome requires certificates to be in at least two CT logs
- Domain owners can monitor logs for unexpected certificates
- Browsers verify certificates are logged before trusting them

**Key Differences from Pinning**:

| Aspect | Certificate Pinning | Certificate Transparency |
|--------|---------------------|--------------------------|
| Scope | Specific app/domain | All participating CAs |
| Detection | Immediate (connection fails) | Async (monitoring required) |
| Prevention | Yes (blocks connection) | No (detection only) |
| Maintenance | High (rotation coordination) | Low (automated) |
| Web Support | None (post-HPKP) | Browser-native |
| Risk of Self-DoS | High | None |

**Important Caveat**: CT is primarily a *detection* mechanism, not a *prevention* mechanism. As security researcher Emily Stark (Chrome Security Team) notes:
> "Certificate Transparency is really not a replacement for key pinning... CT is often seen as the modern replacement for PKP, but they solve different problems."

**Source**: [Emily Stark: CT is not a replacement for key pinning](https://emilymstark.com/2022/08/23/certificate-transparency-is-really-not-a-replacement-for-key-pinning.html)

### Android 16+ Certificate Transparency Support

As of Android 16 (API 36), the Network Security Config file includes a `certificateTransparency` tag that can be enabled globally or per domain. This brings Android up-to-date with iOS, which has had CT support since around 2016. However, this is for native Android apps, not web apps.

### CAA Records

Certificate Authority Authorization (CAA) DNS records allow domain owners to specify which CAs are authorized to issue certificates for their domain. This is server-side protection that doesn't require client-side implementation.

### Expect-CT Header

The Expect-CT HTTP header was introduced as a lighter-weight alternative to HPKP, allowing sites to opt into Certificate Transparency enforcement. However, this is now redundant as all major browsers require CT by default.

---

## 4. Comparison with Other Messaging Apps

### Signal Messenger

**Approach**: Own trust root (eliminates third-party CA trust entirely)

**Implementation**:
- Uses a custom trust root rather than the system CA trust store
- All Signal clients (Android, iOS, Desktop) are pinned to Signal's own certificates
- Certificates issued by "Open Whisper Systems" with issuer "TextSecure"
- Completely eliminates third-party trust from the certificate signature equation

**Web Client**:
- Signal does not have a browser-based web client
- Signal Desktop is an Electron app with native certificate pinning capabilities
- Uses libraries like `electron-ssl-pinning` for certificate validation

**Effect**:
- Corporate SSL interception proxies cannot decrypt Signal traffic
- Connections fail entirely if MITM'd with corporate certificates
- Media downloads fail (spinning wheel) when behind SSL inspection

**Why This Works for Signal but Not Zajel**:
- Signal Desktop is a standalone Electron app, not a browser-based web app
- Electron provides access to Node.js TLS APIs including certificate pinning
- Zajel's web client runs in the browser sandbox where these APIs are unavailable

**Source**: [Signal Blog: Certifiably "F"ine](https://signal.org/blog/certifiably-fine/), [Signal Desktop Issue #3549](https://github.com/signalapp/Signal-Desktop/issues/3549)

---

### Telegram

**Approach**: Custom MTProto protocol (not traditional TLS)

**Implementation**:
- Custom MTProto 2.0 protocol designed specifically for mobile access
- Uses AES-256 encryption, SHA-256 hashing, and custom key generation
- Three components: API query language, cryptographic layer, transport component
- Transport can use HTTP, HTTPS, WS, WSS, TCP, or UDP

**Web Client**:
- Telegram Web Z uses standard TLS via WebSockets
- The MTProto protocol documentation explicitly states: "The protocol is designed for access to a server API from applications running on mobile devices. It must be emphasized that a web browser is not such an application."

**Security Measures**:
- Perfect Forward Secrecy in both cloud chats and secret chats
- DH key exchange verification can detect MITM with >0.9999999999 probability
- Strict validation of prime numbers and group generators
- Clients must verify `msg_key` equals SHA256 of decrypted plaintext

**Encryption Model**:
- Default chats: Server-side encryption (Telegram holds keys)
- Secret Chats: End-to-end encryption
- MTProto has been formally verified correct (ProVerif, December 2020)

**Criticism**:
- Not E2E encrypted by default (unlike Signal/WhatsApp)
- MTProto lacks peer review of widely adopted open standards
- Telegram holds encryption keys for regular chats

**Source**: [Telegram MTProto](https://core.telegram.org/mtproto), [MTProto Security Guidelines](https://core.telegram.org/mtproto/security_guidelines)

---

### WhatsApp

**Approach**: Certificate pinning + Signal Protocol E2E encryption

**History**:
- 2014: Security researchers found WhatsApp lacked certificate pinning
- Post-2014: Implemented SSL pinning following security audit
- Integrated the TextSecure (Signal) encryption protocol

**Current Implementation**:
- Native apps (Android/iOS) use certificate pinning
- WhatsApp Windows client uses certificate pinning
- Combines pinning with end-to-end encryption

**Web Client (WhatsApp Web)**:
- Cannot implement certificate pinning (browser limitation)
- Relies on E2E encryption for message security
- Requires pairing with mobile app via QR code
- Mobile app maintains the encryption keys

**Effect on Network Security**:
- Firewalls cannot decrypt WhatsApp traffic
- Traffic is "blindly allowed to pass or blocked"
- WhatsApp considered a "major blind spot for organizations"

**Source**: [Praetorian: What's Up with WhatsApp's Security?](https://www.praetorian.com/blog/whats-up-with-whatsapps-security-facebook-ssl-vulnerabilities/), [Cyberhaven: How cert pinning and E2EE broke your CASB](https://www.cyberhaven.com/blog/how-cert-pinning-and-e2ee-broke-your-casb)

---

### Summary Comparison Table

| App | Platform | Cert Pinning | Alternative Security |
|-----|----------|--------------|---------------------|
| Signal | Desktop (Electron) | Yes - Own trust root | E2E encryption, Safety numbers |
| Signal | Mobile (Native) | Yes - Own trust root | E2E encryption, Safety numbers |
| Signal | Web | N/A (no web client) | N/A |
| Telegram | Mobile (Native) | Custom MTProto | DH key verification, PFS |
| Telegram | Web (Browser) | No (browser limitation) | Server encryption (not E2E) |
| WhatsApp | Mobile (Native) | Yes (post-2014) | Signal Protocol E2E |
| WhatsApp | Web (Browser) | No (browser limitation) | E2E via mobile app pairing |
| **Zajel** | Mobile (Flutter) | Partial (possible) | E2E encryption, Fingerprints |
| **Zajel** | **Web (Browser)** | **No (impossible)** | **E2E encryption, Fingerprints** |

---

## 5. Why E2E Encryption Mitigates This

### Attack Scenarios Analysis

For a successful MITM attack on Zajel signaling:

**Attacker Requirements**:
1. Network-level access (ISP, WiFi operator, corporate network)
2. Valid certificate for signaling domain (requires CA compromise or rogue CA)
3. Active interception during initial pairing phase

**What Certificate Pinning Would Protect Against**:
- Compromised Certificate Authorities
- Rogue CAs in device trust stores (corporate/government)
- Network-level MITM with fraudulently issued certificates

**What E2E Encryption + Fingerprint Verification Provides**:

| Attack Scenario | Cert Pinning | E2E + Fingerprints |
|-----------------|--------------|-------------------|
| Compromised CA issues fake cert | Blocks connection | Protected (key verification detects) |
| Corporate SSL proxy | Blocks connection | Protected (key verification detects) |
| MITM substitutes public keys | N/A (still vulnerable!) | Protected (fingerprints don't match) |
| Compromised signaling server | **Vulnerable** | **Protected** (server can't decrypt) |
| Network eavesdropping | Protected | Protected |

### Key Insight

**Certificate pinning protects the signaling channel, but E2E encryption means a compromised signaling channel doesn't matter.** Even if an attacker fully compromises the TLS connection to the signaling server:

1. **They cannot read messages**: All message content is encrypted with ChaCha20-Poly1305 using keys derived from X25519 ECDH
2. **They cannot forge messages**: AEAD (Authenticated Encryption with Associated Data) prevents tampering
3. **Key substitution is detectable**: If they substitute public keys during pairing, fingerprint verification reveals this

### The One Attack Certificate Pinning Would Prevent

The only attack that certificate pinning would prevent (that E2E encryption alone cannot) is:
- An attacker with a valid certificate who intercepts the initial pairing
- Substitutes their own public keys for both parties
- Becomes a persistent MITM for all future messages

**However**, this attack is fully detectable through out-of-band fingerprint verification. If users verify fingerprints via phone call or in person, this attack is caught.

### Defense in Depth: WebRTC DTLS

Once WebRTC is established, DTLS-SRTP provides additional protection:
- Encrypted data channels independent of application-layer encryption
- Certificate fingerprint verification via SDP
- Second layer of defense even if application-layer E2E had flaws

---

## 6. Recommendation

### Accept Current Approach

Based on this research, the recommendation is to **accept the current security model** for the following reasons:

1. **Browser Limitation Is Absolute**: Certificate pinning is impossible to implement in browser JavaScript. This is a platform limitation, not an implementation choice.

2. **HPKP Is Dead**: The only web-based pinning mechanism was deprecated in 2017 and removed in 2018. There is no replacement.

3. **E2E Encryption Provides Equivalent Security**: All threats that certificate pinning would address are also addressed by E2E encryption with fingerprint verification - with the bonus of protecting against a compromised signaling server (which pinning cannot do).

4. **Industry Consensus**: WhatsApp Web and Telegram Web both face the same limitation and rely on E2E encryption as their primary security mechanism.

5. **Certificate Transparency Provides Detection**: Modern browsers enforce Certificate Transparency, meaning fraudulent certificates will be detected (though not prevented).

### Recommended Enhancements

Rather than pursuing the impossible (browser certificate pinning), invest in:

1. **Enhanced Fingerprint UI**
   - Make fingerprint display more prominent during pairing
   - Add QR code for easy comparison
   - Clear instructions for out-of-band verification

2. **Trust On First Use (TOFU)**
   - Store peer public keys after first successful pairing
   - Warn users if peer's public key changes
   - Similar to SSH host key verification

3. **Key Change Warning**
   - Prominent UI warning when a peer's key changes
   - Require explicit user acknowledgment
   - Suggest out-of-band verification

4. **Safety Numbers (Signal-style)**
   - Generate safety numbers from combined public keys
   - Users can compare numbers for mutual verification

### For Native Mobile Apps Only

If/when building native mobile apps (not Flutter Web), consider:

**Android**:
- OkHttp CertificatePinner
- Network Security Configuration (Android 7.0+)
- SPKI pinning with backup pins

**iOS**:
- TrustKit
- Custom URLSession delegates
- Multiple backup pins

**Note**: This would only protect native mobile users, not web users.

---

## 7. References

### Browser Limitations
- [Mozilla Bugzilla #594502 - Certificate acceptance for WSS](https://bugzilla.mozilla.org/show_bug.cgi?id=594502)
- [WHATWG HTML Issue #4420 - Extend WebSocket interface](https://github.com/whatwg/html/issues/4420)
- [websockets/ws Issue #1281 - Certificate pinning?](https://github.com/websockets/ws/issues/1281)

### HPKP Deprecation
- [Wikipedia: HTTP Public Key Pinning](https://en.wikipedia.org/wiki/HTTP_Public_Key_Pinning)
- [Cloudflare: Why Certificate Pinning Is Outdated](https://blog.cloudflare.com/why-certificate-pinning-is-outdated/)
- [Scott Helme: HPKP is no more!](https://scotthelme.co.uk/hpkp-is-no-more/)
- [Chrome Platform Status: HPKP Removal](https://chromestatus.com/feature/5903385005916160)

### Certificate Transparency
- [Emily Stark: CT is not a replacement for key pinning](https://emilymstark.com/2022/08/23/certificate-transparency-is-really-not-a-replacement-for-key-pinning.html)
- [Ed Holloway-George: Crystal Clear Certificates (Android 16)](https://www.spght.dev/articles/21-04-2025/crystal-clear-certs)

### Signal
- [Signal Blog: Certifiably "F"ine](https://signal.org/blog/certifiably-fine/)
- [Signal Desktop Issue #3549](https://github.com/signalapp/Signal-Desktop/issues/3549)
- [AndroidPinning Library](https://github.com/moxie0/AndroidPinning)

### Telegram
- [Telegram MTProto Protocol](https://core.telegram.org/mtproto)
- [MTProto Security Guidelines](https://core.telegram.org/mtproto/security_guidelines)
- [MTProto Technical FAQ](https://core.telegram.org/techfaq)

### WhatsApp
- [Praetorian: What's Up with WhatsApp's Security?](https://www.praetorian.com/blog/whats-up-with-whatsapps-security-facebook-ssl-vulnerabilities/)
- [Cyberhaven: How cert pinning and E2EE broke your CASB](https://www.cyberhaven.com/blog/how-cert-pinning-and-e2ee-broke-your-casb)

### General Security
- [OWASP Pinning Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Pinning_Cheat_Sheet.html)
- [WebRTC Security - WebRTC for the Curious](https://webrtcforthecurious.com/docs/04-securing/)
- [SSL.com: What Is Certificate Pinning?](https://www.ssl.com/blogs/what-is-certificate-pinning/)

---

## Document History

| Date | Author | Changes |
|------|--------|---------|
| 2025-01-11 | Research | Initial comprehensive research document |

---

## Related Documents

- [SECURITY.md](/SECURITY.md) - Full security architecture documentation
- [Issue #23: No Certificate Pinning](issue-023-cert-pinning.md) - Original issue analysis
- [Issue #3: MITM Verification](issue-003-mitm-verification.md) - Related fingerprint verification
