# Story 018: Sign WebRTC SDP Offers/Answers

## Priority: MEDIUM-TERM
## Severity: MEDIUM
## Component: packages/server-vps, packages/app

## Summary

WebRTC SDP (Session Description Protocol) offers and answers are forwarded through the VPS signaling server as opaque payloads without any integrity protection. A compromised VPS server (or network-level MITM between client and VPS) can modify SDP content in transit -- for example, replacing ICE candidates to force traffic through an attacker-controlled TURN relay, or modifying DTLS fingerprints to intercept the encrypted media/data channel. The current architecture relies entirely on transport-layer security (TLS/WSS) for SDP integrity, with no application-layer signing.

## Current Behavior

**SDP forwarding on VPS** (`packages/server-vps/src/client/signaling-handler.ts`, lines 482-519):
```typescript
handleSignalingForward(
  ws: WebSocket,
  message: SignalingOfferMessage | SignalingAnswerMessage | SignalingIceCandidateMessage
): void {
  const { type, target, payload } = message;
  // ...
  const targetWs = this.pairingCodeToWs.get(target);
  if (targetWs) {
    this.send(targetWs, {
      type,
      from: senderPairingCode,
      payload,  // SDP forwarded as-is, no integrity check
    });
  }
}
```
The `payload` field contains the SDP offer/answer or ICE candidate and is forwarded verbatim from sender to recipient. The VPS server has full read-write access to the payload.

**SDP creation on Flutter client** (`packages/app/lib/core/network/webrtc_service.dart`, lines 96-116):
```dart
Future<Map<String, dynamic>> createOffer(String peerId) async {
  // ...
  final offer = await connection.pc.createOffer();
  await connection.pc.setLocalDescription(offer);
  return {
    'type': 'offer',
    'sdp': offer.sdp,  // Raw SDP text, unsigned
  };
}
```
The SDP is returned as a plain string. No signature is attached.

**SDP handling on Flutter client** (`webrtc_service.dart`, lines 119-153):
```dart
Future<Map<String, dynamic>> handleOffer(String peerId, Map<String, dynamic> offer) async {
  await connection.pc.setRemoteDescription(
    RTCSessionDescription(offer['sdp'] as String, 'offer'),  // SDP accepted without verification
  );
  // ...
}
```
The received SDP is used directly without verifying that it was actually produced by the claimed peer.

**ICE candidate forwarding** (`signaling-handler.ts`, lines 482-519 and `webrtc_service.dart`, lines 178-204):
ICE candidates are also forwarded as opaque payloads. A compromised VPS can inject additional ICE candidates pointing to attacker-controlled relays.

**Existing crypto infrastructure**:
- The Flutter app has a `CryptoService` that handles X25519 key exchange and ChaCha20-Poly1305 encryption for data channel messages.
- Each peer has an Ed25519 or X25519 public key exchanged during the pairing flow (`pairingCodeToPublicKey` map in `SignalingHandler`).
- The DTLS fingerprint in the SDP should match the WebRTC peer's certificate, but this is verified only by the WebRTC stack internally -- the application layer does not cross-check it against the pairing public key.

## Expected Behavior

1. Each SDP offer/answer should be signed by the sender's identity key before being sent through the signaling server.
2. The recipient should verify the SDP signature using the sender's public key (already exchanged during pairing registration).
3. ICE candidates should either be included in the signed SDP (via ICE trickle bundling) or individually signed.
4. A compromised VPS server should be unable to modify SDP content without detection.
5. The DTLS fingerprint in the SDP should be bound to the peer's identity key to prevent certificate substitution attacks.

## Root Cause Analysis

The WebRTC signaling flow was designed for simplicity: the VPS server acts as a message relay, and security was delegated to WebRTC's built-in DTLS handshake. This is a standard pattern (used by most WebRTC applications) and is secure when:
1. The signaling channel is TLS-protected (client to server)
2. The signaling server is trusted

However, in Zajel's threat model, VPS servers are operated by third-party federation members and may be compromised. The signaling server is NOT fully trusted. This makes the standard WebRTC assumption invalid and requires application-layer SDP integrity.

