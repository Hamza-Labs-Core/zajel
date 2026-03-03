# Review 021: TUF Role Hierarchy for Registry Trust

**Plan:** `docs/security/implementation-plans/plan-021-tuf-role-hierarchy.md`
**Story:** `docs/security/stories/story-021-tuf-role-hierarchy.md`
**Reviewer:** Claude Opus 4.6
**Date:** 2026-03-03

---

## Verdict: PASS WITH NOTES

The plan is architecturally sound, implements the TUF specification correctly for the four core roles, and provides a solid phased migration strategy with backward compatibility. The code samples are production-quality and follow the existing codebase patterns. However, there are several issues that should be addressed: the story's line number references are significantly wrong for the server-registry-do.js file, the Dart `_canonicalJson` implementation is incorrect for nested objects, the `verifyTuf()` method is left as a stub (incomplete implementation), the `freezed` dependency introduces substantial build complexity, and the TUF metadata update endpoint (PUT) has a critical TODO for authentication that must be resolved before deployment.

---

## 1. Accuracy

### 1.1 File Paths -- PASS

All referenced existing source files are present at their stated paths:

| Path | Exists |
|------|--------|
| `scripts/generate-bootstrap-keys.mjs` | Yes |
| `packages/server/src/crypto/signing.js` | Yes |
| `packages/server/src/index.js` | Yes |
| `packages/server/src/durable-objects/server-registry-do.js` | Yes |
| `packages/app/lib/core/crypto/bootstrap_verifier.dart` | Yes |
| `packages/server/wrangler.jsonc` | Yes |
| `packages/app/lib/core/config/environment.dart` | Yes |
| `packages/app/pubspec.yaml` | Yes |
| `README.md` | Yes |
| `packages/server/src/cors.js` (imported by TufMetadataDO) | Yes |
| `packages/server/src/logger.js` (imported by TufMetadataDO) | Yes |
| `packages/app/lib/core/logging/logger_service.dart` (imported by tuf_verifier.dart) | Yes |

No new file paths conflict with existing files. The `packages/server/src/crypto/tuf/` directory does not exist yet (only `signing.js`, `timing-safe.js`, and `attestation.js` are in the crypto directory), which is correct.

### 1.2 Line Numbers -- NEEDS REVISION (Story) / PASS (Plan)

**Story line number references are significantly inaccurate for `server-registry-do.js`:**

| Reference (Story) | Claimed Lines | Actual Lines | Status |
|---|---|---|---|
| `generate-bootstrap-keys.mjs:16-26` | 16-26 | 16-26 | Match |
| `signing.js:27-46` for `importSigningKey` | 27-46 | 45-63 | WRONG (off by ~18) |
| `signing.js:27-58` (general range) | 27-58 | 1-77 (whole file) | WRONG |
| `index.js:77-104` for GET /servers | 77-104 | 99-129 | WRONG (off by ~22) |
| `index.js:92-101` for signing block | 92-101 | 118-126 | WRONG (off by ~26) |
| `bootstrap_verifier.dart:14-16` | 14-16 | 15-17 | Off by 1 |
| `bootstrap_verifier.dart:47-72` | 47-72 | 48-75 | Off by 1 |
| `server-registry-do.js:62-88` for `registerServer` | 62-88 | 464-630 | SIGNIFICANTLY WRONG |
| `server-registry-do.js:90-111` for server listing | 90-111 | 633-690 | SIGNIFICANTLY WRONG |
| `wrangler.jsonc:1-64` | 1-64 | 1-76 | Close (file is 76 lines) |

The story's `server-registry-do.js` line references (62-88, 90-111) appear to reference an older version of the file before anomaly detection and other features were added. The file is now 1033 lines, and `registerServer` starts at line 464.

**Plan line number references are accurate:**

| Reference (Plan) | Claimed Lines | Actual Lines | Status |
|---|---|---|---|
| `index.js, Before (lines 99-129)` | 99-129 | 99-129 | Match |
| `server-registry-do.js, Before (lines 464-473)` | 464-473 | 464-473 | Match |
| `server-registry-do.js, after line 617` | 617 | 617 (`storage.put`) | Match |
| `server-registry-do.js, after line 703` | 703 | 703 (close of unregister) | Match |
| `server-registry-do.js, after line 1032` | 1032 | 1032 (closing brace before end) | Match |
| `bootstrap_verifier.dart, Before (lines 40-75)` | 40-75 | 40-75 | Match |

