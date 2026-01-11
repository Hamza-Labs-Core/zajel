# Issue #23: No Certificate Pinning

## Summary

The WebSocket (WSS) connection to the VPS signaling server does not implement certificate pinning, which could theoretically allow man-in-the-middle (MITM) attacks at the signaling layer.

## Files Analyzed

- `/home/meywd/zajel/packages/web-client/src/lib/signaling.ts` - Browser WebSocket client
- `/home/meywd/zajel/packages/app/lib/core/network/signaling_client.dart` - Flutter/Dart WebSocket client
- `/home/meywd/zajel/packages/web-client/src/lib/crypto.ts` - E2E encryption implementation
- `/home/meywd/zajel/packages/app/lib/core/crypto/crypto_service.dart` - Flutter E2E encryption

## Current Implementation

### Web Client (signaling.ts)
```typescript
this.ws = new WebSocket(this.serverUrl);
```
The browser WebSocket API is used directly with no certificate pinning.

### Flutter App (signaling_client.dart)
```dart
_channel = WebSocketChannel.connect(Uri.parse(serverUrl));
```
Uses `web_socket_channel` package without custom `SecurityContext`.

## Research Findings

### Browser WebSocket Certificate Pinning

**Verdict: Not Possible**

Browser-based JavaScript **cannot implement certificate pinning** for WebSocket connections due to fundamental platform limitations:

1. **No API Access**: The browser's WebSocket API does not expose any mechanism to access, inspect, or verify server certificates from JavaScript code.

2. **No Custom Headers**: Unlike HTTP requests, WebSocket connections cannot set custom headers that could be used for certificate verification.

3. **Browser-Controlled TLS**: All TLS/SSL negotiation happens at the browser level, completely opaque to JavaScript. There is no `getPeerCertificate()` or equivalent API.

4. **Platform Security Model**: Browsers deliberately hide certificate details from web applications as part of their security sandbox model.

