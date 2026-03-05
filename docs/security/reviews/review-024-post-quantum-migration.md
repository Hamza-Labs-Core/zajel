# Review: Plan 024 - Post-Quantum Key Exchange Migration

**Verdict: PASS WITH NOTES**

The plan is thorough, well-structured, and technically sound in its overall approach. The hybrid X25519 + ML-KEM-768 construction follows IETF best practices, and the protocol version negotiation design is correct. However, there are several inaccuracies in referenced code snippets and line numbers, incomplete areas marked as TODO in the test plan, and a few architectural risks that need explicit mitigation before implementation begins.

---

## Accuracy

### File Path Verification

All referenced source files exist in the codebase at the stated paths:

| File Path | Exists |
|-----------|--------|
| `packages/app/lib/core/crypto/crypto_service.dart` | Yes |
| `packages/app/lib/core/constants.dart` | Yes |
| `packages/app/pubspec.yaml` | Yes |
| `packages/headless-client/zajel/crypto.py` | Yes |
| `packages/headless-client/pyproject.toml` | Yes |
| `packages/web-client/src/lib/crypto.ts` | Yes |
| `packages/web-client/src/lib/constants.ts` | Yes |
| `packages/web-client/package.json` | Yes |
| `packages/app/lib/core/network/signaling_client.dart` | Yes |
| `packages/headless-client/zajel/signaling.py` | Yes |
| `packages/web-client/src/lib/signaling.ts` | Yes |

Referenced test directories exist but with different structures than the plan assumes:

| Plan Reference | Actual Location |
|---------------|----------------|
| `packages/app/test/unit/crypto/crypto_service_test.dart` | Directory `packages/app/test/unit/crypto/` does not exist. Tests are in `packages/app/test/unit/` organized by feature (e.g., `channels/`, `storage/`). No existing crypto unit test file was found. |
| `packages/headless-client/tests/test_crypto.py` | Actual path is `packages/headless-client/tests/unit/test_crypto.py` (nested under `unit/`). |
| `packages/web-client/src/lib/__tests__/crypto.test.ts` | Correct. File exists at this path. |

### Line Number and Code Snippet Verification

**Story document inaccuracies:**

1. **Story lines 22-23 reference (`crypto_service.dart:22-23`)**: The story claims lines 22-23 contain `final X25519 _x25519 = X25519();` and `final Chacha20 _chacha20 = Chacha20.poly1305Aead();`. The actual file has these at **lines 31-32**. Lines 22-23 contain comments about forward secrecy.

2. **Story lines 176-195 reference (`crypto_service.dart:176-195`)**: The story claims `performKeyExchange` is at lines 176-195. The actual method is at **lines 315-334**. Lines 176-195 contain the `getPeerPublicKeyFingerprint` method.

3. **Story lines 200-219 reference (`crypto_service.dart:200-219`)**: The story claims `establishSession` is at lines 200-219. The actual method is at **lines 339-371**. Lines 200-219 contain the `computeSafetyNumber` method.

4. **Story lines 291-301 reference (`crypto_service.dart:291-301`)**: The story claims `generateEphemeralKeyPair` is at lines 291-301. The actual method is at **lines 476-486**. Lines 291-301 contain the `getSessionKeyBytes` method.

5. **Story lines 326-343 reference**: The story claims identity key generation and persistence is at these lines. The actual `_loadOrGenerateIdentityKeys` is at **lines 680-712** and `_persistIdentityKeys` is at **lines 760-770**.

6. **Story line 25 reference (`constants.dart:25`)**: The story claims `x25519KeySize = 32` is at line 25. The actual location is **line 22**.

7. **Story reference (`crypto.py:17-23`)**: The story claims X25519 imports are at lines 17-23. The actual imports are at **lines 21-27**.

8. **Story reference (`crypto.py:46-49`)**: The story claims `initialize()` is at lines 46-49. The actual method is at **lines 69-73**.

