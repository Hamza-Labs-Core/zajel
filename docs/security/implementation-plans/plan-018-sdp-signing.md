# Implementation Plan: Story 018 - Sign WebRTC SDP Offers/Answers

## Summary

This plan implements application-layer Ed25519 signatures on WebRTC SDP offers, answers, and ICE candidates to prevent MITM attacks by compromised VPS signaling servers. Currently, SDP payloads are forwarded as opaque data through the VPS without integrity protection, allowing a malicious server to modify DTLS fingerprints or inject ICE candidates to redirect traffic through attacker-controlled relays.

The solution adds cryptographic signatures using the existing identity keys exchanged during pairing registration. Each SDP offer/answer will include an Ed25519 signature that recipients verify before accepting the SDP. ICE candidates will be individually signed to prevent injection attacks.

**Priority**: MEDIUM-TERM
**Severity**: MEDIUM
**Estimated Effort**: 3-5 days
**Dependencies**: None (uses existing Ed25519 infrastructure from bootstrap signing)

---

## Files to Modify

### Flutter App (packages/app)

1. **`lib/core/crypto/crypto_service.dart`** - Add Ed25519 signing/verification methods
2. **`lib/core/network/webrtc_service.dart`** - Sign SDP on creation, verify on receipt
3. **`lib/core/network/signaling_client.dart`** - Update message payload structure (wire format change)
4. **`test/unit/crypto_service_test.dart`** - Add unit tests for SDP signing
5. **`test/unit/webrtc_service_test.dart`** - Add verification tests

### VPS Server (packages/server-vps)

**No server-side changes required** - The VPS forwards signature fields transparently as part of the payload. Signature verification happens entirely client-side.

### TypeScript Types (optional documentation)

**`packages/server-vps/src/client/types.ts`** - Document the new signature fields in comments (no runtime changes)

---

## Implementation Steps

### Step 1: Add Ed25519 Signing Capability to CryptoService

The existing `CryptoService` uses X25519 for key exchange but doesn't expose Ed25519 signing. We need to add separate Ed25519 key pairs for signing (X25519 keys cannot be used for signing).

**File**: `packages/app/lib/core/crypto/crypto_service.dart`

#### 1.1 Add Ed25519 signing key pair storage

**Location**: After line 31 (after `final Chacha20 _chacha20 = Chacha20.poly1305Aead();`)

```dart
// BEFORE (line 31-33)
  final X25519 _x25519 = X25519();
  final Chacha20 _chacha20 = Chacha20.poly1305Aead();
  late final Hkdf _hkdf;

// AFTER
  final X25519 _x25519 = X25519();
  final Chacha20 _chacha20 = Chacha20.poly1305Aead();
  final Ed25519 _ed25519 = Ed25519();  // NEW: For SDP signing
  late final Hkdf _hkdf;
```

**Location**: After line 36 (after `String? _publicKeyBase64Cache;`)

```dart
// BEFORE (line 36-38)
  String? _publicKeyBase64Cache;
  String? _stableId;
  bool _keysWereRegenerated = false;

// AFTER
  String? _publicKeyBase64Cache;
  String? _stableId;
  bool _keysWereRegenerated = false;

  // Ed25519 signing key pair (separate from X25519 exchange keys)
  SimpleKeyPair? _signingKeyPair;
  String? _signingPublicKeyBase64Cache;
```

#### 1.2 Update key initialization to generate Ed25519 signing keys

**File**: `packages/app/lib/core/crypto/crypto_service.dart`
**Location**: Lines 59-68 (inside `initialize()` method)

```dart
// BEFORE
  Future<void> initialize() async {
    if (_identityKeyPair != null) return;
    await _loadOrGenerateIdentityKeys();
    // Cache the public key for synchronous access
    if (_identityKeyPair != null) {
      final publicKey = await _identityKeyPair!.extractPublicKey();
      _publicKeyBase64Cache = base64Encode(Uint8List.fromList(publicKey.bytes));
    }
    await _loadOrGenerateStableId();
  }

// AFTER
  Future<void> initialize() async {
    if (_identityKeyPair != null) return;
    await _loadOrGenerateIdentityKeys();
    await _loadOrGenerateSigningKeys();  // NEW: Load/generate Ed25519 signing keys

    // Cache the public key for synchronous access
    if (_identityKeyPair != null) {
      final publicKey = await _identityKeyPair!.extractPublicKey();
      _publicKeyBase64Cache = base64Encode(Uint8List.fromList(publicKey.bytes));
    }
    if (_signingKeyPair != null) {  // NEW: Cache signing public key
      final signingPublicKey = await _signingKeyPair!.extractPublicKey();
      _signingPublicKeyBase64Cache = base64Encode(Uint8List.fromList(signingPublicKey.bytes));
    }

    await _loadOrGenerateStableId();
  }
```

#### 1.3 Add signing key persistence methods

