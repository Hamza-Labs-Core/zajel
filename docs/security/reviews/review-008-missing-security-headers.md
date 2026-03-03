# Review: Plan 008 - Add Missing Security Headers

**Verdict: PASS WITH NOTES**

**Reviewed:** 2026-03-03
**Plan:** `docs/security/implementation-plans/plan-008-missing-security-headers.md`
**Story:** `docs/security/stories/story-008-missing-security-headers.md`

---

## Accuracy

### File Paths: ALL VERIFIED

All referenced files exist at the stated paths under `/home/meywd/zajel-ddos/`:

| File | Exists |
|------|--------|
| `packages/admin-cf/src/index.ts` | Yes |
| `packages/server/src/cors.js` | Yes |
| `packages/server-vps/src/admin/routes.ts` | Yes |
| `packages/server-vps/src/admin/auth.ts` | Yes |
| `packages/admin-cf/tests/e2e/admin-e2e.test.ts` | Yes |
| `packages/server/tests/e2e/bootstrap.test.js` | Yes |

### Line Numbers and Code Snippets: MOSTLY ACCURATE

1. **`packages/admin-cf/src/index.ts`**
   - Lines 30-35 (`corsHeaders`): MATCHES. Actual code at lines 30-35 is exactly as shown.
   - Lines 37-40 (OPTIONS preflight): MATCHES. Actual code at lines 37-40.
   - Line 151 (`serveDashboard()` function start): MATCHES. Function declaration at line 151.
   - Line 510 (`<script type="module">`): MATCHES. Script tag at line 510.
   - Lines 956-961 (Response constructor in `serveDashboard()`): MATCHES exactly.
   - Lines 967-980 (`jsonResponse()` helper): MATCHES exactly.

2. **`packages/server/src/cors.js`**
   - Lines 26-34 (`headers` object in `getCorsHeaders()`): MATCHES exactly.

3. **`packages/server-vps/src/admin/routes.ts`**
   - Lines 182-188 (`serveDashboard()` method): MATCHES exactly.
   - Line 194 (`getDashboardHtml()` function): MATCHES. Signature is `function getDashboardHtml(cfAdminUrl?: string): string`.
   - Line 611 (`<script type="module">` in VPS dashboard): Confirmed via grep.

4. **`packages/server-vps/src/admin/auth.ts`**
   - Lines 128-140 (`sendJson()` function): MATCHES exactly (function starts at line 128, `res.writeHead` at line 134).

### Response Flow Accuracy: CORRECT

The plan correctly identifies that `serveDashboard()` returns early (line 98 of `index.ts`) and does NOT go through the CORS header merge at lines 107-116. This means adding security headers directly to the `serveDashboard()` response is the correct approach, and adding them to `corsHeaders` covers the API routes that flow through the merge path.

---

## Completeness

### ISSUE 1 (MEDIUM): Missing `jsonResponse()` in Route Handlers

The plan only modifies `jsonResponse()` in `packages/admin-cf/src/index.ts` (line 967). There are three additional `jsonResponse()` helpers that also lack security headers:

- `packages/admin-cf/src/routes/auth.ts` line 133
- `packages/admin-cf/src/routes/servers.ts` line 176
- `packages/admin-cf/src/admin-users-do.ts` line 414

**Mitigating factor:** The responses from these functions flow through the CORS header merge at `index.ts` lines 107-116. Since the plan adds security headers to the `corsHeaders` object (Section 3.3), those headers WILL be applied to the final response. However, for defense-in-depth and consistency, these helpers should also be updated. If the code is ever refactored to bypass the merge (e.g., early-return patterns), the headers would be missing.

**Recommendation:** Add a note to the plan acknowledging these additional `jsonResponse()` functions. Optionally refactor to a single shared helper, or at minimum update all four instances.

### ISSUE 2 (LOW): Story vs Plan Inconsistency on `Permissions-Policy`

The story's proposed fix for `cors.js` uses:
```
'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
```
The plan uses:
```
'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()'
```
The plan is more comprehensive (includes `payment=()`), which is better. The story should be updated to match. Not a blocking issue.

### ISSUE 3 (LOW): VPS Dashboard `connect-src` and WebSocket

The plan correctly notes that `connect-src 'self'` should cover WebSocket connections to the same origin. This is confirmed: the VPS dashboard JavaScript (line 681 of `routes.ts`) constructs `ws://` or `wss://` URLs using `location.host`, which is same-origin. CSP `connect-src 'self'` covers this.

### Acceptance Criteria Coverage

| Acceptance Criterion | Covered in Plan | Covered in Tests |
|---------------------|----------------|-----------------|
| CSP with per-request nonce on CF admin HTML | Section 3.1 | Section 4.1 (test 1, 2, 3) |
| `Referrer-Policy: no-referrer` on CF admin HTML | Section 3.1 | Section 4.1 (test 1) |
| `X-Frame-Options: DENY` on CF admin HTML | Section 3.1 | Section 4.1 (test 1) |
| `X-Content-Type-Options: nosniff` on CF admin HTML | Section 3.1 | Section 4.1 (test 1) |
| `Strict-Transport-Security` on CF admin HTML | Section 3.1 | Section 4.1 (test 1) |
| `Permissions-Policy` on CF admin HTML | Section 3.1 | Section 4.1 (test 1) |
| Security headers on CF API JSON responses | Sections 3.2, 3.3 | Section 4.1 (test 4) |
| `Referrer-Policy` + `Permissions-Policy` on bootstrap | Section 3.4 | Section 4.2 (tests 1, 2) |
| VPS dashboard same headers as CF | Section 3.5 | Section 4.3 (manual) |
| CSP doesn't break inline JS | Section 3.1, 3.5 | Section 4.3 (manual) |
| `connect-src 'self'` for WebSocket | Section 3.5, 5.2 | Section 4.3 (manual) |

