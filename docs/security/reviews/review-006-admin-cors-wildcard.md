# Review: Plan 006 - Fix Admin Portal CORS Wildcard

**Verdict: PASS WITH NOTES**

**Reviewed:** 2026-03-03
**Plan:** `docs/security/implementation-plans/plan-006-admin-cors-wildcard.md`
**Story:** `docs/security/stories/story-006-admin-cors-wildcard.md`

---

## Accuracy

### File Paths

All referenced files exist and are correctly located:

| File | Exists | Correct |
|------|--------|---------|
| `packages/admin-cf/src/index.ts` | Yes | Yes |
| `packages/admin-cf/src/types.ts` | Yes | Yes |
| `packages/admin-cf/wrangler.jsonc` | Yes | Yes |
| `packages/admin-cf/tests/e2e/admin-e2e.test.ts` | Yes | Yes |
| `packages/server/src/cors.js` | Yes | Yes |
| `packages/server-vps/src/admin/routes.ts` | Yes | Yes |
| `packages/admin-cf/src/cors.ts` | N/A | New file (correct) |
| `packages/admin-cf/tests/unit/cors.test.ts` | N/A | New file (correct) |

### Line Numbers and Code Snippets

All line number references in both the plan and story have been verified against the actual source code:

| Reference | Claimed Lines | Actual Lines | Match |
|-----------|---------------|--------------|-------|
| `index.ts` wildcard CORS block | 30-35 | 30-35 | Exact |
| `index.ts` OPTIONS handler | 38-40 | 38-40 | Exact |
| `index.ts` health check with corsHeaders | 47-56 | 47-56 | Exact |
| `index.ts` newHeaders merge | 108-116 | 108-116 | Exact |
| `index.ts` error catch with corsHeaders | 119-123 | 119-123 | Exact |
| `index.ts` imports | 10-14 | 10-13 (line 14 is blank) | Minor: header says 10-14 but imports end at line 13; snippet content is correct |
| `index.ts` localStorage.setItem | 623 | 623 | Exact |
| `index.ts` Authorization headers | 585, 600, 667, 693 | 585, 600, 667, 693 | Exact |
| `index.ts` redirect token set | 552, 633 | 552, 633 | Exact |
| `types.ts` Env interface | 66-73 | 66-73 | Exact |
| `wrangler.jsonc` production vars | 49-52 | 49-52 | Exact |
| `wrangler.jsonc` QA vars | 76-78 | 76-78 | Exact |
| `admin-e2e.test.ts` Security section | 496-517 | 496-517 | Exact |
| `admin-e2e.test.ts` 404 CORS test | 601-605 | 601-605 | Exact |
| `cors.js` getCorsHeaders | 22-42 | 22-42 | Exact |
| `cors.js` HSTS header | 33 | 33 | Exact |
| `routes.ts` CORS with cfAdminUrl | 28-31 | 28-31 | Exact |
| `routes.ts` Access-Control-Allow-Credentials | 30 | 30 | Exact |
| `routes.ts` token from URL / set cookie | 44-54 | 44-56 (line 54 is the redirect, 55-56 close the block) | Close enough; the narrative is correct |
| `routes.ts` redirect to CF admin | 777 | 777 | Exact |

All code snippets shown in the "Before" sections match the actual source verbatim. This plan is unusually thorough in its source references.

---

## Completeness

### Acceptance Criteria Coverage

| Criterion | Covered By | Notes |
|-----------|-----------|-------|
| Remove `Access-Control-Allow-Origin: *` | Step 3 (code change), unit tests, E2E tests | Fully covered |
| Configurable allowlist via `ADMIN_ALLOWED_ORIGINS` | Step 1 (cors.ts), Step 2 (types.ts), Step 4 (wrangler.jsonc) | Fully covered |
| `Vary: Origin` when ACAO is set | Step 1 (cors.ts), unit tests | Fully covered |
| Non-allowed origins get no ACAO | Step 1 (cors.ts), unit tests | Fully covered |
| OPTIONS preflight respects allowlist | Implicitly via getCorsHeaders being used for all paths | No dedicated integration test for OPTIONS+allowed origin (see Risks) |
| Same-origin dashboard continues to work | E2E tests, manual test case 1 | Fully covered |
| VPS redirect flow continues to work | Manual test case 4 | Covered by manual testing only; acceptable given redirect flow is navigation-based |
| Security headers added | Step 1 (cors.ts), E2E tests, unit tests | See risk note below about dashboard HTML |

### Test Coverage Assessment

The unit test suite (Step 7) is comprehensive with 12 test cases covering:
- No-origin requests
- Exact match for allowed origins
- Multiple origins in allowlist
- Disallowed origins
- Localhost wildcard matching
- HTTPS localhost rejection
- Subdomain spoofing (`evil.localhost`)
- Empty/undefined allowlist
- Whitespace trimming
- Malformed Origin header
- Security headers always present

The E2E test updates (Steps 5-6) are appropriately scoped given that E2E clients cannot easily simulate cross-origin requests.

### Missing Test: Preflight from Allowed Origin (Unit)

The story explicitly calls for:
- "Unit test: Preflight OPTIONS from an allowed origin returns correct CORS headers"
- "Unit test: Preflight OPTIONS from a disallowed origin returns no allow-origin header"