**File**: `packages/app/lib/core/crypto/crypto_service.dart`
**Location**: After line 712 (after `_loadOrGenerateIdentityKeys()` method)

```dart
// NEW METHOD: Add after _loadOrGenerateIdentityKeys()
  /// Load or generate Ed25519 signing keys for SDP signatures.
  ///
  /// Signing keys are stored separately from X25519 exchange keys because
  /// Ed25519 is optimized for signing (not ECDH) and provides non-repudiation.
  Future<void> _loadOrGenerateSigningKeys() async {
    try {
      final privateKeyBase64 = await _secureStorage
          .read(key: '${_keyPrefix}signing_private')
          .timeout(const Duration(seconds: 10));
      if (privateKeyBase64 != null) {
        final privateKeyBytes = base64Decode(privateKeyBase64);
        _signingKeyPair = await _ed25519.newKeyPairFromSeed(privateKeyBytes);
        return;
      }
    } catch (e) {
      logger.warning(
          'CryptoService',
          'Failed to load signing keys from storage, generating new keys. '
              'Error: $e');
      _keysWereRegenerated = true;
    }

    // Generate new Ed25519 signing key pair
    _signingKeyPair = await _ed25519.newKeyPair();
    try {
      await _persistSigningKeys();
    } catch (e) {
      logger.warning('CryptoService',
          'Failed to persist signing keys to secure storage: $e');
    }
  }

  /// Persist Ed25519 signing keys to secure storage.
  Future<void> _persistSigningKeys() async {
    if (_signingKeyPair == null) return;

    final privateKeyBytes = await _signingKeyPair!.extractPrivateKeyBytes();
    await _secureStorage
        .write(
          key: '${_keyPrefix}signing_private',
          value: base64Encode(privateKeyBytes),
        )
        .timeout(const Duration(seconds: 10));
  }
```

#### 1.4 Add public signing methods for SDP

**File**: `packages/app/lib/core/crypto/crypto_service.dart`
**Location**: After line 277 (after `getPublicKeyBase64()` method)

```dart
// NEW METHODS: Add after getPublicKeyBase64()
  /// Get our Ed25519 signing public key as a base64 string.
  ///
  /// This is the key peers use to verify our SDP signatures.
  /// Returns the cached value (requires initialize() first).
  String get signingPublicKeyBase64 {
    if (_signingPublicKeyBase64Cache == null) {
      throw CryptoException(
          'CryptoService not initialized. Call initialize() first.');
    }
    return _signingPublicKeyBase64Cache!;
  }

  /// Sign arbitrary data with our Ed25519 signing key.
  ///
  /// Used for SDP offers/answers/ICE candidates to prove authenticity.
  /// Returns a base64-encoded signature.
  Future<String> signData(Uint8List data) async {
    if (_signingKeyPair == null) {
      throw CryptoException('Signing keys not initialized');
    }

    final signature = await _ed25519.sign(data, keyPair: _signingKeyPair!);
    return base64Encode(signature.bytes);
  }

  /// Verify a signature on arbitrary data using a peer's public key.
  ///
  /// Used to verify SDP signatures from peers. Returns true if valid.
  Future<bool> verifyData({
    required Uint8List data,
    required String signatureBase64,
    required String peerSigningPublicKeyBase64,
  }) async {
    try {
      final signatureBytes = base64Decode(signatureBase64);
      final peerPublicKeyBytes = base64Decode(peerSigningPublicKeyBase64);

      final peerPublicKey = SimplePublicKey(
        peerPublicKeyBytes,
        type: KeyPairType.ed25519,
      );

      final signature = Signature(
        signatureBytes,
        publicKey: peerPublicKey,
      );

      return await _ed25519.verify(data, signature: signature);
    } catch (e) {
      logger.warning('CryptoService',
          'Signature verification threw an exception (returning false): $e');
      return false;
    }
  }

  /// Sign an SDP string with our Ed25519 signing key.
  ///
  /// Convenience wrapper around signData() for WebRTC SDP payloads.
  Future<String> signSDP(String sdp) async {
    final sdpBytes = Uint8List.fromList(utf8.encode(sdp));
    return await signData(sdpBytes);
  }

  /// Verify an SDP signature from a peer.
  ///
  /// Convenience wrapper around verifyData() for WebRTC SDP payloads.
  Future<bool> verifySDP({
    required String sdp,
    required String signature,
    required String peerSigningPublicKey,
  }) async {
    final sdpBytes = Uint8List.fromList(utf8.encode(sdp));
    return await verifyData(
      data: sdpBytes,
      signatureBase64: signature,
      peerSigningPublicKeyBase64: peerSigningPublicKey,
    );
  }
```

#### 1.5 Update regenerateIdentityKeys to also regenerate signing keys

**File**: `packages/app/lib/core/crypto/crypto_service.dart`
**Location**: Lines 670-676 (inside `regenerateIdentityKeys()` method)

