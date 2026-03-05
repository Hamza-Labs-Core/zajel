# Review: Plan 022 - Sigstore Keyless/Ephemeral Signing

**Verdict: PASS WITH NOTES**

The plan is well-structured, technically sound in its phased approach, and covers the major threat vectors described in the story. However, there are several line number inaccuracies in the story, one significant architectural gap in Phase 4, a missing file path in Phase 3 Step 5, and a few minor issues that should be corrected before implementation begins.

---

## Accuracy

### Line Number Verification (Story)

| Reference | Claimed Lines | Actual Lines | Status |
|-----------|--------------|-------------|--------|
| `release.yml` - Android keystore decoding | 161-180 | 161-180 | CORRECT |
| `release.yml` - Windows certificate signing | 385-402 | 397-414 (decode at 397-403, sign at 405-414) | WRONG - off by ~12 lines |
| `release.yml` - iOS certificate and provisioning | 231-254 | 243-266 (cert install at 243-266) | WRONG - off by ~12 lines |
| `release.yml` - Release creation without attestation | 499-508 | 511-520 (Create Release step) | WRONG - off by ~12 lines |
| `signing.js` - Long-lived key import and signing | 27-58 | 29-63 (bytesToBase64 at 29, importSigningKey at 45-64) | SLIGHTLY OFF |
| `index.js` - Bootstrap response signing | 92-101 | 117-126 (if block for BOOTSTRAP_SIGNING_KEY) | WRONG - off by ~25 lines |
| `bootstrap_verifier.dart` - Hardcoded public keys | 14-16 | 15-17 | OFF BY 1 |
| `generate-bootstrap-keys.mjs` - Key generation | 1-35 | 1-36 (file is 36 lines) | CLOSE ENOUGH |
| `generate-bootstrap-keys.mjs` - Lines 16-35 | 16-35 | 16-36 | OFF BY 1 |

The story snippet for `generate-bootstrap-keys.mjs` (lines 28-35) uses em-dash characters while the actual file at lines 29-35 uses em-dash -- these actually match since the file uses em-dashes too. The story code snippet at lines 28-35 is labeled as lines 28-35 but the text says "lines 16-35" in the table header. Minor inconsistency.

### Line Number Verification (Plan)

| Reference | Claimed Lines | Actual Lines | Status |
|-----------|--------------|-------------|--------|
| `release.yml` - permissions block | 481-483 | 481-482 | CORRECT |
| `release.yml` - "After line 509" | After 509 | Line 509 is last artifact copy; correct insertion point | CORRECT |
| `release.yml` - Line 516 | 516 | 516 (`files: release-files/*`) | CORRECT |
| `signing.js` - Lines 45-64 | 45-64 | importSigningKey is at 45-64 | CORRECT |
| `signing.js` - Lines 67-77 | 67-77 | signPayload is at 72-76 (file ends at 77) | SLIGHTLY OFF - function starts at 72, not 67 |
| `index.js` - Lines 117-126 | 117-126 | Signing block is at 117-126 | CORRECT |
| `wrangler.jsonc` - "after line 75" | After 75 | File ends at line 76 (closing brace) | CORRECT |
| `bootstrap_verifier.dart` - Lines 14-17 | 14-17 | Public keys at 15-17 | OFF BY 1 (line 14 is the class declaration) |
| `bootstrap_verifier.dart` - Lines 22-37 | 22-37 | Lines 22-38 contain the constructor and factory | CLOSE |
| `bootstrap_verifier.dart` - Lines 40-75 | 40-75 | verify() is at 48-75 | OFF - verify starts at 48, not 40 |

### Code Snippet Verification

**Story snippet for `release.yml` Windows signing (lines 393-401)**: The claimed code is close but not exact. The actual code at lines 405-414 includes `Select-Object -First 1 -ExpandProperty FullName`, an `if (-not $signtool)` check, a comment, and `if ($LASTEXITCODE -ne 0)` check that are not shown in the story. The story version is simplified.

**Story snippet for `signing.js`**: The story says lines 27-58 but the `BEFORE` block in the plan (lines 45-64) is the correct reference for `importSigningKey`. The function signature and PKCS8 logic match.

**Plan `BEFORE` block for `index.js`** (lines 117-126): Matches the actual source exactly.

**Plan `BEFORE` block for `bootstrap_verifier.dart`**: The plan shows `_productionPublicKey` starting at line 14, but the actual class declaration `class BootstrapVerifier {` is at line 14 and the constant is at line 15. The `BEFORE` snippet content matches but line attribution is off by 1.

**Plan `BEFORE` block for `bootstrap_verifier.dart` constructor** (lines 22-37): The actual code at lines 22-38 matches. The `withKey` factory ends at line 38, not 37.

**Plan `BEFORE` block for `bootstrap_verifier.dart` verify()** (lines 40-75): The actual `verify` method starts at line 48, not 40. Lines 40-47 are comments. The function body matches the plan's BEFORE block, but the plan references the wrong starting line.

### File Path Verification