Sources:
- [Certificate pinning? - websockets/ws Issue #1281](https://github.com/websockets/ws/issues/1281)
- [Mozilla Bug 594502 - Certificate acceptance for WSS](https://bugzilla.mozilla.org/show_bug.cgi?id=594502)
- [WebSocket Security - Heroku](https://devcenter.heroku.com/articles/websocket-security)

### Flutter/Dart WebSocket Certificate Pinning

**Verdict: Partially Possible (Mobile Only)**

Flutter can implement certificate pinning for HTTP connections using `SecurityContext`, but WebSocket support is limited:

1. **SecurityContext Class**: Dart's `SecurityContext` can load trusted certificates for `HttpClient`, but `WebSocket.connect()` does not directly accept a `SecurityContext` parameter.

2. **Web Platform Limitation**: Certificate pinning via `SecurityContext` is **not possible on web platform** (Flutter Web).

3. **Mobile Implementation**: For mobile apps, a workaround exists by using lower-level socket APIs and manually managing TLS, but this is complex and fragile.

4. **Package Limitations**: The `web_socket_channel` package used in the app does not expose certificate pinning configuration.

Sources:
- [dart:io WebSocket pinning issue - dart-lang/sdk #34284](https://github.com/dart-lang/sdk/issues/34284)
- [SecurityContext class - Dart API](https://api.flutter.dev/flutter/dart-io/SecurityContext-class.html)
- [SSL Certificate Pinning in Flutter - The Droids On Roids](https://www.thedroidsonroids.com/blog/ssl-certificate-pinning-in-flutter)

## Threat Analysis

### What Certificate Pinning Would Protect Against

1. **Compromised CA**: If a Certificate Authority is compromised, attackers could issue valid certificates for the signaling server domain.

2. **Rogue CA in Trust Store**: Corporate or government CAs added to device trust stores could issue fake certificates.

3. **Network-Level MITM**: Attackers with network access (e.g., malicious WiFi) with a valid certificate could intercept signaling.

### What Certificate Pinning Would NOT Protect Against

1. **Compromised Server**: If the signaling server itself is compromised.

2. **Compromised Endpoints**: If either client device is compromised.

3. **Signaling Content Analysis**: The signaling server already sees all signaling messages regardless of pinning.

## Existing Security Mitigations

Zajel already implements multiple layers of security that significantly mitigate the impact of a signaling MITM:

### 1. End-to-End Encryption (E2E)

All message content is encrypted using X25519 key exchange and ChaCha20-Poly1305:

```typescript
// From crypto.ts
const sharedSecret = x25519.getSharedSecret(this.keyPair.privateKey, peerPublicKey);
const sessionKey = hkdf(sha256, sharedSecret, undefined, info, 32);
// ... ChaCha20-Poly1305 encryption
```

**Impact**: Even if signaling is compromised, message content remains encrypted and unreadable.

### 2. Public Key Exchange

Public keys are exchanged during the pairing phase and used for E2E encryption:

```typescript
this.send({
  type: 'register',
  pairingCode: this.myCode,
  publicKey: this.myPublicKey,
});
```

**Risk**: A MITM could substitute public keys (see mitigation #3).

### 3. Public Key Fingerprint Verification

The codebase includes fingerprint generation for out-of-band verification:

```typescript
getPublicKeyFingerprint(): string {
  const hash = sha256(this.keyPair.publicKey);
  return formatFingerprint(bytesToHex(hash));
}
```

**Mitigation**: Users can verify fingerprints through a trusted channel (phone call, in-person) to detect MITM attacks.

### 4. WebRTC DTLS Protection

Once WebRTC is established, DTLS-SRTP provides:
- Encrypted media/data channels
- Certificate fingerprint verification via SDP
- Detection of MITM during DTLS handshake

```
The actual SRTP key exchange is initially performed end-to-end with DTLS-SRTP,
allowing for the detection of any MiTM attacks.
```

Sources:
- [WebRTC Security Guide - Ant Media](https://antmedia.io/webrtc-security/)
- [Securing - WebRTC for the Curious](https://webrtcforthecurious.com/docs/04-securing/)

### 5. Ephemeral Keys

The web client generates new key pairs per session:

```typescript
// Keys live only in memory - ephemeral messaging
const privateKey = x25519.utils.randomPrivateKey();
const publicKey = x25519.getPublicKey(privateKey);
```

**Impact**: Limits exposure if keys are somehow compromised.

## Practical Risk Assessment

### Attack Scenario Analysis

For a successful MITM attack on Zajel signaling:

1. **Attacker Requirements**:
   - Network-level access (e.g., ISP, WiFi operator)
   - Valid certificate for signaling domain (requires CA compromise)
   - Active interception during initial pairing

2. **What Attacker Could Do**:
   - Substitute public keys during pairing
   - Impersonate one party to the other
   - Read all messages (defeating E2E encryption via key substitution)

3. **What Attacker Could NOT Do**:
   - Attack ongoing sessions if fingerprints were verified
   - Attack if users verified fingerprints out-of-band
   - Remain undetected if users compare fingerprints

### Risk Level: **Medium-Low**

- Requires sophisticated attacker with CA-level access
- Existing E2E encryption protects content by default
- Fingerprint verification provides detection mechanism
- WebRTC DTLS adds second layer of protection

## Recommendations

### Short-term (Recommended)

1. **Enhance Fingerprint Verification UI**
   - Make fingerprint display more prominent during pairing
   - Add clear instructions for out-of-band verification
   - Consider adding QR code for easy comparison

2. **Document Security Model**
   - Add security documentation explaining the trust model
   - Educate users about fingerprint verification importance

### Medium-term (Optional for High-Security Use Cases)

3. **Implement Trust On First Use (TOFU)**
   - Store peer public keys after first successful pairing
   - Warn users if peer's public key changes
   - Similar to SSH host key verification

4. **Mobile-Only: Implement Certificate Pinning**
   - For Flutter mobile apps, implement pinning using custom `HttpClient` with `SecurityContext`
   - Requires maintaining certificate/public key in app updates
   - Note: Not applicable to Flutter Web or browser clients

### Long-term (Future Consideration)

5. **Server-Signed Identity**
   - Consider a TOFU model where the server signs user identities
   - Detect key substitution via server attestation

6. **Safety Numbers (Signal Protocol Style)**
   - Generate safety numbers from combined public keys
   - Users can compare numbers to verify no MITM

## Implementation Complexity

| Approach | Complexity | Platform Support | Effectiveness |
|----------|------------|------------------|---------------|
| Enhanced Fingerprint UI | Low | All platforms | High (with user action) |
| TOFU Model | Medium | All platforms | Medium-High |
| Mobile Cert Pinning | High | Mobile only | Medium |
| Server-Signed Identity | High | All platforms | High |

## Conclusion

**Certificate pinning is not practical for Zajel** due to:

1. **Browser Limitation**: Impossible to implement in web clients
2. **Flutter Web Limitation**: Not supported on web platform
3. **Maintenance Burden**: Certificate rotation requires app updates
4. **Existing Mitigations**: E2E encryption + fingerprint verification provides comparable security

**Recommended Action**: Focus on enhancing the existing fingerprint verification UX and implementing TOFU rather than pursuing certificate pinning. This provides better security coverage across all platforms with lower implementation complexity.

## References

- [WebSocket.org Security Guide](https://websocket.org/guides/security/)
- [SSL Pinning in Flutter - Medium](https://dwirandyh.medium.com/securing-your-flutter-app-by-adding-ssl-pinning-474722e38518)
- [WebRTC Security - A Study](https://webrtc-security.github.io/)
- [WebRTC for the Curious - Securing](https://webrtcforthecurious.com/docs/04-securing/)
- [Certificate Pinning in NodeJS](https://hassansin.github.io/certificate-pinning-in-nodejs)

## Research: How Other Apps Solve This

### Signal Messenger

Signal takes an aggressive approach to certificate pinning by **completely eliminating third-party CA trust** and using their own trust root.

**Implementation Approach:**
- Signal uses a custom trust root rather than relying on the system CA trust store
- All Signal clients (Android, iOS, Desktop) are pinned to Signal's own certificates
- The approach "completely eliminates third-party trust from the certificate signature equation"

**Why Signal Uses Their Own Trust Root:**
- Browsers ship with 175+ trusted root certificates (Mozilla Firefox example)
- Any misbehaving, malicious, or compromised CA can issue "valid" certificates
- Signal's approach prevents attacks even if a CA is compromised

**Real-World Effect:**
- Corporate SSL interception proxies cannot decrypt Signal traffic
- Users behind such proxies report that media downloads fail (spinning wheel)
- Signal connections fail entirely if traffic is MITM'd with corporate certificates

**Desktop (Electron):**
- Signal Desktop uses Electron with certificate pinning
- Libraries like `electron-ssl-pinning` and `electron-root-ssl-pinning` enable this
- The app fails to connect when SSL interception is detected

**Historical Development:**
- Moxie Marlinspike (Signal's creator) authored the [AndroidPinning library](https://github.com/moxie0/AndroidPinning)
- The library pins the hex-encoded hash of X.509 certificate's SubjectPublicKeyInfo
- This approach has been foundational for Android certificate pinning

Sources:
- [Signal Blog: Certifiably "F"ine](https://signal.org/blog/certifiably-fine/)
- [Signal Desktop GitHub Issue #3549](https://github.com/signalapp/Signal-Desktop/issues/3549)
- [AndroidPinning Library](https://github.com/moxie0/AndroidPinning)

---

### Telegram

Telegram takes a **different approach** by using their custom MTProto protocol rather than traditional HTTPS/TLS.

**MTProto Protocol:**
- Custom protocol designed specifically for mobile access to server API
- Three components: API query language, cryptographic (authorization) layer, and transport component
- Transport can use HTTP, HTTPS, WS, WSS, TCP, or UDP

**Security Measures in MTProto:**
- Perfect Forward Secrecy in both cloud chats and secret chats
- Man-in-the-middle prevention via DH key exchange verification
- Clients must use cryptographically secure PRNG for DH key exchange
- Strict validation of prime numbers and group generators

**Key Security Guidelines:**
- Clients MUST verify msg_key equals SHA256 of decrypted plaintext
- If any check fails, client must "completely discard the message"
- Recommendation to close and reestablish TCP connection on validation failure
- "No information from incorrect messages can be used"

**Certificate Pinning Status:**
- Reports suggest Telegram may not use traditional certificate pinning
- The custom MTProto protocol provides its own authentication mechanisms
- DH key visualization enables MitM detection with >0.9999999999 probability

**Note:** The MTProto approach means Telegram's security model differs significantly from apps using standard TLS + certificate pinning.

Sources:
- [Telegram MTProto Protocol](https://core.telegram.org/mtproto)
- [MTProto Security Guidelines](https://core.telegram.org/mtproto/security_guidelines)
- [MTProto Technical FAQ](https://core.telegram.org/techfaq)

---

### WhatsApp

WhatsApp's certificate pinning has evolved significantly over the years.

**Historical Issues (2014):**
- Security researchers at Praetorian found WhatsApp lacked certificate pinning
- This exposed users to MITM attack risks
- Issues also included export ciphers and SSLv2 support

**Current Implementation:**
- WhatsApp implemented SSL pinning following the 2014 security audit
- Integrated the TextSecure (Signal) encryption protocol
- Certificate pinning combined with E2E encryption

**Security Implications:**
- Firewalls cannot decrypt WhatsApp traffic due to pinning + E2E encryption
- Traffic is "blindly allowed to pass or blocked" by network security tools
- WhatsApp is considered a "major blind spot for organizations"

**Implementation Method:**
- Uses the same approaches as other modern Android/iOS apps
- Network Security Configuration on Android (API 24+)
- Custom TrustManager or OkHttp CertificatePinner

Sources:
- [Praetorian: What's Up with WhatsApp's Security?](https://www.praetorian.com/blog/whats-up-with-whatsapps-security-facebook-ssl-vulnerabilities/)
- [SecurityAffairs: WhatsApp lack enforcing certificate pinning](https://securityaffairs.com/22449/hacking/whatsapp-lack-certificate-pinning.html)
- [Cyberhaven: How cert pinning and E2EE broke your CASB](https://www.cyberhaven.com/blog/how-cert-pinning-and-e2ee-broke-your-casb)

---

### Mobile App Implementation Methods

#### Android: OkHttp CertificatePinner

The most popular approach for Android certificate pinning.

**Basic Implementation:**
```kotlin
val certificatePinner = CertificatePinner.Builder()
    .add("api.example.com", "sha256/primary_pin_hash==")
    .add("api.example.com", "sha256/backup_pin_hash==")  // Always include backup!
    .build()

val okHttpClient = OkHttpClient.Builder()
    .certificatePinner(certificatePinner)
    .build()
```

**Best Practices (2025):**
1. **Use SPKI Pinning**: Pin Subject Public Key Info, not entire certificate
2. **Always Include Backup Pins**: Never deploy with only a single pin
3. **Consider Pinning Intermediate CA**: More flexibility for leaf certificate rotation
4. **Inject Keys at Build Time**: Use `buildConfigField` rather than hardcoding
5. **Coordinate with Server Teams**: Certificate rotation requires synchronization

**Generating SHA-256 Hash:**
```bash
openssl x509 -in certificate.crt -pubkey -noout | \
  openssl pkey -pubin -outform der | \
  openssl dgst -sha256 -binary | \
  openssl enc -base64
```

Sources:
- [OkHttp HTTPS Documentation](https://square.github.io/okhttp/features/https/)
- [OkHttp CertificatePinner API](https://square.github.io/okhttp/5.x/okhttp/okhttp3/-certificate-pinner/index.html)
- [Netguru: 3 Ways to Implement Certificate Pinning on Android](https://www.netguru.com/blog/android-certificate-pinning)

#### Android: Network Security Configuration

Declarative XML-based approach (Android 7.0+).

**Example Configuration:**
```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config>
        <domain includeSubdomains="true">example.com</domain>
        <pin-set expiration="2025-12-31">
            <pin digest="SHA-256">primary_pin_hash==</pin>
            <pin digest="SHA-256">backup_pin_hash==</pin>
        </pin-set>
    </domain-config>
</network-security-config>
```

**Advantages:**
- Centralized security policy management
- Works with all network traffic (not just OkHttp)
- No code changes required
- Expiration dates can be set declaratively

Sources:
- [Android Developer: Network Security Configuration](https://developer.android.com/training/articles/security-config)
- [nextnative: Android SSL Certificate Pinning Guide](https://nextnative.dev/blog/android-ssl-certificate-pinning)

#### iOS/macOS: TrustKit

Open-source SSL pinning library from Data Theorem.

**Key Features:**
- Easy SSL public key pinning and reporting
- Based on HTTP Public Key Pinning (HPKP) specification
- Pins Subject Public Key Info (SPKI)
- Auto-pinning via method swizzling (NSURLConnection/NSURLSession)
- Reporting mechanism for pinning failures

**Requirements:**
- Requires at least two public key hashes (primary + backup)
- TrustKit will fail to start with only one hash
- Backup ensures recovery path during key compromise

**Platforms:**
- iOS 12+, macOS 10.13+, tvOS 12+, watchOS 4+
- Supports both Swift and Objective-C
- Android version also available

Sources:
- [TrustKit iOS GitHub](https://github.com/datatheorem/TrustKit)
- [TrustKit Android GitHub](https://github.com/datatheorem/TrustKit-Android)
- [Bugsee: SSL certificate pinning on iOS using TrustKit](https://bugsee.com/blog/ssl-certificate-pinning-on-ios-using-trustkit/)

---

### Web Apps: Why Pinning Is Not Possible

Web browsers fundamentally cannot support certificate pinning from JavaScript.

**Technical Limitations:**
1. **No API Access**: WebSocket/fetch APIs don't expose certificate information
2. **Browser-Controlled TLS**: All TLS negotiation is opaque to JavaScript
3. **No `getPeerCertificate()`**: Unlike Node.js, browsers provide no such API
4. **Security Sandbox**: Browsers deliberately hide certificate details

**HTTP Public Key Pinning (HPKP) - Deprecated:**
- Was a browser feature for web-based certificate pinning
- Allowed servers to specify trusted public keys via HTTP headers
- **Deprecated in 2017, removed in 2018**
- Caused too many self-inflicted DoS incidents
- Replaced by Certificate Transparency

---

### Alternative: Certificate Transparency (CT)

Modern alternative to certificate pinning for detecting misissuance.

**How CT Works:**
- Certificates must be logged in public append-only logs
- Domain owners can monitor logs for unexpected certificates
- Browsers verify certificates are logged before trusting them
- Provides detection (not prevention) of rogue certificates

**Key Differences from Pinning:**
| Aspect | Certificate Pinning | Certificate Transparency |
|--------|---------------------|--------------------------|
| Scope | Specific app/domain | All participating CAs |
| Detection | Immediate (connection fails) | Async (monitoring required) |
| Prevention | Yes (blocks connection) | No (detection only) |
| Maintenance | High (rotation coordination) | Low (automated) |
| Web Support | None | Browser-native |

**Important Caveat:**
> "Certificate Transparency is really not a replacement for key pinning... CT is often seen as the modern replacement for PKP, but they solve different problems."
> - Emily Stark (Chrome Security Team)

**When to Use CT Instead of Pinning:**
- Web applications (only option)
- When maintenance burden of pinning is too high
- When short certificate lifetimes are acceptable
- Combined with automated certificate rotation

Sources:
- [Cloudflare: Why Certificate Pinning Is Outdated](https://blog.cloudflare.com/why-certificate-pinning-is-outdated/)
- [Emily Stark: CT is not a replacement for key pinning](https://emilymstark.com/2022/08/23/certificate-transparency-is-really-not-a-replacement-for-key-pinning.html)
- [Cloudflare SSL: Certificate Pinning](https://developers.cloudflare.com/ssl/reference/certificate-pinning/)

---

### Pin Rotation and Update Strategies

**The Core Challenge:**
Certificate pinning creates an operational burden - certificates expire and must be rotated without breaking apps.

**Strategy 1: SPKI Pinning (Preferred)**
- Pin the public key info, not the certificate itself
- Allows certificate renewal without changing the pin
- Same key pair = same pin hash

**Strategy 2: Backup Pins (Required)**
- Always include at least one backup pin
- Options for backup:
  - Pre-generated future certificate's public key
  - Intermediate CA's public key
  - Second leaf certificate ready to deploy

**Strategy 3: Pin Intermediate CA**
- Pin the intermediate CA instead of leaf certificate
- Any certificate from that CA will be trusted
- More flexible for leaf certificate rotation

**Strategy 4: Dynamic Pinning (Advanced)**
- Fetch pin configuration from trusted endpoint
- Initial pins must cover the update channel
- Solutions like Approov, Build38 provide this as a service
- Over-the-air updates without app releases

**Example: Multiple Pins Strategy:**
```kotlin
val pinner = CertificatePinner.Builder()
    .add("api.example.com", "sha256/currentCertHash==")     // Current
    .add("api.example.com", "sha256/backupCertHash==")      // Backup
    .add("api.example.com", "sha256/intermediateCaHash==")  // CA fallback
    .build()
```

Sources:
- [OWASP Pinning Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Pinning_Cheat_Sheet.html)
- [Approov: Dynamic Certificate Pinning](https://approov.io/mobile-app-security/rasp/dynamic-cert-pinning/)
- [Build38: Dynamic Certificate Pinning](https://build38.com/blog/security/dynamic-certificate-pinning/)

---

### Fallback Strategies When Pinning Fails

**Option 1: Fail Hard (Signal's Approach)**
- Connection fails completely if pin doesn't match
- Most secure option
- User cannot proceed (no degraded mode)
- Best for high-security applications

**Option 2: Fail Soft**
- Report pinning failure to backend/crash reporting
- Allow limited functionality without sensitive operations
- Fall back to standard X.509 validation
- Availability prioritized over strict security

**Option 3: Graceful Degradation**
- Provide clear error handling and user messaging
- Offer retry or fallback endpoints
- Map pin validation failures to actionable error states
- Log for monitoring and alerting

**Best Practices:**
1. **Use staged rollouts**: Test pin changes on small user cohorts first
2. **Feature flags**: Enable quick rollback if issues occur
3. **Clear error messages**: Help users understand why connection failed
4. **Monitoring**: Alert on pin validation failure spikes
5. **Multiple pins**: Reduce risk of complete lockout

**Risks of Fallback Mechanisms:**
- Fallback to non-pinned mode can be exploited
- Attackers may trigger pin failures intentionally
- Must ensure fallback is still secure (valid CA certificate)
- Third-party API pins can break without warning

Sources:
- [MOSS: SSL Pinning for Mobile Apps Guide](https://moss.sh/reviews/ssl-pinning-for-mobile-apps-guide/)
- [Zimperium: Certificate Pinning](https://zimperium.com/glossary/certificate-pinning/)
- [Corellium: SSL Certificate Pinning](https://www.corellium.com/blog/what-is-certificate-pinning)

---

### 2025 Industry Perspective

**The Debate on Certificate Pinning:**

**Arguments Against Pinning:**
- Google now recommends against pinning in Android security best practices
- Increased certificate rotation frequency makes pinning brittle
- Operational risk of self-inflicted outages
- Certificate Transparency + short-lived certificates provide alternative protection

**Arguments For Pinning (OWASP):**
- "Certificate pinning is mandatory"
- "The sole means to ensure genuinely secure networking"
- "The most potent defense against Man-in-the-Middle attacks"

**Adoption Rates:**
- 0.9% to 8% of Android apps use certificate pinning at runtime
- 2.5% to 11% of iOS apps use certificate pinning at runtime
- High-security apps (banking, messaging) more likely to implement

**Recommendation for Zajel:**

Given that:
1. Browsers cannot implement certificate pinning
2. Flutter Web cannot implement certificate pinning
3. Zajel already has E2E encryption + fingerprint verification
4. Certificate Transparency provides some detection capability

**The existing security model (E2E encryption + fingerprint verification + TOFU) is the most practical approach** for a cross-platform app with web support. Certificate pinning would only be viable for native mobile apps and would not protect web users.

For native mobile builds specifically, consider:
- Implementing OkHttp CertificatePinner (Android)
- Implementing TrustKit (iOS)
- Using SPKI pinning with backup pins
- Coordinating with server team for certificate rotation

---

### Summary Table: How Messaging Apps Handle This

| App | Certificate Pinning | Alternative Security |
|-----|---------------------|---------------------|
| Signal | Yes - Own trust root | E2E encryption, Safety numbers |
| Telegram | Custom MTProto protocol | DH key verification, PFS |
| WhatsApp | Yes (post-2014) | Signal Protocol E2E encryption |
| Zajel (current) | No (browser limitation) | E2E encryption, Fingerprint verification |

| Platform | Pinning Possible | Recommended Approach |
|----------|-----------------|---------------------|
| Android Native | Yes | OkHttp CertificatePinner or NSC |
| iOS Native | Yes | TrustKit or URLSession delegates |
| Flutter Mobile | Partial | SecurityContext (complex) |
| Flutter Web | No | N/A - browser limitation |
| Browser/Web | No | Certificate Transparency monitoring |
| Electron Desktop | Yes | electron-ssl-pinning library |
