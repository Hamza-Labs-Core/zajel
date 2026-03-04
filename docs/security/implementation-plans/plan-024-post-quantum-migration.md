# Implementation Plan: Post-Quantum Key Exchange Migration

**Story:** [Story 024: Post-Quantum Key Exchange Migration Planning](../stories/story-024-post-quantum-migration.md)

**Priority:** LONG-TERM
**Severity:** LOW
**Estimated Effort:** 8-12 weeks (multi-platform, library research + implementation + testing)

---

## 1. Summary

This plan outlines the migration from X25519-only key exchange to a hybrid X25519 + ML-KEM-768 construction across all three Zajel client platforms (Flutter app, Python headless client, JavaScript web client). The hybrid approach ensures security against both classical and quantum adversaries, following the principle that the system remains secure as long as either algorithm is unbroken.

**Security Benefit:** Protects against "harvest now, decrypt later" attacks where an adversary records encrypted sessions today and decrypts them once a cryptographically relevant quantum computer (CRQC) becomes available.

**Key Design Decisions:**
- Use ML-KEM-768 (NIST FIPS 203) as the post-quantum component
- Implement hybrid construction: `session_key = HKDF-SHA256(X25519_secret || ML-KEM_secret)`
- Add protocol version negotiation for backward compatibility
- Preserve forward secrecy with ephemeral keys for both algorithms
- Maintain wire-format compatibility during migration period

---

## 2. Files to Modify

### 2.1 Flutter App (Dart)

| File Path | Modification Type | Description |
|-----------|------------------|-------------|
| `packages/app/lib/core/crypto/crypto_service.dart` | Major refactor | Add ML-KEM-768 key generation, encapsulation, decapsulation; implement hybrid key exchange |
| `packages/app/lib/core/constants.dart` | Minor addition | Add ML-KEM public key size constant, hybrid protocol version |
| `packages/app/pubspec.yaml` | Dependency addition | Add FFI wrapper for liboqs or pure-Dart ML-KEM library |
| `packages/app/lib/core/crypto/ml_kem_service.dart` | **NEW FILE** | Wrapper around ML-KEM implementation (FFI or pure Dart) |
| `packages/app/test/unit/crypto/crypto_service_test.dart` | Test expansion | Add hybrid key exchange tests |
| `packages/app/test/unit/crypto/ml_kem_test.dart` | **NEW FILE** | ML-KEM primitive tests with NIST test vectors |
| `packages/app/test/unit/crypto/cross_platform_hybrid_test.dart` | **NEW FILE** | Cross-platform hybrid key derivation tests |

### 2.2 Python Headless Client

| File Path | Modification Type | Description |
|-----------|------------------|-------------|
| `packages/headless-client/zajel/crypto.py` | Major refactor | Add ML-KEM-768 support using `cryptography` >= 44.0; implement hybrid key exchange |
| `packages/headless-client/pyproject.toml` | Dependency update | Update `cryptography` to >= 44.0 for ML-KEM support |
| `packages/headless-client/tests/test_crypto.py` | Test expansion | Add hybrid key exchange tests |
| `packages/headless-client/tests/test_ml_kem.py` | **NEW FILE** | ML-KEM primitive tests with NIST test vectors |

### 2.3 JavaScript Web Client

| File Path | Modification Type | Description |
|-----------|------------------|-------------|
| `packages/web-client/src/lib/crypto.ts` | Major refactor | Add ML-KEM-768 support using `@noble/post-quantum`; implement hybrid key exchange |
| `packages/web-client/src/lib/constants.ts` | Minor addition | Add ML-KEM public key size constant, hybrid protocol version |
| `packages/web-client/package.json` | Dependency addition | Add `@noble/post-quantum` for ML-KEM support |
| `packages/web-client/src/lib/__tests__/crypto.test.ts` | Test expansion | Add hybrid key exchange tests |
| `packages/web-client/src/lib/__tests__/ml-kem.test.ts` | **NEW FILE** | ML-KEM primitive tests with NIST test vectors |

### 2.4 Protocol / Signaling

| File Path | Modification Type | Description |
|-----------|------------------|-------------|
| `packages/app/lib/core/network/signaling_client.dart` | Minor modification | Add `pqPublicKey` and `protocolVersion` fields to signaling messages |
| `packages/headless-client/zajel/signaling.py` | Minor modification | Add `pqPublicKey` and `protocolVersion` fields to signaling messages |
| `packages/web-client/src/lib/signaling.ts` | Minor modification | Add `pqPublicKey` and `protocolVersion` fields to signaling messages |

---

## 3. Implementation Steps

### Phase 1: Library Research and Selection (Week 1-2)

#### Step 1.1: Evaluate Dart/Flutter ML-KEM Libraries

**Research Options:**
1. **FFI wrapper around liboqs** (C library from Open Quantum Safe)
   - Pros: Battle-tested, NIST-compliant, actively maintained
   - Cons: Requires native code packaging, platform-specific builds
   - Evaluation criteria: Build complexity, mobile support (Android/iOS), Windows support

2. **Pure Dart ML-KEM implementation** (if available)
   - Pros: No native dependencies, easier to package
   - Cons: Performance may be slower, fewer implementations available
   - Evaluation criteria: NIST test vector compliance, performance benchmarks

**Action:** Create proof-of-concept for both approaches, benchmark key generation and encapsulation performance on Android/iOS devices.

#### Step 1.2: Verify Python ML-KEM Support

**Validation:**
```python
# Test that cryptography >= 44.0 has ML-KEM support
from cryptography.hazmat.primitives.asymmetric.mlkem import MLKEM768PrivateKey

private_key = MLKEM768PrivateKey.generate()
public_key = private_key.public_key()
ciphertext, shared_secret = public_key.encapsulate()
decapsulated_secret = private_key.decapsulate(ciphertext)
assert shared_secret == decapsulated_secret
```

**Action:** Update `pyproject.toml` to require `cryptography >= 44.0`, run NIST test vectors.

#### Step 1.3: Evaluate JavaScript ML-KEM Libraries

**Primary Option: `@noble/post-quantum`**
```typescript
import { ml_kem768 } from '@noble/post-quantum/ml-kem';

const seed = new Uint8Array(64); // deterministic for testing
const [publicKey, secretKey] = ml_kem768.keygen(seed);
const { cipherText, sharedSecret } = ml_kem768.encapsulate(publicKey);
const decapsulated = ml_kem768.decapsulate(cipherText, secretKey);
```

**Action:** Add `@noble/post-quantum` to `package.json`, verify NIST test vector compliance.

---

### Phase 2: Add Constants and Protocol Version (Week 2)

#### Step 2.1: Update Constants Files

**File:** `packages/app/lib/core/constants.dart`

**Before:**
```dart
class CryptoConstants {
  CryptoConstants._();

  /// X25519 public key size in bytes
  static const int x25519KeySize = 32;

  /// HKDF output length in bytes
  static const int hkdfOutputLength = 32;
}
```

**After:**
```dart
class CryptoConstants {
  CryptoConstants._();

  /// X25519 public key size in bytes
  static const int x25519KeySize = 32;

  /// ML-KEM-768 public key size in bytes
  static const int mlKem768PublicKeySize = 1184;

  /// ML-KEM-768 ciphertext size in bytes
  static const int mlKem768CiphertextSize = 1088;

  /// ML-KEM-768 shared secret size in bytes
  static const int mlKem768SharedSecretSize = 32;

  /// HKDF output length in bytes
  static const int hkdfOutputLength = 32;

  /// Protocol version for classical X25519-only key exchange
  static const int protocolVersionClassical = 1;

  /// Protocol version for hybrid X25519 + ML-KEM-768 key exchange
  static const int protocolVersionHybrid = 2;

  /// Current protocol version (what we advertise in signaling)
  static const int protocolVersionCurrent = protocolVersionHybrid;

  /// Supported key exchange methods
  static const List<String> supportedKEMs = ['x25519', 'x25519-mlkem768'];
}
```

**Repeat for:**
- `packages/web-client/src/lib/constants.ts`
- `packages/headless-client/zajel/crypto.py` (as module-level constants)

---

#### Step 2.2: Update Signaling Message Schema

**File:** `packages/app/lib/core/network/signaling_client.dart`

**Before:**
```dart
// Existing pair_request message
final message = {
  'type': 'pair_request',
  'code': code,
  'publicKey': publicKey,
};
```

