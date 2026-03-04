# Review: Plan 007 - Remove JWT Tokens from URL Query Parameters

**Reviewer**: Claude Opus 4.6
**Date**: 2026-03-03
**Plan**: `/home/meywd/zajel-ddos/docs/security/implementation-plans/plan-007-jwt-token-in-url.md`
**Story**: `/home/meywd/zajel-ddos/docs/security/stories/story-007-jwt-token-in-url.md`

---

## Verdict: PASS WITH NOTES

The plan is thorough, well-structured, and addresses the security vulnerability correctly. The authorization code exchange pattern is sound and follows OAuth 2.0 conventions. However, there are several inaccuracies in line number references, a significant issue with the E2E test code, and a few architectural concerns that should be addressed before implementation.

---

## 1. Accuracy

### 1.1 File Path Verification

All referenced source files exist:

| File | Exists |
|------|--------|
| `packages/admin-cf/src/types.ts` | YES |
| `packages/admin-cf/src/admin-users-do.ts` | YES |
| `packages/admin-cf/src/index.ts` | YES |
| `packages/server-vps/src/admin/routes.ts` | YES |
| `packages/server-vps/src/admin/auth.ts` | YES |
| `packages/server-vps/src/config.ts` | YES |
| `packages/admin-cf/src/routes/auth-code.ts` | NEW FILE (correct) |
| `packages/admin-cf/tests/e2e/admin-e2e.test.ts` | YES |
| `packages/admin-cf/tests/e2e/helpers.ts` | YES |
| `packages/server-vps/tests/unit/admin-auth-code.test.ts` | NEW FILE (correct) |
| `packages/admin-cf/tests/unit/auth-code.test.ts` | NEW FILE (noted in Section 2 table but never implemented in the plan) |

The `routes` directory at `packages/admin-cf/src/routes/` exists and already contains `auth.ts`, `index.ts`, `servers.ts`, `users.ts`, confirming the new `auth-code.ts` file fits the existing structure.

### 1.2 Line Number and Code Snippet Verification

**types.ts** (Step 1.1):
- Plan says `ApiResponse` is at "line 96". Actual: `ApiResponse` interface spans lines 92-96, with the closing brace `}` on line 96. The "Before" snippet matches the actual source. **ACCURATE**.

**admin-users-do.ts** (Step 1.2):
- Plan says "Before (line 60)" shows the `/init` route and the 404 handler. Actual: The `/init` route is at lines 62-64 and the 404 is at line 66. The plan says "lines 60-66" but the actual code has additional routes between line 57-61 (the `/users/:id DELETE` handler). The "Before" snippet in the plan is **INACCURATE** -- it skips the `/users/:id DELETE` handler that sits at lines 57-60. The snippet shows:
  ```
  if (path === '/init' && method === 'POST') {
    return this.handleInit(request);
  }

  return this.jsonResponse({ success: false, error: 'Not found' }, 404);
  ```
  This matches lines 62-66 in the actual file, not "line 60" as stated.

- Plan says "Add before `handleInit` method (after line 75)". Actual: The `handleInit` method starts at line 79. Line 75 is the end of the `catch` block in the `fetch` method. The new code should be added as new methods in the class, after the `fetch` method's routing block. **MINOR INACCURACY** in line number, but intent is clear.

- Plan says to add `generateJwt` import. The actual `admin-users-do.ts` already imports `generateJwt` at line 13. **No change needed** for that import. The plan only needs to add `AuthCode` to the type imports, which is correctly noted.

**index.ts** (Steps 1.4, 1.5):
- Plan says "Before (line 10)" for imports. Actual: Line 10 is `import type { Env } from './types.js';`, lines 11-13 have the remaining imports. **ACCURATE**.

- Plan says "Before (line 92)" for the servers route. Actual: Line 92 is `} else if (path === '/admin/api/servers' && method === 'GET') {`. Line 94 is `} else if (path.startsWith('/admin/api/')) {`. **ACCURATE**.

- Plan says "Before (lines 710-716)" for `openVpsDashboard()`. Actual: `openVpsDashboard` is at lines 710-716. The code snippet **MATCHES** exactly. **ACCURATE**.

- Plan says "Before (lines 545-557)" for the post-verify redirect. Actual: Lines 544-557 contain this block. The code at line 552 reads `url.searchParams.set('token', state.token);`. **ACCURATE** (off by 1 on start line, content matches).

- Plan says "Before (lines 625-638)" for the post-login redirect. Actual: Lines 625-638. The code at lines 631-635 does `url.searchParams.set('token', state.token);`. **ACCURATE**.

**routes.ts** (Step 2.1):
- Plan says "Before (lines 41-64)". Actual: Lines 41-64 contain the `?token=` handling block, `serveDashboard` call, and `return true`. **ACCURATE**.

**auth.ts** (Step 2.2):
- Plan says "Before (lines 65-89)" for `extractToken`. Actual: `extractToken` spans lines 65-89. The code snippet **MATCHES** exactly. **ACCURATE**.
- Plan says "Remove lines 72-77". Actual: Lines 72-77 are the query parameter check block. **ACCURATE**.

