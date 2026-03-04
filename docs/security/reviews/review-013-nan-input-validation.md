# Review: Plan 013 - NaN Input Validation Guards in Attestation

## Verdict: PASS WITH NOTES

The plan correctly identifies and addresses the NaN bypass vulnerability in `region_index` bounds checking, the `typeof NaN === 'number'` gap in `critical_regions` validation, and the nonce consumption DoS vector. The proposed `isNonNegativeInteger()` / `isPositiveInteger()` helpers are correct and the nonce-deletion reordering is the right fix. However, the E2E test code contains several inaccuracies that will cause compilation or runtime failures if copied verbatim.

---

## Accuracy

### File paths: CORRECT
All referenced source files exist:
- `packages/server/src/durable-objects/attestation-registry-do.js` -- exists
- `packages/server/src/durable-objects/server-registry-do.js` -- exists (referenced in story only)
- `packages/server/src/utils/request-validation.js` -- exists
- `packages/server/tests/e2e/attestation.test.js` -- exists
- New files (`src/utils/numeric-validation.js`, `tests/unit/numeric-validation.test.js`) -- directories exist, files do not yet exist (correct for new file creation)

### Line numbers: CORRECT
All referenced line numbers were verified against the actual source:

| Reference | Plan says | Actual | Match |
|-----------|-----------|--------|-------|
| Imports | Lines 30-33 | Lines 30-33 | Yes |
| `critical_regions` validation | Lines 494-503 | Lines 494-503 | Yes |
| Nonce deletion | Line 720 | Line 720 | Yes |
| Bounds check | Lines 752-758 | Lines 752-758 | Yes |
| `selectRandomRegions` | Lines 977-979 | Lines 977-979 | Yes |
| Outer try-catch | Line 179 (story) | Line 179 | Yes |
| `VERIFY_FAILED_MSG` | Line 63 (implicit) | Line 63 | Yes |
| Server registry `Number.isFinite` | Lines 560-571 | Lines 560-571 | Yes |

### Code snippets: CORRECT
All "Before" code snippets match the actual source verbatim.

### Vulnerability analysis: CORRECT
- `NaN < 0` is indeed `false`, `NaN >= n` is indeed `false` -- bounds check bypassed
- `typeof NaN === 'number'` is indeed `true` -- critical_regions type check bypassed
- `challenge.regions[NaN]` returns `undefined` -- confirmed
- Nonce is deleted at line 720 before validation at line 752 -- confirmed

---

## Completeness

### Acceptance criteria coverage

| Story acceptance criterion | Covered in plan | Covered in tests |
|----------------------------|-----------------|------------------|
| `region_index` validated with `isFinite`+`isInteger` | Yes (Step 4) | Yes |
| `critical_regions` offset/length validated | Yes (Step 3) | Yes |
| NaN/Infinity/null/undefined/string return clean error | Yes (Step 4) | Yes |
| Nonce deletion moved after validation | Yes (Step 4) | Yes (DoS test) |
| Consistent `isNonNegativeInteger` helper | Yes (Step 1) | Yes (unit tests) |
| Helper extracted to shared module | Yes (Step 1) | Yes |

### Test coverage gaps

1. **Missing test for `selectRandomRegions` guard (Step 5)**: The plan adds a defensive guard to `selectRandomRegions` that throws on invalid `count`, but there is no unit test for this new throw behavior. While the plan notes this is "defensive," adding a test would be trivial and worthwhile.

2. **No test for duplicate `region_index` values**: The validation loop does not check for duplicate `region_index` values across responses. An attacker could submit `[{region_index: 0, hmac: X}, {region_index: 0, hmac: X}]` with the same valid HMAC twice and skip region 1. This is arguably out of scope for NaN validation but is a related input validation gap.

3. **No test for `responses` count after validation reorder**: The plan moves the response count check (`responses.length !== challenge.regions.length`) before nonce deletion (Step 4, STEP 2), but does not add a test verifying that a wrong response count also preserves the nonce.

---

## Risks

### Risk 1: E2E test code will not compile as written (MEDIUM)

The plan's E2E test code has several errors that will prevent it from working if copied verbatim:

1. **`VERIFY_FAILED_MSG` is not accessible in tests.** The constant is defined as a module-local `const` at line 63 of `attestation-registry-do.js` and is not exported. The test code at plan line 616 references `expect(data.error).toBe(VERIFY_FAILED_MSG)` which will fail with `ReferenceError`. The existing tests use string literals (e.g., `'HMAC mismatch'`). The fix is to use the string literal `'Verification failed'` instead.

2. **`exportPublicKey` does not exist.** The plan's `beforeEach` at line 546 calls `exportPublicKey(seedHex)`, but the actual function is `exportPublicKeyBase64` (imported from `../../src/crypto/attestation.js`). Furthermore, `exportPublicKeyBase64` takes a `CryptoKey` object, not a hex seed string. The existing test file calls `importAttestationSigningKey(seedHex)` first, then `exportPublicKeyBase64(signingKey)`.

3. **`hexToBytes` is not available in test scope.** The plan's positive test case at line 776 calls `hexToBytes(matchingRegion.data_hex)`, but the test file uses a local `hexToBytes2()` function defined at line 1718. The import `hexToBytes` from `../../src/crypto/signing.js` is not present in the test file's imports.