| Referenced Path | Exists | Notes |
|----------------|--------|-------|
| `.github/workflows/release.yml` | YES | |
| `packages/server/src/crypto/signing.js` | YES | |
| `packages/server/src/index.js` | YES | |
| `packages/server/wrangler.jsonc` | YES | |
| `packages/app/lib/core/crypto/bootstrap_verifier.dart` | YES | |
| `scripts/generate-bootstrap-keys.mjs` | YES | |
| `packages/app/lib/core/network/bootstrap_client.dart` | NO | Plan says "or wherever bootstrap responses are consumed" -- the actual file is `packages/app/lib/core/network/server_discovery_service.dart` |
| `packages/app/lib/features/attestation/services/version_check_service.dart` | YES | |
| `docs/RELEASE_VERIFICATION.md` | NO | New file (expected) |
| `packages/app/lib/core/crypto/cosign_verifier.dart` | NO | New file (expected) |
| `scripts/rotate-bootstrap-keys.mjs` | NO | New file (expected) |

---

## Completeness

### Acceptance Criteria Coverage

| Acceptance Criterion | Covered in Plan | Covered in Tests |
|---------------------|----------------|-----------------|
| Release workflow produces SLSA provenance attestations | Phase 1 | Test 1 |
| Attestations published to Rekor | Phase 1 | Test 1 |
| Each attestation binds to commit/workflow/repo | Phase 1 | Test 1 |
| Cosign bundles published alongside artifacts | Phase 2 | Tests 2, 3 |
| Users can verify with `cosign verify-blob` | Phase 2 + docs | Test 3 |
| Bootstrap key supports rotation without app updates | Phase 3 | Tests 6-9 |
| Key rotation events are logged/auditable | Partial (manual logging only) | Not covered |
| No new long-lived signing keys | Phase 1-2 (keyless) | Implicit |
| Platform-specific signing remains | Non-goal (preserved) | Not tested |

**Gap: "Key rotation events are logged and auditable"** -- The plan's rotation script only prints instructions to stdout. There is no audit log mechanism. The plan should specify where rotation events are recorded (e.g., Rekor entry for the new public key, a GitHub Actions workflow log, or a commit to the repository).

### Missing Steps

1. **Phase 3, Step 3.4 (bootstrap client update)**: The plan references `bootstrap_client.dart` which does not exist. The actual file consuming bootstrap responses is `packages/app/lib/core/network/server_discovery_service.dart`. The code at line 130-134 reads `x-bootstrap-signature` but does NOT read any version header. The plan's pseudocode for this step is too vague ("Assuming bootstrap client code looks like this"). This step needs to reference the actual file and provide exact BEFORE/AFTER code.

2. **CORS header exposure**: The server sends new custom headers (`X-Bootstrap-Key-Version`, `X-Bootstrap-Signature-Secondary`, `X-Bootstrap-Key-Version-Secondary`). Per the CLAUDE.md memory note about CORS, these headers need to be added to `Access-Control-Expose-Headers` in the CORS configuration. The plan does not mention this.

3. **`VersionCheckService` integration (Phase 4, Step 4.3)**: The plan proposes adding `downloadVerifiedUpdate()` to `VersionCheckService`, but that class has no concept of artifacts or downloads -- it only evaluates version policies. Adding artifact download/verification here is architecturally misplaced. A separate service or extending `ServerDiscoveryService` would be more appropriate.

4. **Test fixtures**: Tests 10-12 reference test fixture files (`test/fixtures/zajel-0.0.1-test-android.apk`) that need to be created as part of the test plan. The plan does not specify how to generate these fixtures.

5. **`COSIGN_EXPERIMENTAL` vs `COSIGN_YES`**: The story's Phase 2 snippet uses `COSIGN_EXPERIMENTAL: 1` (deprecated in cosign v2.x), while the plan uses `COSIGN_YES: "true"` (correct for v2.x). The story should be updated, but since the plan has the correct value, this is a story-only issue.

---

## Risks

### Risk 1: Cosign CLI Dependency in Flutter App (Phase 4) -- HIGH

The `CosignVerifier` in Phase 4 shells out to the `cosign` CLI binary via `Process.run`. This is fundamentally incompatible with mobile platforms (Android, iOS) where arbitrary binaries cannot be executed. The plan acknowledges this in the Security Considerations section ("NOT suitable for end-user auto-update") but still creates the class and integrates it into `VersionCheckService`. This creates dead code that will never work on the primary target platforms.

**Recommendation**: Either (a) scope Phase 4 as desktop-only and guard the code with platform checks, or (b) defer Phase 4 entirely until a pure Dart Sigstore implementation exists, or (c) implement Phase 4 as a CLI verification tool (not a Flutter library).

### Risk 2: Cosign `sign-blob` Loop May Fail Partially -- MEDIUM

The cosign signing step iterates over `release-files/zajel-*` with a for loop. If cosign signing fails for one artifact (e.g., transient Fulcio/Rekor issue), the loop continues and subsequent artifacts may succeed. This produces an incomplete set of `.sigstore.json` bundles. The plan mentions `continue-on-error: true` for rollback scenarios but does not handle partial failure within the loop.