### 1.3 Story Line Number Cross-Check

The story references:
- `index.ts:715` for `openVpsDashboard()`. Actual: Line 715. **ACCURATE**.
- `index.ts:550-554` for post-verify redirect. Actual: Lines 550-554 match. **ACCURATE** (though the `if` condition starts at line 551, `url.searchParams.set` is on line 552).
- `index.ts:631-635` for post-login redirect. Actual: The `if` block with `url.searchParams.set('token', ...)` is at lines 631-635. **ACCURATE**.
- `routes.ts:42-64` for VPS token handling. **ACCURATE**.
- `auth.ts:72-77` for query param extraction. **ACCURATE**.
- `auth.ts:65-89` for full `extractToken`. **ACCURATE**.
- `routes.ts:777` for VPS redirect to CF admin. Actual: The VPS `getDashboardHtml` function contains `CF_ADMIN_URL + '/admin/?redirect=' + returnUrl` at line 777 of `routes.ts`. **ACCURATE**.

---

## 2. Completeness

### 2.1 Acceptance Criteria Coverage

| Acceptance Criterion | Covered in Plan | Covered in Tests |
|---------------------|----------------|-----------------|
| JWT tokens never in URL query params | YES (Step 1.5, 2.1) | Partially (manual checklist) |
| 30-second TTL authorization codes | YES (Step 1.3) | YES (expiry test) |
| Server-to-server back-channel exchange | YES (Step 2.1) | YES (E2E exchange test) |
| Single-use code invalidation | YES (Step 1.2) | YES (reuse test) |
| Expired codes rejected | YES (Step 1.2) | YES (expiry test) |
| `extractToken()` no longer reads query params | YES (Step 2.2) | NO -- **MISSING** unit test |
| `openVpsDashboard()` uses auth code | YES (Step 1.5) | Partially (manual only) |
| Redirect flow uses auth codes | YES (Step 1.5) | Partially (manual only) |
| Browser history clean | YES (implicit) | Manual checklist only |
| VPS logs clean | YES (implicit) | Manual checklist only |
| Existing cookie auth continues | YES (unchanged) | Not explicitly tested |

**Missing test**: The story requires a unit test for "`extractToken()` no longer returns tokens from query parameters." The plan's test section mentions it in Section 4.1 but it is not implemented in the test code (Step 3.2). The VPS unit test file (`admin-auth-code.test.ts`) only tests the fetch mock, not the actual `extractToken()` function.

### 2.2 Test Implementation Issues

**Critical: E2E tests use `client.fetch()` which does not exist.**
The proposed E2E tests in Step 3.1 call `client.fetch('/admin/api/auth/code', ...)`. The `AdminApiClient` class in `helpers.ts` does NOT have a `fetch()` method. It has specific methods like `login()`, `verify()`, `rawGet()`, `rawRequest()`, etc. The tests will fail to compile.

**Fix needed**: Either:
1. Add a generic `fetch(path, options)` method to `AdminApiClient`, or
2. Rewrite the E2E tests to use `fetch()` directly with `client['baseUrl']` as existing tests do (e.g., lines 126, 139, 152 of the existing E2E test file).

**VPS unit tests are superficial.** The `admin-auth-code.test.ts` file mocks `global.fetch` and tests that the mock works, which proves nothing about the actual VPS route handler. The tests should instantiate or test the actual `AdminRoutes.handleRequest()` method with the new code exchange logic, verifying:
- A request with `?code=` triggers the exchange flow
- A request with `?token=` is NOT handled (old behavior removed)
- Failed exchange redirects to CF admin

### 2.3 Missing Unit Test File

Section 2.3 of the plan lists `packages/admin-cf/tests/unit/auth-code.test.ts` as a new file, but no implementation is provided. The `packages/admin-cf/tests/` directory currently only has an `e2e/` subdirectory, so a `unit/` directory would need to be created. The plan body never provides the content for this file.

---

## 3. Risks

### 3.1 Exchange Endpoint Has No Authentication

The `/admin/api/auth/exchange` endpoint is unauthenticated (by design, since VPS servers call it server-to-server). However, this means **anyone** can attempt to exchange codes. The only protection is:
- Code is 32 bytes (64 hex chars) -- computationally infeasible to brute force in 30 seconds
- Codes are single-use and expire in 30 seconds

This is acceptable given the entropy (256 bits) and short TTL, but the plan should explicitly note this as a deliberate design decision and mention that rate limiting on the exchange endpoint would be a defense-in-depth measure.

### 3.2 `handleExchangeAuthCode` in DO Calls `generateJwt` But env Type is Narrow

The `AdminUsersDO` class declares `env` as `{ ZAJEL_ADMIN_JWT_SECRET: string }` (line 27). The `handleExchangeAuthCode` method in the plan calls `generateJwt(..., this.env.ZAJEL_ADMIN_JWT_SECRET, 240)`. This works because `ZAJEL_ADMIN_JWT_SECRET` is available on `this.env`. **No issue here.**