**After:**
```dart
// Hybrid-capable pair_request message
final message = {
  'type': 'pair_request',
  'code': code,
  'publicKey': publicKey,  // X25519 public key (base64)
  'pqPublicKey': pqPublicKey,  // ML-KEM-768 public key (base64, optional)
  'protocolVersion': CryptoConstants.protocolVersionCurrent,
  'supportedKEMs': CryptoConstants.supportedKEMs,
};
```

**Backward Compatibility Logic:**
- If `pqPublicKey` is absent in peer's message → fall back to X25519-only
- If `protocolVersion` < 2 → fall back to X25519-only
- If both peers support `x25519-mlkem768` → use hybrid mode

---

### Phase 3: Implement ML-KEM Primitives (Week 3-4)

#### Step 3.1: Dart ML-KEM Service (FFI Wrapper Approach)

**File:** `packages/app/lib/core/crypto/ml_kem_service.dart` (**NEW FILE**)

```dart
import 'dart:ffi';
import 'dart:typed_data';
import 'package:ffi/ffi.dart';

/// FFI wrapper around liboqs ML-KEM-768 implementation.
///
/// This service provides Dart bindings to the Open Quantum Safe (OQS)
/// liboqs C library for ML-KEM-768 (CRYSTALS-Kyber).
class MlKemService {
  static const int publicKeySize = 1184;
  static const int secretKeySize = 2400;
  static const int ciphertextSize = 1088;
  static const int sharedSecretSize = 32;

  late final DynamicLibrary _lib;
  late final _KeygenFunc _keygen;
  late final _EncapsulateFunc _encapsulate;
  late final _DecapsulateFunc _decapsulate;

  MlKemService() {
    // Load platform-specific library
    if (Platform.isAndroid || Platform.isLinux) {
      _lib = DynamicLibrary.open('liboqs.so');
    } else if (Platform.isIOS || Platform.isMacOS) {
      _lib = DynamicLibrary.open('liboqs.dylib');
    } else if (Platform.isWindows) {
      _lib = DynamicLibrary.open('oqs.dll');
    } else {
      throw UnsupportedError('Platform not supported for ML-KEM');
    }

    // Bind C functions
    _keygen = _lib.lookupFunction<
      Int32 Function(Pointer<Uint8>, Pointer<Uint8>),
      int Function(Pointer<Uint8>, Pointer<Uint8>)
    >('OQS_KEM_kyber_768_keypair');

    _encapsulate = _lib.lookupFunction<
      Int32 Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>),
      int Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>)
    >('OQS_KEM_kyber_768_encaps');

    _decapsulate = _lib.lookupFunction<
      Int32 Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>),
      int Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>)
    >('OQS_KEM_kyber_768_decaps');
  }

  /// Generate a new ML-KEM-768 key pair.
  ({Uint8List publicKey, Uint8List secretKey}) generateKeyPair() {
    final publicKeyPtr = calloc<Uint8>(publicKeySize);
    final secretKeyPtr = calloc<Uint8>(secretKeySize);

    try {
      final result = _keygen(publicKeyPtr, secretKeyPtr);
      if (result != 0) {
        throw Exception('ML-KEM keygen failed with code $result');
      }

      final publicKey = Uint8List.fromList(
        publicKeyPtr.asTypedList(publicKeySize)
      );
      final secretKey = Uint8List.fromList(
        secretKeyPtr.asTypedList(secretKeySize)
      );

      return (publicKey: publicKey, secretKey: secretKey);
    } finally {
      calloc.free(publicKeyPtr);
      calloc.free(secretKeyPtr);
    }
  }

  /// Encapsulate to a peer's public key (initiator side).
  ({Uint8List ciphertext, Uint8List sharedSecret}) encapsulate(
    Uint8List peerPublicKey
  ) {
    if (peerPublicKey.length != publicKeySize) {
      throw ArgumentError(
        'Invalid ML-KEM public key size: ${peerPublicKey.length}'
      );
    }

    final ciphertextPtr = calloc<Uint8>(ciphertextSize);
    final sharedSecretPtr = calloc<Uint8>(sharedSecretSize);
    final publicKeyPtr = calloc<Uint8>(publicKeySize);

    try {
      // Copy public key to native memory
      publicKeyPtr.asTypedList(publicKeySize).setAll(0, peerPublicKey);

      final result = _encapsulate(
        ciphertextPtr,
        sharedSecretPtr,
        publicKeyPtr
      );
      if (result != 0) {
        throw Exception('ML-KEM encapsulation failed with code $result');
      }

      final ciphertext = Uint8List.fromList(
        ciphertextPtr.asTypedList(ciphertextSize)
      );
      final sharedSecret = Uint8List.fromList(
        sharedSecretPtr.asTypedList(sharedSecretSize)
      );

      return (ciphertext: ciphertext, sharedSecret: sharedSecret);
    } finally {
      calloc.free(ciphertextPtr);
      calloc.free(sharedSecretPtr);
      calloc.free(publicKeyPtr);
    }
  }

  /// Decapsulate a ciphertext (responder side).
  Uint8List decapsulate(Uint8List ciphertext, Uint8List secretKey) {
    if (ciphertext.length != ciphertextSize) {
      throw ArgumentError(
        'Invalid ML-KEM ciphertext size: ${ciphertext.length}'
      );
    }
    if (secretKey.length != secretKeySize) {
      throw ArgumentError(
        'Invalid ML-KEM secret key size: ${secretKey.length}'
      );
    }

    final sharedSecretPtr = calloc<Uint8>(sharedSecretSize);
    final ciphertextPtr = calloc<Uint8>(ciphertextSize);
    final secretKeyPtr = calloc<Uint8>(secretKeySize);

    try {
      // Copy inputs to native memory
      ciphertextPtr.asTypedList(ciphertextSize).setAll(0, ciphertext);
      secretKeyPtr.asTypedList(secretKeySize).setAll(0, secretKey);

      final result = _decapsulate(
        sharedSecretPtr,
        ciphertextPtr,
        secretKeyPtr
      );
      if (result != 0) {
        throw Exception('ML-KEM decapsulation failed with code $result');
      }

      return Uint8List.fromList(
        sharedSecretPtr.asTypedList(sharedSecretSize)
      );
    } finally {
      calloc.free(sharedSecretPtr);
      calloc.free(ciphertextPtr);
      calloc.free(secretKeyPtr);
    }
  }
}

typedef _KeygenFunc = int Function(Pointer<Uint8>, Pointer<Uint8>);
typedef _EncapsulateFunc = int Function(
  Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>
);
typedef _DecapsulateFunc = int Function(
  Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>
);
```

**Build Integration:**
- Add liboqs as a submodule or vendored dependency
- Update `android/CMakeLists.txt` to build liboqs for Android
- Update `ios/Podfile` to include liboqs framework
- Add Windows build scripts for liboqs

---

#### Step 3.2: Python ML-KEM Support

**File:** `packages/headless-client/zajel/crypto.py`

**Addition (after imports):**
```python
from cryptography.hazmat.primitives.asymmetric.mlkem import (
    MLKEM768PrivateKey,
    MLKEM768PublicKey,
)

# Constants
MLKEM768_PUBLIC_KEY_SIZE = 1184
MLKEM768_CIPHERTEXT_SIZE = 1088
MLKEM768_SHARED_SECRET_SIZE = 32
```

**New Methods in `CryptoService` class:**
```python
@staticmethod
def generate_mlkem_keypair() -> tuple[bytes, MLKEM768PrivateKey]:
    """Generate an ML-KEM-768 keypair.

    Returns:
        Tuple of (public_key_bytes, private_key_object).
    """
    private_key = MLKEM768PrivateKey.generate()
    public_key_bytes = private_key.public_key().public_bytes_raw()
    return public_key_bytes, private_key

@staticmethod
def mlkem_encapsulate(peer_public_key_bytes: bytes) -> tuple[bytes, bytes]:
    """Encapsulate to a peer's ML-KEM public key (initiator side).

    Args:
        peer_public_key_bytes: Peer's ML-KEM-768 public key (1184 bytes).

    Returns:
        Tuple of (ciphertext, shared_secret).
    """
    if len(peer_public_key_bytes) != MLKEM768_PUBLIC_KEY_SIZE:
        raise ValueError(
            f"Invalid ML-KEM public key size: {len(peer_public_key_bytes)}"
        )

    peer_public_key = MLKEM768PublicKey.from_public_bytes(peer_public_key_bytes)
    ciphertext, shared_secret = peer_public_key.encapsulate()
    return ciphertext, shared_secret

@staticmethod
def mlkem_decapsulate(ciphertext: bytes, private_key: MLKEM768PrivateKey) -> bytes:
    """Decapsulate a ciphertext (responder side).

    Args:
        ciphertext: ML-KEM-768 ciphertext (1088 bytes).
        private_key: Our ML-KEM-768 private key object.

    Returns:
        The 32-byte shared secret.
    """
    if len(ciphertext) != MLKEM768_CIPHERTEXT_SIZE:
        raise ValueError(f"Invalid ML-KEM ciphertext size: {len(ciphertext)}")

    shared_secret = private_key.decapsulate(ciphertext)
    return shared_secret
```

