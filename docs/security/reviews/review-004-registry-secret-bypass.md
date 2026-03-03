# Review 004: Fix SERVER_REGISTRY_SECRET Auth Bypass

**Plan:** `docs/security/implementation-plans/plan-004-registry-secret-bypass.md`
**Story:** `docs/security/stories/story-004-registry-secret-bypass.md`
**Reviewer:** Claude Opus 4.6
**Date:** 2026-03-03

---

## Verdict: NEEDS REVISION

The core fix is correct: replacing the fail-open `if (this.env.SERVER_REGISTRY_SECRET && !this.verifyServerAuth(request))` pattern with a `requireServerAuth()` helper that returns 503 when the secret is unconfigured is the right approach. The vulnerability analysis is thorough and the code snippets match the actual source. However, the plan has a **critical omission**: it only accounts for updating `integration.test.js` but ignores **three additional test files** that will break, collectively containing ~80+ tests. Without addressing these, the PR will have a broken test suite.

---

## 1. Accuracy

### 1.1 File Paths -- PASS

All referenced source files exist at their stated paths:

| Path | Exists |
|------|--------|
| `packages/server/src/durable-objects/server-registry-do.js` | Yes |
| `packages/server/tests/e2e/integration.test.js` | Yes |
| `packages/server/tests/unit/server-registry-auth.test.js` | Does not exist yet (proposed new file) |

### 1.2 Line Numbers -- PASS

All line number references in both the plan and story are accurate against the current source:

| Reference | Claimed Line(s) | Actual Line(s) | Status |
|-----------|-----------------|-----------------|--------|
| `verifyServerAuth()` | 346-351 | 346-351 | Match |
| `POST /servers` auth check | 376 | 376 | Match |
| `DELETE /servers/:id` auth check | 392 | 392 | Match |
| `POST /servers/heartbeat` auth check | 418 | 418 | Match |
| `GET /servers/anomalies` auth check | 429 | 429 | Match |
| `unregisterServer()` secondary auth | 677-691 | 677-691 | Match |
| `DEV_MODE` usage | 495 | 495 | Match |
| `CI_UPLOAD_SECRET` correct pattern | 898-903 | 898-903 | Match |
| Story 002 `keyTrusted` in `registerServer` | 586 | 586 | Match |
| Story 002 `keyTrusted` in `heartbeat` | 751 | 751 | Match |

### 1.3 Code Snippets -- PASS

All "Before" code snippets in the plan match the actual source verbatim. The vulnerability pattern `if (this.env.SERVER_REGISTRY_SECRET && !this.verifyServerAuth(request))` is confirmed at all four locations. The `unregisterServer()` secondary auth block at lines 677-691 also matches exactly.

### 1.4 `verifyCIAuth` Pattern Reference -- PASS

The story correctly notes that the `CI_UPLOAD_SECRET` auth pattern at lines 898-903 in `setTrustedKeys()` already uses the correct fail-closed approach (returning 503 when unconfigured). The proposed fix mirrors this pattern.

---

## 2. Completeness

### 2.1 All Vulnerable Endpoints Covered -- PASS

The plan addresses all four vulnerable auth checks:
- `POST /servers` (line 376)
- `DELETE /servers/:id` (line 392)
- `POST /servers/heartbeat` (line 418)
- `GET /servers/anomalies` (line 429)

Plus the secondary auth path in `unregisterServer()` (lines 677-691).

A grep for `SERVER_REGISTRY_SECRET` in the source confirms no other occurrences exist beyond lines 340, 348, 350, 376, 392, 418, 429, 677, and 680. The plan covers all mutable uses.

### 2.2 Proposed `requireServerAuth()` Helper -- PASS

The helper method is well-designed:
- Returns 503 when secret is unconfigured (fail-closed)
- Returns 401 when credentials are missing or wrong
- Returns `null` on success (caller checks for error response)
- Includes audit logging with `[audit]` prefix, method, path, and IP
- Preserves CORS headers in error responses
- Placement after `verifyServerAuth()` is clean and logical

### 2.3 Test Coverage of Acceptance Criteria -- PASS WITH NOTES

The proposed unit tests cover all acceptance criteria from the story:

| Acceptance Criterion | Test Coverage |
|---------------------|---------------|
| `POST /servers` returns 503 without secret | Covered |
| `DELETE /servers/:id` returns 503 without secret | Covered |
| `POST /servers/heartbeat` returns 503 without secret | Covered |
| `GET /servers/anomalies` returns 503 without secret | Covered |
| All endpoints work with correct auth | Covered |
| All endpoints return 401 with wrong/no auth | Covered |
| `unregisterServer()` secondary auth fixed | Covered (indirectly via DELETE 503) |
| `GET /servers` remains public | Covered |
| Audit log on unconfigured auth | Not tested (would require asserting `console.warn` calls) |
| DEV_MODE escape hatch | Not tested (marked optional in plan) |

**Note:** The audit log acceptance criterion (AC #9 in story) is not explicitly tested. Consider adding a test that spies on `console.warn` and verifies the `[audit]` log message is emitted.

### 2.4 Existing Test Breakage -- FAIL (Critical Omission)

The plan acknowledges that `integration.test.js` tests will break and provides update instructions. However, it **fails to mention three additional test files** that also instantiate `ServerRegistryDO` with an empty env (`{}`) and call protected endpoints:

| Test File | Instances of `ServerRegistryDO(mockState, {})` | Calls Protected Endpoints | Test Count |
|-----------|------------------------------------------------|--------------------------|------------|
| `tests/e2e/integration.test.js` | 1 (line 162) | Yes | ~15 tests |
| `tests/e2e/bootstrap.test.js` | 1 (line 128) | Yes (`POST /servers`, `POST /servers/heartbeat`, `DELETE /servers/:id`) | ~36 tests |
| `tests/unit/build-signing.test.js` | 13 instances | Yes (`POST /servers`, `POST /servers/heartbeat`) | ~33 tests |
| `tests/unit/anomaly-detection.test.js` | 1 (line 113) | Yes (`POST /servers`, `POST /servers/heartbeat`) | ~20 tests |

None of these files set `SERVER_REGISTRY_SECRET` in their env objects. All tests that call `POST /servers`, `POST /servers/heartbeat`, or `DELETE /servers/:id` will start returning 503 instead of 200, causing widespread test failures.

Additionally, `tests/unit/signing.test.js` (line 156) and `tests/e2e/attestation.test.js` (line 1139) instantiate the DO with `{}`, but they do not appear to call protected server registry endpoints, so they should be unaffected.

**The plan must include update instructions for all four affected test files**, not just `integration.test.js`. Each needs either:
1. `SERVER_REGISTRY_SECRET` added to the env, AND
2. `Authorization` headers added to all requests hitting protected endpoints

### 2.5 Helper Function Updates -- INCOMPLETE

The plan provides updated `registerServer()`, `sendHeartbeat()`, and `unregisterServer()` helper functions for `integration.test.js`. However:

- `bootstrap.test.js` has its own separate helper functions and `createRequest` helper (confirmed at lines 109-178) that also need updating.
- `build-signing.test.js` uses inline `createRequest('POST', '/servers', ...)` calls throughout -- each call site needs an auth header, or the test-local `createRequest` helper needs modification.
- `anomaly-detection.test.js` uses its own `registerServer()` and `sendHeartbeat()` helpers (confirmed via grep) that also need auth headers.

---

## 3. Risks

### 3.1 Rollback Strategy -- ADEQUATE

The plan's rollback procedure (wrangler rollback + emergency DEV_MODE) is reasonable. The pre-deployment checklist is thorough.

### 3.2 DEV_MODE Escape Hatch -- LOW RISK

The plan correctly marks the DEV_MODE bypass as optional and clearly insecure. The decision to omit it by default is appropriate. If included, the risk is minimal since DEV_MODE is an explicit opt-in that requires deliberate configuration.

### 3.3 Merge Conflict with Story 002 -- ACKNOWLEDGED

The plan correctly identifies that Stories 002 and 004 modify the same file and recommends implementing 004 first. The merge conflict risk assessment is accurate.

### 3.4 Route Ordering Risk -- NONE

The `DELETE /servers/:serverId` route uses `url.pathname.startsWith('/servers/')` which could theoretically match `/servers/heartbeat` or `/servers/anomalies`, but since the POST and GET methods are checked first, and DELETE only matches the DELETE method, there is no ambiguity. The plan does not introduce any routing changes.

### 3.5 `timingSafeEqual` Not Called on Unconfigured Secret -- CORRECT

The new `requireServerAuth()` returns 503 before ever calling `verifyServerAuth()` when the secret is unconfigured. This avoids the redundant `verifyServerAuth()` call that would also return `false`. The method chain is clean: 503 for unconfigured, then delegate to `verifyServerAuth()` for credential checking.

---

## 4. Recommended Changes

### 4.1 REQUIRED: Document All Affected Test Files

Add update instructions for the following test files (same pattern as the `integration.test.js` section):

1. **`packages/server/tests/e2e/bootstrap.test.js`** -- Add `SERVER_REGISTRY_SECRET` to env at line 128; update all request helpers to include `Authorization` headers.

2. **`packages/server/tests/unit/build-signing.test.js`** -- Add `SERVER_REGISTRY_SECRET` to all 13 `ServerRegistryDO(mockState, {})` instantiations that reach protected endpoints; update `createRequest` calls with auth headers.

3. **`packages/server/tests/unit/anomaly-detection.test.js`** -- Add `SERVER_REGISTRY_SECRET` to env at line 113; update `registerServer()` and `sendHeartbeat()` helpers.

This is the only blocking issue. Without this, the implementation will produce a broken test suite.

### 4.2 RECOMMENDED: Add Audit Log Assertion Tests

Add at least one test that verifies the `[audit]` log message is emitted when a request hits an unconfigured endpoint. This directly maps to acceptance criterion #9 in the story. Example:

```javascript
it('should emit audit log when SERVER_REGISTRY_SECRET is not configured', async () => {
  const warnSpy = vi.spyOn(console, 'warn');
  const registry = new ServerRegistryDO(new MockState(), {});

  await registry.fetch(createRequest('POST', '/servers', { ... }));

  expect(warnSpy).toHaveBeenCalledWith(
    expect.stringContaining('[audit]'),
    expect.objectContaining({ action: 'auth_unconfigured' })
  );
  warnSpy.mockRestore();
});
```

### 4.3 RECOMMENDED: Clarify Step 6 Defense-in-Depth Rationale

The Step 6 change to `unregisterServer()` is correct, but the comment says "This method should only be reached if auth passed in fetch()". After the fix, this is true -- the fetch-level guard will already return 503 for unconfigured secrets. The defense-in-depth block will therefore be dead code under normal execution. Consider adding a brief note in the plan acknowledging this is intentionally dead code for safety, to avoid a future maintainer removing it thinking it's unnecessary.

### 4.4 OPTIONAL: Consider a Shared Auth Test Helper

Given that four test files all need the same auth plumbing, consider extracting a shared test utility:

```javascript
// tests/helpers/auth-helpers.js
export const TEST_REGISTRY_SECRET = 'test-registry-secret';

export function createAuthenticatedRequest(method, path, body = null) {
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TEST_REGISTRY_SECRET}`,
    },
  };
  if (body) options.body = JSON.stringify(body);
  return new Request(`https://test.workers.dev${path}`, options);
}
```

This would reduce duplication and make future auth changes easier.

---

## 5. Summary Table

| Category | Status |
|----------|--------|
| File paths | PASS |
| Line numbers | PASS |
| Code snippets | PASS |
| Fix correctness | PASS |
| New helper method | PASS |
| Unit test plan | PASS |
| Integration test plan | PASS |
| Existing test breakage analysis | **FAIL -- missing 3 of 4 affected test files** |
| Acceptance criteria coverage | PASS WITH NOTES (audit log not tested) |
| Rollback plan | PASS |
| Risk assessment | PASS |
| Deployment ordering | PASS |

**Bottom line:** The security fix itself is sound and well-designed. The plan needs one revision: expand the test update section to cover `bootstrap.test.js`, `build-signing.test.js`, and `anomaly-detection.test.js`. Once those are addressed, this is ready to implement.