```dart
// BEFORE
  Future<void> regenerateIdentityKeys() async {
    _identityKeyPair = await _x25519.newKeyPair();
    await _persistIdentityKeys();
    // Update the cache with the new public key
    final publicKey = await _identityKeyPair!.extractPublicKey();
    _publicKeyBase64Cache = base64Encode(Uint8List.fromList(publicKey.bytes));
  }

// AFTER
  Future<void> regenerateIdentityKeys() async {
    _identityKeyPair = await _x25519.newKeyPair();
    _signingKeyPair = await _ed25519.newKeyPair();  // NEW: Regenerate signing keys too
    await _persistIdentityKeys();
    await _persistSigningKeys();  // NEW: Persist signing keys

    // Update the cache with the new public keys
    final publicKey = await _identityKeyPair!.extractPublicKey();
    _publicKeyBase64Cache = base64Encode(Uint8List.fromList(publicKey.bytes));

    final signingPublicKey = await _signingKeyPair!.extractPublicKey();  // NEW
    _signingPublicKeyBase64Cache = base64Encode(Uint8List.fromList(signingPublicKey.bytes));  // NEW
  }
```

---

### Step 2: Update Pairing Registration to Exchange Signing Keys

During pairing registration, clients exchange X25519 public keys. We need to also exchange Ed25519 signing public keys so peers can verify SDP signatures later.

**File**: `packages/app/lib/core/network/signaling_client.dart`
**Location**: Lines 86-89 (constructor parameters)

The constructor already accepts a `publicKey` parameter which is the X25519 key. We need to update the registration message to include the signing public key as well.

**File**: `packages/app/lib/core/network/connection_manager.dart`
**Location**: Search for where `SignalingClient` is instantiated and the registration message is prepared

Let me check the connection manager to see how the public key is passed:

```dart
// This requires inspecting connection_manager.dart to find where:
// 1. SignalingClient is created
// 2. The 'publicKey' field is set in the registration message
```

For now, document the change needed:

**File**: `packages/app/lib/core/network/signaling_client.dart`
**Location**: Lines 225-229 (inside `connect()` method, registration message)

```dart
// BEFORE
      _send({
        'type': 'register',
        'pairingCode': _pairingCode,
        'publicKey': _publicKey,
      });

// AFTER
      _send({
        'type': 'register',
        'pairingCode': _pairingCode,
        'publicKey': _publicKey,  // X25519 key for session encryption
        'signingPublicKey': _cryptoService.signingPublicKeyBase64,  // NEW: Ed25519 key for SDP signing
      });
```

**Note**: This requires passing `CryptoService` to `SignalingClient` or accessing it via a provider. Implementation details depend on the app's architecture.

**Alternative approach** (simpler): Include the signing public key in the offer/answer payload itself (see Step 3).

---

### Step 3: Sign SDP Offers and Answers in WebRTCService

**File**: `packages/app/lib/core/network/webrtc_service.dart`

#### 3.1 Update createOffer to include SDP signature

**Location**: Lines 124-128 (return statement of `createOffer()`)

```dart
// BEFORE
    return {
      'type': 'offer',
      'sdp': offer.sdp,
    };

// AFTER
    final sdp = offer.sdp!;
    final signature = await _cryptoService.signSDP(sdp);

    return {
      'type': 'offer',
      'sdp': sdp,
      'sdpSignature': signature,  // NEW: Ed25519 signature over SDP
      'signingPublicKey': _cryptoService.signingPublicKeyBase64,  // NEW: Our signing public key
    };
```

#### 3.2 Update handleOffer to verify SDP signature

**Location**: Lines 131-153 (inside `handleOffer()` method)