---

#### Step 3.3: JavaScript ML-KEM Support

**File:** `packages/web-client/src/lib/crypto.ts`

**Addition (after imports):**
```typescript
import { ml_kem768 } from '@noble/post-quantum/ml-kem';

// Constants
const MLKEM768_PUBLIC_KEY_SIZE = 1184;
const MLKEM768_CIPHERTEXT_SIZE = 1088;
const MLKEM768_SHARED_SECRET_SIZE = 32;
```

**New Methods in `CryptoService` class:**
```typescript
/**
 * Generate an ML-KEM-768 keypair.
 * @returns Object with publicKey and secretKey as Uint8Arrays
 */
static generateMlKemKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  // @noble/post-quantum uses deterministic keygen from a seed
  // For production, use a cryptographically secure random seed
  const seed = crypto.getRandomValues(new Uint8Array(64));
  const [publicKey, secretKey] = ml_kem768.keygen(seed);
  return { publicKey, secretKey };
}

/**
 * Encapsulate to a peer's ML-KEM public key (initiator side).
 * @param peerPublicKey - Peer's ML-KEM-768 public key (1184 bytes)
 * @returns Object with ciphertext and sharedSecret
 */
static mlKemEncapsulate(peerPublicKey: Uint8Array): {
  ciphertext: Uint8Array;
  sharedSecret: Uint8Array;
} {
  if (peerPublicKey.length !== MLKEM768_PUBLIC_KEY_SIZE) {
    throw new CryptoError(
      `Invalid ML-KEM public key size: ${peerPublicKey.length}`,
      ErrorCodes.CRYPTO_INVALID_KEY
    );
  }

  const { cipherText, sharedSecret } = ml_kem768.encapsulate(peerPublicKey);
  return { ciphertext: cipherText, sharedSecret };
}

/**
 * Decapsulate a ciphertext (responder side).
 * @param ciphertext - ML-KEM-768 ciphertext (1088 bytes)
 * @param secretKey - Our ML-KEM-768 secret key
 * @returns The 32-byte shared secret
 */
static mlKemDecapsulate(
  ciphertext: Uint8Array,
  secretKey: Uint8Array
): Uint8Array {
  if (ciphertext.length !== MLKEM768_CIPHERTEXT_SIZE) {
    throw new CryptoError(
      `Invalid ML-KEM ciphertext size: ${ciphertext.length}`,
      ErrorCodes.CRYPTO_INVALID_KEY
    );
  }

  return ml_kem768.decapsulate(ciphertext, secretKey);
}
```

---

### Phase 4: Implement Hybrid Key Exchange (Week 5-6)

#### Step 4.1: Dart Hybrid Key Exchange

**File:** `packages/app/lib/core/crypto/crypto_service.dart`

**Add new fields to `CryptoService` class:**
```dart
class CryptoService {
  // Existing X25519 fields...
  final X25519 _x25519 = X25519();
  SimpleKeyPair? _identityKeyPair;

  // New ML-KEM fields
  final MlKemService _mlKem = MlKemService();
  Uint8List? _mlKemPublicKey;
  Uint8List? _mlKemSecretKey;

  // Store peer ML-KEM public keys
  final Map<String, Uint8List> _peerMlKemPublicKeys = {};

  // Protocol version tracking per peer
  final Map<String, int> _peerProtocolVersions = {};
```

**New method: `initialize()` update:**
```dart
Future<void> initialize() async {
  if (_identityKeyPair != null) return;

  // Existing X25519 initialization
  await _loadOrGenerateIdentityKeys();

  // Generate ML-KEM identity keys
  final mlKemKeys = _mlKem.generateKeyPair();
  _mlKemPublicKey = mlKemKeys.publicKey;
  _mlKemSecretKey = mlKemKeys.secretKey;

  // Cache public keys
  if (_identityKeyPair != null) {
    final publicKey = await _identityKeyPair!.extractPublicKey();
    _publicKeyBase64Cache = base64Encode(Uint8List.fromList(publicKey.bytes));
  }

  await _loadOrGenerateStableId();
}
```

**New method: Get ML-KEM public key:**
```dart
/// Get our ML-KEM-768 public key as base64 for signaling.
String get mlKemPublicKeyBase64 {
  if (_mlKemPublicKey == null) {
    throw CryptoException(
      'CryptoService not initialized. Call initialize() first.'
    );
  }
  return base64Encode(_mlKemPublicKey!);
}
```

**New method: Hybrid session establishment:**
```dart
/// Establish a hybrid X25519 + ML-KEM-768 session with a peer.
///
/// Performs both classical and post-quantum key exchanges:
/// 1. X25519 ECDH (authenticates both parties, classical security)
/// 2. ML-KEM-768 encapsulation (post-quantum security)
/// 3. HKDF derives session key from concatenated secrets
///
/// The final session key is secure as long as either X25519 or ML-KEM
/// remains unbroken.
///
/// Returns the session ID (peerId) that can be used for encryption/decryption.
Future<String> establishHybridSession({
  required String peerId,
  required String peerX25519PublicKeyBase64,
  required String peerMlKemPublicKeyBase64,
}) async {
  if (_identityKeyPair == null || _mlKemSecretKey == null) {
    await initialize();
  }

  // 1. X25519 ECDH (existing logic)
  final peerX25519PublicKeyBytes = base64Decode(peerX25519PublicKeyBase64);
  final peerX25519PublicKey = SimplePublicKey(
    peerX25519PublicKeyBytes,
    type: KeyPairType.x25519,
  );
  final x25519SharedSecret = await _x25519.sharedSecretKey(
    keyPair: _identityKeyPair!,
    remotePublicKey: peerX25519PublicKey,
  );
  final x25519SharedSecretBytes = await x25519SharedSecret.extractBytes();

  // 2. ML-KEM-768 encapsulation (initiator) or decapsulation (responder)
  final peerMlKemPublicKeyBytes = base64Decode(peerMlKemPublicKeyBase64);
  _peerMlKemPublicKeys[peerId] = peerMlKemPublicKeyBytes;

  late final Uint8List mlKemSharedSecret;

  // For now, assume we're always the initiator (encapsulate)
  // TODO: Add role negotiation (initiator vs responder)
  final encapResult = _mlKem.encapsulate(peerMlKemPublicKeyBytes);
  mlKemSharedSecret = encapResult.sharedSecret;

  // Store ciphertext to send to peer (in signaling or data channel)
  // TODO: Add ciphertext exchange mechanism

  // 3. Combine secrets: X25519 || ML-KEM
  final combinedSecret = Uint8List(
    x25519SharedSecretBytes.length + mlKemSharedSecret.length
  );
  combinedSecret.setAll(0, x25519SharedSecretBytes);
  combinedSecret.setAll(x25519SharedSecretBytes.length, mlKemSharedSecret);

  // 4. Derive session key via HKDF with hybrid info string
  final sessionKey = await _hkdf.deriveKey(
    secretKey: SecretKey(combinedSecret),
    info: utf8.encode('zajel_hybrid_session'),
    nonce: const [],
  );

  // Diagnostic logging
  final sessionKeyBytes = await sessionKey.extractBytes();
  final sessionKeyHash = crypto.sha256.convert(sessionKeyBytes).toString();
  final x25519Hash = crypto.sha256.convert(x25519SharedSecretBytes).toString();
  final mlKemHash = crypto.sha256.convert(mlKemSharedSecret).toString();

  logger.info(
    'CryptoService',
    'establishHybridSession($peerId): '
    'x25519Hash=${x25519Hash.substring(0, 16)} '
    'mlKemHash=${mlKemHash.substring(0, 16)} '
    'sessionHash=${sessionKeyHash.substring(0, 16)}'
  );

  // Store session key
  _sessionKeys[peerId] = sessionKey;
  _peerProtocolVersions[peerId] = CryptoConstants.protocolVersionHybrid;
  await _storeSessionKey(peerId, sessionKey);

  return peerId;
}
```

