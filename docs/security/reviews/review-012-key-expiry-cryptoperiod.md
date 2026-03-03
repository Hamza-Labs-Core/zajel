# Review: Plan 012 - Key Expiry/Crypto-Period Limits for Build Signing Keys

**Verdict: PASS WITH NOTES**

The plan is well-structured, thorough, and correctly identifies the security gaps. The proposed implementation is sound and the test plan covers all acceptance criteria. However, there are several inaccuracies in referenced line numbers/snippets, one logic bug in the proposed code, and a few missing edge cases that should be addressed before implementation.

---

## 1. Accuracy

### 1.1 File Paths

| Referenced Path | Exists | Status |
|---|---|---|
| `packages/server/src/durable-objects/server-registry-do.js` | Yes | OK |
| `packages/server/tests/unit/build-signing.test.js` | Yes | OK |

### 1.2 Line Number Verification

The plan references specific line numbers throughout. Verified against the actual source (1033 lines total):

| Plan Reference | Claimed Content | Actual Content | Status |
|---|---|---|---|
| Line 131-132 | `MAX_TRUSTED_BUILD_KEYS = 50` | Line 131: `/** Maximum trusted build keys allowed */`, Line 132: `const MAX_TRUSTED_BUILD_KEYS = 50;` | **OK** |
| Lines 172-204 | `encryptKeys`/`decryptKeys` | Lines 172-204 match exactly | **OK** |
| Lines 214-234 | `loadTrustedKeys` | Lines 214-234 match exactly | **OK** |
| Lines 279-281 | `isTrustedKey` | Lines 279-281 match exactly | **OK** |
| Lines 317-337 | `alarm()` handler | Lines 317-337 match exactly | **OK** |
| Line 586 | `trustedKeys.length === 0 \|\| ...` | Line 586 matches exactly | **OK** |
| Line 751 | Same empty-set fallback in heartbeat | Line 751 matches exactly | **OK** |
| Lines 897-978 | `setTrustedKeys` handler | Lines 897-978 match exactly | **OK** |
| Line 919 | `isValidKey` lambda | Line 919 matches exactly | **OK** |
| Lines 986-1032 | `getTrustedKeys` handler | Lines 986-1032 match exactly | **OK** |

**All "Before" code snippets match the actual source exactly.** This is a well-researched plan.

### 1.3 Story Line Number References

The story references lines 964-967 for key storage format. Verified: lines 964-967 contain exactly `const plainData = { keys: finalKeys, updatedAt: Date.now() };` / `const stored = await BuildVerifier.encryptKeys(...)` / `await this.state.storage.put(...)`. **OK.**

---

## 2. Completeness

### 2.1 Acceptance Criteria Coverage

| Acceptance Criterion | Covered in Plan | Covered in Tests | Status |
|---|---|---|---|
| Per-key metadata (keyId, publicKey, addedAt, expiresAt, addedBy) | Step 3.7 | Test Cases 5, 9, 10 | OK |
| `addKeys` requires expiresAt or defaults to 90 days | Step 3.7 | Test Case 5 | OK |
| expiresAt cannot exceed 90 days | Step 3.7 | Test Case 4 | OK |
| loadTrustedKeys filters expired and revoked keys | Step 3.2 | Test Cases 1, 2, 3 | OK |
| GET returns per-key metadata with time-to-expiry | Step 3.8 | Test Case 5 (partially) | **NOTE A** |
| Empty trustedKeys = buildVerified false | Steps 3.4, 3.5 | Test Case 6 | OK |
| DO alarm logs warning for keys expiring within 14 days | Step 3.6 | Test Cases 11, 12 | OK |
| Legacy format migrates on first read | Step 3.2 | Test Cases 8, 9 | OK |
| Key validation enforces base64 + 32-byte Ed25519 | Step 3.1 | Test Cases 13, 14 | OK |

**NOTE A**: Test Case 5 checks default expiry in the GET response but does not specifically verify the `status` field ("active"/"expiring-soon"/"expired"/"revoked") or `daysUntilExpiry` field that Step 3.8 introduces. Consider adding a dedicated test for the GET response metadata fields.

### 2.2 Existing Tests That Will Break

The plan correctly notes (Section 4.8) that existing tests need updating but does not enumerate which ones. Based on review of the existing test file:

1. **`should accept any valid signature when TRUSTED_BUILD_KEYS is not configured`** (line 220-238): This test asserts `buildVerified === true` when no keys are configured. After the empty-set fix (Steps 3.4/3.5), this will fail. The test must be updated to expect `buildVerified === false`, or the test should configure a trusted key.

2. **`GET /servers/trusted-keys` response format tests** (lines 552-571): The existing test asserts `data.keys[0]` is a string (`keypair.publicKeyBase64`). After Step 3.8, `data.keys[0]` will be an object with `{ keyId, publicKey, ... }`. These tests must be updated.

3. **`should deduplicate keys`** (lines 494-507): The existing test asserts `data.keys.length === 1` on the POST response. The plan's new POST response (Step 3.7) returns `keys` filtered by non-revoked and mapped to `publicKey`, so this should still pass. However, if the same key is submitted twice with different `expiresAt` values, deduplication by fingerprint would keep only one. This edge case is not tested.

The plan should explicitly list these breaking tests and provide updated versions.

---

## 3. Risks

### 3.1 Bug: `computeKeyFingerprint` Produces Incorrect Format

The plan's `computeKeyFingerprint` function (Step 3.1, lines 79-90) uses this reduce:

```javascript
return Array.from(prefix, b => b.toString(16).padStart(2, '0'))
  .reduce((acc, byte, i) => acc + byte + (i === 3 ? ':' : ''), '');
```

This produces a fingerprint like `a1b2c3d4:e5f6a7b8` (16 hex chars with one colon). However, the docstring says "8-byte hex fingerprint (e.g., `a1b2c3d4:e5f6a7b8`)" which is misleading -- it is 8 bytes but formatted as `xxxxxxxx:xxxxxxxx`. More importantly, the colon is only inserted at index 3, so the last 4 bytes are concatenated without separators. The actual output would be: `a1` + `b2` + `c3` + `d4:` + `e5` + `f6` + `a7` + `b8` = `a1b2c3d4:e5f6a7b8`. This is cosmetic and functionally correct for deduplication purposes.

**No action required**, but the format description in the docstring should match the actual output.

### 3.2 Bug: Unhandled `throw` in `setTrustedKeys` (Crypto-Period Enforcement)

In Step 3.7, the crypto-period enforcement uses `throw new Error(...)` inside a `Promise.all` / `map`:

```javascript
if (expiresAt - now > MAX_KEY_LIFETIME_MS) {
  throw new Error(`Key expiry exceeds maximum crypto-period of ${MAX_KEY_LIFETIME_MS}ms`);
}
```

This `throw` is inside `body.keys.map(async (...) => { ... })` which is wrapped in `Promise.all(...)`. If this throws, the `Promise.all` rejects, but **there is no try/catch around the `Promise.all`**. This will result in an **unhandled promise rejection** that bubbles up to the Cloudflare Workers runtime, likely returning a 500 error with no meaningful error message.

**Recommended fix**: Either (a) validate all keys in a pre-check loop before constructing the metadata objects, or (b) wrap the `Promise.all` in a try/catch that returns a 400 response with the crypto-period error message.

The same issue exists in the `addKeys` branch of Step 3.7.

### 3.3 Risk: Migration Writes Unencrypted Data When `ciSecret` is Missing

In Step 3.2 (rewritten `loadTrustedKeys`), the migration write path is:

```javascript
if (ciSecret) {
  try {
    const encrypted = await this.encryptKeys(migratedData, ciSecret);
    await storage.put('trusted_build_keys', encrypted);
  } catch { /* ... */ }
}
```

If `ciSecret` is not set (i.e., `CI_UPLOAD_SECRET` is not configured), the migration is never persisted. This means the migration runs on every single `loadTrustedKeys` call, performing the `computeKeyFingerprint` async work repeatedly. While the plan notes this is "best-effort," it creates a performance concern if `loadTrustedKeys` is called frequently (every registration and heartbeat) and CI_UPLOAD_SECRET is not set.

Consider adding a plaintext migration path when `ciSecret` is absent.

### 3.4 Risk: `removeKeys` Computes Fingerprints for Matching But Previous Format May Differ

In Step 3.7, `removeKeys` computes fingerprints of the keys to remove and matches them against `keyId` of stored keys:

```javascript
const removeFingerprints = await Promise.all(
  body.removeKeys.map(publicKey => BuildVerifier.computeKeyFingerprint(publicKey))
);
const removeSet = new Set(removeFingerprints);
finalKeysMetadata = currentKeysMetadata.map(k => {
  if (removeSet.has(k.keyId)) { return { ...k, revoked: true }; }
  return k;
});
```

This is correct. However, the existing API contract for `removeKeys` accepts raw public key strings. If a caller provides a slightly different base64 encoding (e.g., with or without trailing `=` padding), the fingerprint will differ and the key will not be found. The old behavior did exact string matching, so this is not a regression, but the plan should note this behavior change (matching by fingerprint vs. exact string).

### 3.5 Risk: Existing Test Expects `trustedKeys.length === 0` Trust-All Behavior

As noted in Section 2.2, the existing test at line 220 (`should accept any valid signature when TRUSTED_BUILD_KEYS is not configured`) directly tests the trust-all behavior that Steps 3.4/3.5 intentionally break. The plan acknowledges this in Section 4.8 ("except those testing the `trustedKeys.length === 0` fallback behavior") but does not provide the updated test. The implementation must update this test or it will fail in CI.

### 3.6 Risk: `encryptKeys` Type Signature Mismatch After Schema v2

Step 3.2 and 3.7 pass `{ keys: Array<Object>, updatedAt, schemaVersion: 2 }` to `encryptKeys`. The JSDoc on `encryptKeys` (line 174) declares `@param {{ keys: string[], updatedAt: number }} data`. While `encryptKeys` just does `JSON.stringify(data)` and does not validate the type, the JSDoc is misleading. The plan mentions this in Section 2.1 ("Update type signatures (no logic change)") but Step 3.1 does not actually update the JSDoc. This should be included.

---

## 4. Recommended Changes

### Must Fix (Before Implementation)

1. **Wrap `Promise.all` in try/catch in `setTrustedKeys`** (Risk 3.2): The `throw new Error(...)` for crypto-period enforcement will cause unhandled rejections. Pre-validate expiry before entering the async map, or catch the rejection and return a proper 400 response.

2. **Provide updated versions of breaking tests** (Section 2.2): At minimum, update the test at line 220 that asserts trust-all behavior with empty keys. Also update GET response format assertions.

### Should Fix

3. **Update `encryptKeys`/`decryptKeys` JSDoc** (Risk 3.6): Change the `@param` type from `{ keys: string[], updatedAt: number }` to `{ keys: Array, updatedAt: number, schemaVersion?: number }` to reflect the new schema.

4. **Add a test for the GET response metadata fields**: Verify `status`, `daysUntilExpiry`, `keyId`, `addedBy`, and `addedAt` are present and correct in the GET response (Note A).

5. **Add plaintext migration fallback** (Risk 3.3): When `ciSecret` is absent, persist the migrated v2 format as plaintext to avoid re-migrating on every read.

### Nice to Have

6. **Test for `removeKeys` with fingerprint matching**: Add a test that verifies `removeKeys` correctly soft-deletes a key by computing its fingerprint, and that the key appears as `revoked: true` in subsequent GET calls.

7. **Document the base64 padding sensitivity** (Risk 3.4): Note in the API docs that `removeKeys` values must exactly match the `publicKey` values that were originally uploaded (same padding, same encoding).

8. **Test Case 4 error handling**: The test at Section 4.2 (Test Case 4) expects `response.status` to be 400. However, due to Risk 3.2 (unhandled throw), the actual response would be a 500 from the Workers runtime. This test would fail as-written unless the throw is replaced with a proper response.

---

## 5. Summary

The plan is thorough and well-researched. All source file paths exist, all line number references are accurate, and all code snippets match the actual source exactly. The proposed changes correctly address the security gaps identified in Story 012.

The primary issue is the unhandled `throw` inside `Promise.all` for crypto-period enforcement (Risk 3.2), which would cause 500 errors instead of the intended 400 responses. This must be fixed before implementation. The plan should also explicitly provide updated versions of the 2-3 existing tests that will break due to the empty-set behavior change and GET response format change.

With these fixes applied, the plan is ready for implementation.

**Reviewed:** 2026-03-03
**Reviewer:** Claude Code (automated review)
**Plan Version Reviewed:** 1.0