9. **Story reference (`crypto.py:63-91`)**: The story claims `perform_key_exchange` is at lines 63-91. The actual method is at **lines 143-186**.

10. **Story reference (`crypto.ts:1`)**: Correct. Line 1 is `import { x25519 } from '@noble/curves/ed25519';`.

11. **Story reference (`crypto.ts:127-136`)**: The story claims `initialize()` is at lines 127-136. The actual method is at **lines 110-119**.

12. **Story reference (`crypto.ts:205-246`)**: The story claims the key exchange/session establishment code is at these lines. The actual `establishSession` method is at **lines 228-269**.

13. **Story reference (`constants.ts:25`)**: The story claims `X25519_KEY_SIZE: 32` is at line 25. The actual location is **line 25**. This is correct.

14. **CRITICAL - HKDF info string discrepancy**: The story (line 156) claims the web client uses `'zajel_session_${peerId}'` as the HKDF info string, which would make it derive a different session key than the other two clients. However, the actual source code at `crypto.ts:263` uses `'zajel_session'` (without peerId). This means the story's interoperability warning about differing HKDF info strings is **incorrect** -- all three clients actually use the same info string `"zajel_session"`, which is the correct behavior for interop. The plan's hybrid info string `"zajel_hybrid_session"` correctly differentiates hybrid from classical, but the plan should not inherit the story's false claim.

**Plan document inaccuracies:**

15. **Plan Step 2.1 "Before" snippet for `constants.dart`**: Shows only `x25519KeySize` and `hkdfOutputLength` in the `CryptoConstants` class. The actual class also includes `nonceSize` (line 16) and `macSize` (line 19). The plan's "Before" snippet is incomplete, which could cause confusion during implementation.

16. **Plan Step 2.2 "Before" snippet for signaling**: Shows `publicKey` being sent in `pair_request` messages. The actual signaling client sends `publicKey` in the `register` message (line 228), not in `pair_request`. The `pair_request` message (line 384-391) only contains `type` and `targetCode`. Public keys are exchanged during registration, not pairing.

17. **Plan Step 3.1 FFI function names**: The plan uses `OQS_KEM_kyber_768_keypair`, `OQS_KEM_kyber_768_encaps`, `OQS_KEM_kyber_768_decaps`. These are the old Kyber function names. With the rename to ML-KEM in FIPS 203, liboqs versions after 0.10.0 use `OQS_KEM_ml_kem_768_keypair` etc. The plan should use the ML-KEM names or note which liboqs version is targeted.

18. **Plan `pyproject.toml` current version**: The plan's Appendix D shows `cryptography>=42.0` as the current version to bump. The actual `pyproject.toml` has `cryptography>=42.0` (line 13), which is correct.

---

## Completeness

### Acceptance Criteria Coverage

| Acceptance Criterion | Covered in Test Plan | Notes |
|---------------------|---------------------|-------|
| Hybrid key exchange on all three platforms | Yes (Section 4.1-4.2) | Covered by unit and integration tests |
| Protocol version negotiation with fallback | Yes (Section 4.1) | v2+v2, v2+v1, v1+v1 combinations |
| Cross-platform test vectors | Partially (Section 4.5) | Test vector JSON defined but `expected_session_key` is TODO |
| Message encryption/decryption with hybrid keys | Yes (Section 4.2) | All platform pairs covered |
| Public key size handling in signaling | Yes (Section 4.3) | Message size measurement included |
| Forward secrecy preserved | Partially (Section 4.4) | Key uniqueness test exists, but no explicit test for ephemeral ML-KEM key deletion |
| HKDF info string distinction | Yes (Section 4.1) | Hybrid uses `"zajel_hybrid_session"` |
| Existing classical sessions unchanged | Yes (Section 4.1) | Backward compatibility row |
| Performance benchmarks | Yes (Section 4.3) | Specific thresholds per platform |

### Missing Items