4. **`MockState` is defined inside the test file but the plan's new `describe` block creates its own `beforeEach` with `new MockState()`.** Since the plan adds the new test suite inside the top-level `describe('Attestation Service E2E Tests', ...)`, it would be a nested `describe` block. This is fine structurally, but the plan's `beforeEach` shadows the outer `beforeEach` and does not call `afterEach` for cleanup (the outer `afterEach` calls `mockState.storage.clear()` on the outer `mockState` variable, not the inner one).

5. **`BUILD_SIGNING_PUBKEY` and `AUDIT_LOG_KEY` are not used by the outer tests' env setup.** The plan's `mockEnv` includes extra keys not present in the existing test setup. This is not a bug but an inconsistency.

### Risk 2: JSON serialization makes some test scenarios unreachable (LOW)

Since `createRequest` calls `JSON.stringify(body)` (line 99 of the test file), values like `NaN`, `Infinity`, and `undefined` in the body object get serialized as `null` or omitted entirely. This means:
- `region_index: NaN` becomes `region_index: null` after JSON round-trip
- `region_index: Infinity` becomes `region_index: null` after JSON round-trip
- `region_index: undefined` gets omitted from the JSON entirely

The plan acknowledges the Infinity issue (lines 738-751) and works around it by using `Number.MAX_VALUE`. However, the NaN test at plan line 606 uses `region_index: 'abc'` (a string), not actual NaN, so this test is fine. The real NaN value is unreachable via standard JSON, which the story itself acknowledges at line 101.

### Risk 3: Nonce reordering introduces a new timing window (LOW)

Moving nonce deletion after validation means there is a slightly longer window where a valid nonce exists in storage. An attacker could potentially submit two concurrent requests: one with invalid input (which preserves the nonce) and one with valid input (racing to use the nonce before the first request returns). However, Durable Objects process requests sequentially (`blockConcurrencyWhile`), so this is not exploitable in practice.

### Risk 4: `Number.MAX_VALUE` passes `isNonNegativeInteger` (LOW)

The Infinity test (plan lines 730-759) replaces `Infinity` with `Number.MAX_VALUE` to avoid JSON serialization issues. However, `Number.MAX_VALUE` is considered a finite integer by JavaScript (`Number.isFinite(Number.MAX_VALUE)` is `true`, `Number.isInteger(Number.MAX_VALUE)` is `true`). This means `isNonNegativeInteger(Number.MAX_VALUE)` returns `true`. The test would still pass because `Number.MAX_VALUE >= challenge.regions.length` would be `true` (caught by the bounds check), but the test comment "simulate Infinity-like behavior" is misleading. The test is not testing the `isNonNegativeInteger` guard; it is testing the bounds check, which already worked correctly for large finite numbers.

---

## Recommended Changes

### Must Fix (will cause test failures)

1. **Replace `VERIFY_FAILED_MSG` with string literal `'Verification failed'`** in all E2E test assertions. The constant is not exported.

2. **Fix `exportPublicKey` call in test `beforeEach`.** Replace:
   ```javascript
   publicKeyBase64 = await exportPublicKey(seedHex);
   ```
   with:
   ```javascript
   const signingKey = await importAttestationSigningKey(seedHex);
   publicKeyBase64 = await exportPublicKeyBase64(signingKey);
   ```

3. **Replace `hexToBytes` with `hexToBytes2`** in the positive test case (plan line 776), or add an import/alias for it.

### Should Fix (correctness/clarity)

4. **Add `afterEach` cleanup** to the new `describe` block's `beforeEach` to avoid leaking state. Alternatively, restructure the tests to reuse the outer `beforeEach`/`afterEach` and helper functions like `setupFullFlow` and `computeCorrectResponses`.

5. **Add a unit test for the `selectRandomRegions` defensive guard** (Step 5). A simple test that `selectRandomRegions(regions, NaN)` throws would suffice.

6. **Remove or rewrite the Infinity test** (plan lines 730-759). Since `Infinity` becomes `null` via JSON and `Number.MAX_VALUE` passes `isNonNegativeInteger`, the test as written does not actually exercise the Infinity guard. Either: (a) test with `null` explicitly and document that this covers the JSON-serialized Infinity case, or (b) construct a raw `Request` object with a hand-crafted body string to bypass JSON serialization.

7. **Add a test verifying that wrong response count also preserves the nonce** (analogous to the DoS test for invalid `region_index`).

### Nice to Have

8. **Consider validating for duplicate `region_index` values** in the response array. While out of scope for this story, it is a related input validation gap where an attacker could skip verification of certain regions by submitting the same valid region_index multiple times.

9. **Add the `data_hex` validation to the story's acceptance criteria**. The plan adds `data_hex` hex format validation (Step 3, lines 185-203) which is a bonus improvement not listed in the story's acceptance criteria. This should be noted to avoid scope creep confusion.

10. **Consider whether `isPositiveInteger` is needed.** It is only used for `region.length` validation. Using `isNonNegativeInteger(region.length) && region.length > 0` would avoid introducing a second function. However, the current approach is clean and the helper is well-documented, so this is purely a style preference.
