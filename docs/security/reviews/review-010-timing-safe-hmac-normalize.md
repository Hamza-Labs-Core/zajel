# Review: Plan 010 - HMAC-Normalize Timing-Safe Comparison

**Verdict: NEEDS REVISION**

The HMAC-based approach is cryptographically sound, and the core implementation code is correct. However, the plan has a critical gap: it identifies only 2 of the 6 actual call sites for `verifyServerAuth`/`verifyCIAuth` in `fetch()` and related methods, and references a non-existent endpoint. Deploying the plan as-written would break 4 auth-protected endpoints at runtime.

---

## Accuracy

### File paths: PASS

All referenced source files exist at the stated paths:

- `/home/meywd/zajel-ddos/packages/server/src/crypto/timing-safe.js` -- exists
- `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js` -- exists
- `/home/meywd/zajel-ddos/packages/admin-cf/src/crypto.ts` -- exists
- `/home/meywd/zajel-ddos/packages/server-vps/src/admin/auth.ts` -- exists (referenced in story only)

### Line numbers and code snippets

| Reference | Claimed | Actual | Status |
|-----------|---------|--------|--------|
| `timing-safe.js` function body | lines 1-33 (plan), 11-33 (story) | lines 1-33 (full file) | PASS -- both are correct scoping |
| `timing-safe.js` early return | line 25 (plan summary) | line 25 (`return false`) | PASS |
| `verifyServerAuth` definition | lines 340-351 (plan) / line 350 (story) | lines 339-351 (with JSDoc), function at 346, timingSafeEqual call at 350 | PASS (minor: plan says 340, JSDoc starts at 339) |
| `verifyCIAuth` definition | lines 353-362 (plan) / line 361 (story) | lines 353-362, timingSafeEqual call at 361 | PASS |
| POST /servers auth check | line 376 (plan) | line 376 | PASS |
| admin-cf `timingSafeEqual` | lines 207-214 (plan) | lines 207-214 | PASS |
| admin-cf `verifyPassword` | lines 52-59 (plan) | lines 52-59 | PASS |
| admin-cf `verifyPassword` call to `timingSafeEqual` | line 58 (story) | line 58 | PASS |
| VPS admin `timingSafeEqual` import | line 8 (story) | line 8 | PASS |
| VPS admin length check + compare | lines 40-43 (story) | lines 40-42 | PASS |

All "Before" code snippets in the plan match the actual source verbatim.

### Non-existent endpoint: FAIL

The plan references `POST /ci/build-tokens` at "around line 389" as the second `await` location. **This endpoint does not exist** in `server-registry-do.js`. Line 389 is actually within the response body of the POST /servers handler. The actual endpoint at that vicinity is `DELETE /servers/:serverId` at line 391. The `/ci/build-tokens` endpoint appears to be fabricated.

---

## Completeness

### CRITICAL: Missed call sites for `verifyServerAuth` and `verifyCIAuth`

The plan identifies **2 call sites** to update with `await`:
1. Line 376: `POST /servers` -- `verifyServerAuth`
2. Line 389: `POST /ci/build-tokens` (non-existent) -- `verifyCIAuth`

The actual codebase has **6 call sites** that must be updated:

| Line | Endpoint | Method Called | In Plan? |
|------|----------|-------------|----------|
| 376 | `POST /servers` | `verifyServerAuth` | YES |
| 392 | `DELETE /servers/:serverId` | `verifyServerAuth` | NO |
| 418 | `POST /servers/heartbeat` | `verifyServerAuth` | NO |
| 429 | `GET /servers/anomalies` | `verifyServerAuth` | NO |
| 905 | `setTrustedKeys()` (POST /servers/trusted-keys) | `verifyCIAuth` | NO |
| 994 | `getTrustedKeys()` (GET /servers/trusted-keys) | `verifyCIAuth` | NO |

Missing `await` on any of these will cause the auth check to always evaluate to truthy (a Promise object is truthy), effectively **bypassing authentication** on those endpoints. This is a security regression worse than the timing leak being fixed.

The plan's step 3.4 does include a note to "search the entire file for all usages" and provides a `grep` command, which is good. But the explicit enumeration is wrong and incomplete, which is dangerous if an implementer follows the explicit steps rather than the advice to grep.

### Story acceptance criteria coverage

| Acceptance Criterion | Covered in Plan? | Covered in Tests? |
|---------------------|------------------|-------------------|
| No early return on length mismatch | YES (HMAC approach) | YES (different-length test) |
| Constant time regardless of input lengths | YES | YES (timing test) |
| No minimum length leakage | YES | YES (timing test) |
| HMAC normalization used | YES | Implicit (implementation, not tested directly) |
| All callers updated for async | PARTIALLY (4 of 6 missed) | NO (no integration test for all endpoints) |
| `verifyServerAuth` and `verifyCIAuth` await correctly | PARTIALLY | NO (no unit test for auth methods) |
| admin-cf `timingSafeEqual` updated | YES | YES (smoke test via verifyPassword) |
| admin-cf `verifyPassword` works | YES | YES |
| XOR loop not optimizable away | YES (HMAC values used in return) | Not directly testable |
| Unit tests pass | YES | YES |
| Timing test passes | YES | YES |
| Integration tests verify auth | PARTIALLY (manual curl examples but incomplete) | NO automated integration test |

### Story test requirements coverage

