# Story 024: Post-Quantum Key Exchange Migration Planning

## Priority: LONG-TERM
## Severity: LOW
## Component: packages/app, packages/headless-client, packages/web-client

## Summary

All three Zajel client implementations (Flutter app, Python headless client, and JavaScript web client) use X25519 for key exchange, which is vulnerable to quantum computing attacks. NIST finalized ML-KEM (Module-Lattice-Based Key Encapsulation Mechanism, formerly CRYSTALS-Kyber) as FIPS 203 in August 2024. A "harvest now, decrypt later" attack could compromise current session keys retroactively once a cryptographically relevant quantum computer (CRQC) exists. This story covers the planning and design for a hybrid classical+post-quantum key exchange migration across all three client platforms.

## Current Behavior

All three clients implement identical cryptographic primitives: X25519 for key exchange, HKDF-SHA256 for key derivation, and ChaCha20-Poly1305 for authenticated encryption. The vulnerability is specifically in the key exchange layer.

### Flutter App (Dart)

**Key exchange** (`packages/app/lib/core/crypto/crypto_service.dart`, lines 22-23, 176-195):

The `CryptoService` class uses the `cryptography` Dart package. X25519 key exchange is performed via `_x25519.sharedSecretKey()`:

```dart
// packages/app/lib/core/crypto/crypto_service.dart:22-23
final X25519 _x25519 = X25519();
final Chacha20 _chacha20 = Chacha20.poly1305Aead();

// packages/app/lib/core/crypto/crypto_service.dart:186-195
Future<String> performKeyExchange(String peerPublicKeyBase64) async {
  // ...
  final peerPublicKey = SimplePublicKey(
    peerPublicKeyBytes,
    type: KeyPairType.x25519,
  );
  final sharedSecret = await _x25519.sharedSecretKey(
    keyPair: _identityKeyPair!,
    remotePublicKey: peerPublicKey,
  );
  // ...
}
```

**Session establishment** (`packages/app/lib/core/crypto/crypto_service.dart`, lines 200-219): The shared secret from X25519 is passed through HKDF-SHA256 to derive a 32-byte session key:

```dart
// packages/app/lib/core/crypto/crypto_service.dart:200-219
Future<String> establishSession(String peerId, String peerPublicKeyBase64) async {
  final sharedSecretBase64 = await performKeyExchange(peerPublicKeyBase64);
  final sharedSecretBytes = base64Decode(sharedSecretBase64);
  final sessionKey = await _hkdf.deriveKey(
    secretKey: SecretKey(sharedSecretBytes),
    info: utf8.encode('zajel_session'),
    nonce: const [],
  );
  _sessionKeys[peerId] = sessionKey;
  await _storeSessionKey(peerId, sessionKey);
  return peerId;
}
```

**Key pair generation** (`packages/app/lib/core/crypto/crypto_service.dart`, lines 291-301): Ephemeral key pairs are generated per session using `_x25519.newKeyPair()`. Identity keys are also X25519 and are persisted in secure storage (lines 326-343).

```dart
// packages/app/lib/core/crypto/crypto_service.dart:291-301
Future<({String publicKey, String privateKey})> generateEphemeralKeyPair() async {
  final keyPair = await _x25519.newKeyPair();
  final publicKey = await keyPair.extractPublicKey();
  final privateKeyBytes = await keyPair.extractPrivateKeyBytes();
  return (
    publicKey: base64Encode(publicKey.bytes),
    privateKey: base64Encode(privateKeyBytes),
  );
}
```

### Python Headless Client

**Key exchange** (`packages/headless-client/zajel/crypto.py`, lines 17-23, 63-91):

The headless client uses the `cryptography` Python package (pyca/cryptography). X25519 key exchange is performed via `X25519PrivateKey.exchange()`:

```python
# packages/headless-client/zajel/crypto.py:17-23
from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey,
    X25519PublicKey,
)
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

# packages/headless-client/zajel/crypto.py:63-91
def perform_key_exchange(self, peer_id: str, peer_public_key_b64: str) -> bytes:
    if self._private_key is None:
        raise RuntimeError("CryptoService not initialized")
    peer_pub_bytes = base64.b64decode(peer_public_key_b64)
    peer_pub = X25519PublicKey.from_public_bytes(peer_pub_bytes)
    shared_secret = self._private_key.exchange(peer_pub)
    session_key = HKDF(
        algorithm=SHA256(),
        length=32,
        salt=b"",
        info=HKDF_INFO,
    ).derive(shared_secret)
    self._session_keys[peer_id] = session_key
    return session_key
```

**Key generation** (`packages/headless-client/zajel/crypto.py`, lines 46-49): Keys are ephemeral, generated fresh on each `initialize()` call:

```python
# packages/headless-client/zajel/crypto.py:46-49
def initialize(self) -> None:
    self._private_key = X25519PrivateKey.generate()
    self._public_key_bytes = self._private_key.public_key().public_bytes_raw()
```

### JavaScript Web Client

**Key exchange** (`packages/web-client/src/lib/crypto.ts`, lines 1, 205-246):

The web client uses the `@noble/curves` library for X25519 and `@noble/ciphers` for ChaCha20-Poly1305:

```typescript
// packages/web-client/src/lib/crypto.ts:1
import { x25519 } from '@noble/curves/ed25519';

// packages/web-client/src/lib/crypto.ts:233-241
establishSession(peerId: string, peerPublicKeyBase64: string): void {
  // ...
  const sharedSecret = x25519.getSharedSecret(
    this.keyPair.privateKey,
    peerPublicKey
  );
  const info = new TextEncoder().encode(`zajel_session_${peerId}`);
  const sessionKey = hkdf(sha256, sharedSecret, undefined, info, 32);
  this.sessionKeys.set(peerId, sessionKey);
  this.sessionCreatedAt.set(peerId, Date.now());
}
```

**Key generation** (`packages/web-client/src/lib/crypto.ts`, lines 127-136): Ephemeral keys are generated using `x25519.utils.randomPrivateKey()`:

```typescript
// packages/web-client/src/lib/crypto.ts:127-136
async initialize(): Promise<void> {
  const privateKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(privateKey);
  this.keyPair = { privateKey, publicKey };
}
```

### Interoperability Note

The HKDF info string differs between clients:
- Flutter: `'zajel_session'` (line 209 of `crypto_service.dart`)
- Python: `b"zajel_session"` (line 28 of `crypto.py`)
- Web: `'zajel_session_${peerId}'` (line 240 of `crypto.ts`)

This means the web client derives a different session key than the Flutter and Python clients for the same shared secret, but this is an existing interop issue and not related to the post-quantum migration. The migration must preserve whatever HKDF info convention each client currently uses.

### Public Key Sizes

All three clients exchange 32-byte X25519 public keys, transmitted as base64 strings (~44 characters). This is relevant because ML-KEM public keys are significantly larger:
- ML-KEM-768 (recommended): 1,184 bytes (~1,579 base64 characters)
- ML-KEM-1024 (paranoid): 1,568 bytes (~2,091 base64 characters)

These larger keys affect signaling message sizes and WebRTC data channel handshake messages.

## Expected Behavior

The key exchange should use a hybrid construction that combines X25519 with ML-KEM, ensuring security against both classical and quantum adversaries. The shared secret should be derived from both key exchange outputs, so that the system remains secure as long as either algorithm is unbroken.

## Root Cause Analysis

X25519 (Curve25519 ECDH) relies on the hardness of the Elliptic Curve Discrete Logarithm Problem (ECDLP). Shor's algorithm, running on a sufficiently large quantum computer, can solve ECDLP in polynomial time, breaking X25519 entirely.

The threat model has two dimensions:

1. **Future compromise**: Once a CRQC exists, any adversary can break X25519 key exchanges in real time.
2. **Harvest now, decrypt later (HNDL)**: An adversary can record encrypted sessions today (including the key exchange) and decrypt them later once a CRQC is available. Zajel's P2P architecture somewhat mitigates this since sessions go through WebRTC (which uses DTLS-SRTP with its own key exchange), but the application-layer encryption uses Zajel's X25519-derived session keys, which are vulnerable.

The specific code paths affected are all the `performKeyExchange` / `establish_session` / `establishSession` methods across the three clients. The downstream encryption (ChaCha20-Poly1305) and hashing (SHA-256, HKDF) are considered quantum-resistant (Grover's algorithm provides only a quadratic speedup, so 256-bit symmetric keys and hashes remain secure with a 128-bit post-quantum security level).

The challenge is that post-quantum algorithm support varies across the three platforms:

- **Dart/Flutter**: The `cryptography` package does not yet support ML-KEM. A Dart FFI wrapper around a native library (e.g., liboqs) would be needed.
- **Python**: The `cryptography` package (pyca) added ML-KEM support in version 44.0.0 (late 2024) via `cryptography.hazmat.primitives.asymmetric.mlkem`.
- **JavaScript/Browser**: No native Web Crypto API support for ML-KEM. The `@noble/post-quantum` npm package or similar would be needed. Chrome has experimental support for X25519Kyber768 in TLS.

## Affected Code

| File | Lines | Description |
|------|-------|-------------|
| `packages/app/lib/core/crypto/crypto_service.dart` | 22 | X25519 algorithm instantiation |
| `packages/app/lib/core/crypto/crypto_service.dart` | 176-195 | X25519 key exchange |
| `packages/app/lib/core/crypto/crypto_service.dart` | 200-219 | Session establishment from X25519 shared secret |
| `packages/app/lib/core/crypto/crypto_service.dart` | 291-301 | Ephemeral X25519 key pair generation |
| `packages/app/lib/core/crypto/crypto_service.dart` | 326-343 | Identity key generation and persistence (X25519) |
| `packages/app/lib/core/constants.dart` | 25 | `x25519KeySize = 32` -- will need to change for hybrid |
| `packages/headless-client/zajel/crypto.py` | 17-23 | X25519 imports |
| `packages/headless-client/zajel/crypto.py` | 46-49 | X25519 key generation |
| `packages/headless-client/zajel/crypto.py` | 63-91 | X25519 key exchange and HKDF derivation |
| `packages/web-client/src/lib/crypto.ts` | 1 | X25519 import from `@noble/curves` |
| `packages/web-client/src/lib/crypto.ts` | 127-136 | X25519 key generation |
| `packages/web-client/src/lib/crypto.ts` | 205-246 | X25519 key exchange and session establishment |
| `packages/web-client/src/lib/constants.ts` | 25 | `X25519_KEY_SIZE: 32` -- will need hybrid constant |

## Reproduction Steps

1. Examine `packages/app/lib/core/crypto/crypto_service.dart` -- all key exchange uses X25519 exclusively.
2. Examine `packages/headless-client/zajel/crypto.py` -- same X25519-only key exchange.
3. Examine `packages/web-client/src/lib/crypto.ts` -- same X25519-only key exchange.
4. Note that no post-quantum algorithms are used anywhere in the codebase.
5. A "harvest now, decrypt later" attack is possible: an attacker who captures the signaling messages (which contain the X25519 public keys in plaintext) and the encrypted data channel traffic can derive the session key once a CRQC is available.

## Impact Assessment

- **Long-term confidentiality risk**: Any encrypted sessions captured today can be decrypted by a future quantum computer. For a messaging application, this means past messages could be retroactively read.
- **Timeline uncertainty**: Estimates for CRQC vary widely (2030-2050+), but NIST and major governments have mandated PQ migration timelines (US OMB M-23-02 requires migration planning by 2025, completion by 2035).
- **Regulatory pressure**: As PQ mandates become more common, applications that have not migrated may face compliance issues.
- **Migration complexity**: Three different platforms with three different cryptographic library ecosystems make migration non-trivial. Each platform needs its own ML-KEM implementation.
- **Signaling message size increase**: ML-KEM-768 public keys are 1,184 bytes vs. X25519's 32 bytes -- a 37x increase. This affects signaling WebSocket message sizes and WebRTC data channel handshake overhead.
- **Forward secrecy preservation**: The current ephemeral key model provides forward secrecy. The hybrid scheme must preserve this property.

## Proposed Fix

### Phase 1: Algorithm Selection and Design

Adopt the hybrid X25519 + ML-KEM-768 approach, following the IETF draft model used in TLS 1.3 (X25519Kyber768Draft00):

1. Each peer generates both an X25519 key pair and an ML-KEM-768 key pair.
2. Public keys for both algorithms are transmitted during session establishment.
3. The initiator encapsulates to the responder's ML-KEM public key, obtaining a PQ shared secret and ciphertext.
4. The responder decapsulates to obtain the same PQ shared secret.
5. Both peers perform X25519 ECDH to obtain a classical shared secret.
6. The final session key is derived using HKDF over the concatenation of both shared secrets:
   ```
   session_key = HKDF-SHA256(
     IKM = X25519_shared_secret || ML-KEM_shared_secret,
     salt = empty,
     info = "zajel_hybrid_session",
     L = 32
   )
   ```

This ensures security as long as either X25519 or ML-KEM remains unbroken.

### Phase 2: Protocol Version Negotiation

Add a protocol version field to the signaling handshake:

```json
{
  "type": "pair_request",
  "publicKey": "<X25519 base64>",
  "pqPublicKey": "<ML-KEM-768 base64, optional>",
  "protocolVersion": 2,
  "supportedKEMs": ["x25519", "x25519-mlkem768"]
}
```

Backward compatibility rules:
- If both peers support `x25519-mlkem768`, use hybrid mode.
- If either peer only supports `x25519`, fall back to classical-only mode.
- The protocol version field enables future algorithm agility.

### Phase 3: Platform-Specific Implementation

**Dart/Flutter**:
- Evaluate `pqcrypto` or `liboqs-dart` FFI wrappers.
- If no mature Dart ML-KEM library exists, create a Dart FFI wrapper around `liboqs` (C library from Open Quantum Safe project).
- The wrapper needs to support ML-KEM-768 `KeyGen()`, `Encaps()`, and `Decaps()`.

**Python**:
- Use `cryptography` >= 44.0.0 which has native ML-KEM support:
  ```python
  from cryptography.hazmat.primitives.asymmetric.mlkem import MLKEM768PrivateKey
  private_key = MLKEM768PrivateKey.generate()
  public_key = private_key.public_key()
  ```

**JavaScript**:
- Use `@noble/post-quantum` package which implements ML-KEM:
  ```typescript
  import { ml_kem768 } from '@noble/post-quantum/ml-kem';
  const [publicKey, secretKey] = ml_kem768.keygen();
  const [ciphertext, sharedSecret] = ml_kem768.encapsulate(publicKey);
  ```

### Phase 4: Testing and Interoperability Verification

Ensure all three platforms produce identical session keys from the same key material:
1. Create cross-platform test vectors with known X25519 and ML-KEM key pairs.
2. Verify that the hybrid HKDF derivation produces identical 32-byte session keys on all platforms.
3. Verify that messages encrypted on one platform can be decrypted on all others.

## Acceptance Criteria

- [ ] Hybrid X25519 + ML-KEM-768 key exchange is implemented on all three platforms.
- [ ] Protocol version negotiation allows graceful fallback to X25519-only for older clients.
- [ ] Cross-platform test vectors verify identical session key derivation.
- [ ] Message encryption/decryption works correctly across all platform combinations using hybrid keys.
- [ ] Public key sizes are handled correctly in signaling messages (larger PQ keys).
- [ ] Forward secrecy is preserved (ephemeral key pairs for both X25519 and ML-KEM per session).
- [ ] Performance benchmarks show acceptable overhead (ML-KEM-768 keygen and encaps/decaps are fast, but mobile devices should be tested).
- [ ] The HKDF info string for hybrid mode is distinct from classical mode to prevent cross-protocol confusion.
- [ ] Existing classical-only sessions continue to work during the migration period.

## Test Requirements

- **Cross-platform interop tests**: Generate a hybrid key exchange between each pair of platforms (Flutter-Python, Flutter-Web, Python-Web) and verify successful encryption/decryption.
- **Fallback tests**: Verify that a hybrid-capable client correctly falls back to X25519-only when paired with a classical-only client.
- **Test vectors**: Create and verify NIST ML-KEM test vectors on each platform to ensure correct algorithm implementation.
- **Performance benchmarks**: Measure key generation, encapsulation, and decapsulation times on target devices (Android phone, iOS device, desktop browser, Python server).
- **Message size tests**: Verify that signaling messages with ML-KEM public keys are correctly transmitted through the WebSocket signaling server without truncation or rejection.
- **Regression tests**: Verify that classical X25519-only encryption continues to work unchanged.
- **Key persistence tests** (Flutter only): Verify that hybrid identity keys are correctly stored in and loaded from secure storage.

## Dependencies

- No direct dependencies on other stories in this batch, but the broader cryptographic infrastructure improvements (Stories 021-023) should be designed with PQ algorithms in mind (e.g., TUF metadata signing could eventually use PQ-safe signature schemes like ML-DSA/CRYSTALS-Dilithium).

## Research References

- [NIST FIPS 203 -- ML-KEM](https://csrc.nist.gov/pubs/fips/203/final) -- The finalized NIST standard for Module-Lattice-Based Key Encapsulation Mechanism (formerly CRYSTALS-Kyber).
- [NIST FIPS 204 -- ML-DSA](https://csrc.nist.gov/pubs/fips/204/final) -- Module-Lattice-Based Digital Signature Algorithm (relevant for future signature migration).
- [IETF draft-ietf-tls-hybrid-design](https://datatracker.ietf.org/doc/draft-ietf-tls-hybrid-design/) -- Hybrid key exchange design for TLS 1.3, reference architecture for hybrid construction.
- [X25519Kyber768Draft00](https://www.ietf.org/archive/id/draft-tls-westerbaan-xyber768d00-03.html) -- Specific hybrid construction combining X25519 and Kyber768 for TLS.
- [Open Quantum Safe (OQS)](https://openquantumsafe.org/) -- Open-source project providing PQ algorithm implementations (liboqs C library, with wrappers for many languages).
- [@noble/post-quantum](https://github.com/nicola/post-quantum) -- JavaScript implementation of ML-KEM and other PQ algorithms.
- [pyca/cryptography ML-KEM](https://cryptography.io/en/latest/hazmat/primitives/asymmetric/mlkem/) -- Python ML-KEM support documentation.
- [CISA Post-Quantum Cryptography Initiative](https://www.cisa.gov/quantum) -- US government guidance on PQ migration planning.
- [OMB Memorandum M-23-02](https://www.whitehouse.gov/wp-content/uploads/2022/11/M-23-02-M-Memo-on-Migrating-to-Post-Quantum-Cryptography.pdf) -- US federal mandate for PQ migration timelines.
- [ETSI QSC Migration](https://www.etsi.org/technologies/quantum-safe-cryptography) -- European guidance on quantum-safe cryptography migration.
- [Hybrid Key Exchange in Signal](https://signal.org/docs/specifications/pqxdh/) -- Signal's PQXDH protocol combining X25519 and CRYSTALS-Kyber, a real-world messaging app reference.