**Update existing `establishSession` to detect hybrid capability:**
```dart
/// Establish a session with a peer using their public key.
///
/// Auto-detects protocol version:
/// - If peer provides ML-KEM public key → use hybrid mode
/// - Otherwise → fall back to classical X25519-only
///
/// Returns the session ID that can be used for encryption/decryption.
Future<String> establishSession(
  String peerId,
  String peerPublicKeyBase64, {
  String? peerMlKemPublicKeyBase64,  // NEW: optional PQ public key
  int? peerProtocolVersion,          // NEW: optional protocol version
}) async {
  // Detect hybrid capability
  final useHybrid = peerMlKemPublicKeyBase64 != null &&
                    (peerProtocolVersion ?? 1) >= CryptoConstants.protocolVersionHybrid;

  if (useHybrid) {
    return establishHybridSession(
      peerId: peerId,
      peerX25519PublicKeyBase64: peerPublicKeyBase64,
      peerMlKemPublicKeyBase64: peerMlKemPublicKeyBase64!,
    );
  }

  // Fall back to classical X25519-only (existing implementation)
  final sharedSecretBase64 = await performKeyExchange(peerPublicKeyBase64);
  final sharedSecretBytes = base64Decode(sharedSecretBase64);

  final sessionKey = await _hkdf.deriveKey(
    secretKey: SecretKey(sharedSecretBytes),
    info: utf8.encode('zajel_session'),
    nonce: const [],
  );

  _sessionKeys[peerId] = sessionKey;
  _peerProtocolVersions[peerId] = CryptoConstants.protocolVersionClassical;
  await _storeSessionKey(peerId, sessionKey);

  return peerId;
}
```

---

#### Step 4.2: Python Hybrid Key Exchange

**File:** `packages/headless-client/zajel/crypto.py`

**Add new fields to `CryptoService.__init__`:**
```python
def __init__(self, stable_id_path: Optional[str] = None):
    # Existing X25519 fields...
    self._private_key: Optional[X25519PrivateKey] = None

    # New ML-KEM fields
    self._mlkem_public_key: Optional[bytes] = None
    self._mlkem_private_key: Optional[MLKEM768PrivateKey] = None

    # Store peer ML-KEM public keys
    self._peer_mlkem_public_keys: dict[str, bytes] = {}

    # Protocol version tracking per peer
    self._peer_protocol_versions: dict[str, int] = {}
```

**Update `initialize()`:**
```python
def initialize(self) -> None:
    """Generate X25519 and ML-KEM-768 key pairs."""
    # Existing X25519 initialization
    self._private_key = X25519PrivateKey.generate()
    self._public_key_bytes = self._private_key.public_key().public_bytes_raw()

    # Generate ML-KEM identity keys
    self._mlkem_public_key, self._mlkem_private_key = self.generate_mlkem_keypair()

    self._load_or_generate_stable_id()
```

**New property:**
```python
@property
def mlkem_public_key_base64(self) -> str:
    """Get our ML-KEM-768 public key as base64."""
    if self._mlkem_public_key is None:
        raise RuntimeError("CryptoService not initialized")
    return base64.b64encode(self._mlkem_public_key).decode()
```

**New method: Hybrid key exchange:**
```python
def establish_hybrid_session(
    self,
    peer_id: str,
    peer_x25519_public_key_b64: str,
    peer_mlkem_public_key_b64: str,
    role: str = "initiator",  # "initiator" or "responder"
    mlkem_ciphertext_b64: Optional[str] = None,  # Required for responder
) -> tuple[bytes, Optional[bytes]]:
    """Establish a hybrid X25519 + ML-KEM-768 session.

    Args:
        peer_id: The peer's identifier.
        peer_x25519_public_key_b64: Peer's X25519 public key (base64).
        peer_mlkem_public_key_b64: Peer's ML-KEM-768 public key (base64).
        role: "initiator" (encapsulate) or "responder" (decapsulate).
        mlkem_ciphertext_b64: ML-KEM ciphertext (base64, required for responder).

    Returns:
        Tuple of (session_key, mlkem_ciphertext_bytes).
        For initiator: returns the ciphertext to send to peer.
        For responder: returns None as ciphertext.
    """
    if self._private_key is None or self._mlkem_private_key is None:
        raise RuntimeError("CryptoService not initialized")

    # 1. X25519 ECDH
    peer_x25519_bytes = base64.b64decode(peer_x25519_public_key_b64)
    peer_x25519_pub = X25519PublicKey.from_public_bytes(peer_x25519_bytes)
    x25519_shared_secret = self._private_key.exchange(peer_x25519_pub)

    # 2. ML-KEM encapsulation or decapsulation
    peer_mlkem_bytes = base64.b64decode(peer_mlkem_public_key_b64)
    self._peer_mlkem_public_keys[peer_id] = peer_mlkem_bytes

    mlkem_ciphertext_return: Optional[bytes] = None

    if role == "initiator":
        # Initiator: encapsulate to peer's public key
        mlkem_ciphertext, mlkem_shared_secret = self.mlkem_encapsulate(
            peer_mlkem_bytes
        )
        mlkem_ciphertext_return = mlkem_ciphertext
    elif role == "responder":
        # Responder: decapsulate peer's ciphertext
        if mlkem_ciphertext_b64 is None:
            raise ValueError("mlkem_ciphertext_b64 required for responder role")
        mlkem_ciphertext = base64.b64decode(mlkem_ciphertext_b64)
        mlkem_shared_secret = self.mlkem_decapsulate(
            mlkem_ciphertext,
            self._mlkem_private_key
        )
    else:
        raise ValueError(f"Invalid role: {role}")

    # 3. Combine secrets: X25519 || ML-KEM
    combined_secret = x25519_shared_secret + mlkem_shared_secret

    # 4. Derive session key via HKDF with hybrid info string
    session_key = HKDF(
        algorithm=SHA256(),
        length=32,
        salt=b"",
        info=b"zajel_hybrid_session",
    ).derive(combined_secret)

    self._session_keys[peer_id] = session_key
    self._peer_protocol_versions[peer_id] = 2  # Hybrid protocol version
    self._seen_nonces[peer_id] = set()

    # Diagnostic logging
    x25519_hash = hashlib.sha256(x25519_shared_secret).hexdigest()[:16]
    mlkem_hash = hashlib.sha256(mlkem_shared_secret).hexdigest()[:16]
    session_hash = hashlib.sha256(session_key).hexdigest()[:16]

    logger.info(
        "establish_hybrid_session(%s, role=%s): "
        "x25519Hash=%s mlKemHash=%s sessionHash=%s",
        peer_id, role, x25519_hash, mlkem_hash, session_hash,
    )

    return session_key, mlkem_ciphertext_return
```

---

#### Step 4.3: JavaScript Hybrid Key Exchange

**File:** `packages/web-client/src/lib/crypto.ts`

**Add new fields to `CryptoService` class:**
```typescript
export class CryptoService {
  private keyPair: KeyPair | null = null;

  // New ML-KEM fields
  private mlKemKeyPair: {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  } | null = null;

  // Store peer ML-KEM public keys
  private peerMlKemPublicKeys = new Map<string, Uint8Array>();

  // Protocol version tracking per peer
  private peerProtocolVersions = new Map<string, number>();
```

**Update `initialize()`:**
```typescript
async initialize(): Promise<void> {
  // Existing X25519 initialization
  const privateKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(privateKey);
  this.keyPair = { privateKey, publicKey };

  // Generate ML-KEM identity keys
  this.mlKemKeyPair = CryptoService.generateMlKemKeyPair();
}
```

**New getter:**
```typescript
getMlKemPublicKeyBase64(): string {
  if (!this.mlKemKeyPair) {
    throw new CryptoError(
      'CryptoService not initialized',
      ErrorCodes.CRYPTO_NOT_INITIALIZED
    );
  }
  return btoa(String.fromCharCode(...this.mlKemKeyPair.publicKey));
}
```