| Story Test Requirement | Covered? |
|----------------------|----------|
| Equal strings return true | YES |
| Different strings, equal length, return false | YES |
| Different strings, different lengths, return false | YES |
| Empty strings return true | YES |
| One empty, one non-empty returns false | YES |
| Timing test (1000 comparisons, no statistical difference) | YES |
| `verifyServerAuth` accepts valid / rejects invalid (regression) | NO -- not in any test file |
| `verifyCIAuth` accepts valid / rejects invalid (regression) | NO -- not in any test file |
| `verifyPassword` accepts valid / rejects invalid (regression) | YES (admin-cf crypto.test.ts) |

The story explicitly requires regression unit tests for `verifyServerAuth` and `verifyCIAuth`. The plan's test files do not include these. The plan mentions manual curl tests in the "Integration Tests" section but provides no automated tests for these methods.

---

## Risks

### 1. Authentication bypass from missed `await` (CRITICAL)

If any of the 4 missed call sites are not updated, the Promise returned by the now-async `verifyServerAuth`/`verifyCIAuth` will be truthy regardless of the actual auth result. This means:
- `DELETE /servers/:serverId` would allow unauthenticated server deletion
- `POST /servers/heartbeat` would allow unauthenticated heartbeats
- `GET /servers/anomalies` would expose anomaly data without auth
- `POST /servers/trusted-keys` and `GET /servers/trusted-keys` would allow unauthenticated key management

This is strictly worse than the timing leak being patched.

### 2. Statistical timing test flakiness (LOW)

The plan acknowledges this. The 2-standard-deviation threshold with 1000 iterations is reasonable but may produce false failures on CI. The 30-second timeout is appropriate. Consider marking as `{ retry: 3 }` in vitest to reduce flakiness impact.

### 3. Performance overhead of HMAC per auth check (LOW)

Each auth check now requires: 1 `importKey` + 2 `sign` operations. On Cloudflare Workers, Web Crypto operations are fast (sub-millisecond). The plan correctly notes this. For endpoints like `POST /servers/heartbeat` called every few minutes per server, the overhead is negligible.

### 4. admin-cf unit test environment (LOW)

The admin-cf vitest config does not specify a `miniflare` or Cloudflare Workers-like environment. The new unit tests use `crypto.subtle` (Web Crypto API) which requires either Node 20+ (with webcrypto global) or a CF Workers runtime. The existing E2E tests run against a live deployment so this hasn't been an issue. The plan does not address whether `vitest` will have access to `crypto.subtle` in the unit test runner. If the test runner is plain Node.js, `crypto.subtle` is available as a global since Node 20, but `crypto.getRandomValues` in the source code requires the web crypto polyfill or Node 20+ where `crypto` is global. This should be verified.

### 5. `void dummy` concern is overstated (INFORMATIONAL)

The story and plan claim `void dummy` is insufficient to prevent dead-code elimination. While `void dummy` is indeed a weak hint, in practice V8's optimizer is unlikely to eliminate the loop because the loop has a side effect (reading from `bufA` and `bufB` arrays, which are aliased ArrayBuffer views). The real issue is the early `return false` and `minLen` iteration, not dead-code elimination. The HMAC approach solves both, so this is moot, but the claim about `void dummy` being insufficient is somewhat theoretical.

---

## Recommended Changes

### Must Fix (before implementation)

1. **Enumerate all 6 call sites explicitly** in Section 3.4. Add the 4 missing locations:
   - Line 392: `DELETE /servers/:serverId` (`verifyServerAuth`)
   - Line 418: `POST /servers/heartbeat` (`verifyServerAuth`)
   - Line 429: `GET /servers/anomalies` (`verifyServerAuth`)
   - Lines 905 and 994: `setTrustedKeys()` and `getTrustedKeys()` (`verifyCIAuth`) -- these are in separate methods, not in `fetch()` directly, but are still callers that need `await`

2. **Remove the non-existent `/ci/build-tokens` reference** from Section 3.4 and replace with the actual endpoints.

3. **Add automated regression tests for `verifyServerAuth` and `verifyCIAuth`** as required by the story. These can be added to the existing server unit test suite. Example approach: extract the auth methods to be testable, or test via the DO fetch handler with mock env/storage.

### Should Fix

4. **Add a linting or grep step** to the implementation checklist that verifies no un-awaited calls remain. For example:
   ```bash
   grep -n 'verifyServerAuth\|verifyCIAuth' server-registry-do.js | grep -v 'await'
   ```
   This should be empty after implementation. The plan mentions grep in passing but does not include it as a verification step.

5. **Verify admin-cf unit test runtime** has access to `crypto.subtle`. Add a note about Node.js version requirement or add `@cloudflare/vitest-pool-workers` if needed.

6. **Update the integration test section** (4.2) to cover all 6 protected endpoints, not just `POST /servers` and the non-existent `POST /ci/build-tokens`.

### Nice to Have

7. **Add `{ retry: 3 }` to the statistical timing test** to reduce CI flakiness.

8. **Consider exporting `timingSafeEqual` from admin-cf** for direct unit testing rather than relying solely on smoke tests through `verifyPassword`.

---

## Summary Table

| Aspect | Rating |
|--------|--------|
| Cryptographic approach | Sound |
| Core implementation code | Correct |
| File path accuracy | Correct |
| Line number accuracy | Correct (with minor discrepancies) |
| Call site enumeration | **Incomplete -- 4 of 6 missed** |
| Endpoint references | **1 non-existent endpoint cited** |
| Test coverage of acceptance criteria | Partial (missing auth regression tests) |
| Risk analysis | Adequate (but misses the biggest risk: missed await = auth bypass) |
| Rollback plan | Adequate |

**Reviewer:** Claude Opus 4.6
**Date:** 2026-03-03