These are not directly present in the unit test file. They are implicitly satisfied because `getCorsHeaders` is method-agnostic and the unit tests already test allowed vs. disallowed origins. However, adding explicit tests that name "preflight" would more clearly map to the acceptance criteria and could test integration with the OPTIONS handler in `index.ts`.

---

## Risks

### 1. Security Headers Not Applied to Dashboard HTML (MEDIUM)

The plan claims to add `X-Frame-Options: DENY` and `X-Content-Type-Options: nosniff` to all responses. However, the `serveDashboard()` function in `index.ts` (lines 96-101) returns directly without going through the CORS headers merge at lines 108-116:

```typescript
} else if (path === '/admin' || path === '/admin/') {
    return serveDashboard();  // <-- bypasses corsHeaders merge
} else if (path.startsWith('/admin/')) {
    return serveDashboard();  // <-- bypasses corsHeaders merge
}
```

This means the dashboard HTML itself will NOT receive `X-Frame-Options: DENY`, which is precisely the response most vulnerable to clickjacking. The API endpoints (health, users, servers, errors) will all correctly receive the headers since they either use `jsonResponse(..., corsHeaders)` or go through the merge block.

**Impact:** The dashboard can still be framed by malicious sites, undermining the clickjacking protection. This was also the case before the change (no security headers existed), so it is not a regression, but the plan's claim to add `X-Frame-Options: DENY` is incomplete.

**Recommendation:** Either:
- (a) Add security headers to `serveDashboard()` directly, or
- (b) Restructure the handler so dashboard responses also flow through the corsHeaders merge, or
- (c) Document this as a known limitation for Story 008 to address.

### 2. Redirect Response Missing Security Headers (LOW)

The `Response.redirect()` at line 104 (`GET /` redirects to `/admin/`) also bypasses the CORS headers merge. This is low risk since it's a 302 redirect with no body content.

### 3. E2E Tests Cannot Verify Core CORS Logic (LOW, ACKNOWLEDGED)

The plan correctly acknowledges that E2E tests run from the same origin and cannot simulate cross-origin requests. The actual CORS logic is validated only in unit tests. This is an acceptable tradeoff, but it means a subtle integration bug between `getCorsHeaders()` and the `index.ts` handler would not be caught until manual testing.

### 4. `http://localhost:*` in Production Config (LOW)

The plan includes `http://localhost:*` in the production `ADMIN_ALLOWED_ORIGINS` value in `wrangler.jsonc`. While localhost is only accessible from the local machine, this slightly widens the attack surface in theoretical scenarios (e.g., DNS rebinding attacks). The plan discusses this in Section 9.3 and provides an alternative approach, so this is a conscious decision. Production environments typically should not include development origins.

### 5. No `Access-Control-Allow-Credentials` Consideration for Future (LOW)

The plan correctly identifies that `Access-Control-Allow-Credentials` is not needed. Section 9.1 provides thorough justification. No action needed.

---

## Recommended Changes

### Must Fix (before implementation)

None. The plan is implementable as-is. All the items below are improvements.

### Should Fix (high value, low effort)

1. **Add security headers to `serveDashboard()` responses.** Modify `serveDashboard()` in `index.ts` to include `X-Frame-Options: DENY` and `X-Content-Type-Options: nosniff` in its response headers. Without this, the plan's acceptance criterion "X-Content-Type-Options: nosniff and X-Frame-Options: DENY are added as security headers" is only partially met. This is a 2-line change in the `serveDashboard()` function:

   ```typescript
   return new Response(html, {
     headers: {
       'Content-Type': 'text/html; charset=utf-8',
       'Cache-Control': 'no-cache',
       'X-Content-Type-Options': 'nosniff',
       'X-Frame-Options': 'DENY',
     },
   });
   ```

2. **Remove `http://localhost:*` from production `ADMIN_ALLOWED_ORIGINS`.** Keep it only in the QA environment config. Developers running `wrangler dev` use `--env qa` or set `.dev.vars` locally. The production value should be:

   ```jsonc
   "ADMIN_ALLOWED_ORIGINS": "https://admin.zajel.hamzalabs.dev"
   ```

### Nice to Have (low priority)

3. **Add explicit preflight unit tests** to satisfy the story's test requirements verbatim. These could be simple tests that create an OPTIONS-method request and verify the returned headers from `getCorsHeaders()` for allowed vs. disallowed origins.

4. **Consider adding `Vary: Origin` even when no ACAO is set.** Some CORS implementations always include `Vary: Origin` to prevent cache poisoning in all cases (not just when an origin matches). This is a defense-in-depth measure. The current bootstrap server's `cors.js` only sets `Vary: Origin` when origin matches, so the plan is consistent, but it's worth noting.

5. **Minor: Plan Section 3 header says "lines 10-14"** but the import block is actually lines 10-13 (line 14 is blank). The snippet content is correct; only the range label is slightly off.

---

## Summary

The plan is thorough, well-researched, and implementable. All file paths, line numbers, and code snippets match the actual codebase. The proposed CORS utility follows the established pattern from `packages/server/src/cors.js`. The unit test suite is comprehensive. The dependency analysis with Stories 007 and 008 is thoughtful.

The primary gap is that security headers will not be applied to the dashboard HTML responses due to the early-return pattern in `index.ts`. This should be addressed as part of this implementation since the plan explicitly lists `X-Frame-Options: DENY` as an acceptance criterion and the dashboard HTML is the most important response to protect from clickjacking.