**New method: Hybrid session establishment:**
```typescript
establishHybridSession(
  peerId: string,
  peerX25519PublicKeyBase64: string,
  peerMlKemPublicKeyBase64: string,
  role: 'initiator' | 'responder' = 'initiator',
  mlKemCiphertextBase64?: string
): { ciphertext?: string } {
  if (!this.keyPair || !this.mlKemKeyPair) {
    throw new CryptoError(
      'CryptoService not initialized',
      ErrorCodes.CRYPTO_NOT_INITIALIZED
    );
  }

  // 1. X25519 ECDH
  const peerX25519PublicKey = Uint8Array.from(
    atob(peerX25519PublicKeyBase64),
    (c) => c.charCodeAt(0)
  );
  const x25519SharedSecret = x25519.getSharedSecret(
    this.keyPair.privateKey,
    peerX25519PublicKey
  );

  // 2. ML-KEM encapsulation or decapsulation
  const peerMlKemPublicKey = Uint8Array.from(
    atob(peerMlKemPublicKeyBase64),
    (c) => c.charCodeAt(0)
  );
  this.peerMlKemPublicKeys.set(peerId, peerMlKemPublicKey);

  let mlKemSharedSecret: Uint8Array;
  let ciphertextReturn: string | undefined;

  if (role === 'initiator') {
    // Initiator: encapsulate to peer's public key
    const { ciphertext, sharedSecret } = CryptoService.mlKemEncapsulate(
      peerMlKemPublicKey
    );
    mlKemSharedSecret = sharedSecret;
    ciphertextReturn = btoa(String.fromCharCode(...ciphertext));
  } else {
    // Responder: decapsulate peer's ciphertext
    if (!mlKemCiphertextBase64) {
      throw new CryptoError(
        'mlKemCiphertextBase64 required for responder role',
        ErrorCodes.CRYPTO_INVALID_KEY
      );
    }
    const mlKemCiphertext = Uint8Array.from(
      atob(mlKemCiphertextBase64),
      (c) => c.charCodeAt(0)
    );
    mlKemSharedSecret = CryptoService.mlKemDecapsulate(
      mlKemCiphertext,
      this.mlKemKeyPair.secretKey
    );
  }

  // 3. Combine secrets: X25519 || ML-KEM
  const combinedSecret = new Uint8Array(
    x25519SharedSecret.length + mlKemSharedSecret.length
  );
  combinedSecret.set(x25519SharedSecret, 0);
  combinedSecret.set(mlKemSharedSecret, x25519SharedSecret.length);

  // 4. Derive session key via HKDF with hybrid info string
  const info = new TextEncoder().encode('zajel_hybrid_session');
  const sessionKey = hkdf(sha256, combinedSecret, undefined, info, 32);

  this.sessionKeys.set(peerId, sessionKey);
  this.peerProtocolVersions.set(peerId, 2); // Hybrid protocol version
  this.sessionCreatedAt.set(peerId, Date.now());

  return { ciphertext: ciphertextReturn };
}
```

**Update existing `establishSession` for backward compatibility:**
```typescript
establishSession(
  peerId: string,
  peerPublicKeyBase64: string,
  peerMlKemPublicKeyBase64?: string,
  peerProtocolVersion?: number
): { ciphertext?: string } {
  // Detect hybrid capability
  const useHybrid = peerMlKemPublicKeyBase64 &&
                    (peerProtocolVersion ?? 1) >= 2;

  if (useHybrid) {
    return this.establishHybridSession(
      peerId,
      peerPublicKeyBase64,
      peerMlKemPublicKeyBase64,
      'initiator'
    );
  }

  // Fall back to classical X25519-only (existing implementation)
  if (!this.keyPair) {
    throw new CryptoError(
      'CryptoService not initialized',
      ErrorCodes.CRYPTO_NOT_INITIALIZED
    );
  }

  const peerPublicKey = Uint8Array.from(
    atob(peerPublicKeyBase64),
    (c) => c.charCodeAt(0)
  );

  const sharedSecret = x25519.getSharedSecret(
    this.keyPair.privateKey,
    peerPublicKey
  );

  const info = new TextEncoder().encode('zajel_session');
  const sessionKey = hkdf(sha256, sharedSecret, undefined, info, 32);

  this.sessionKeys.set(peerId, sessionKey);
  this.peerProtocolVersions.set(peerId, 1); // Classical protocol version
  this.sessionCreatedAt.set(peerId, Date.now());

  return {};
}
```

---

### Phase 5: Protocol Integration and Signaling (Week 7)

#### Step 5.1: Update Signaling Client (All Platforms)

**Dart signaling update:**
```dart
// Send pair request with hybrid keys
final message = {
  'type': 'pair_request',
  'code': code,
  'publicKey': _cryptoService.publicKeyBase64,
  'pqPublicKey': _cryptoService.mlKemPublicKeyBase64,
  'protocolVersion': CryptoConstants.protocolVersionCurrent,
  'supportedKEMs': CryptoConstants.supportedKEMs,
};

// Handle pair response with hybrid capability detection
void _handlePairResponse(Map<String, dynamic> data) {
  final peerPublicKey = data['publicKey'] as String?;
  final peerPqPublicKey = data['pqPublicKey'] as String?;
  final peerProtocolVersion = data['protocolVersion'] as int?;

  if (peerPublicKey == null) {
    logger.warning('SignalingClient', 'Received pair response without publicKey');
    return;
  }

  // Establish session with auto-detection
  _cryptoService.establishSession(
    peerId,
    peerPublicKey,
    peerMlKemPublicKeyBase64: peerPqPublicKey,
    peerProtocolVersion: peerProtocolVersion,
  );
}
```

**Python signaling update:** (similar structure)

**JavaScript signaling update:** (similar structure)

---

#### Step 5.2: ML-KEM Ciphertext Exchange

**Problem:** ML-KEM requires asymmetric ciphertext exchange:
- Initiator encapsulates → generates ciphertext
- Initiator sends ciphertext to responder
- Responder decapsulates ciphertext → derives same shared secret

**Solution Options:**

**Option A: Extend signaling messages (simpler, more bandwidth)**
```json
{
  "type": "pair_response",
  "publicKey": "...",
  "pqPublicKey": "...",
  "pqCiphertext": "...",  // 1088 bytes base64 (~1451 chars)
  "protocolVersion": 2
}
```

**Option B: Exchange via WebRTC data channel (after connection, more complex)**
- Establish WebRTC connection with X25519-only initially
- Send ML-KEM ciphertext over data channel
- Re-derive session key with hybrid construction
- Rotate to hybrid session key

**Recommendation: Use Option A for simplicity**
- Signaling messages already handle public keys (~44 chars)
- ML-KEM ciphertext is 1088 bytes (~1451 base64 chars)
- Total message size: ~2.7KB (well within WebSocket limits)

---

### Phase 6: Testing (Week 8-10)

#### Step 6.1: Unit Tests for ML-KEM Primitives

**File:** `packages/app/test/unit/crypto/ml_kem_test.dart` (**NEW**)

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/crypto/ml_kem_service.dart';

void main() {
  group('ML-KEM-768 Primitives', () {
    late MlKemService mlKem;

    setUp(() {
      mlKem = MlKemService();
    });

    test('keygen produces valid key sizes', () {
      final keys = mlKem.generateKeyPair();

      expect(keys.publicKey.length, equals(1184));
      expect(keys.secretKey.length, equals(2400));
    });

    test('encapsulate produces valid ciphertext and shared secret', () {
      final keys = mlKem.generateKeyPair();
      final result = mlKem.encapsulate(keys.publicKey);

      expect(result.ciphertext.length, equals(1088));
      expect(result.sharedSecret.length, equals(32));
    });

    test('decapsulate recovers same shared secret', () {
      final keys = mlKem.generateKeyPair();
      final encapResult = mlKem.encapsulate(keys.publicKey);
      final decapSecret = mlKem.decapsulate(
        encapResult.ciphertext,
        keys.secretKey
      );

      expect(decapSecret, equals(encapResult.sharedSecret));
    });

    test('NIST test vector 0 (deterministic)', () {
      // TODO: Add NIST FIPS 203 test vectors
      // Reference: https://csrc.nist.gov/Projects/post-quantum-cryptography/post-quantum-cryptography-standardization/example-files
    });
  });
}
```

**Equivalent tests for Python (`test_ml_kem.py`) and JavaScript (`ml-kem.test.ts`)**

---

#### Step 6.2: Cross-Platform Hybrid Key Exchange Tests

**File:** `packages/app/test/unit/crypto/cross_platform_hybrid_test.dart` (**NEW**)

```dart
import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/crypto/crypto_service.dart';

