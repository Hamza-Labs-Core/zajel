# Review: Plan 014 - Test Coverage for Replay, Rotation, and Race Conditions

**Verdict: NEEDS REVISION**

**Reviewed:** 2026-03-03
**Plan:** `/home/meywd/zajel-ddos/docs/security/implementation-plans/plan-014-security-test-coverage.md`
**Story:** `/home/meywd/zajel-ddos/docs/security/stories/story-014-security-test-coverage.md`

---

## 1. Accuracy

### 1.1 Story Contains a Major Factual Error

The story states:

> A recursive search for test files (`*.test.*`, `*.spec.*`) under `packages/server/` returns zero results. There is no `tests/`, `test/`, or `__tests__/` directory. No test framework configuration (vitest, jest, mocha, etc.) was found in the package.

This is **false**. The codebase already contains **7 test files**:

| File | Type |
|------|------|
| `tests/unit/anomaly-detection.test.js` | Unit |
| `tests/unit/attestation-crypto.test.js` | Unit |
| `tests/unit/build-signing.test.js` | Unit |
| `tests/unit/signing.test.js` | Unit |
| `tests/e2e/attestation.test.js` | E2E |
| `tests/e2e/bootstrap.test.js` | E2E |
| `tests/e2e/integration.test.js` | E2E |

Additionally, vitest is already configured in `package.json` (version `^4.0.16`, not `^2.0.0` as the story suggests), and `vitest.config.js` exists with coverage settings.

The plan partially acknowledges this (its summary mentions "7 existing test files"), but the story's framing as "zero test files" is incorrect and misleads scope estimation.

### 1.2 Vitest Version Mismatch

The story proposes adding `"vitest": "^2.0.0"` to devDependencies. The actual `package.json` already has `"vitest": "^4.0.16"`. This discrepancy is harmless (since vitest already exists) but indicates the story was not written against the actual codebase state.

### 1.3 Source File Line Counts

The story's line count table is mostly accurate:

| File | Story Claims | Actual | Match |
|------|-------------|--------|-------|
| `rate-limiter.js` | 57 | 57 | Yes |
| `index.js` | 174 | 174 | Yes |
| `server-registry-do.js` | 1033 | 1033 | Yes |
| `attestation-registry-do.js` | 1013 | 1014 | Off by 1 |
| `attestation.js` | 270 | 270 | Yes |
| `timing-safe.js` | 33 | 33 | Yes |
| `request-validation.js` | 49 | 49 | Yes |
| `cors.js` | 91 | 91 | Yes |
| `logger.js` | 138 | 138 | Yes |

Minor discrepancy on `attestation-registry-do.js` (1013 vs 1014).

### 1.4 File Paths All Verified

All source file paths referenced in the plan exist:
- `/home/meywd/zajel-ddos/packages/server/src/rate-limiter.js` -- exists
- `/home/meywd/zajel-ddos/packages/server/src/crypto/timing-safe.js` -- exists
- `/home/meywd/zajel-ddos/packages/server/src/utils/request-validation.js` -- exists
- `/home/meywd/zajel-ddos/packages/server/src/cors.js` -- exists
- `/home/meywd/zajel-ddos/packages/server/src/logger.js` -- exists
- `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js` -- exists
- `/home/meywd/zajel-ddos/packages/server/src/durable-objects/attestation-registry-do.js` -- exists
- `/home/meywd/zajel-ddos/packages/server/src/crypto/attestation.js` -- exists

### 1.5 API Signatures Verified Correct

The plan's test code correctly references:
- `RateLimiter.check(ip, limit, windowMs)` returns `{ allowed, remaining }` -- matches source
- `RateLimiter.prune()` -- matches source
- `RateLimiter.counters` (Map) -- matches source
- `timingSafeEqual(a, b)` returns boolean -- matches source
- `parseJsonBody(request, maxSize)` -- matches source
- `BodyTooLargeError` class -- matches source
- `getCorsHeaders(request, env)` -- matches source
- `redactPairingCode(code)` -- matches source
- `createLogger(env)` -- matches source
- `importAttestationSigningKey(hexSeed)` -- matches source
- `signPayloadEd25519(privateKey, payload)` -- matches source
- `computeHmac(data, nonceHex)` -- matches source
- `createSessionToken(signingKey, tokenData)` -- matches source
- `verifySessionToken(publicKey, token)` -- matches source
- `importVerifyKey(base64Key)` -- matches source
- `exportPublicKeyBase64(signingKey)` -- matches source

---

## 2. Bugs in Proposed Test Code

### 2.1 CRITICAL: Build Token Staleness Test Will Fail (Step 7, Lines 1204-1219)

The plan's test uses a timestamp **8 days** in the past:

```javascript
timestamp: Date.now() - (8 * 24 * 60 * 60 * 1000), // 8 days old
```

But `MAX_TOKEN_AGE` in the source is **30 days** (`30 * 24 * 60 * 60 * 1000`). An 8-day-old token would **not** be rejected. The test would fail because `resp.status` would be `200`, not `400`.