The Jitsi project documented this exact MITM vector in their "ooh-ahh" (ooh-Authentication-And-Hashing) mechanism, where a compromised SRTP bridge can substitute DTLS fingerprints. The mitigation is to bind the DTLS fingerprint to an out-of-band identity verification (in Zajel's case, the Ed25519 identity key from the pairing flow).

**SDP structure** (relevant to the attack):
```
v=0
o=- 12345 2 IN IP4 0.0.0.0
s=-
t=0 0
a=fingerprint:sha-256 AA:BB:CC:DD:...  <-- DTLS certificate fingerprint (MITM target)
a=ice-ufrag:XXXX                         <-- ICE credentials (MITM target)
a=ice-pwd:YYYYYYYY                       <-- ICE credentials (MITM target)
m=application 9 UDP/DTLS/SCTP webrtc-datachannel
c=IN IP4 0.0.0.0
a=candidate:... typ host ...             <-- ICE candidates (redirect target)
```

An attacker who controls the VPS can:
1. Replace `a=fingerprint` to substitute their own DTLS certificate
2. Replace ICE candidates to redirect traffic through their relay
3. The WebRTC stack will connect to the attacker's DTLS endpoint, and the attacker can decrypt and re-encrypt all data channel traffic

## Affected Code

| File | Lines | Description |
|------|-------|-------------|
| `packages/server-vps/src/client/signaling-handler.ts` | 482-519 | `handleSignalingForward` -- SDP relay with no integrity check |
| `packages/server-vps/src/client/signaling-handler.ts` | 573-616 | `handleCallSignalingForward` -- call SDP relay (same issue) |
| `packages/app/lib/core/network/webrtc_service.dart` | 96-116 | `createOffer` -- SDP creation without signing |
| `packages/app/lib/core/network/webrtc_service.dart` | 119-153 | `handleOffer` -- SDP acceptance without verification |
| `packages/app/lib/core/network/webrtc_service.dart` | 156-175 | `handleAnswer` -- answer acceptance without verification |
| `packages/app/lib/core/network/webrtc_service.dart` | 178-204 | `addIceCandidate` -- ICE candidate acceptance without verification |
| `packages/app/lib/core/crypto/crypto_service.dart` | (not read) | Crypto service -- needs SDP signing method |

## Reproduction Steps

1. **Deploy a malicious VPS server** that modifies SDP in the `handleSignalingForward` path:
   ```typescript
   // In a compromised signaling handler:
   handleSignalingForward(ws, message) {
     if (message.type === 'offer' || message.type === 'answer') {
       // Replace DTLS fingerprint with attacker's
       message.payload.sdp = message.payload.sdp.replace(
         /a=fingerprint:sha-256 .*/,
         'a=fingerprint:sha-256 AA:BB:CC:...(attacker fingerprint)'
       );
     }
     // Forward modified SDP
     this.send(targetWs, { type: message.type, from: sender, payload: message.payload });
   }
   ```

2. **Client A** creates an offer and sends it through the compromised VPS.
3. **Client B** receives the modified offer, accepts it, and creates an answer.
4. The VPS modifies the answer similarly.
5. Both clients connect to the attacker's DTLS endpoint instead of each other.
6. The attacker performs a full MITM on the WebRTC data channel.

## Impact Assessment

- **Complete MITM on data channels**: An attacker who controls a VPS signaling server can read and modify all messages and file transfers between peers using that server.
- **Transparent to users**: The WebRTC connection appears to work normally -- data channels are "connected" and messages are "encrypted" -- but the encryption terminates at the attacker, not the peer.
- **Undermines E2E encryption**: Zajel's X25519 + ChaCha20-Poly1305 data channel encryption happens OVER the WebRTC data channel. If the data channel itself is MITMed, the handshake public keys can also be substituted (the attacker performs two separate key exchanges, one with each peer).
- **Federation trust model violation**: The entire point of federation is that VPS servers are semi-trusted relays, not fully trusted endpoints. Without SDP signing, they are effectively fully trusted.

## Proposed Fix

### 1. Add SDP signing on the Flutter client

```dart
/// Sign an SDP string with the local identity key.
/// Returns a signature that can be verified with the sender's public key.
Future<String> signSDP(String sdp) async {
  final signatureBytes = await _cryptoService.sign(
    Uint8List.fromList(utf8.encode(sdp)),
  );
  return base64Encode(signatureBytes);
}

/// Verify an SDP signature from a peer.
Future<bool> verifySDP(String sdp, String signature, String peerPublicKey) async {
  final sigBytes = base64Decode(signature);
  return await _cryptoService.verify(
    Uint8List.fromList(utf8.encode(sdp)),
    sigBytes,
    peerPublicKey,
  );
}
```

### 2. Include signature in signaling messages

```dart
Future<Map<String, dynamic>> createOffer(String peerId) async {
  final offer = await connection.pc.createOffer();
  await connection.pc.setLocalDescription(offer);
  final sdp = offer.sdp!;
  final signature = await signSDP(sdp);
  return {
    'type': 'offer',
    'sdp': sdp,
    'sdpSignature': signature,
    'signerPublicKey': await _cryptoService.getPublicKeyBase64(),
  };
}
```

### 3. Verify signature on receipt

```dart
Future<Map<String, dynamic>> handleOffer(String peerId, Map<String, dynamic> offer) async {
  final sdp = offer['sdp'] as String;
  final signature = offer['sdpSignature'] as String?;
  final signerKey = offer['signerPublicKey'] as String?;

  if (signature != null && signerKey != null) {
    final valid = await verifySDP(sdp, signature, signerKey);
    if (!valid) {
      throw WebRTCException('SDP signature verification failed -- possible MITM');
    }
    // Optionally: verify signerKey matches the peer's known public key from pairing
  }

  await connection.pc.setRemoteDescription(RTCSessionDescription(sdp, 'offer'));
  // ...
}
```

### 4. DTLS fingerprint binding (optional, defense in depth)

Extract the DTLS fingerprint from the SDP and bind it to the peer identity:
```dart
String? extractDtlsFingerprint(String sdp) {
  final match = RegExp(r'a=fingerprint:sha-256 (.+)').firstMatch(sdp);
  return match?.group(1);
}
```
After WebRTC connection is established, verify the remote DTLS certificate fingerprint matches the one in the signed SDP.

## Acceptance Criteria

- [ ] SDP offers include an Ed25519 signature from the sender's identity key
- [ ] SDP answers include an Ed25519 signature from the sender's identity key
- [ ] Recipients verify the SDP signature before calling `setRemoteDescription`
- [ ] Signature verification failure results in connection rejection (not silent fallback)
- [ ] ICE candidates are either bundled with the signed SDP or individually signed
- [ ] The VPS signaling server forwards SDP and signature without modification (no server-side changes needed)
- [ ] Backward compatibility: clients that don't send signatures can still connect (degraded trust level, logged warning)
- [ ] Unit tests verify signature generation and verification with test vectors
- [ ] Integration test with a simulated MITM (modified SDP) demonstrates detection

## Test Requirements

1. **Sign/verify round-trip**: Create SDP, sign it, verify signature on another device
2. **Tampered SDP detection**: Sign SDP, modify one character, verify signature check fails
3. **Wrong key detection**: Sign SDP with key A, verify with key B, confirm rejection
4. **ICE candidate signing**: Sign individual ICE candidates, verify on receipt
5. **Backward compatibility**: Client without SDP signing connects to client with SDP signing -- confirm graceful degradation with warning
6. **DTLS fingerprint binding**: Extract fingerprint from signed SDP, compare with actual DTLS certificate after connection

## Dependencies

- Related: Story 015 (VPS Reverse Proxy) -- TLS protects SDP at the transport layer (complementary)
- Related: Story 019 (DO Sharding) -- does not affect SDP signing
- Depends on: The Flutter CryptoService must expose Ed25519 signing (currently used for X25519 key exchange -- may need separate Ed25519 key pair)