void main() {
  group('Cross-platform hybrid key exchange', () {
    test('Dart hybrid HKDF produces expected session key from known secrets', () async {
      // Known X25519 shared secret (32 bytes, from Python test)
      final x25519Secret = Uint8List.fromList([
        0x73, 0xb8, 0xab, 0x88, 0xd1, 0xb5, 0x0f, 0x58,
        0xea, 0xdc, 0xef, 0x6b, 0x4c, 0x51, 0xee, 0x50,
        0x63, 0xb8, 0xd1, 0x92, 0x78, 0x5d, 0x46, 0xbe,
        0x71, 0xbb, 0x72, 0x71, 0x68, 0x33, 0x1a, 0x4d,
      ]);

      // Known ML-KEM shared secret (32 bytes, from Python test)
      final mlKemSecret = Uint8List.fromList([
        0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8,
        0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8,
        0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8,
        0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8,
      ]);

      // Expected hybrid session key from Python:
      // HKDF(x25519Secret || mlKemSecret, info="zajel_hybrid_session")
      final expectedSessionKey = Uint8List.fromList([
        // TODO: Compute expected value using Python implementation
      ]);

      // Replicate hybrid HKDF derivation
      final combinedSecret = Uint8List(64);
      combinedSecret.setAll(0, x25519Secret);
      combinedSecret.setAll(32, mlKemSecret);

      final hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: 32);
      final sessionKey = await hkdf.deriveKey(
        secretKey: SecretKey(combinedSecret),
        info: utf8.encode('zajel_hybrid_session'),
        nonce: const [],
      );

      final sessionKeyBytes = await sessionKey.extractBytes();
      expect(sessionKeyBytes, equals(expectedSessionKey));
    });

    test('Full hybrid key exchange between two CryptoService instances', () async {
      // Initiator
      final alice = CryptoService();
      await alice.initialize();

      // Responder
      final bob = CryptoService();
      await bob.initialize();

      // Exchange public keys
      final aliceX25519Pub = alice.publicKeyBase64;
      final aliceMlKemPub = alice.mlKemPublicKeyBase64;
      final bobX25519Pub = bob.publicKeyBase64;
      final bobMlKemPub = bob.mlKemPublicKeyBase64;

      // TODO: Implement role-based hybrid exchange (initiator/responder)
      // Alice encapsulates to Bob
      // Bob decapsulates Alice's ciphertext
      // Both derive same session key
    });
  });
}
```

**Python equivalent:** `packages/headless-client/tests/test_hybrid_crypto.py`

**JavaScript equivalent:** `packages/web-client/src/lib/__tests__/hybrid-crypto.test.ts`

---

#### Step 6.3: End-to-End Interoperability Tests

**Test Matrix:**
- Flutter app (initiator) ↔ Python headless (responder): Hybrid key exchange
- Flutter app (initiator) ↔ Web client (responder): Hybrid key exchange
- Python headless (initiator) ↔ Web client (responder): Hybrid key exchange
- Flutter app (hybrid) ↔ Flutter app (classical fallback): Backward compatibility
- All pairs: Message encryption/decryption with hybrid session keys

**Test Implementation:**
```dart
// packages/app/test/integration/hybrid_pairing_test.dart
test('Flutter-to-Python hybrid pairing and message exchange', () async {
  // 1. Start Python headless client with hybrid support
  // 2. Flutter app pairs with hybrid protocol
  // 3. Verify both derive same session key (via message exchange)
  // 4. Send encrypted message from Flutter → Python
  // 5. Verify Python decrypts correctly
  // 6. Send encrypted message from Python → Flutter
  // 7. Verify Flutter decrypts correctly
});
```

---

#### Step 6.4: Performance Benchmarks

**Benchmark Targets:**
- **Dart (Android Pixel 6):**
  - ML-KEM keygen: < 1ms
  - ML-KEM encapsulation: < 1ms
  - ML-KEM decapsulation: < 1ms
  - Hybrid session establishment: < 5ms total

- **Python (x86_64 Linux):**
  - ML-KEM keygen: < 0.5ms
  - ML-KEM encapsulation: < 0.5ms
  - ML-KEM decapsulation: < 0.5ms

- **JavaScript (Chrome on desktop):**
  - ML-KEM keygen: < 2ms
  - ML-KEM encapsulation: < 2ms
  - ML-KEM decapsulation: < 2ms

**Benchmark Code:**
```dart
// packages/app/test/benchmark/ml_kem_benchmark.dart
void main() {
  final mlKem = MlKemService();
  final stopwatch = Stopwatch();

  // Keygen benchmark
  stopwatch.start();
  for (var i = 0; i < 100; i++) {
    mlKem.generateKeyPair();
  }
  stopwatch.stop();
  print('Keygen avg: ${stopwatch.elapsedMilliseconds / 100}ms');

  // Encapsulation benchmark
  final keys = mlKem.generateKeyPair();
  stopwatch.reset();
  stopwatch.start();
  for (var i = 0; i < 100; i++) {
    mlKem.encapsulate(keys.publicKey);
  }
  stopwatch.stop();
  print('Encapsulate avg: ${stopwatch.elapsedMilliseconds / 100}ms');

  // Decapsulation benchmark
  final encapResult = mlKem.encapsulate(keys.publicKey);
  stopwatch.reset();
  stopwatch.start();
  for (var i = 0; i < 100; i++) {
    mlKem.decapsulate(encapResult.ciphertext, keys.secretKey);
  }
  stopwatch.stop();
  print('Decapsulate avg: ${stopwatch.elapsedMilliseconds / 100}ms');
}
```

---

### Phase 7: Documentation and Deployment (Week 11-12)

#### Step 7.1: Update User-Facing Documentation

**File:** `docs/cryptography.md` (if exists) or create new

```markdown
# Cryptography in Zajel

## Key Exchange

Zajel uses a hybrid post-quantum key exchange combining:

1. **X25519 (Curve25519 ECDH)** — Classical elliptic curve key exchange
2. **ML-KEM-768 (CRYSTALS-Kyber)** — NIST-standardized post-quantum KEM

### Why Hybrid?

The hybrid construction ensures security as long as **either** algorithm remains unbroken:
- X25519 protects against classical computers today
- ML-KEM-768 protects against future quantum computers

### Protocol Versions

- **Version 1 (legacy):** X25519-only
- **Version 2 (current):** Hybrid X25519 + ML-KEM-768

Zajel automatically negotiates the highest common protocol version during pairing.

### Session Key Derivation

```
session_key = HKDF-SHA256(
  IKM = X25519_shared_secret || ML-KEM_shared_secret,
  salt = empty,
  info = "zajel_hybrid_session",
  L = 32 bytes
)
```

### Public Key Sizes

- X25519: 32 bytes (~44 characters base64)
- ML-KEM-768: 1,184 bytes (~1,579 characters base64)
- Combined signaling payload: ~2.7 KB (including ciphertext)
```

---

#### Step 7.2: Migration Guide for Existing Users

**File:** `docs/migration/post-quantum-upgrade.md`

```markdown
# Post-Quantum Upgrade Migration Guide

## For End Users

### What's Changing?

Zajel is upgrading to post-quantum-safe encryption to protect your messages
against future quantum computers. This is a proactive security measure.

### Do I Need to Do Anything?

**No action required.** The upgrade is automatic:
- Update to Zajel v2.0 or later
- Re-pair with your contacts
- New sessions will use hybrid post-quantum encryption

### Backward Compatibility

- Zajel v2.0+ can still pair with v1.x clients
- Old sessions use classical X25519 encryption
- New sessions with v2.0+ peers use hybrid encryption

### Pairing Code Changes

Pairing codes remain the same format (6 characters). However, the initial
handshake message is now larger (~2.7 KB vs ~200 bytes) due to post-quantum
public keys. This may take a few extra milliseconds on slow networks.

## For Developers

### Breaking Changes

None. The hybrid key exchange is backward-compatible via protocol version
negotiation.

### API Changes

#### Dart (Flutter)
```dart
// Old: X25519-only
await cryptoService.establishSession(peerId, peerPublicKey);

// New: Auto-detects hybrid capability
await cryptoService.establishSession(
  peerId,
  peerPublicKey,
  peerMlKemPublicKeyBase64: peerPqPublicKey,  // Optional
  peerProtocolVersion: 2,                     // Optional
);

// Explicit hybrid
await cryptoService.establishHybridSession(
  peerId: peerId,
  peerX25519PublicKeyBase64: peerX25519Pub,
  peerMlKemPublicKeyBase64: peerMlKemPub,
);
```

