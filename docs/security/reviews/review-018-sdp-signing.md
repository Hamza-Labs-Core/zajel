# Review: Plan 018 - Sign WebRTC SDP Offers/Answers

**Verdict: NEEDS REVISION**

The plan demonstrates a solid understanding of the MITM threat via SDP manipulation and proposes the right general approach (Ed25519 signing of SDP payloads). However, it contains a critical security flaw in the verification model, several inaccurate line-number references, incorrect test file paths, and missing implementation details for ICE candidate signing. The plan requires targeted revisions before implementation can proceed.

---

## Accuracy

### File Paths

All referenced source files exist at the correct paths within the project:

| Referenced Path | Exists |
|---|---|
| `packages/app/lib/core/crypto/crypto_service.dart` | YES |
| `packages/app/lib/core/network/webrtc_service.dart` | YES |
| `packages/app/lib/core/network/signaling_client.dart` | YES |
| `packages/app/lib/core/network/connection_manager.dart` | YES |
| `packages/server-vps/src/client/signaling-handler.ts` | YES |
| `packages/server-vps/src/client/types.ts` | YES |

Test file paths referenced in the plan are **INCORRECT**:

| Referenced Test Path | Actual Path |
|---|---|
| `test/unit/crypto_service_test.dart` | `test/unit/crypto/crypto_service_test.dart` |
| `test/unit/webrtc_service_test.dart` | Does not exist (no WebRTC service test file exists) |
| `test/integration/sdp_signing_test.dart` | Does not exist (no integration test directory exists under `packages/app/test/`) |
| `packages/server-vps/tests/unit/signaling-handler.test.js` | Wrong extension. Server tests use `.test.ts`. Existing file is `client-handler-pairing.test.ts` |

### Line Numbers and Code Snippets

**crypto_service.dart** -- All line references are accurate:
- Lines 31-33 (X25519/Chacha20/Hkdf fields): CORRECT
- Lines 36-38 (cache fields): CORRECT
- Lines 59-68 (`initialize()` method): CORRECT
- Line 277 (end of `getPublicKeyBase64()`): CORRECT
- Lines 670-676 (`regenerateIdentityKeys()`): CORRECT
- Line 712 (end of `_loadOrGenerateIdentityKeys()`): CORRECT

**webrtc_service.dart** -- Plan line references are accurate; story line references are off:
- Lines 124-128 (return in `createOffer()`): CORRECT (plan)
- Lines 131-153 (`handleOffer()`): CORRECT (plan)
- Lines 159-172 (answer return in `handleOffer()`): CORRECT (plan)
- Lines 175-194 (`handleAnswer()`): CORRECT (plan)
- Lines 197-217 (`addIceCandidate()`): PARTIALLY CORRECT -- method actually extends to line 223
- "Approximately line 250-280" for `onIceCandidate`: **WRONG** -- actual location is lines 457-474. The plan acknowledges uncertainty with "approximately" but the actual location is ~200 lines away.

**signaling_client.dart**:
- Lines 86-89 (constructor parameters): **WRONG** -- constructor is at lines 124-144
- Lines 225-229 (registration message): CORRECT
- Lines 424-432 (`sendCallOffer()`): CORRECT

**signaling-handler.ts** (story references):
- Lines 482-519 (`handleSignalingForward`): CORRECT
- Lines 573-616 (`handleCallSignalingForward`): CORRECT

### Code Snippets

The BEFORE code snippets in the plan accurately match the current source. The proposed AFTER code is syntactically valid Dart and uses the `cryptography` package API correctly. The `Ed25519` class from the `cryptography` package is already used in `packages/app/lib/core/crypto/bootstrap_verifier.dart`, confirming the import and API pattern are established in the codebase.

---

## Completeness

### Critical Gap: Signing Key Verification Is Not Bound to Peer Identity

This is the most significant issue in the plan. The proposed verification model accepts a `signingPublicKey` field **embedded in the SDP payload itself** and verifies the signature against that self-asserted key. This means:

1. A MITM attacker who controls the VPS can strip the original sender's signature, re-sign the modified SDP with the attacker's own Ed25519 key, and include the attacker's `signingPublicKey` in the payload.
2. The recipient will verify the signature successfully against the attacker's key, believing the SDP is authentic.