1. **Incomplete test vector values**: The cross-platform hybrid test (Step 6.2) has `expectedSessionKey` as an empty list with a TODO comment. The cross-platform test vector JSON (Section 4.5) has `expected_session_key` as `"..."`. These must be computed by a reference implementation before the plan can be executed.

2. **Role negotiation is unresolved in code**: The plan's `establishHybridSession` in Dart (Step 4.1, line 635) has a comment "For now, assume we're always the initiator (encapsulate)" with a TODO for role negotiation. The Python and JS implementations properly handle roles, but the Dart implementation does not. This asymmetry will cause cross-platform failures.

3. **ML-KEM ciphertext exchange is not fully specified**: Step 5.2 discusses options but the actual integration into the signaling flow is incomplete. There is no updated signaling message handler showing how the ML-KEM ciphertext flows from initiator to responder. The Dart `establishHybridSession` (Step 4.1) has a TODO comment about "ciphertext exchange mechanism" that is never resolved.

4. **No NIST test vectors are included**: Step 6.1 has a test case for "NIST test vector 0 (deterministic)" but it is entirely a TODO placeholder. The plan should either include specific test vectors or provide a script to download them.

5. **Existing `establishSessionWithEphemeral` not addressed**: The Dart `crypto_service.dart` already has a two-phase key exchange method (`establishSessionWithEphemeral`, lines 499-556) that uses identity + ephemeral X25519 keys. The Python client has a matching `establish_session_with_ephemeral` method. The plan does not address how hybrid key exchange interacts with this existing ephemeral key exchange pattern. Should the hybrid session also support ephemeral keys? Should `establishSessionWithEphemeral` be updated for hybrid mode?

6. **Key ratcheting not addressed**: Both Dart and Python already implement key ratcheting (`ratchetSessionKey`, `prepareRatchet`, `commitRatchet`). The plan does not discuss whether ratcheting continues to work unchanged with hybrid-derived session keys. Since the ratchet only operates on the session key (not the underlying key exchange), it should work, but this should be explicitly tested.

7. **Secure storage of ML-KEM secret keys**: The plan (Section 7.4) recommends persistent ML-KEM identity keys, and Step 4.1 mentions storing them, but there is no explicit code for persisting/loading ML-KEM keys from Flutter's secure storage. The existing `_loadOrGenerateIdentityKeys` pattern for X25519 (lines 680-712) would need a parallel implementation for ML-KEM keys.

8. **Web client has no test expansion path specified**: The plan references `packages/web-client/src/lib/__tests__/crypto.test.ts` for "test expansion" but provides no concrete test code for the web client, unlike the Dart and Python platforms.

---

## Risks

### Risk 1: Dart/Flutter ML-KEM Library Availability (HIGH)

The plan correctly identifies this as the critical path item (Week 1-2). As of March 2026, there is no mature pure-Dart ML-KEM implementation. The FFI wrapper approach with liboqs introduces significant build complexity:

- **Android**: Requires cross-compiling liboqs for ARM64/ARM32/x86_64 via CMake. The plan shows a 2-line CMake snippet, but real-world liboqs cross-compilation requires OpenSSL as a dependency and platform-specific toolchain files.
- **iOS**: The plan suggests a CocoaPods pod for liboqs, but no official pod exists. Building from source for iOS requires Xcode framework packaging.
- **Windows**: The plan has a placeholder comment. Windows liboqs builds require Visual Studio and cmake with `-DBUILD_SHARED_LIBS=ON`.
- **Flutter Web**: FFI is not available on Flutter Web. The plan does not address this at all. If the Flutter app is ever compiled for web (even if not the primary target), the `MlKemService` would need a conditional import pattern or a WASM fallback.

### Risk 2: Signaling Message Format Change (MEDIUM)

The plan incorrectly assumes `publicKey` is sent in `pair_request` messages. The actual signaling flow sends `publicKey` in the `register` message. Adding `pqPublicKey` to the wrong message type would not work. The plan needs to audit the actual signaling flow and determine the correct message(s) to extend.

### Risk 3: HKDF Salt Parameter Inconsistency (LOW)