```dart
// BEFORE
  Future<Map<String, dynamic>> handleOffer(
    String peerId,
    Map<String, dynamic> offer,
  ) async {
    final connection = await _createConnection(peerId);

    // Pre-generate ephemeral keypair BEFORE setRemoteDescription triggers
    // data channel creation (for the answerer, channels arrive via
    // onDataChannel after the remote description is applied).
    final ephemeral = await _cryptoService.generateEphemeralKeyPair();
    _pendingEphemeralKeys[peerId] = ephemeral.privateKey;
    _pendingEphemeralPublicKeys[peerId] = ephemeral.publicKey;

    // Set remote description with timeout to prevent hanging
    await connection.pc
        .setRemoteDescription(
          RTCSessionDescription(offer['sdp'] as String, 'offer'),
        )
        .timeout(
          WebRTCConstants.operationTimeout,
          onTimeout: () =>
              throw WebRTCException('setRemoteDescription timeout'),
        );

// AFTER
  Future<Map<String, dynamic>> handleOffer(
    String peerId,
    Map<String, dynamic> offer,
  ) async {
    final connection = await _createConnection(peerId);

    // Pre-generate ephemeral keypair BEFORE setRemoteDescription triggers
    // data channel creation (for the answerer, channels arrive via
    // onDataChannel after the remote description is applied).
    final ephemeral = await _cryptoService.generateEphemeralKeyPair();
    _pendingEphemeralKeys[peerId] = ephemeral.privateKey;
    _pendingEphemeralPublicKeys[peerId] = ephemeral.publicKey;

    // NEW: Verify SDP signature before accepting
    final sdp = offer['sdp'] as String;
    final signature = offer['sdpSignature'] as String?;
    final signingPublicKey = offer['signingPublicKey'] as String?;

    if (signature != null && signingPublicKey != null) {
      final isValid = await _cryptoService.verifySDP(
        sdp: sdp,
        signature: signature,
        peerSigningPublicKey: signingPublicKey,
      );

      if (!isValid) {
        logger.error('WebRTCService',
            'SDP signature verification failed for peer $peerId -- POSSIBLE MITM ATTACK');
        throw WebRTCException(
            'SDP signature verification failed -- possible MITM attack');
      }

      logger.info('WebRTCService',
          'SDP signature verified for peer $peerId');
    } else {
      // Backward compatibility: allow unsigned SDP with warning
      logger.warning('WebRTCService',
          'Received unsigned SDP from peer $peerId -- degraded trust level');
    }

    // Set remote description with timeout to prevent hanging
    await connection.pc
        .setRemoteDescription(
          RTCSessionDescription(sdp, 'offer'),
        )
        .timeout(
          WebRTCConstants.operationTimeout,
          onTimeout: () =>
              throw WebRTCException('setRemoteDescription timeout'),
        );
```

#### 3.3 Update handleOffer to sign the answer

**Location**: Lines 159-172 (return statement of `handleOffer()`)

```dart
// BEFORE
    final answer = await connection.pc.createAnswer().timeout(
          WebRTCConstants.operationTimeout,
          onTimeout: () => throw WebRTCException('createAnswer timeout'),
        );
    await connection.pc.setLocalDescription(answer).timeout(
          WebRTCConstants.operationTimeout,
          onTimeout: () => throw WebRTCException('setLocalDescription timeout'),
        );

    return {
      'type': 'answer',
      'sdp': answer.sdp,
    };

// AFTER
    final answer = await connection.pc.createAnswer().timeout(
          WebRTCConstants.operationTimeout,
          onTimeout: () => throw WebRTCException('createAnswer timeout'),
        );
    await connection.pc.setLocalDescription(answer).timeout(
          WebRTCConstants.operationTimeout,
          onTimeout: () => throw WebRTCException('setLocalDescription timeout'),
        );

    final answerSdp = answer.sdp!;
    final answerSignature = await _cryptoService.signSDP(answerSdp);

    return {
      'type': 'answer',
      'sdp': answerSdp,
      'sdpSignature': answerSignature,  // NEW
      'signingPublicKey': _cryptoService.signingPublicKeyBase64,  // NEW
    };
```

#### 3.4 Update handleAnswer to verify signature

**Location**: Lines 175-194 (inside `handleAnswer()` method)

```dart
// BEFORE
  Future<void> handleAnswer(
    String peerId,
    Map<String, dynamic> answer,
  ) async {
    final connection = _connections[peerId];
    if (connection == null) {
      throw WebRTCException('No connection found for peer: $peerId');
    }

    // Set remote description with timeout to prevent hanging
    await connection.pc
        .setRemoteDescription(
          RTCSessionDescription(answer['sdp'] as String, 'answer'),
        )
        .timeout(
          WebRTCConstants.operationTimeout,
          onTimeout: () =>
              throw WebRTCException('setRemoteDescription timeout'),
        );
  }

// AFTER
  Future<void> handleAnswer(
    String peerId,
    Map<String, dynamic> answer,
  ) async {
    final connection = _connections[peerId];
    if (connection == null) {
      throw WebRTCException('No connection found for peer: $peerId');
    }

    // NEW: Verify SDP signature before accepting
    final sdp = answer['sdp'] as String;
    final signature = answer['sdpSignature'] as String?;
    final signingPublicKey = answer['signingPublicKey'] as String?;

    if (signature != null && signingPublicKey != null) {
      final isValid = await _cryptoService.verifySDP(
        sdp: sdp,
        signature: signature,
        peerSigningPublicKey: signingPublicKey,
      );

      if (!isValid) {
        logger.error('WebRTCService',
            'SDP answer signature verification failed for peer $peerId -- POSSIBLE MITM ATTACK');
        throw WebRTCException(
            'SDP answer signature verification failed -- possible MITM attack');
      }

      logger.info('WebRTCService',
          'SDP answer signature verified for peer $peerId');
    } else {
      logger.warning('WebRTCService',
          'Received unsigned SDP answer from peer $peerId -- degraded trust level');
    }

    // Set remote description with timeout to prevent hanging
    await connection.pc
        .setRemoteDescription(
          RTCSessionDescription(sdp, 'answer'),
        )
        .timeout(
          WebRTCConstants.operationTimeout,
          onTimeout: () =>
              throw WebRTCException('setRemoteDescription timeout'),
        );
  }
```