The verification MUST cross-check the `signingPublicKey` against a **previously exchanged** and **trusted** peer identity. The plan's Step 2 hints at this (exchanging signing public keys during pairing registration) but then says "Alternative approach (simpler): Include the signing public key in the offer/answer payload itself (see Step 3)" -- and Step 3 implements the insecure alternative.

The server already stores `pairingCodeToPublicKey` (X25519 keys exchanged during registration). The signing public key MUST either:
- Be exchanged during pairing registration and stored by the recipient before any SDP exchange occurs, OR
- Be derived deterministically from the X25519 identity key (though X25519 and Ed25519 are different curves, this requires a separate mechanism), OR
- Be included in the `pair_matched` message which the server forwards after pairing approval (alongside the existing `peerPublicKey` field).

Without this binding, the entire signing scheme provides no actual MITM protection -- it only detects accidental corruption.

### Missing: `onIceCandidate` Is Synchronous; Signing Is Async

The plan proposes changing the `onIceCandidate` callback from synchronous to `async`:

```dart
connection.pc.onIceCandidate = (candidate) async {  // was synchronous
```

The callback at line 457 in `webrtc_service.dart` is a synchronous callback assigned to `RTCPeerConnection.onIceCandidate`. Making this async means the `await _cryptoService.signData(...)` call will be fire-and-forget from the WebRTC engine's perspective. While this should work in practice (the signature just delays the send slightly), it introduces a subtle race condition: if the connection closes before the async signing completes, the `_signalingController.add()` call could fire on a closed controller. The plan does not discuss this risk.

### Missing: `_loadOrGenerateSigningKeys` Seed vs Full Keypair

The plan stores `extractPrivateKeyBytes()` and restores via `newKeyPairFromSeed()`. For Ed25519, `extractPrivateKeyBytes()` from the `cryptography` package returns the 32-byte seed (not the 64-byte expanded private key). The `newKeyPairFromSeed()` method expects a 32-byte seed. This is correct for Ed25519 in this package, but the plan does not explicitly note this distinction, and a developer unfamiliar with the difference could be confused.

### Missing: Server-Side Payload Size Validation

The VPS `signaling-handler.ts` currently validates SDP payload sizes (see `CALL_SIGNALING.MAX_SDP_LENGTH`). Adding `sdpSignature` (88 bytes base64) and `signingPublicKey` (44 bytes base64) to every payload increases the message size. While unlikely to exceed limits, the plan should note this and verify the existing size limits accommodate the additional fields.

### Step 2 Is Incomplete

Step 2 ("Update Pairing Registration to Exchange Signing Keys") is left partially unresolved. The plan says "This requires passing `CryptoService` to `SignalingClient` or accessing it via a provider. Implementation details depend on the app's architecture." and then falls back to the insecure inline key approach. This step needs to be fully specified since it is the foundation for secure verification.

### Step 5 Is Skeletal

Step 5 ("Update Call Signaling") only shows `sendCallOffer` and says "Similar changes needed for `sendCallAnswer()` and verification logic." The verification side (where `CallOfferMessage.fromJson` and `CallAnswerMessage.fromJson` are consumed) is not addressed at all. The call signaling flow uses a separate stream (`_callOfferController`, `_callAnswerController`) and the SDP from call messages would need to be verified before being passed to the call service.

### Story Acceptance Criterion Not Fully Covered

The story's acceptance criteria state: "Signature verification failure results in connection rejection (not silent fallback)." However, the plan implements **silent fallback** for unsigned SDP (backward compatibility). While this is reasonable for transition, the plan should include a concrete timeline or feature flag for when unsigned SDP will be **rejected** (i.e., enforced mode), not just warned about. Otherwise the backward compatibility window becomes a permanent security gap.

### DTLS Fingerprint Binding

The story lists "The DTLS fingerprint in the SDP should be bound to the peer's identity key to prevent certificate substitution attacks" as expected behavior item 5. The plan explicitly defers this to "Future Enhancements (Out of Scope)." The story test requirements (item 6) also list DTLS fingerprint binding. This mismatch between story expectations and plan scope should be explicitly acknowledged as a deliberate de-scoping decision.

---

## Risks

### 1. CRITICAL: Self-Asserted Key Provides No MITM Protection