Additionally, the assertion `expect(data.error).toContain('Build token timestamp')` does not match the actual error message `'Build token expired'` (line 306 of `attestation-registry-do.js`).

**Fix:** Use `timestamp: Date.now() - (31 * 24 * 60 * 60 * 1000)` (31 days) and change the assertion to `toContain('Build token expired')`.

### 2.2 CRITICAL: Pairing Event Logger Tests Will Fail (Step 6, Lines 917-940)

The `pairingEvent` method calls `this.debug(message, meta)`, which prepends `[DEBUG]`. The plan's assertions expect:

```javascript
expect(consoleSpies.debug).toHaveBeenCalledWith(
  '[Pairing] registered',
  { code: 'A****3' }
);
```

But the actual `console.debug` call will be:

```javascript
console.debug('[DEBUG] [Pairing] registered', { code: 'A****3' })
```

**Fix:** All three `pairingEvent` test assertions need the `[DEBUG] ` prefix added.

### 2.3 MODERATE: Double-Call on Consumed Request Body (Step 4, Lines 518-519)

The plan calls `parseJsonBody(request, 65536)` twice on the same Request:

```javascript
await expect(parseJsonBody(request, 65536)).rejects.toThrow(BodyTooLargeError);
await expect(parseJsonBody(request, 65536)).rejects.toThrow(/exceeds 65536 byte limit/);
```

After the first call, `request.text()` will have consumed the body stream. The second call will get an empty body and throw a `SyntaxError`, not `BodyTooLargeError`. These two assertions need to be merged into one, or separate Request objects created.

### 2.4 LOW: Logger `shouldRedact` Property Assumption

The plan tests `logger.shouldRedact` as a plain property:

```javascript
expect(logger.shouldRedact).toBe(true);
```

In the source, `shouldRedact` is defined as a getter (`get shouldRedact()`). The `expect` assertion will work because it accesses the getter, but the plan's comment about "detecting production environment" via `shouldRedact` could be misleading. This is not a functional issue.

---

## 3. Completeness

### 3.1 Significant Overlap with Existing Tests

Many scenarios the plan proposes to test are **already covered** by existing test files:

| Plan's Proposed Test | Already Covered By |
|---------------------|-------------------|
| Nonce reuse detection | `tests/e2e/attestation.test.js` line 877 |
| Expired nonce rejection | `tests/e2e/attestation.test.js` line 905 |
| Cross-device nonce rejection | `tests/e2e/attestation.test.js` line 928 |
| Build token replay (multiple registrations) | `tests/e2e/attestation.test.js` line 1650 (concurrent) |
| Trusted key CRUD (add/remove/replace) | `tests/unit/build-signing.test.js` lines 392-523 |
| Encrypted key storage | `tests/unit/build-signing.test.js` lines 643-735 |
| Env var fallback for keys | `tests/unit/build-signing.test.js` lines 574-643 |
| AnomalyDetector scenarios | `tests/unit/anomaly-detection.test.js` (comprehensive) |
| Attestation crypto functions | `tests/unit/attestation-crypto.test.js` (comprehensive) |
| Version comparison | `tests/unit/attestation-crypto.test.js` lines 260-295 |
| Session token create/verify/expiry | `tests/unit/attestation-crypto.test.js` lines 194-258 |
| Build signature verification | `tests/unit/build-signing.test.js` lines 99-164 |

The replay attack tests (Step 7) are essentially re-implementations of existing e2e attestation tests. While there is value in having focused security test files for audit purposes, the plan should acknowledge this overlap explicitly and explain the rationale (e.g., isolation from e2e infrastructure, faster execution).

### 3.2 Story Acceptance Criteria Coverage

| Acceptance Criterion | Covered in Plan? |
|---------------------|-----------------|
| vitest configured in package.json | Already done (N/A) |
| `npm run test` runs all tests | Already works |
| Unit tests for rate-limiter, timing-safe, request-validation, cors, logger | Yes (Steps 2-6) |
| Unit tests for AnomalyDetector (5+ scenarios) | Already exists |
| Unit tests for BuildVerifier | Already exists |
| Unit tests for attestation.js crypto functions | Already exists |
| Security test: nonce replay | Yes (Step 7) but already exists in e2e |
| Security test: nonce expiry | Yes (Step 7) but already exists in e2e |
| Security test: cross-device nonce | Yes (Step 7) but already exists in e2e |
| Security test: NaN region_index | Outlined (Step 11) but only abbreviated |
| Security test: ciphertext tampering | Outlined (Step 10) but only abbreviated |
| Security test: empty trusted keys | Partially (via key rotation tests) |
| Integration tests for ServerRegistryDO | Already exists in e2e |
| Integration tests for AttestationRegistryDO | Already exists in e2e |
| Code coverage >80% | Plan targets this but no baseline measurement provided |
| CI pipeline integration | Not addressed in plan |

### 3.3 Missing from Plan

1. **Steps 9-11 are abbreviated** -- The plan provides only outlines for race-conditions, HKDF edge cases, ciphertext-tampering, and NaN-validation tests. These four test files are listed in the plan's file table but lack full implementation code, unlike Steps 1-8. This is a gap -- the plan cannot be implemented as-is for these files.