All acceptance criteria from the story are addressed.

---

## Risks

### RISK 1 (MEDIUM): Test Plan Contains Errors That Will Cause Failures

**Section 4.1, Test "should include security headers on API JSON responses":**

Two bugs in the proposed test code:

1. **Wrong HTTP method:** The test calls `fetch(\`${BASE_URL}/admin/verify\`, { method: 'POST' })`, but the verify endpoint is `GET` (see `index.ts` line 83: `path === '/admin/api/auth/verify' && method === 'GET'`). Using `POST` will hit the `Not found` 404 handler instead.

2. **Wrong URL path:** The test uses `/admin/verify`, but the actual route is `/admin/api/auth/verify`.

3. **Wrong return type assumption:** The test calls `client.login(...)` and expects `loginResponse.success` and `loginResponse.data!.token`. But `AdminApiClient.login()` returns a raw `Response` object, not parsed JSON. Should use `client.loginAndStore()` instead.

**Recommendation:** Fix the test to use `GET` method, correct path `/admin/api/auth/verify`, and use `client.loginAndStore()` or parse the response manually.

### RISK 2 (MEDIUM): Bootstrap Server Test Will Fail for Server Registration

**Section 4.2, Test "should include all security headers on server registration":**

The test calls `serverRegistry.fetch(request)` directly on the Durable Object. The security headers from `getCorsHeaders()` are added in the Worker's `fetch()` handler (`packages/server/src/index.js` lines 131-142), NOT in the DO itself. The DO's response will not include `Referrer-Policy`, `Permissions-Policy`, etc.

**Recommendation:** Either:
- Test via `worker.fetch(request, env)` instead of `serverRegistry.fetch(request)`, OR
- Also add the new headers inside the DO's response helpers, OR
- Adjust the test to only check headers on `worker.fetch()` responses.

### RISK 3 (LOW): `crypto.getRandomValues` in VPS Routes

The plan uses `crypto.getRandomValues(new Uint8Array(16))` in the VPS `serveDashboard()` method. The file `packages/server-vps/src/admin/routes.ts` does not import `crypto`. The global `crypto` object is available in Node.js 20+ (which the project requires via `engines.node >= 20.0.0`), so this will work. However, for explicit clarity, consider using `import { randomBytes } from 'node:crypto'` and `randomBytes(16)` instead, which is more idiomatic for Node.js.

### RISK 4 (LOW): `Cache-Control` Upgrade May Affect Behavior

The plan upgrades `Cache-Control` from `no-cache` to `no-cache, no-store` on the dashboard HTML response. `no-cache` allows caching but requires revalidation; `no-store` prevents caching entirely. This is a security improvement (prevents sensitive admin UI from being stored in browser cache), but could slightly increase load if the dashboard is refreshed frequently. This is an acceptable trade-off.

### RISK 5 (LOW): HSTS on Development/Local Environments

`Strict-Transport-Security` header is always set, including in local development. If a developer accesses the admin dashboard via `https://localhost` during development, the browser will cache the HSTS policy and refuse HTTP connections for the duration of `max-age` (1 year). This is unlikely to cause issues in practice since local development typically uses HTTP, and HSTS only applies to the specific domain.

---

## Recommended Changes

### Must Fix (before implementation)

1. **Fix test for API JSON headers (Section 4.1):**
   - Change `method: 'POST'` to `method: 'GET'`
   - Change URL from `${BASE_URL}/admin/verify` to `${BASE_URL}/admin/api/auth/verify`
   - Change `client.login(...)` to `client.loginAndStore(...)` or parse the response

2. **Fix bootstrap server registration test (Section 4.2):**
   - Change `serverRegistry.fetch(request)` to `worker.fetch(request, env)` for the test that checks security headers, since security headers are applied in the worker wrapper, not the DO.

### Should Fix (recommended)

3. **Document the additional `jsonResponse()` functions** in `routes/auth.ts`, `routes/servers.ts`, and `admin-users-do.ts`. Either add them to the modification list or explicitly note they are covered by the CORS header merge at `index.ts` lines 107-116.

4. **Align the story's `Permissions-Policy` value** with the plan's value (add `payment=()` to the story's bootstrap cors.js snippet).

### Nice to Have

5. **Consider using `import { randomBytes } from 'node:crypto'`** in the VPS routes.ts instead of relying on the global `crypto.getRandomValues`.

6. **Consider adding `base-uri 'none'`** to the CSP directives, which prevents `<base>` tag injection attacks that could redirect relative URLs.

7. **Consider `Content-Security-Policy-Report-Only`** as a rollout strategy: deploy with report-only first to detect any CSP violations without breaking functionality, then switch to enforcing mode after confirming no issues.