---

### Step 4: Sign ICE Candidates

ICE candidates are sent individually as they're discovered. Each candidate should be signed to prevent injection.

**File**: `packages/app/lib/core/network/webrtc_service.dart`

#### 4.1 Sign ICE candidates when they're sent

**Location**: Search for `onIceCandidate` callback (approximately line 250-280)

```dart
// BEFORE (example - actual location may vary)
connection.pc.onIceCandidate = (candidate) {
  if (candidate.candidate != null) {
    _signalingClient.sendIceCandidate(peerId, {
      'candidate': candidate.candidate,
      'sdpMid': candidate.sdpMid,
      'sdpMLineIndex': candidate.sdpMLineIndex,
    });
  }
};

// AFTER
connection.pc.onIceCandidate = (candidate) async {
  if (candidate.candidate != null) {
    final candidateData = {
      'candidate': candidate.candidate,
      'sdpMid': candidate.sdpMid,
      'sdpMLineIndex': candidate.sdpMLineIndex,
    };

    // Sign the ICE candidate JSON (deterministic serialization)
    final candidateJson = jsonEncode(candidateData);
    final signature = await _cryptoService.signData(
      Uint8List.fromList(utf8.encode(candidateJson))
    );

    _signalingClient.sendIceCandidate(peerId, {
      ...candidateData,
      'candidateSignature': signature,  // NEW
      'signingPublicKey': _cryptoService.signingPublicKeyBase64,  // NEW
    });
  }
};
```

#### 4.2 Verify ICE candidate signatures on receipt

**Location**: Lines 197-217 (inside `addIceCandidate()` method)

```dart
// BEFORE
  Future<void> addIceCandidate(
    String peerId,
    Map<String, dynamic> candidate,
  ) async {
    final connection = _connections[peerId];
    if (connection == null) {
      // Queue candidate — connection is still being set up (handleOffer in progress)
      logger.debug('WebRTCService',
          'Queuing ICE candidate for $peerId (connection not ready)');
      _pendingCandidates.putIfAbsent(peerId, () => []).add(candidate);
      return;
    }

    // Add ICE candidate with timeout to prevent hanging
    await connection.pc
        .addCandidate(
          RTCIceCandidate(
            candidate['candidate'] as String?,
            candidate['sdpMid'] as String?,

// AFTER
  Future<void> addIceCandidate(
    String peerId,
    Map<String, dynamic> candidate,
  ) async {
    final connection = _connections[peerId];

    // NEW: Verify ICE candidate signature
    final signature = candidate['candidateSignature'] as String?;
    final signingPublicKey = candidate['signingPublicKey'] as String?;

    if (signature != null && signingPublicKey != null) {
      // Recreate the signed payload (without signature/key fields)
      final candidateData = {
        'candidate': candidate['candidate'],
        'sdpMid': candidate['sdpMid'],
        'sdpMLineIndex': candidate['sdpMLineIndex'],
      };
      final candidateJson = jsonEncode(candidateData);

      final isValid = await _cryptoService.verifyData(
        data: Uint8List.fromList(utf8.encode(candidateJson)),
        signatureBase64: signature,
        peerSigningPublicKeyBase64: signingPublicKey,
      );

      if (!isValid) {
        logger.error('WebRTCService',
            'ICE candidate signature verification failed for peer $peerId -- REJECTING CANDIDATE');
        // Silently drop invalid candidates (don't throw, ICE can continue with other candidates)
        return;
      }

      logger.debug('WebRTCService',
          'ICE candidate signature verified for peer $peerId');
    } else {
      logger.warning('WebRTCService',
          'Received unsigned ICE candidate from peer $peerId');
    }

    if (connection == null) {
      // Queue candidate — connection is still being set up (handleOffer in progress)
      logger.debug('WebRTCService',
          'Queuing ICE candidate for $peerId (connection not ready)');
      _pendingCandidates.putIfAbsent(peerId, () => []).add(candidate);
      return;
    }

    // Add ICE candidate with timeout to prevent hanging
    await connection.pc
        .addCandidate(
          RTCIceCandidate(
            candidate['candidate'] as String?,
            candidate['sdpMid'] as String?,
```

---

### Step 5: Update Call Signaling (VoIP)

The VoIP call flow uses separate signaling messages (`call_offer`, `call_answer`, `call_ice`). These also contain SDP and need signing.

**File**: `packages/app/lib/core/network/signaling_client.dart`

#### 5.1 Update sendCallOffer to sign SDP

**Location**: Lines 424-432 (inside `sendCallOffer()` method)