2. **No unit/integration test directory for crypto** -- The story's "Minimum test file list" includes `tests/unit/crypto/attestation.test.js` and `tests/unit/crypto/signing.test.js`, but these already exist at the top level as `tests/unit/attestation-crypto.test.js` and `tests/unit/signing.test.js`. The plan ignores this structure discrepancy.

3. **No integration test files for DOs** -- The story lists `tests/integration/server-registry-do.test.js` and `tests/integration/attestation-registry-do.test.js` but the plan does not propose creating these (they effectively exist as e2e tests).

4. **CI pipeline integration** -- The story requires "CI pipeline runs server tests as part of `npm run test --workspaces`" but the plan does not address CI configuration.

5. **Anomaly detection security test** -- The story lists `tests/security/anomaly-detection.test.js` in its minimum test file list, but the plan does not include this file in its new test file table.

6. **Version policy security test** -- The story lists `tests/security/version-policy.test.js` but the plan does not include it.

### 3.4 Workspace Name Discrepancy

The plan's success criteria references `npm run test --workspace=zajel-signaling` but the actual package name in `package.json` is `"name": "zajel-signaling"` (no `@zajel/` scope). The story references `npm run test --workspace=@zajel/server`. Neither is correct -- the workspace should be referenced as `zajel-signaling` per the package name.

---

## 4. Risks

### 4.1 Mock Fidelity

The `MockStorage.list()` implementation in the plan defaults `prefix` to `''`, which is correct but differs slightly from the existing test mocks that accept `{ prefix, limit }` without default. The existing mock at `anomaly-detection.test.js` line 41 uses `list({ prefix, limit })` without defaults. The plan's version at line 111 uses `list({ prefix = '', limit } = {})`. While the plan's version is more robust, mixing two MockStorage implementations in the same test suite creates maintenance risk.

The plan's Step 1 (shared mock helpers) is the right idea, but the existing 7 test files would need to be migrated to use the shared helpers, and the plan explicitly does not modify existing files.

### 4.2 Request Body Consumption in Vitest

Multiple tests create a `Request` object and pass it to `parseJsonBody`. In the Node.js/vitest environment, `Request.text()` consumes the body stream. If a test calls `parseJsonBody` twice on the same request (as in bug 2.3 above), the second call will fail unexpectedly. This could also affect the replay attack tests if the `AttestationRegistryDO.fetch()` method reads the body -- but since each test creates a fresh Request, this should be fine for the DO tests.

### 4.3 Fake Timers and Crypto

The plan uses `vi.useFakeTimers()` alongside `crypto.subtle` operations. In some environments, fake timers can interfere with async Web Crypto operations. The existing tests also use this pattern without issue, so the risk is low but worth noting.

### 4.4 Race Condition Tests Are Inherently Unreliable

Step 9 (race-conditions.test.js) attempts to test concurrent access patterns. However, Durable Objects serialize all requests internally -- there are no actual race conditions in a properly functioning DO. The plan can only test concurrent `Promise.all()` calls to the same DO instance, which in the mock environment just execute sequentially via `blockConcurrencyWhile`. These tests would not catch real concurrency bugs; they would only verify that sequential execution produces consistent results.

---

## 5. Recommended Changes

### Must Fix (Blocking)

1. **Fix build token staleness test**: Change timestamp to 31+ days old and assertion to `'Build token expired'`.

2. **Fix pairingEvent test assertions**: Add `[DEBUG] ` prefix to all expected `console.debug` calls in pairingEvent tests.

3. **Fix double parseJsonBody call**: Create separate Request objects for the two assertions, or combine into a single assertion.

4. **Complete Steps 9-11**: Provide full test code for race-conditions, HKDF edge cases, ciphertext-tampering, and NaN-validation, or explicitly mark them as deferred scope.

### Should Fix (Recommended)

5. **Correct the story**: Update the story to acknowledge the 7 existing test files and existing vitest configuration. The scope of this story should be redefined as "fill coverage gaps" rather than "create test infrastructure from scratch."

6. **Deduplicate with existing tests**: Either (a) skip the replay attack tests that duplicate e2e coverage and reference the existing tests, or (b) explicitly document the rationale for having focused security test files alongside e2e tests.

7. **Add missing security test files**: Include `anomaly-detection.test.js` and `version-policy.test.js` from the story's minimum file list, or document why they are excluded (already covered by existing tests).

8. **Fix workspace name**: Use `zajel-signaling` consistently (matching `package.json`).

### Nice to Have

9. **Migrate existing mocks**: Plan a follow-up to migrate existing test files to use the shared `mock-do.js` helpers to reduce duplication.

10. **Add baseline coverage measurement**: Before implementing, run `vitest --coverage` to establish a baseline. The plan targets >80% without knowing the current level.

11. **Address CI integration**: Add a step for verifying that the new test directories are picked up by the existing `vitest.config.js` include pattern (`tests/**/*.test.js`). The current config already covers this, so just verify it in the plan.