**Recommendation**: Add `set -e` to the shell script and/or check exit codes within the loop. Alternatively, accept partial failure but document it.

### Risk 3: Glob Pattern for Sigstore Bundles in Release -- LOW

The plan changes the release `files:` from `release-files/*` to a multiline value including `release-files/*.sigstore.json`. However, `release-files/*` already matches `*.sigstore.json` files since they are in the same directory. The change is harmless but redundant. More importantly, the cosign loop signs `release-files/zajel-*`, which will NOT match existing `.sigstore.json` files (they don't start with `zajel-`), so there is no risk of recursive signing.

### Risk 4: Production Release Workflow Only Runs on Production Tags -- MEDIUM

The `release.yml` workflow has a guard at line 24 that skips for non-production tags (e.g., `v1.0.0-test.1`). The test plan calls for creating pre-release tags like `v0.0.1-test.1` for testing, but these will be skipped by the `check-production-release` job. The plan's testing approach will not work with the current workflow structure.

**Recommendation**: Either (a) add a separate test workflow that runs on pre-release tags, or (b) temporarily modify the production guard during testing, or (c) use a different trigger mechanism for test runs.

### Risk 5: `which cosign` Not Available on Windows Runners -- LOW

The `CosignVerifier` class uses `Process.run('which', ['cosign'])` which is a Unix command. On Windows, this would fail. Since Phase 4 is desktop-targeted, this needs `where.exe` on Windows.

---

## Recommended Changes

### Must Fix (before implementation)

1. **Correct the bootstrap client file path in Phase 3, Step 3.4**: Replace `bootstrap_client.dart` with the actual path `packages/app/lib/core/network/server_discovery_service.dart`. Provide exact BEFORE/AFTER code showing how `x-bootstrap-key-version` is extracted from `response.headers` at line 130 and passed to `_verifier.verify()` at line 134.

2. **Add CORS header exposure**: In Phase 3, Step 3.2, add a step to update the CORS configuration (likely in `packages/server/src/cors.js`) to include `X-Bootstrap-Key-Version`, `X-Bootstrap-Signature-Secondary`, and `X-Bootstrap-Key-Version-Secondary` in `Access-Control-Expose-Headers`. Without this, the Flutter Web client cannot read these headers.

3. **Fix test plan for pre-release tags**: Tests 1, 2, and 13 rely on pre-release tags (`v0.0.1-test.attestation`, `v0.0.1-test.cosign`, `v0.0.1-rc.1`) triggering the release workflow. The current workflow skips non-production tags. Either create a separate CI workflow for testing or adjust the test plan.

4. **Fix line number references in the story**: Update the "Affected Code" table to use correct line numbers -- particularly `index.js` (92-101 should be 117-126), `release.yml` Windows signing (385-402 should be 397-414), iOS (231-254 should be 243-266), and release creation (499-508 should be 511-520).

### Should Fix

5. **Relocate `downloadVerifiedUpdate` out of `VersionCheckService`**: This method does not belong in a service that evaluates version policies. Create a dedicated `ArtifactVerificationService` or similar.

6. **Add platform guard to CosignVerifier**: At minimum, document that this class is desktop-only. Better: add `dart:io` Platform checks and throw `UnsupportedError` on mobile.

7. **Add audit logging for key rotation events**: The acceptance criterion "Key rotation events are logged and auditable" is not addressed. The rotation script should output a JSON record (timestamp, operator, key version, public key hash) that can be committed to the repo or logged elsewhere.

8. **Correct line number references in the plan**: Fix `signing.js` lines 67-77 (should be 72-77 for `signPayload`), `bootstrap_verifier.dart` lines 14-17 (should be 15-17), and lines 40-75 (verify starts at 48).

### Nice to Have

9. **Add `set -e` to the cosign signing shell script** to fail fast on partial signing failure.

10. **Replace `which cosign` with a cross-platform check** in `CosignVerifier` (use `where.exe` on Windows).

11. **Consider using `actions/attest-build-provenance@v2` with individual subject paths** instead of a glob, since some artifacts (iOS, macOS) may not exist if the build was skipped due to missing secrets. A glob that matches zero files may cause the action to fail.

---

## Summary

The plan is architecturally sound and well-phased. Phases 1-2 (GitHub Actions attestation and Cosign signing) are low-risk, high-value improvements that can be implemented immediately. Phase 3 (bootstrap key rotation) is well-designed with proper dual-signing for zero-downtime rotation, though it needs the CORS fix and correct file path. Phase 4 (Flutter CosignVerifier) has a fundamental platform limitation that should be acknowledged more prominently -- it will only work on desktop and should be scoped accordingly or deferred.

The test plan is comprehensive with 16 tests covering positive, negative, rotation, and performance scenarios. The main gap is that the CI testing approach relies on pre-release tags that the current workflow explicitly skips.

Overall: the plan can proceed with implementation after the four "Must Fix" items are addressed.