```dart
// BEFORE
  void sendCallOffer(
      String callId, String targetId, String sdp, bool withVideo) {
    _send(CallOfferMessage(
      callId: callId,
      targetId: targetId,
      sdp: sdp,
      withVideo: withVideo,
    ).toJson());
  }

// AFTER
  Future<void> sendCallOffer(
      String callId, String targetId, String sdp, bool withVideo,
      {required CryptoService cryptoService}) async {  // NEW: Require crypto service
    final signature = await cryptoService.signSDP(sdp);

    final message = CallOfferMessage(
      callId: callId,
      targetId: targetId,
      sdp: sdp,
      withVideo: withVideo,
    ).toJson();

    // Add signature fields to the payload
    message['payload']['sdpSignature'] = signature;
    message['payload']['signingPublicKey'] = cryptoService.signingPublicKeyBase64;

    _send(message);
  }
```

**Note**: Similar changes needed for `sendCallAnswer()` and verification logic in the call service that processes `CallOfferMessage` and `CallAnswerMessage`.

---

## Test Plan

### Unit Tests

#### 1. CryptoService Signing Tests (`test/unit/crypto_service_test.dart`)

```dart
group('SDP Signing', () {
  test('signSDP returns valid base64 signature', () async {
    final crypto = CryptoService();
    await crypto.initialize();

    final sdp = 'v=0\r\no=- 12345 2 IN IP4 0.0.0.0\r\n...';
    final signature = await crypto.signSDP(sdp);

    expect(signature, isNotEmpty);
    expect(() => base64Decode(signature), returnsNormally);
  });

  test('verifySDP accepts valid signature', () async {
    final crypto = CryptoService();
    await crypto.initialize();

    final sdp = 'v=0\r\no=- 12345 2 IN IP4 0.0.0.0\r\n...';
    final signature = await crypto.signSDP(sdp);
    final publicKey = crypto.signingPublicKeyBase64;

    final isValid = await crypto.verifySDP(
      sdp: sdp,
      signature: signature,
      peerSigningPublicKey: publicKey,
    );

    expect(isValid, isTrue);
  });

  test('verifySDP rejects modified SDP', () async {
    final crypto = CryptoService();
    await crypto.initialize();

    final sdp = 'v=0\r\no=- 12345 2 IN IP4 0.0.0.0\r\n...';
    final signature = await crypto.signSDP(sdp);
    final publicKey = crypto.signingPublicKeyBase64;

    // Modify SDP (simulate MITM tampering)
    final tamperedSdp = sdp.replaceFirst('12345', '99999');

    final isValid = await crypto.verifySDP(
      sdp: tamperedSdp,
      signature: signature,
      peerSigningPublicKey: publicKey,
    );

    expect(isValid, isFalse);
  });

  test('verifySDP rejects wrong signing key', () async {
    final crypto1 = CryptoService();
    final crypto2 = CryptoService();
    await crypto1.initialize();
    await crypto2.initialize();

    final sdp = 'v=0\r\no=- 12345 2 IN IP4 0.0.0.0\r\n...';
    final signature = await crypto1.signSDP(sdp);
    final wrongKey = crypto2.signingPublicKeyBase64;

    final isValid = await crypto1.verifySDP(
      sdp: sdp,
      signature: signature,
      peerSigningPublicKey: wrongKey,
    );

    expect(isValid, isFalse);
  });

  test('signData and verifyData roundtrip', () async {
    final crypto = CryptoService();
    await crypto.initialize();

    final data = Uint8List.fromList(utf8.encode('test data'));
    final signature = await crypto.signData(data);

    final isValid = await crypto.verifyData(
      data: data,
      signatureBase64: signature,
      peerSigningPublicKeyBase64: crypto.signingPublicKeyBase64,
    );

    expect(isValid, isTrue);
  });
});
```

#### 2. WebRTCService Verification Tests (`test/unit/webrtc_service_test.dart`)