### 3.3 Race Condition: Mark-as-Used vs Delete

In `handleExchangeAuthCode`, the plan checks `authCode.used` and then immediately deletes the code. However, between the `storage.get` and `storage.delete`, two concurrent exchange requests could both read the code as unused. Durable Objects handle this because they are single-threaded and only process one request at a time -- concurrent requests are serialized by the DO runtime. **No actual risk**, but worth noting as a correctness dependency on DO semantics.

### 3.4 No Transition Period

Open Question 4 in the plan recommends NO legacy `?token=` support during transition. However, the staged deployment strategy (Section 5.4) describes deploying CF admin first, then VPS later. During the window between steps 2 and 3:
- CF admin sends `?code=` parameters
- VPS still expects `?token=` parameters

This means VPS dashboards will fail to authenticate during the transition. The plan's deployment strategy contradicts the "no legacy support" recommendation. Either:
1. Deploy both simultaneously, or
2. Add temporary `?token=` fallback support on VPS during transition (handle both `?code=` and `?token=`)

### 3.5 `openVpsDashboard` Becomes Async but Event Listener Is Sync

The plan changes `openVpsDashboard` from sync to `async`, but the event listener at line 922 calls it synchronously:
```javascript
if (server) openVpsDashboard(server);
```
This still works in JavaScript (the returned promise is simply ignored), but any errors from the async function will become unhandled promise rejections rather than being caught by the click handler. The plan's implementation does have `try/catch` inside the async function, so errors are handled, but the `alert()` calls inside the catch blocks rely on the user seeing them. **Low risk**, acceptable.

### 3.6 Post-Verify and Post-Login Redirect Code Generation Failures Are Silent

In the updated post-verify redirect (lines 545-537 in the plan), if code generation fails, the plan falls through to normal dashboard load with `console.warn()`. This is a reasonable degradation, but the user will see the CF admin dashboard instead of being redirected to the VPS. This could be confusing. Consider showing a user-facing message.

---

## 4. Recommended Changes

### 4.1 Must Fix

1. **Fix E2E test code to not use `client.fetch()`**. The `AdminApiClient` class does not have a `fetch()` method. Either add one to the helper class or use raw `fetch()` calls as the existing tests do.

2. **Add the missing `extractToken()` unit test**. The story's acceptance criteria explicitly require verifying that `extractToken()` no longer accepts tokens from query parameters. Add a test in the VPS unit test file that constructs a mock `IncomingMessage` with a `?token=` query parameter and asserts `extractToken()` returns `null`.

3. **Fix the deployment transition gap**. The staged deployment strategy (CF admin first, VPS later) will cause authentication failures during the transition window. Either:
   - Deploy simultaneously, or
   - Have VPS temporarily accept both `?code=` and `?token=` during the transition, then remove `?token=` in a follow-up deployment.

4. **Provide implementation for `packages/admin-cf/tests/unit/auth-code.test.ts`**. It is listed in Section 2.3 but never implemented in the plan body.

### 4.2 Should Fix

5. **Rewrite VPS unit tests to test actual route handler logic**, not just mock fetch calls. The current `admin-auth-code.test.ts` only tests that `global.fetch` works with a mock, which has no value. Test the `AdminRoutes` class behavior with `?code=` parameters.

6. **Add rate limiting to the `/admin/api/auth/exchange` endpoint**. While the 256-bit code entropy makes brute force infeasible, rate limiting is a defense-in-depth measure. The plan mentions this in Open Question 2 but only for code generation, not exchange.

7. **Fix the minor line number inaccuracy in Step 1.2**. The "Before (line 60)" reference for `admin-users-do.ts` should say "lines 62-66" to accurately point at the `/init` route and 404 handler.

### 4.3 Nice to Have

8. **Consider PKCE-style code_verifier/code_challenge** if additional protection against code interception is desired. The current 256-bit random code with 30-second TTL and single-use is likely sufficient for this use case.

9. **Add structured logging** (as described in Section 8.2) to the implementation code itself, not just as a monitoring plan. The current implementation code lacks the log messages described in the monitoring section.

10. **Consider the Durable Object alarm collision risk**. The `setAlarm` call overwrites any previously set alarm. If multiple codes are generated in rapid succession, only the last alarm will fire. The `alarm()` handler does clean up all expired codes, so this is acceptable -- but it means expired codes may persist slightly longer than the 35-second target if no new codes are generated after them. This is a minor concern since the codes are checked for expiration on exchange regardless.

---

## Summary

The plan is well-researched, correctly identifies all three locations where JWTs appear in URLs, and proposes a sound OAuth2-style authorization code exchange pattern. The implementation approach of storing codes in the existing `AdminUsersDO` Durable Object is appropriate and avoids adding new infrastructure.

The main issues are:
- E2E tests reference a method (`client.fetch()`) that does not exist on the `AdminApiClient` class
- The staged deployment strategy creates a transition gap where authentication breaks
- VPS unit tests test the mock, not the actual implementation
- One test file listed in the table of contents is never implemented

These are all fixable without changing the overall architecture. The plan is ready for implementation after these corrections.