#### Python
```python
# Auto-detect
crypto.perform_key_exchange(peer_id, peer_x25519_pub)

# Explicit hybrid (initiator)
session_key, ciphertext = crypto.establish_hybrid_session(
    peer_id,
    peer_x25519_pub,
    peer_mlkem_pub,
    role="initiator"
)

# Explicit hybrid (responder)
session_key, _ = crypto.establish_hybrid_session(
    peer_id,
    peer_x25519_pub,
    peer_mlkem_pub,
    role="responder",
    mlkem_ciphertext_b64=received_ciphertext
)
```

#### JavaScript
```typescript
// Auto-detect
cryptoService.establishSession(peerId, peerX25519Pub, peerMlKemPub, 2);

// Explicit hybrid (initiator)
const { ciphertext } = cryptoService.establishHybridSession(
  peerId,
  peerX25519Pub,
  peerMlKemPub,
  'initiator'
);
```
```

---

#### Step 7.3: Release Notes

**File:** `CHANGELOG.md`

```markdown
## [2.0.0] - 2026-XX-XX

### Added
- **Post-Quantum Cryptography:** Hybrid X25519 + ML-KEM-768 key exchange
  - Protects against "harvest now, decrypt later" quantum attacks
  - Fully backward-compatible with v1.x clients
  - NIST FIPS 203 compliant ML-KEM implementation

### Changed
- Session key derivation now uses `zajel_hybrid_session` HKDF info string
  for hybrid sessions (v1 sessions unchanged)
- Signaling messages include `pqPublicKey` and `protocolVersion` fields

### Technical Details
- Flutter app: ML-KEM via liboqs FFI wrapper
- Python headless client: ML-KEM via `cryptography` >= 44.0
- Web client: ML-KEM via `@noble/post-quantum`
```

---

## 4. Test Plan

### 4.1 Unit Tests

| Test Category | Test Cases | Coverage Target |
|---------------|------------|-----------------|
| ML-KEM primitives | Keygen, encapsulate, decapsulate, NIST test vectors | 100% |
| Hybrid HKDF derivation | Known secrets → expected session key | 100% |
| Protocol version negotiation | v2+v2→hybrid, v2+v1→classical, v1+v1→classical | 100% |
| Backward compatibility | Existing X25519-only sessions still work | 100% |

### 4.2 Integration Tests

| Test Scenario | Platforms | Expected Result |
|---------------|-----------|-----------------|
| Hybrid pairing | Flutter ↔ Python | Both derive same session key |
| Hybrid pairing | Flutter ↔ Web | Both derive same session key |
| Hybrid pairing | Python ↔ Web | Both derive same session key |
| Message encryption | All pairs, hybrid mode | Messages decrypt correctly |
| Fallback to classical | v2 Flutter ↔ v1 Flutter | Classical X25519 session |

### 4.3 Performance Tests

| Metric | Platform | Threshold | Test Method |
|--------|----------|-----------|-------------|
| ML-KEM keygen | Flutter (Android) | < 1ms | Benchmark 100 iterations |
| ML-KEM encapsulate | Flutter (Android) | < 1ms | Benchmark 100 iterations |
| ML-KEM decapsulate | Flutter (Android) | < 1ms | Benchmark 100 iterations |
| Hybrid session setup | Flutter (Android) | < 5ms | End-to-end timing |
| Signaling message size | All platforms | < 3 KB | Message size measurement |

### 4.4 Security Tests

| Test Type | Description | Pass Criteria |
|-----------|-------------|---------------|
| NIST test vectors | Run official FIPS 203 test vectors | All vectors pass |
| Key reuse detection | Ensure ephemeral keys are unique per session | No duplicates in 10,000 sessions |
| Ciphertext tampering | Modify ML-KEM ciphertext, verify decapsulation fails | Exception raised |
| Protocol downgrade attack | Attacker removes `pqPublicKey` from signaling | Session fails or falls back logged |

### 4.5 Cross-Platform Compatibility Tests

**Test Vector Format (JSON):**
```json
{
  "test_name": "hybrid_session_derivation_vector_1",
  "x25519_secret": "73b8ab88d1b50f58eadcef6b4c51ee5063b8d192785d46be71bb727168331a4d",
  "mlkem_secret": "a1a2a3a4a5a6a7a8b1b2b3b4b5b6b7b8c1c2c3c4c5c6c7c8d1d2d3d4d5d6d7d8",
  "expected_session_key": "..."  // Computed by reference implementation
}
```

**Validation:**
- All three platforms (Dart, Python, JS) must produce identical session keys from the same test vectors
- Test vectors cover:
  - Known deterministic keys
  - Edge cases (all-zero secrets, all-FF secrets)
  - Cross-client message encryption/decryption

---

## 5. Rollback Risk

### 5.1 Risk Level: **LOW**

**Rationale:**
- Backward compatibility is maintained via protocol version negotiation
- Classical X25519-only sessions continue to work unchanged
- Hybrid mode is additive, not replacing existing functionality

### 5.2 Rollback Triggers

| Trigger | Action | Recovery Time |
|---------|--------|---------------|
| ML-KEM library crashes on specific devices | Disable hybrid mode via feature flag | Immediate (hotfix) |
| Cross-platform interop failure (session key mismatch) | Force fallback to classical mode | 1-2 days (patch release) |
| Performance regression (session setup > 10ms on mid-range Android) | Optimize or disable hybrid | 1 week (investigation) |
| Signaling message size causes WebSocket rejections | Reduce key sizes or compress payloads | 1-2 days (server update) |

### 5.3 Rollback Procedure

**Step 1: Server-side feature flag**
```javascript
// packages/server/src/config.js
export const FEATURES = {
  ENABLE_HYBRID_CRYPTO: env.ENABLE_HYBRID_CRYPTO !== 'false',
};

// Signaling server: strip pqPublicKey from messages if disabled
if (!FEATURES.ENABLE_HYBRID_CRYPTO && msg.pqPublicKey) {
  delete msg.pqPublicKey;
  msg.protocolVersion = 1;  // Force classical mode
}
```

**Step 2: Client-side fallback**
```dart
// packages/app/lib/core/config/feature_flags.dart
class FeatureFlags {
  static const bool enableHybridCrypto = bool.fromEnvironment(
    'ENABLE_HYBRID_CRYPTO',
    defaultValue: true,
  );
}