```dart
group('SDP Signature Verification', () {
  test('handleOffer rejects tampered SDP', () async {
    // Mock WebRTC and crypto service
    final mockCrypto = MockCryptoService();
    final webrtc = WebRTCService(cryptoService: mockCrypto, ...);

    // Simulate receiving an offer with invalid signature
    when(() => mockCrypto.verifySDP(
      sdp: any(named: 'sdp'),
      signature: any(named: 'signature'),
      peerSigningPublicKey: any(named: 'peerSigningPublicKey'),
    )).thenAnswer((_) async => false);

    final offer = {
      'sdp': 'v=0\r\n...',
      'sdpSignature': 'fake_signature',
      'signingPublicKey': 'fake_key',
    };

    expect(
      () => webrtc.handleOffer('peer123', offer),
      throwsA(isA<WebRTCException>().having(
        (e) => e.message,
        'message',
        contains('MITM'),
      )),
    );
  });

  test('handleOffer accepts valid signed SDP', () async {
    final mockCrypto = MockCryptoService();
    final webrtc = WebRTCService(cryptoService: mockCrypto, ...);

    when(() => mockCrypto.verifySDP(
      sdp: any(named: 'sdp'),
      signature: any(named: 'signature'),
      peerSigningPublicKey: any(named: 'peerSigningPublicKey'),
    )).thenAnswer((_) async => true);

    final offer = {
      'sdp': 'v=0\r\n...',
      'sdpSignature': 'valid_signature',
      'signingPublicKey': 'peer_key',
    };

    // Should not throw
    expect(
      () => webrtc.handleOffer('peer123', offer),
      returnsNormally,
    );
  });

  test('handleOffer accepts unsigned SDP with warning (backward compat)', () async {
    final webrtc = WebRTCService(...);

    final offer = {
      'sdp': 'v=0\r\n...',
      // No signature fields
    };

    // Should not throw, but should log warning
    expect(
      () => webrtc.handleOffer('peer123', offer),
      returnsNormally,
    );
    // Verify warning was logged (requires logger mock)
  });

  test('addIceCandidate rejects invalid signature', () async {
    final mockCrypto = MockCryptoService();
    final webrtc = WebRTCService(cryptoService: mockCrypto, ...);

    when(() => mockCrypto.verifyData(
      data: any(named: 'data'),
      signatureBase64: any(named: 'signatureBase64'),
      peerSigningPublicKeyBase64: any(named: 'peerSigningPublicKeyBase64'),
    )).thenAnswer((_) async => false);

    final candidate = {
      'candidate': 'candidate:1 1 UDP 2130706431 192.168.1.1 12345 typ host',
      'sdpMid': 'data',
      'sdpMLineIndex': 0,
      'candidateSignature': 'invalid_sig',
      'signingPublicKey': 'peer_key',
    };

    // Should silently drop (not throw)
    await webrtc.addIceCandidate('peer123', candidate);

    // Verify candidate was not added to peer connection (requires mock)
  });
});
```

### Integration Tests

#### 3. End-to-End SDP Signing Test

Create a new test file: `test/integration/sdp_signing_test.dart`

```dart
void main() {
  group('SDP Signing E2E', () {
    test('Two peers exchange signed SDP offers/answers', () async {
      // Initialize two crypto services (Alice and Bob)
      final aliceCrypto = CryptoService();
      final bobCrypto = CryptoService();
      await aliceCrypto.initialize();
      await bobCrypto.initialize();

      // Alice creates and signs an offer
      final aliceOffer = 'v=0\r\no=- 12345 2 IN IP4 0.0.0.0\r\n...';
      final aliceSignature = await aliceCrypto.signSDP(aliceOffer);

      // Bob verifies Alice's offer
      final aliceOfferValid = await bobCrypto.verifySDP(
        sdp: aliceOffer,
        signature: aliceSignature,
        peerSigningPublicKey: aliceCrypto.signingPublicKeyBase64,
      );
      expect(aliceOfferValid, isTrue);

      // Bob creates and signs an answer
      final bobAnswer = 'v=0\r\no=- 67890 2 IN IP4 0.0.0.0\r\n...';
      final bobSignature = await bobCrypto.signSDP(bobAnswer);

      // Alice verifies Bob's answer
      final bobAnswerValid = await aliceCrypto.verifySDP(
        sdp: bobAnswer,
        signature: bobSignature,
        peerSigningPublicKey: bobCrypto.signingPublicKeyBase64,
      );
      expect(bobAnswerValid, isTrue);
    });

    test('MITM attack is detected', () async {
      final aliceCrypto = CryptoService();
      final bobCrypto = CryptoService();
      final attackerCrypto = CryptoService();
      await aliceCrypto.initialize();
      await bobCrypto.initialize();
      await attackerCrypto.initialize();

      // Alice creates and signs an offer
      final aliceOffer = 'v=0\r\na=fingerprint:sha-256 AA:BB:CC:...\r\n';
      final aliceSignature = await aliceCrypto.signSDP(aliceOffer);

      // Attacker modifies the SDP (changes fingerprint)
      final tamperedOffer = aliceOffer.replaceFirst(
        'AA:BB:CC',
        'XX:YY:ZZ',
      );

      // Bob tries to verify with the tampered SDP but Alice's signature
      final isValid = await bobCrypto.verifySDP(
        sdp: tamperedOffer,
        signature: aliceSignature,  // Original signature
        peerSigningPublicKey: aliceCrypto.signingPublicKeyBase64,
      );

      expect(isValid, isFalse);  // Attack detected!
    });
  });
}
```

#### 4. VPS Forwarding Test (Server-Side)

Create a test in `packages/server-vps/tests/unit/signaling-handler.test.js`:

```javascript
describe('SDP Signature Forwarding', () => {
  it('forwards SDP signature fields transparently', () => {
    const handler = new SignalingHandler(config);

    // Alice sends signed offer
    const aliceOffer = {
      type: 'offer',
      target: 'BOB123',
      payload: {
        sdp: 'v=0\r\n...',
        sdpSignature: 'base64_signature',
        signingPublicKey: 'alice_public_key',
      },
    };

    handler.handleSignalingForward(aliceWs, aliceOffer);

    // Verify Bob receives exact same payload
    const bobMessage = getBobReceivedMessage();
    expect(bobMessage.payload.sdp).toBe(aliceOffer.payload.sdp);
    expect(bobMessage.payload.sdpSignature).toBe(aliceOffer.payload.sdpSignature);
    expect(bobMessage.payload.signingPublicKey).toBe(aliceOffer.payload.signingPublicKey);
  });

  it('cannot modify SDP without detection', () => {
    // This is a conceptual test - demonstrates that even if the VPS
    // modifies the SDP, the client-side signature verification will fail.
    // Actual implementation happens on the client side.
  });
});
```