### 1.3 Code Snippet Accuracy -- PASS WITH NOTES

**Plan "Before" code snippets are accurate.** The `index.js` GET /servers handler, `server-registry-do.js` registerServer, and `bootstrap_verifier.dart` verify method all match their actual source exactly.

**Story code snippets are accurate** in content (the code itself matches), but the line numbers associated with them are wrong as documented above.

---

## 2. Completeness

### 2.1 Acceptance Criteria Coverage

| Acceptance Criterion | Covered in Plan | Test Coverage |
|---|---|---|
| Root, targets, snapshot, and timestamp roles with separate keys | Yes (Step 1.1, 1.2) | Yes (unit tests in Step 4.1) |
| Root metadata embedded in app, supports versioned transitions | Yes (Step 3.1, 3.2) | Yes (tuf_verifier_test.dart) |
| Targets metadata lists VPS servers, signed by targets key | Yes (Step 1.2 createTargetsMetadata) | Yes (Step 4.1) |
| Snapshot prevents mix-and-match attacks | Yes (Step 3.2 hash checks) | Yes (Attack scenario test #9) |
| Timestamp has short expiration, prevents freeze attacks | Yes (Step 1.2 createTimestampMetadata, 1-hour) | Yes (Attack scenario test #7) |
| Non-root key rotation without app update | Yes (root metadata defines delegated keys) | Partial (test #10 covers root rotation, delegated key rotation is manual test only) |
| Root N+1 trust transition | Yes (Step 3.2 updateRoot) | Yes (test #10) |
| Server registration requires key ownership proof | Yes (Step 2.2) | Yes (test #11) |
| Client follows TUF metadata verification workflow | Yes (Step 3.2 verifyAndExtractTargets) | Yes (tuf_verifier_test.dart) |
| All metadata includes version numbers and expiration dates | Yes (all metadata schemas include version + expires) | Yes (implicit in all tests) |

### 2.2 Missing Pieces

1. **`verifyTuf()` in `bootstrap_verifier.dart` is a stub.** The plan's Step 3.3 leaves the actual TUF metadata fetching as a TODO with `throw UnimplementedError()`. While the `TufVerifier` class handles verification, the integration point that actually fetches the four metadata files from the server and passes them to the verifier is not implemented. This means the client has no way to actually use TUF mode even when `Environment.useTufMetadata` is enabled.

2. **`metadata_cache.dart` (file #17 in the file list) is never implemented.** It is listed as a new file to create but no implementation step provides its code. The test plan references "offline/degraded mode testing" (test #14) but there is no cache implementation to test.

3. **No implementation step for `wrangler.jsonc` changes.** The plan lists it as file #13 to modify (add TUF_METADATA DO binding and migration), but no step provides the actual JSONC changes. The TUF_METADATA binding is referenced in the server code but never declared in wrangler config.

4. **No implementation step for `environment.dart` changes.** The plan lists file #22 (add `useTufMetadata` flag) but never provides the actual Dart code to add this constant. The bootstrap_verifier.dart references `Environment.useTufMetadata` without it existing.

5. **Scripts `generate-root-metadata.mjs`, `generate-delegated-keys.mjs`, and `sign-server-registration.mjs` are listed but not implemented.** These are critical operational tools referenced throughout the migration plan and key rotation ceremony checklist.

6. **`freezed` and `json_serializable` are not in pubspec.yaml.** The plan (file #23) says to add `freezed`, `freezed_annotation`, `json_annotation`, and `json_serializable` to `pubspec.yaml`, but no implementation step provides the actual pubspec changes. Additionally, `build_runner` would be needed as a dev_dependency for code generation, and the plan does not mention running `dart run build_runner build` to generate the `*.freezed.dart` and `*.g.dart` files.

### 2.3 Test Plan Completeness

The test plan is thorough for the implemented portions. It covers:
- All four metadata types (creation, signing, verification)
- All three attack vectors (freeze, rollback, mix-and-match)
- Root key rotation (N to N+1)
- Server registration authentication
- Full metadata chain verification

**Gaps:**
- No automated test for delegated key rotation (only manual test #12)
- No test for the `TufMetadataDO` Durable Object in isolation (version monotonicity enforcement, history tracking)
- No test for the `GET /servers` backward compatibility path (legacy + TUF timestamp version header)
- E2E attack tests (Step 4.2) are more like pseudo-tests: they create conditions and assert properties but do not actually exercise the client verifier. The rollback test, for example, just fetches old metadata and notes "client verifier would throw" without actually calling the verifier.

---

## 3. Risks

### 3.1 Critical: TUF Metadata Update Endpoint Unauthenticated

The `TufMetadataDO.updateMetadata()` method (PUT /tuf/:role) has a TODO comment: `// TODO: Add authentication (SERVER_REGISTRY_SECRET or dedicated TUF_UPDATE_SECRET)`. This endpoint is exposed through the main worker's `/tuf/*` route delegation. Without authentication, **any external client can push arbitrary signed metadata** to the TUF store, completely undermining the trust model.

The plan's section 7 (Security Considerations) acknowledges this: "PUT /tuf/:role endpoints MUST be authenticated (TODO in implementation)." However, leaving this as a TODO in a security-critical implementation plan is a significant oversight. The authentication must be implemented before any deployment, not deferred.

**Recommendation:** Add an implementation step (e.g., Step 2.1b) that adds authentication to the PUT endpoint. At minimum, check for `Authorization: Bearer <TUF_UPDATE_SECRET>` header. The internal calls from `ServerRegistryDO.updateTufMetadata()` should include this secret.

### 3.2 High: Canonical JSON Mismatch Between Server and Client

The server-side `canonicalJSON()` (in `metadata.js`) implements recursive key sorting for nested objects. The client-side `_canonicalJson()` (in `tuf_verifier.dart`) only sorts the top-level keys:

```dart
String _canonicalJson(Map<String, dynamic> obj) {
  final sorted = Map.fromEntries(
    obj.entries.toList()..sort((a, b) => a.key.compareTo(b.key)),
  );
  return jsonEncode(sorted);
}
```

The Dart `jsonEncode` does NOT recursively sort nested map keys. If a metadata object has nested maps (which it does -- `keys`, `roles`, `meta`, `targets` are all nested maps), the Dart canonical JSON will produce a different byte string than the JavaScript version. This will cause **all signature verifications to fail** because the server signs with recursively-sorted JSON but the client verifies against shallowly-sorted JSON.

**Recommendation:** The Dart `_canonicalJson` must be a recursive implementation matching the JS version. Example:

```dart
String _canonicalJson(dynamic obj) {
  if (obj == null) return 'null';
  if (obj is! Map && obj is! List) return jsonEncode(obj);
  if (obj is List) return '[${obj.map(_canonicalJson).join(',')}]';
  final map = obj as Map<String, dynamic>;
  final keys = map.keys.toList()..sort();
  final pairs = keys.map((k) => '"$k":${_canonicalJson(map[k])}');
  return '{${pairs.join(',')}}';
}
```

### 3.3 High: Snapshot Hash Verification Uses `toJson()` Output, Not Canonical JSON

In `tuf_verifier.dart`, the snapshot and targets hash checks use:

```dart
final snapshotJson = jsonEncode(snapshotMeta.toJson());
final snapshotHash = _sha256(snapshotJson);
```

But the server computes hashes using `canonicalJSON(targetsMetadata.signed)` (the recursive canonical form). The `toJson()` output from a `freezed` model and Dart's `jsonEncode` will NOT produce the same string as JavaScript's `canonicalJSON()`, because:
1. Key ordering from `toJson()` depends on the Dart code generation order, not alphabetical.
2. `jsonEncode` uses Dart's default serialization, not canonical sorting.

This means **all hash checks in the client will fail** due to different serialization between server and client.

**Recommendation:** Hash verification on the client must use the same canonical JSON function used for signature verification. Replace `jsonEncode(meta.toJson())` with `_canonicalJson(meta.toJson())` (using the fixed recursive version from 3.2).

### 3.4 Medium: `freezed` Dependency Adds Significant Build Complexity

The project currently has zero code generation dependencies. Adding `freezed`, `freezed_annotation`, `json_annotation`, `json_serializable`, and `build_runner` introduces:
- A new `dart run build_runner build` step in the build pipeline
- Generated `*.freezed.dart` and `*.g.dart` files that must be committed or generated during CI
- Potential version conflicts with existing dependencies
- Slower build times

The existing codebase uses plain Dart classes (see attestation models, peer models, etc.). No other model in the project uses `freezed`.

**Recommendation:** Consider using plain Dart classes with manual `fromJson`/`toJson` methods, consistent with the rest of the codebase. This avoids introducing code generation infrastructure for just four model classes.

### 3.5 Medium: TUF Metadata Update Not Atomic Across Roles

In `ServerRegistryDO.updateTufMetadata()`, the three metadata updates (targets, snapshot, timestamp) are performed sequentially with separate `PUT` requests to the `TufMetadataDO`. If the process fails after updating targets but before updating snapshot/timestamp, the metadata chain becomes inconsistent: the snapshot will reference an old targets version while the DO stores a new one.

**Recommendation:** Either:
- Add a single atomic batch-update endpoint to `TufMetadataDO` that updates all three roles in one DO transaction.
- Or add error handling that rolls back targets if snapshot/timestamp updates fail.

### 3.6 Low: Timestamp Renewal Not Automated

The plan mentions in section 12 (Future Enhancements) that automatic timestamp renewal via Cron Trigger is "out of scope." However, with a 1-hour timestamp expiration, if no server registration occurs for more than 1 hour, all clients will receive expired timestamp metadata and reject it. This is a realistic scenario for a small federation.

**Recommendation:** Either increase the timestamp expiration (e.g., 24 hours) for the initial rollout, or include a basic Cron Trigger in the plan.

---

## 4. Recommended Changes

### Must Fix (Before Implementation)

1. **Fix Dart `_canonicalJson` to recursively sort nested objects.** The current shallow sort will cause all cross-platform signature verification to fail.

2. **Fix hash verification in `tuf_verifier.dart` to use canonical JSON** instead of `jsonEncode(meta.toJson())`.

3. **Implement authentication on PUT /tuf/:role endpoint.** Do not leave this as a TODO. Add a `TUF_UPDATE_SECRET` check in `updateMetadata()` and include it in the `ServerRegistryDO.updateTufMetadata()` internal calls.

4. **Add missing implementation steps** for: `wrangler.jsonc` DO binding and migration, `environment.dart` useTufMetadata flag, and `pubspec.yaml` dependency additions.

### Should Fix

5. **Implement `verifyTuf()` in `bootstrap_verifier.dart`** instead of leaving it as `throw UnimplementedError()`. Without this, the TUF client path is completely non-functional.

6. **Implement `metadata_cache.dart`** or remove it from the file list and defer to a follow-up story. Its absence makes offline/degraded mode (test #14) untestable.

7. **Consider dropping `freezed` in favor of plain Dart classes** to avoid introducing code generation infrastructure. The four TUF metadata models are straightforward enough to implement manually.

8. **Add a unit test for `TufMetadataDO`** that validates version monotonicity enforcement, history tracking, and the 404 response for missing metadata.

9. **Add an integration test for the `GET /servers` backward-compatible path** that verifies the `X-TUF-Timestamp-Version` header is present when TUF_METADATA is configured.

### Nice to Have

10. **Fix the story's line number references** for `server-registry-do.js` (currently referencing lines from an older version of the file) and `signing.js`/`index.js` (off by 18-26 lines).

11. **Make metadata updates atomic** across all three roles (targets, snapshot, timestamp) to prevent inconsistent state on partial failure.

12. **Add a Cron Trigger for timestamp renewal** or increase timestamp expiration to 24 hours for initial rollout to avoid freeze-attack false positives during quiet periods.

13. **Implement at least one of the three scripts** (`generate-root-metadata.mjs`, `generate-delegated-keys.mjs`, `sign-server-registration.mjs`) in the plan, since the migration plan and manual testing procedures depend on them.

---

## 5. Summary

The plan demonstrates strong understanding of the TUF specification and proposes a well-structured phased migration from single-key signing to a proper four-role hierarchy. The server-side implementation (metadata schema, role signing, Durable Object storage, registry integration) is thorough and follows existing codebase patterns. The client-side TUF verifier correctly implements the TUF section 5 verification workflow with rollback, freeze, and mix-and-match protections.

The primary concerns are:
- A canonical JSON serialization mismatch between server (recursive) and client (shallow) that would cause all signature and hash verifications to fail in practice.
- Several listed files that are never actually implemented in the plan steps (cache, wrangler config, environment flag, scripts).
- The unauthenticated PUT endpoint for metadata updates, which contradicts the entire security purpose of the TUF hierarchy.

These issues are fixable and do not require rethinking the architecture. With the recommended changes, this plan is ready for implementation.