// In CryptoService.initialize():
if (FeatureFlags.enableHybridCrypto) {
  final mlKemKeys = _mlKem.generateKeyPair();
  _mlKemPublicKey = mlKemKeys.publicKey;
  _mlKemSecretKey = mlKemKeys.secretKey;
} else {
  logger.warning('CryptoService', 'Hybrid crypto disabled by feature flag');
}
```

**Step 3: Gradual rollout**
- Week 1: 10% of users (canary release)
- Week 2: 50% of users (if no issues)
- Week 3: 100% of users

**Step 4: Full rollback (worst case)**
- Revert to v1.x release branch
- Redeploy app to stores
- Estimated downtime: 0 (backward compatible)

---

## 6. Dependencies on Other Stories

### 6.1 No Direct Dependencies

This story is **independent** of Stories 021-023 (TUF, Sigstore, Threshold Signing). However, there are design synergies:

### 6.2 Future Integration Opportunities

**Story 021: TUF Role Hierarchy**
- TUF metadata signatures could migrate to ML-DSA (CRYSTALS-Dilithium, NIST FIPS 204)
- Timeline: After Story 024 completes, evaluate PQ signature schemes

**Story 022: Sigstore Keyless Signing**
- Fulcio certificates could use PQ-safe signature algorithms
- Timeline: Wait for Sigstore's PQ migration roadmap (est. 2027+)

**Story 023: Threshold Signing**
- Threshold schemes for ML-KEM exist but are research-stage (not standardized)
- Timeline: Monitor NIST PQC Round 4 for threshold KEM proposals

### 6.3 Architectural Alignment

All security stories (021-024) share common principles:
- **Defense in depth:** Multiple independent security layers
- **Cryptographic agility:** Support for algorithm transitions
- **Backward compatibility:** Graceful fallback for legacy clients

The hybrid key exchange in Story 024 exemplifies cryptographic agility, making future algorithm transitions easier (e.g., migrating from ML-KEM-768 to ML-KEM-1024, or adding new PQ algorithms).

---

## 7. Open Questions and Decisions

### 7.1 ML-KEM Parameter Set Choice

**Decision: Use ML-KEM-768 (recommended by NIST)**

| Parameter Set | Public Key | Ciphertext | Security Level | Rationale |
|---------------|------------|------------|----------------|-----------|
| ML-KEM-512 | 800 bytes | 768 bytes | NIST Level 1 (AES-128) | Too weak for long-term confidentiality |
| **ML-KEM-768** | **1184 bytes** | **1088 bytes** | **NIST Level 3 (AES-192)** | **Balanced security/performance** |
| ML-KEM-1024 | 1568 bytes | 1568 bytes | NIST Level 5 (AES-256) | Overkill for P2P messaging, larger payloads |

**Justification:**
- NIST Level 3 matches classical 192-bit security (stronger than X25519's ~128-bit)
- ML-KEM-768 is the recommended parameter set in IETF TLS hybrid drafts
- Performance benchmarks show negligible difference between 768 and 512 on modern devices

---

### 7.2 Role Negotiation (Initiator vs Responder)

**Problem:** ML-KEM is asymmetric:
- Initiator encapsulates to responder's public key → produces ciphertext
- Responder decapsulates ciphertext → recovers shared secret

**Options:**

**Option A: Signaling order determines role**
- First `pair_request` sender = initiator
- First `pair_response` sender = responder
- Simpler, but requires careful state tracking

**Option B: Explicit role field in signaling**
```json
{
  "type": "pair_request",
  "role": "initiator",
  "pqPublicKey": "..."
}
```
- More explicit, but redundant with message type

**Option C: Both parties encapsulate (double ciphertext)**
- Alice encapsulates to Bob's key → `ciphertext_A`
- Bob encapsulates to Alice's key → `ciphertext_B`
- Both derive `session_key = HKDF(x25519_secret || mlkem_secret_A || mlkem_secret_B)`
- Eliminates role ambiguity, but doubles ML-KEM overhead

**Recommendation: Use Option A (signaling order)**
- Zajel already has initiator/responder semantics in pairing
- Reuse existing state machine

---

### 7.3 Ciphertext Delivery Mechanism

**Decision: Send ciphertext in signaling `pair_response`**

**Pros:**
- Single round-trip for key exchange (same as classical)
- No additional data channel setup required

**Cons:**
- Increases signaling message size (~1 KB additional)

**Alternative (deferred):** Send ciphertext over WebRTC data channel after connection
- Pros: Keeps signaling messages small
- Cons: Requires two-phase session establishment (complexity)

**Recommendation:** Start with signaling-based delivery, optimize later if needed

---

### 7.4 Key Persistence Strategy

**Question:** Should ML-KEM identity keys be ephemeral or persistent?

**Current X25519 behavior:**
- Identity keys are persistent (stored in secure storage)
- Ephemeral keys are generated per session (forward secrecy)

**Options for ML-KEM:**

**Option A: Persistent ML-KEM identity keys**
- Pros: Consistent with X25519 model
- Cons: Larger secure storage footprint (2400-byte secret key)

**Option B: Ephemeral ML-KEM keys per session**
- Pros: Simpler storage, perfect forward secrecy
- Cons: Regenerating keys on every pairing adds latency (~1ms)

**Recommendation: Option A (persistent)**
- Matches X25519 semantics
- 1ms keygen overhead is acceptable for session setup
- Allows future features (e.g., pre-shared ML-KEM keys for offline pairing)

---

## 8. Success Metrics

| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| Cross-platform interop success rate | > 99.9% | E2E test pass rate (1000+ iterations) |
| Hybrid session setup latency (Android) | < 5ms | Performance benchmark median |
| Signaling message delivery success | > 99.5% | Production telemetry (if added) |
| ML-KEM library crash rate | < 0.01% | Client-side error reporting |
| User-reported pairing failures | < 1% increase vs. v1.x | Support tickets, GitHub issues |
| Backward compatibility (v2 ↔ v1) | 100% success | Integration tests |

---

## 9. Timeline and Milestones

| Week | Phase | Deliverables | Risk |
|------|-------|--------------|------|
| 1-2 | Library Research | FFI wrapper POC, performance benchmarks | **HIGH** (library availability) |
| 2 | Constants & Protocol | Updated constants, signaling schema | LOW |
| 3-4 | ML-KEM Primitives | `MlKemService` (Dart), Python/JS equivalents | MEDIUM (FFI complexity) |
| 5-6 | Hybrid Key Exchange | `establishHybridSession` on all platforms | MEDIUM (role negotiation) |
| 7 | Protocol Integration | Signaling updates, ciphertext exchange | LOW |
| 8-10 | Testing | Unit, integration, cross-platform tests | MEDIUM (interop bugs) |
| 11-12 | Documentation & Deployment | User docs, migration guide, release | LOW |

**Total Estimated Time:** 12 weeks (3 months)

**Critical Path:**
1. FFI wrapper development (Week 1-2) — **BLOCKING** for Dart implementation
2. Cross-platform interop testing (Week 8-10) — **BLOCKING** for release

---

## 10. Appendices

### Appendix A: NIST ML-KEM Reference

- **Standard:** [NIST FIPS 203](https://csrc.nist.gov/pubs/fips/203/final)
- **Algorithm:** Module-Lattice-Based Key Encapsulation Mechanism
- **Security Assumption:** Hardness of Module Learning With Errors (M-LWE)
- **Quantum Security:** Designed to resist quantum attacks (Grover's algorithm provides only quadratic speedup)

### Appendix B: Hybrid Construction Rationale

**Why not ML-KEM alone?**
- ML-KEM is a newer algorithm (standardized 2024)
- X25519 is battle-tested (2006, extensively analyzed)
- Hybrid provides defense-in-depth: security relies on breaking **both** algorithms

**Why concatenate instead of XOR?**
```
// GOOD: HKDF(x25519_secret || mlkem_secret)
// BAD:  HKDF(x25519_secret XOR mlkem_secret)
```
- Concatenation preserves full entropy from both secrets
- XOR could lose entropy if secrets are correlated (theoretical risk)
- NIST and IETF hybrid drafts recommend concatenation

### Appendix C: Alternative PQ KEMs Considered

| Algorithm | Status | Pros | Cons | Decision |
|-----------|--------|------|------|----------|
| ML-KEM (Kyber) | **NIST FIPS 203** | Standardized, fast, small keys | None | **SELECTED** |
| Classic McEliece | NIST Round 4 finalist | Mature, conservative | Very large keys (260 KB) | Rejected (size) |
| BIKE | NIST Round 4 finalist | Smaller keys than McEliece | Newer, less analyzed | Rejected (maturity) |
| HQC | NIST Round 4 finalist | Similar to BIKE | Newer, less analyzed | Rejected (maturity) |
| NTRU Prime | Not standardized | Fast | Not NIST-selected | Rejected (standardization) |

### Appendix D: Build System Changes

**Android (Dart FFI):**
```cmake
# android/CMakeLists.txt
add_subdirectory(third_party/liboqs)
target_link_libraries(${PROJECT_NAME} PRIVATE oqs)
```

**iOS (Dart FFI):**
```ruby
# ios/Podfile
pod 'liboqs', :git => 'https://github.com/open-quantum-safe/liboqs.git'
```

**Windows (Dart FFI):**
```powershell
# Build liboqs.dll separately, package in app
# Add to windows/CMakeLists.txt
```

**Python:**
```toml
# pyproject.toml
[project]
dependencies = [
    "cryptography>=44.0",  # Bumped from >=42.0
]
```

**JavaScript:**
```json
// package.json
{
  "dependencies": {
    "@noble/post-quantum": "^1.0.0"
  }
}
```

---

## 11. Final Review Checklist

- [ ] All three platforms (Dart, Python, JS) implement ML-KEM primitives
- [ ] Hybrid key exchange produces identical session keys across platforms
- [ ] Protocol version negotiation handles all combinations (v2+v2, v2+v1, v1+v1)
- [ ] NIST test vectors pass on all platforms
- [ ] Cross-platform integration tests pass (1000+ iterations, 0 failures)
- [ ] Performance benchmarks meet targets (< 5ms hybrid session setup on Android)
- [ ] Backward compatibility tests pass (v2 ↔ v1 pairing works)
- [ ] Documentation updated (user guide, developer guide, changelog)
- [ ] Migration guide published
- [ ] Feature flag infrastructure in place for rollback
- [ ] Security audit complete (if required)
- [ ] Release notes drafted

---

**Plan Author:** Claude Opus 4.6
**Plan Date:** 2026-03-03
**Plan Version:** 1.0
**Reviewed By:** [Pending]
**Approved By:** [Pending]