### Manual Testing Checklist

- [ ] Two devices pair successfully with signed SDP
- [ ] WebRTC data channel establishes and messages are exchanged
- [ ] File transfer works with signed SDP/ICE
- [ ] VoIP call establishes with signed call SDP
- [ ] Unsigned SDP from old client is accepted with warning log
- [ ] Modified SDP is rejected with error log mentioning MITM
- [ ] Modified ICE candidate is silently dropped (connection continues with other candidates)
- [ ] App works with VPS server that doesn't understand signature fields (backward compat)

---

## Rollback Risk

### Low Risk - Graceful Degradation

This implementation is designed for **backward compatibility**:

1. **Client receives unsigned SDP**: Logs a warning but accepts it (degraded trust mode)
2. **Server forwards unknown fields**: VPS transparently forwards `sdpSignature` and `signingPublicKey` as part of the `payload` object
3. **Old client receives signed SDP**: Ignores unknown fields, works normally

### Rollback Procedure

If critical issues arise:

1. **Client-side hotfix**: Change verification from `throw WebRTCException` to `logger.warning` (temporarily disable enforcement)
2. **Full rollback**: Remove signing code from `createOffer`, `handleOffer`, `handleAnswer` (keep verification methods for testing)
3. **No server-side changes needed** - server is agnostic to payload content

### Monitoring

After deployment, monitor:

- **Error rate** for "SDP signature verification failed"
- **Warning rate** for "Received unsigned SDP"
- **Connection success rate** (should not decrease)
- **DTLS fingerprint mismatches** (WebRTC layer - should not increase)

---

## Dependencies on Other Stories

### No Blocking Dependencies

This story is **independent** and can be implemented immediately:

- Does not depend on Story 015 (VPS Reverse Proxy) - works over WSS with or without reverse proxy
- Does not depend on Story 019 (DO Sharding) - signing happens at client layer, independent of server topology

### Related Security Stories

- **Complementary to Story 015**: TLS protects transport, SDP signing protects application layer (defense in depth)
- **Synergy with bootstrap signing**: Reuses the same Ed25519 signing pattern established for bootstrap responses

### Future Enhancements (Out of Scope)

1. **DTLS Fingerprint Binding** (mentioned in story): After WebRTC connection, extract actual DTLS certificate fingerprint and compare with signed SDP
2. **ICE Candidate Bundling**: Instead of signing individual candidates, bundle them in the SDP and sign once
3. **Signature Algorithm Agility**: Support multiple signature algorithms with a `signatureAlgorithm` field
4. **Revocation**: Mechanism to revoke compromised signing keys (requires protocol extension)

---

## Implementation Checklist

- [ ] Step 1.1: Add Ed25519 key pair storage to CryptoService
- [ ] Step 1.2: Update initialize() to load/generate signing keys
- [ ] Step 1.3: Add _loadOrGenerateSigningKeys() and _persistSigningKeys()
- [ ] Step 1.4: Add public signing/verification methods (signSDP, verifySDP)
- [ ] Step 1.5: Update regenerateIdentityKeys() to regenerate signing keys
- [ ] Step 3.1: Sign SDP in createOffer()
- [ ] Step 3.2: Verify SDP in handleOffer()
- [ ] Step 3.3: Sign SDP in handleOffer() answer creation
- [ ] Step 3.4: Verify SDP in handleAnswer()
- [ ] Step 4.1: Sign ICE candidates in onIceCandidate callback
- [ ] Step 4.2: Verify ICE candidates in addIceCandidate()
- [ ] Step 5.1: Update call signaling (sendCallOffer, sendCallAnswer)
- [ ] Unit tests: CryptoService signing tests
- [ ] Unit tests: WebRTCService verification tests
- [ ] Integration tests: E2E SDP signing test
- [ ] Integration tests: MITM detection test
- [ ] Manual testing: Two-device pairing with signed SDP
- [ ] Manual testing: Backward compatibility with unsigned SDP
- [ ] Documentation: Update SECURITY.md with SDP signing details

---

## Estimated Timeline

- **Day 1**: Step 1 (CryptoService signing methods) + unit tests
- **Day 2**: Step 3 (WebRTC offer/answer signing) + verification tests
- **Day 3**: Step 4 (ICE candidate signing) + integration tests
- **Day 4**: Step 5 (Call signaling) + manual testing
- **Day 5**: Bug fixes, edge case handling, documentation

**Total**: 3-5 days depending on testing complexity and edge cases discovered.