As described above, the current design allows an attacker to substitute both the SDP and the signing key. This defeats the purpose of the feature entirely. Severity: **CRITICAL** -- blocks the implementation's primary security goal.

### 2. HIGH: JSON Serialization Non-Determinism for ICE Candidate Signing

The plan signs ICE candidates by calling `jsonEncode(candidateData)` on the sender side and reconstructing the same map on the receiver side. Dart's `jsonEncode` does produce deterministic key ordering (insertion order), and the plan constructs the map in the same order on both sides. However, this is fragile: any future code change that reorders the map keys, adds a field, or changes null handling will silently break signature verification. The plan should either:
- Use a canonical serialization (sorted keys), or
- Sign the raw candidate string directly (`candidate.candidate`) rather than a JSON wrapper, or
- Document the ordering requirement prominently.

### 3. MEDIUM: Backward Compatibility Window Is Open-Ended

The plan allows unsigned SDP indefinitely with only a warning log. An attacker who controls the VPS can simply strip signatures from all messages, downgrading all clients to "unsigned" mode. The plan should specify either:
- A mandatory upgrade deadline after which unsigned SDP is rejected, or
- A per-peer trust-on-first-use (TOFU) model where once a peer is seen with signatures, unsigned SDP from that peer is rejected.

### 4. LOW: No Signature Replay Protection

The plan does not include a nonce or timestamp in the signed payload. An attacker could replay a previously captured signed SDP offer to re-establish an old connection. In practice, this is low risk because:
- WebRTC SDP contains ICE credentials that change per session
- The DTLS fingerprint changes per session
- The SDP itself is unique per offer

But the absence of explicit replay protection should be documented as a known limitation.

### 5. LOW: `signSDP` Signs the Full SDP Including Mutable Fields

Some WebRTC implementations or intermediary code may reformat SDP whitespace or line endings (`\r\n` vs `\n`). If the SDP is modified between signing and verification (even cosmetically), the signature will fail. The plan should note that SDP must be treated as an opaque byte string and not reformatted after signing.

---

## Recommended Changes

### Must Fix (Blocking)

1. **Bind signing key to peer identity**: The `signingPublicKey` MUST be exchanged during pairing registration (Step 2) and stored alongside the peer's X25519 public key. During verification, the received `signingPublicKey` must be compared against the stored value. The "alternative approach" of inline keys must be removed. Concretely:
   - Add `signingPublicKey` to the `register` message (already partially shown in Step 2).
   - Store it in `pairingCodeToPublicKey` or a parallel map on the server.
   - Include it in the `pair_matched` message sent to both peers.
   - On the client, store it in `_peerPublicKeys` or a new `_peerSigningKeys` map.
   - During SDP verification, compare the `signingPublicKey` in the payload against the stored value and reject if they differ.

2. **Fix test file paths**: Update to `test/unit/crypto/crypto_service_test.dart` and create a new file for WebRTC tests at an appropriate path (e.g., `test/unit/network/webrtc_service_test.dart`). Server test should use `.test.ts` extension.

3. **Fix `onIceCandidate` line reference**: Change "approximately line 250-280" to lines 457-474 in `webrtc_service.dart`.

### Should Fix (Important)

4. **Add downgrade attack protection**: Implement a TOFU model where once a peer sends signed SDP, future unsigned SDP from that peer is rejected. This prevents a VPS from stripping signatures.

5. **Complete Step 5**: Fully specify the call signaling verification path, including where `CallOfferMessage` and `CallAnswerMessage` SDP fields are verified before being used.

6. **Address ICE candidate serialization fragility**: Sign the raw `candidate.candidate` string directly instead of wrapping in a JSON object.

7. **Add async safety check for `onIceCandidate`**: Guard against the signaling controller being closed when the async signing completes.

### Nice to Have

8. **Acknowledge DTLS fingerprint binding de-scope**: Add an explicit note that story acceptance criterion 5 (DTLS binding) and test requirement 6 are intentionally deferred, with a reference to a follow-up story.

9. **Document SDP byte-exactness requirement**: Note that SDP must not be reformatted between signing and verification.

10. **Fix signaling_client.dart constructor line reference**: Change "Lines 86-89" to "Lines 124-144".