The plan uses `salt = empty` (empty bytes) for HKDF in the hybrid construction. The existing Dart code passes `nonce: const []` to HKDF (which maps to salt in the underlying HKDF construction). The Python code passes `salt=b""`. The JS code passes `undefined` for salt. While all three effectively produce the same result (HKDF with zero-length salt), the plan should explicitly verify that `undefined`, `b""`, and `const []` all produce identical HKDF outputs when combined with ML-KEM secrets.

### Risk 4: `btoa`/`atob` for Large Keys (MEDIUM)

The JavaScript plan uses `btoa(String.fromCharCode(...this.mlKemKeyPair.publicKey))` to encode 1184-byte ML-KEM public keys. The spread operator (`...`) on a 1184-element array may hit the maximum call stack size in some JavaScript engines (the limit is typically around 65536 arguments, so 1184 is safe). However, the more idiomatic and safer approach would be to use a proper base64 encoding utility. For the 1088-byte ciphertext, the same pattern is used. This is technically fine but should be noted.

### Risk 5: Protocol Downgrade Attack (MEDIUM)

Section 4.4 mentions testing protocol downgrade attacks (attacker strips `pqPublicKey`), but the plan's only mitigation is "Session fails or falls back logged." A MITM attacker who can modify signaling messages could strip the PQ fields, forcing a classical-only session. The plan should consider:
- Logging a warning when a hybrid-capable peer falls back to classical
- Optionally allowing users to require hybrid mode for specific contacts
- Signing the signaling messages (which the existing bootstrap signing infrastructure could support)

### Risk 6: Memory/Storage Impact on Mobile (LOW)

ML-KEM-768 secret keys are 2400 bytes. Storing these in Flutter's secure storage per identity is fine. However, if ephemeral ML-KEM keys are generated per session (the plan recommends persistent keys but the implementation could change), the memory impact of holding many concurrent session ML-KEM keys should be considered.

---

## Recommended Changes

1. **Fix all line number references in the story**: The story's line number references are significantly off from the actual source code. All line numbers in the "Affected Code" table and code snippets should be updated to match the current source.

2. **Correct the HKDF info string claim**: Remove the incorrect claim in the story (line 156) that the web client uses `'zajel_session_${peerId}'`. All three clients use `"zajel_session"`.

3. **Fix the signaling message structure**: Audit the actual signaling flow. Public keys are exchanged via `register` messages, not `pair_request`. The plan's signaling changes need to target the correct message types.

4. **Resolve the Dart role negotiation TODO**: The Dart `establishHybridSession` must support both initiator and responder roles, matching the Python and JS implementations. The current Dart code assumes initiator-only.

5. **Add ML-KEM ciphertext exchange to the signaling protocol**: Fully specify which signaling message carries the ML-KEM ciphertext from initiator to responder. The current plan identifies the options but does not commit to a concrete message flow.

6. **Update liboqs function names**: Use `OQS_KEM_ml_kem_768_*` instead of `OQS_KEM_kyber_768_*` to match current liboqs naming conventions post-FIPS 203 standardization.

7. **Address interaction with existing ephemeral key exchange**: Document whether `establishSessionWithEphemeral` (the 2-ECDH forward secrecy pattern) should also get hybrid support, or whether hybrid mode replaces it.

8. **Add concrete NIST test vectors or a generation script**: Replace TODO placeholders with actual test vector data or a script that downloads/generates them from the NIST reference.

9. **Fix test file paths**: Update `packages/headless-client/tests/test_crypto.py` to the correct path `packages/headless-client/tests/unit/test_crypto.py`. Create the `packages/app/test/unit/crypto/` directory structure (it does not currently exist).

10. **Add Flutter Web consideration**: Note that `dart:ffi` is unavailable on Flutter Web, and either exclude web as a target or provide a conditional import strategy using `@noble/post-quantum` via JS interop.

---

**Reviewer:** Claude Opus 4.6
**Review Date:** 2026-03-03
