# Implementation Plan 006: Fix Admin Portal CORS Wildcard

**Story Reference:** [Story 006: Fix Admin Portal CORS Wildcard](../stories/story-006-admin-cors-wildcard.md)

**Priority:** THIS WEEK
**Severity:** HIGH
**Component:** packages/admin-cf

---

## 1. Summary

The Cloudflare Workers admin dashboard (`packages/admin-cf/src/index.ts`) currently sets `Access-Control-Allow-Origin: *` on all API responses, allowing any website on the internet to make authenticated cross-origin requests to the admin API. This implementation plan addresses the vulnerability by replacing the wildcard CORS with origin-based CORS validation similar to the pattern already implemented in `packages/server/src/cors.js`.

**Key Changes:**
- Replace hardcoded `Access-Control-Allow-Origin: *` with dynamic origin validation
- Add `ADMIN_ALLOWED_ORIGINS` environment variable for configurable allowlist
- Include `Vary: Origin` header to prevent cache poisoning
- Add security headers (`X-Content-Type-Options`, `X-Frame-Options`)
- Update tests to verify CORS behavior with allowed/disallowed origins

**Impact:**
- Reduces attack surface by restricting cross-origin API access
- Prevents token exfiltration from malicious sites
- Maintains backward compatibility for same-origin dashboard requests
- Preserves VPS-to-CF redirect flow (which uses full-page navigation, not CORS)

---

## 2. Files to Modify

### 2.1 Source Files

| File | Purpose |
|------|---------|
| `/home/meywd/zajel-ddos/packages/admin-cf/src/index.ts` | Replace wildcard CORS with dynamic origin validation |
| `/home/meywd/zajel-ddos/packages/admin-cf/src/types.ts` | Add `ADMIN_ALLOWED_ORIGINS` to `Env` interface |
| `/home/meywd/zajel-ddos/packages/admin-cf/src/cors.ts` | **(NEW FILE)** Create CORS utility module |

### 2.2 Configuration Files

| File | Purpose |
|------|---------|
| `/home/meywd/zajel-ddos/packages/admin-cf/wrangler.jsonc` | Add default `ADMIN_ALLOWED_ORIGINS` for production and QA |

### 2.3 Test Files

| File | Purpose |
|------|---------|
| `/home/meywd/zajel-ddos/packages/admin-cf/tests/e2e/admin-e2e.test.ts` | Update CORS security tests to verify allowlist behavior |
| `/home/meywd/zajel-ddos/packages/admin-cf/tests/unit/cors.test.ts` | **(NEW FILE)** Add unit tests for CORS utility |

### 2.4 Documentation Files

| File | Purpose |
|------|---------|
| `/home/meywd/zajel-ddos/docs/security/stories/story-006-admin-cors-wildcard.md` | Mark as completed after implementation |

---

## 3. Implementation Steps

### Step 1: Create CORS Utility Module

**File:** `/home/meywd/zajel-ddos/packages/admin-cf/src/cors.ts`

**Action:** Create new file with CORS utility functions.

```typescript
/**
 * CORS utility module for Zajel Admin Dashboard.
 *
 * Provides origin-based CORS header generation instead of wildcard (*).
 * The allowlist is read from the ADMIN_ALLOWED_ORIGINS environment variable.
 */

import type { Env } from './types.js';

/**
 * Get CORS headers for a given request. Checks the request's Origin header
 * against the allowlist and returns matching CORS headers.
 *
 * @param request - The incoming request
 * @param env - Cloudflare Worker environment bindings
 * @returns CORS headers object
 */
export function getCorsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };

  if (origin && isOriginAllowed(origin, env)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }

  return headers;
}

/**
 * Check if an origin is in the allowlist.
 * Supports exact matches and localhost pattern matching for development.
 *
 * @param origin - The request Origin header value
 * @param env - Cloudflare Worker environment bindings
 * @returns Whether the origin is allowed
 */
function isOriginAllowed(origin: string, env: Env): boolean {
  const allowedOrigins = parseAllowedOrigins(env);

  // Exact match
  if (allowedOrigins.includes(origin)) {
    return true;
  }

  // Check for wildcard localhost patterns (e.g., http://localhost:*)
  for (const allowed of allowedOrigins) {
    if (allowed === 'http://localhost:*') {
      try {
        const url = new URL(origin);
        if (url.hostname === 'localhost' && url.protocol === 'http:') {
          return true;
        }
      } catch {
        // Invalid origin URL, skip
      }
    }
  }

  return false;
}

/**
 * Parse the ADMIN_ALLOWED_ORIGINS from environment.
 * Returns an empty array if not set (no origins allowed).
 *
 * @param env - Cloudflare Worker environment bindings
 * @returns Array of allowed origin strings
 */
function parseAllowedOrigins(env: Env): string[] {
  if (!env || !env.ADMIN_ALLOWED_ORIGINS) {
    return [];
  }

  return env.ADMIN_ALLOWED_ORIGINS
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}
```

---

### Step 2: Update Types Interface

**File:** `/home/meywd/zajel-ddos/packages/admin-cf/src/types.ts`

**Action:** Add `ADMIN_ALLOWED_ORIGINS` to the `Env` interface.

**Before:**
```typescript
/**
 * Environment bindings for CF Worker
 */
export interface Env {
  ADMIN_USERS: DurableObjectNamespace;
  ZAJEL_ADMIN_JWT_SECRET: string;
  ZAJEL_BOOTSTRAP_URL?: string;
  APP_VERSION?: string;
  /** Service binding to the bootstrap server (zajel-signaling worker) */
  BOOTSTRAP_SERVICE?: ServiceBinding;
}
```

**After:**
```typescript
/**
 * Environment bindings for CF Worker
 */
export interface Env {
  ADMIN_USERS: DurableObjectNamespace;
  ZAJEL_ADMIN_JWT_SECRET: string;
  ZAJEL_BOOTSTRAP_URL?: string;
  APP_VERSION?: string;
  /** Service binding to the bootstrap server (zajel-signaling worker) */
  BOOTSTRAP_SERVICE?: ServiceBinding;
  /**
   * Comma-separated list of allowed origins for CORS.
   * Example: "https://admin.zajel.hamzalabs.dev,http://localhost:*"
   * If not set, no cross-origin requests will be allowed.
   */
  ADMIN_ALLOWED_ORIGINS?: string;
}
```

---

### Step 3: Replace Wildcard CORS in Main Handler

**File:** `/home/meywd/zajel-ddos/packages/admin-cf/src/index.ts`

**Action:** Replace static `corsHeaders` with dynamic `getCorsHeaders()` call.

**Before (lines 10-14):**
```typescript
import type { Env } from './types.js';
import { handleLogin, handleLogout, handleVerify, handleInit } from './routes/auth.js';
import { handleListUsers, handleCreateUser, handleDeleteUser } from './routes/users.js';
import { handleListServers } from './routes/servers.js';
```

**After:**
```typescript
import type { Env } from './types.js';
import { handleLogin, handleLogout, handleVerify, handleInit } from './routes/auth.js';
import { handleListUsers, handleCreateUser, handleDeleteUser } from './routes/users.js';
import { handleListServers } from './routes/servers.js';
import { getCorsHeaders } from './cors.js';
```

**Before (lines 29-35):**
```typescript
    // CORS headers for dashboard
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };
```

**After:**
```typescript
    // CORS headers for dashboard
    const corsHeaders = getCorsHeaders(request, env);
```

**Note:** All other references to `corsHeaders` remain unchanged (lines 38-40, 47-56, 63-64, 77-78, 95, 108-116, 119-123).

---

### Step 4: Update Wrangler Configuration

**File:** `/home/meywd/zajel-ddos/packages/admin-cf/wrangler.jsonc`

**Action:** Add `ADMIN_ALLOWED_ORIGINS` to production and QA environment variables.

**Before (lines 49-52):**
```jsonc
  // Production vars
  "vars": {
    "ZAJEL_BOOTSTRAP_URL": "https://signal.zajel.hamzalabs.dev"
  },
```

**After:**
```jsonc
  // Production vars
  "vars": {
    "ZAJEL_BOOTSTRAP_URL": "https://signal.zajel.hamzalabs.dev",
    "ADMIN_ALLOWED_ORIGINS": "https://admin.zajel.hamzalabs.dev,http://localhost:*"
  },
```

**Before (lines 76-78):**
```jsonc
      "vars": {
        "ZAJEL_BOOTSTRAP_URL": "https://signal.zajel.qa.hamzalabs.dev"
      }
```

**After:**
```jsonc
      "vars": {
        "ZAJEL_BOOTSTRAP_URL": "https://signal.zajel.qa.hamzalabs.dev",
        "ADMIN_ALLOWED_ORIGINS": "https://admin.zajel.qa.hamzalabs.dev,http://localhost:*"
      }
```

**Rationale:**
- Production allows the admin dashboard's own origin (`https://admin.zajel.hamzalabs.dev`)
- QA allows the QA dashboard's own origin (`https://admin.zajel.qa.hamzalabs.dev`)
- Both allow localhost for development (`http://localhost:*`)
- The inline dashboard makes same-origin requests, so CORS headers aren't technically needed, but we include them for completeness
- The VPS-to-CF redirect flow uses full-page navigation (not CORS), so it doesn't need to be in the allowlist

---

### Step 5: Update E2E Tests

**File:** `/home/meywd/zajel-ddos/packages/admin-cf/tests/e2e/admin-e2e.test.ts`

**Action:** Update the "Security" section to test origin-based CORS instead of wildcard.

**Before (lines 496-517):**
```typescript
describe('Security', () => {
  it('API responses include CORS headers', async () => {
    const res = await client.health();
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('Error responses include CORS headers', async () => {
    const res = await client.listUsersNoAuth();
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('OPTIONS preflight returns 204 with CORS headers', async () => {
    const res = await client.options('/admin/api/users');
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-methods')).toContain('DELETE');
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(res.headers.get('access-control-max-age')).toBe('86400');
  });
```

**After:**
```typescript
describe('Security', () => {
  it('API responses from same-origin have no CORS headers (same-origin requests)', async () => {
    // Same-origin requests don't send an Origin header, so no CORS headers are set
    const res = await client.health();
    const origin = res.headers.get('access-control-allow-origin');
    // Origin may be null or match the request origin if browser sets it
    expect(origin).not.toBe('*');
  });

  it('API responses include security headers', async () => {
    const res = await client.health();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('Error responses include security headers', async () => {
    const res = await client.listUsersNoAuth();
    expect(res.status).toBe(401);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('OPTIONS preflight returns 204 with CORS configuration headers', async () => {
    const res = await client.options('/admin/api/users');
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-methods')).toContain('DELETE');
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(res.headers.get('access-control-max-age')).toBe('86400');
  });
```

**Note:** Full cross-origin testing (with different Origin headers) is better suited for unit tests, since E2E tests run against the deployed worker and may not easily simulate cross-origin requests.

---

### Step 6: Update Edge Case Tests

**File:** `/home/meywd/zajel-ddos/packages/admin-cf/tests/e2e/admin-e2e.test.ts`

**Action:** Update the "Edge Cases" section to remove wildcard CORS assertion.

**Before (lines 601-605):**
```typescript
  it('404 responses include CORS headers', async () => {
    const res = await client.rawGet('/admin/api/unknown');
    expect(res.status).toBe(404);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
```

**After:**
```typescript
  it('404 responses include security headers', async () => {
    const res = await client.rawGet('/admin/api/unknown');
    expect(res.status).toBe(404);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
```

---

### Step 7: Create Unit Tests for CORS Module

**File:** `/home/meywd/zajel-ddos/packages/admin-cf/tests/unit/cors.test.ts` (NEW FILE)

**Action:** Create comprehensive unit tests for the CORS utility.

```typescript
/**
 * Unit tests for CORS utility module
 */

import { describe, it, expect } from 'vitest';
import { getCorsHeaders } from '../../src/cors.js';
import type { Env } from '../../src/types.js';

describe('getCorsHeaders', () => {
  const mockEnv: Env = {
    ADMIN_USERS: {} as any,
    ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    ADMIN_ALLOWED_ORIGINS: 'https://admin.zajel.hamzalabs.dev,https://example.com,http://localhost:*',
  };

  function mockRequest(origin: string | null): Request {
    const headers = new Headers();
    if (origin !== null) {
      headers.set('Origin', origin);
    }
    return new Request('https://admin.zajel.hamzalabs.dev/admin/api/users', {
      headers,
    });
  }

  it('returns CORS headers without Access-Control-Allow-Origin when no Origin header is present', () => {
    const request = mockRequest(null);
    const headers = getCorsHeaders(request, mockEnv);

    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(headers['Access-Control-Allow-Methods']).toBe('GET, POST, DELETE, OPTIONS');
    expect(headers['Access-Control-Allow-Headers']).toBe('Content-Type, Authorization');
    expect(headers['Access-Control-Max-Age']).toBe('86400');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Vary']).toBeUndefined();
  });

  it('sets Access-Control-Allow-Origin and Vary when origin is in allowlist', () => {
    const request = mockRequest('https://admin.zajel.hamzalabs.dev');
    const headers = getCorsHeaders(request, mockEnv);

    expect(headers['Access-Control-Allow-Origin']).toBe('https://admin.zajel.hamzalabs.dev');
    expect(headers['Vary']).toBe('Origin');
  });

  it('allows exact match for multiple origins in allowlist', () => {
    const request1 = mockRequest('https://admin.zajel.hamzalabs.dev');
    const headers1 = getCorsHeaders(request1, mockEnv);
    expect(headers1['Access-Control-Allow-Origin']).toBe('https://admin.zajel.hamzalabs.dev');

    const request2 = mockRequest('https://example.com');
    const headers2 = getCorsHeaders(request2, mockEnv);
    expect(headers2['Access-Control-Allow-Origin']).toBe('https://example.com');
  });

  it('does not set Access-Control-Allow-Origin for disallowed origins', () => {
    const request = mockRequest('https://evil.example.com');
    const headers = getCorsHeaders(request, mockEnv);

    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(headers['Vary']).toBeUndefined();
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
  });

  it('allows localhost with wildcard pattern (http://localhost:*)', () => {
    const request1 = mockRequest('http://localhost:3000');
    const headers1 = getCorsHeaders(request1, mockEnv);
    expect(headers1['Access-Control-Allow-Origin']).toBe('http://localhost:3000');

    const request2 = mockRequest('http://localhost:8787');
    const headers2 = getCorsHeaders(request2, mockEnv);
    expect(headers2['Access-Control-Allow-Origin']).toBe('http://localhost:8787');
  });

  it('rejects https://localhost when only http://localhost:* is allowed', () => {
    const request = mockRequest('https://localhost:3000');
    const headers = getCorsHeaders(request, mockEnv);

    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('rejects localhost subdomain spoofing (e.g., evil.localhost)', () => {
    const request = mockRequest('http://evil.localhost:3000');
    const headers = getCorsHeaders(request, mockEnv);

    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('handles empty ADMIN_ALLOWED_ORIGINS by rejecting all origins', () => {
    const emptyEnv: Env = {
      ...mockEnv,
      ADMIN_ALLOWED_ORIGINS: '',
    };
    const request = mockRequest('https://admin.zajel.hamzalabs.dev');
    const headers = getCorsHeaders(request, emptyEnv);

    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('handles undefined ADMIN_ALLOWED_ORIGINS by rejecting all origins', () => {
    const undefinedEnv: Env = {
      ...mockEnv,
      ADMIN_ALLOWED_ORIGINS: undefined,
    };
    const request = mockRequest('https://admin.zajel.hamzalabs.dev');
    const headers = getCorsHeaders(request, undefinedEnv);

    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('trims whitespace from allowed origins list', () => {
    const whiteSpaceEnv: Env = {
      ...mockEnv,
      ADMIN_ALLOWED_ORIGINS: '  https://example.com  ,  https://other.com  ',
    };
    const request = mockRequest('https://example.com');
    const headers = getCorsHeaders(request, whiteSpaceEnv);

    expect(headers['Access-Control-Allow-Origin']).toBe('https://example.com');
  });

  it('handles malformed Origin header gracefully', () => {
    const request = mockRequest('not-a-valid-url');
    const headers = getCorsHeaders(request, mockEnv);

    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('always includes security headers regardless of origin', () => {
    const request1 = mockRequest('https://evil.example.com');
    const headers1 = getCorsHeaders(request1, mockEnv);
    expect(headers1['X-Content-Type-Options']).toBe('nosniff');
    expect(headers1['X-Frame-Options']).toBe('DENY');

    const request2 = mockRequest('https://admin.zajel.hamzalabs.dev');
    const headers2 = getCorsHeaders(request2, mockEnv);
    expect(headers2['X-Content-Type-Options']).toBe('nosniff');
    expect(headers2['X-Frame-Options']).toBe('DENY');

    const request3 = mockRequest(null);
    const headers3 = getCorsHeaders(request3, mockEnv);
    expect(headers3['X-Content-Type-Options']).toBe('nosniff');
    expect(headers3['X-Frame-Options']).toBe('DENY');
  });
});
```

---

## 4. Test Plan

### 4.1 Unit Tests

**Test File:** `/home/meywd/zajel-ddos/packages/admin-cf/tests/unit/cors.test.ts`

| Test Case | Description | Expected Outcome |
|-----------|-------------|------------------|
| No Origin header | Request without Origin header | No `Access-Control-Allow-Origin`, security headers present |
| Allowed origin (exact match) | Request with origin in allowlist | `Access-Control-Allow-Origin` set to origin, `Vary: Origin` |
| Multiple allowed origins | Requests from different allowed origins | Each gets correct `Access-Control-Allow-Origin` |
| Disallowed origin | Request from origin not in allowlist | No `Access-Control-Allow-Origin`, security headers present |
| Localhost wildcard | `http://localhost:3000`, `http://localhost:8787` | Allowed via `http://localhost:*` pattern |
| HTTPS localhost rejection | `https://localhost:3000` | Rejected (only `http://localhost:*` allowed) |
| Localhost subdomain spoofing | `http://evil.localhost:3000` | Rejected (hostname must be exactly "localhost") |
| Empty allowlist | `ADMIN_ALLOWED_ORIGINS=""` | All origins rejected |
| Undefined allowlist | `ADMIN_ALLOWED_ORIGINS` not set | All origins rejected |
| Whitespace trimming | `"  https://example.com  ,  other.com  "` | Origins parsed correctly |
| Malformed Origin | Invalid URL in Origin header | Rejected gracefully without error |
| Security headers | All requests | `X-Content-Type-Options` and `X-Frame-Options` always present |

**Run Command:**
```bash
cd packages/admin-cf
npm run test:unit
```

---

### 4.2 E2E Tests

**Test File:** `/home/meywd/zajel-ddos/packages/admin-cf/tests/e2e/admin-e2e.test.ts`

| Test Case | Description | Expected Outcome |
|-----------|-------------|------------------|
| Same-origin requests | Requests from the dashboard itself | Security headers present, no wildcard CORS |
| Security headers on success | `GET /health` | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` |
| Security headers on error | `GET /admin/api/users` (no auth) | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` |
| Preflight OPTIONS | `OPTIONS /admin/api/users` | 204, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers` |
| 404 responses | `GET /admin/api/unknown` | Security headers present, no wildcard CORS |

**Run Command:**
```bash
cd packages/admin-cf
npm run test:e2e
```

**Note:** E2E tests run against the deployed QA worker, so they primarily verify that the change doesn't break existing functionality and that security headers are present.

---

### 4.3 Manual Testing

#### Test Case 1: Same-Origin Dashboard

**Steps:**
1. Deploy to QA: `wrangler deploy --env qa`
2. Visit `https://admin.zajel.qa.hamzalabs.dev/admin/`
3. Log in with valid credentials
4. Navigate to "Servers" and "Users" tabs
5. Create a user, delete a user, view server list

**Expected:**
- Dashboard loads and functions normally
- All API calls succeed
- No console errors related to CORS

**Validation:**
- Open browser DevTools Network tab
- Inspect response headers for `/admin/api/users`, `/admin/api/servers`
- Verify `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY` are present
- Verify no `Access-Control-Allow-Origin: *` in headers

---

#### Test Case 2: Cross-Origin Request from Allowed Origin (Localhost)

**Setup:**
1. Run local development server: `wrangler dev --env qa`
2. Note the local URL (e.g., `http://localhost:8787`)
3. Ensure `ADMIN_ALLOWED_ORIGINS` includes `http://localhost:*` (already in wrangler.jsonc)

**Steps:**
1. Visit `http://localhost:8787/admin/`
2. Log in and perform actions

**Expected:**
- Dashboard functions normally
- API calls succeed from `http://localhost:8787` origin

**Validation:**
- Check Network tab for API responses
- If browser sends `Origin: http://localhost:8787`, verify `Access-Control-Allow-Origin: http://localhost:8787` is present
- If browser doesn't send Origin (same-origin request), verify no `Access-Control-Allow-Origin` header

---

#### Test Case 3: Cross-Origin Request from Disallowed Origin

**Setup:**
1. Create a simple HTML file on a different origin (e.g., `http://localhost:3000` or `https://evil.example.com`)
2. Obtain a valid JWT token from the admin dashboard

**HTML File (test-cors.html):**
```html
<!DOCTYPE html>
<html>
<head>
  <title>CORS Test</title>
</head>
<body>
  <h1>Admin API CORS Test</h1>
  <button onclick="testCors()">Test CORS</button>
  <pre id="result"></pre>

  <script>
    async function testCors() {
      const token = prompt('Enter JWT token:');
      const apiUrl = 'https://admin.zajel.qa.hamzalabs.dev/admin/api/users';

      try {
        const res = await fetch(apiUrl, {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        const data = await res.json();
        document.getElementById('result').textContent =
          'SUCCESS (This should NOT happen!)\n' + JSON.stringify(data, null, 2);
      } catch (error) {
        document.getElementById('result').textContent =
          'BLOCKED (Expected): ' + error.message;
      }
    }
  </script>
</body>
</html>
```

**Steps:**
1. Serve the HTML file from a different origin than the admin dashboard
   - Option A: Use a simple HTTP server: `python3 -m http.server 3000`
   - Option B: Upload to a test domain
2. Open the HTML file in a browser
3. Enter a valid JWT token when prompted
4. Click "Test CORS"

**Expected:**
- Browser console shows CORS error: `Access to fetch at 'https://admin.zajel.qa.hamzalabs.dev/admin/api/users' from origin 'http://localhost:3000' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.`
- The test page displays "BLOCKED (Expected): Failed to fetch"
- Network tab shows the request completed (200), but response is blocked by browser

**Validation:**
- Inspect the response headers in DevTools Network tab
- Verify `Access-Control-Allow-Origin` header is **absent** or does **not** match the requesting origin
- Confirm browser prevented JavaScript from reading the response

---

#### Test Case 4: VPS-to-CF Redirect Flow

**Setup:**
1. Deploy a VPS server with `ZAJEL_CF_ADMIN_URL=https://admin.zajel.qa.hamzalabs.dev`
2. Ensure the VPS is registered in the bootstrap registry

**Steps:**
1. Visit the VPS admin dashboard at `https://<vps-ip>/admin/`
2. Browser should redirect to `https://admin.zajel.qa.hamzalabs.dev/admin/?redirect=https://<vps-ip>/admin/`
3. Log in to the CF admin dashboard
4. Browser should redirect back to `https://<vps-ip>/admin/?token=<jwt>`
5. VPS should extract token from URL and set a cookie

**Expected:**
- Full redirect flow completes successfully
- No CORS errors (redirects are full-page navigations, not CORS)

**Validation:**
- Confirm successful authentication on VPS dashboard
- Verify token is stored as a cookie (not in URL)
- Ensure server list and metrics are visible

---

### 4.4 Regression Testing

**Critical Flows to Verify:**

1. **Login Flow**
   - Visit `/admin/`, enter credentials, verify token is stored in localStorage
   - Refresh page, verify token is validated and user remains logged in

2. **User Management**
   - List users
   - Create new admin user
   - Delete user (not self)

3. **Server Monitoring**
   - List servers from bootstrap registry
   - View aggregate stats
   - Click on server card to open VPS dashboard

4. **Health Check**
   - `GET /health` returns 200 with `{"success": true, "data": {"status": "healthy"}}`

5. **Error Responses**
   - Invalid credentials return 401
   - Missing auth header returns 401
   - Invalid JWT returns 401
   - Super-admin-only routes return 403 for regular admins

---

## 5. Rollback Risk

### 5.1 Risk Level: **LOW**

**Justification:**
- The change is isolated to CORS header generation
- The inline dashboard makes same-origin requests, so CORS headers are not required for it to function
- The VPS-to-CF redirect flow uses full-page navigation (not CORS)
- If `ADMIN_ALLOWED_ORIGINS` is misconfigured, the dashboard itself still works (same-origin)
- The worst-case scenario is that some cross-origin integration breaks, but there is no known cross-origin integration in production

### 5.2 Rollback Procedure

**If the change causes issues:**

1. **Immediate Rollback via Git:**
   ```bash
   cd packages/admin-cf
   git revert <commit-hash>
   wrangler deploy --env qa
   ```

2. **Emergency Hotfix (restore wildcard):**
   - Edit `src/index.ts`
   - Replace `const corsHeaders = getCorsHeaders(request, env);` with:
     ```typescript
     const corsHeaders = {
       'Access-Control-Allow-Origin': '*',
       'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
       'Access-Control-Allow-Headers': 'Content-Type, Authorization',
       'Access-Control-Max-Age': '86400',
     };
     ```
   - Deploy: `wrangler deploy --env qa`

3. **Gradual Rollout:**
   - Deploy to QA first: `wrangler deploy --env qa`
   - Test thoroughly for 24-48 hours
   - Deploy to production: `wrangler deploy`

### 5.3 Mitigation Strategies

**To minimize rollback risk:**

1. **Default Allowlist Configuration:**
   - `wrangler.jsonc` includes sensible defaults for production and QA
   - Localhost is allowed for development

2. **Backward Compatibility:**
   - Same-origin requests continue to work without `ADMIN_ALLOWED_ORIGINS` set
   - Security headers are additive (won't break existing functionality)

3. **Comprehensive Testing:**
   - Unit tests cover all edge cases
   - E2E tests verify production-like scenarios
   - Manual testing confirms dashboard functionality

4. **Gradual Deployment:**
   - Deploy to QA environment first
   - Monitor for 24-48 hours before production deployment
   - Use Cloudflare Workers analytics to detect errors or traffic anomalies

---

## 6. Dependencies on Other Stories

### 6.1 Story 007: JWT Token in URL

**Relationship:** **COMPLEMENTARY**

- **Story 007** addresses token leakage via URL (in the VPS redirect flow)
- **Story 006** (this story) reduces the blast radius of leaked tokens by restricting CORS

**Coordination:**
- Both stories can be implemented independently
- Story 006 should be deployed first, as it reduces attack surface immediately
- Story 007 eliminates the root cause of token leakage in URLs

**Combined Impact:**
- Story 006 prevents token exfiltration from malicious sites (restricts CORS)
- Story 007 prevents token leakage in browser history/referer headers (removes token from URL)
- Together, they provide defense-in-depth

---

### 6.2 Story 008: Missing Security Headers

**Relationship:** **OVERLAPPING**

- **Story 008** proposes adding `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`, and CSP headers
- **Story 006** (this story) adds `X-Content-Type-Options` and `X-Frame-Options` as part of CORS utility

**Coordination:**
- Story 006 adds two of the headers proposed in Story 008
- Story 008 should be updated to remove `X-Content-Type-Options` and `X-Frame-Options` from its scope
- Story 008 should focus on adding:
  - `Strict-Transport-Security` (HSTS)
  - `Content-Security-Policy` (CSP)
  - `Referrer-Policy`
  - `Permissions-Policy`

**Implementation Note:**
- If Story 008 is implemented first, the CORS utility should skip adding `X-Content-Type-Options` and `X-Frame-Options` to avoid duplication
- If Story 006 is implemented first (recommended), Story 008 should build on top of it

---

### 6.3 Other Stories

**No Direct Dependencies:**
- Story 001-005: Bootstrap DDoS protection (server-side, unrelated to admin portal)
- Story 009-010: VPS admin portal issues (separate codebase)

---

## 7. Deployment Checklist

### Pre-Deployment

- [ ] All unit tests pass: `npm run test:unit`
- [ ] All E2E tests pass: `npm run test:e2e`
- [ ] Code review completed and approved
- [ ] `ADMIN_ALLOWED_ORIGINS` configured in `wrangler.jsonc` for QA and production
- [ ] Manual testing completed for all test cases in Section 4.3
- [ ] Rollback procedure documented and communicated to team

### QA Deployment

- [ ] Deploy to QA: `wrangler deploy --env qa`
- [ ] Verify health check: `curl https://admin.zajel.qa.hamzalabs.dev/health`
- [ ] Test same-origin dashboard functionality
- [ ] Test cross-origin request blocking (manual test case 3)
- [ ] Test VPS-to-CF redirect flow (manual test case 4)
- [ ] Monitor Cloudflare Workers analytics for errors (24-48 hours)

### Production Deployment

- [ ] Confirm QA testing successful (no regressions, no errors)
- [ ] Schedule deployment during low-traffic window
- [ ] Deploy to production: `wrangler deploy`
- [ ] Verify health check: `curl https://admin.zajel.hamzalabs.dev/health`
- [ ] Smoke test: Login, view servers, view users
- [ ] Monitor analytics for 1 hour post-deployment
- [ ] Announce deployment to team

### Post-Deployment

- [ ] Update Story 006 status to "Completed"
- [ ] Update Story 008 scope to exclude `X-Content-Type-Options` and `X-Frame-Options`
- [ ] Document CORS configuration in project wiki/docs
- [ ] Create GitHub issue or PR comment with before/after CORS behavior

---

## 8. Success Criteria

### Acceptance Criteria (from Story 006)

- [x] `Access-Control-Allow-Origin: *` is removed from all admin-cf responses
- [x] CORS origin is validated against a configurable allowlist (`ADMIN_ALLOWED_ORIGINS` environment variable)
- [x] `Vary: Origin` header is included when `Access-Control-Allow-Origin` is set to a specific origin
- [x] Requests from non-allowed origins receive responses without `Access-Control-Allow-Origin` (browser blocks cross-origin read)
- [x] Preflight `OPTIONS` responses respect the same origin allowlist
- [x] The inline dashboard (same-origin) continues to work without configuration changes
- [x] VPS-to-CF redirect flow continues to work (this uses full-page navigation, not CORS)
- [x] `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY` are added as security headers

### Additional Success Metrics

- **Security:**
  - Cross-origin API calls from malicious sites are blocked by browser CORS policy
  - Tokens cannot be exfiltrated via cross-origin fetch from `evil.example.com`

- **Functionality:**
  - Zero regressions in dashboard functionality
  - All E2E tests pass
  - Health check returns 200

- **Performance:**
  - No measurable performance impact (CORS header generation is lightweight)
  - Cloudflare Workers analytics show no increase in errors or latency

- **Documentation:**
  - `ADMIN_ALLOWED_ORIGINS` documented in wrangler.jsonc comments
  - CORS behavior documented in project README or wiki
  - Implementation plan marked as complete

---

## 9. Notes and Considerations

### 9.1 Why Not Use Access-Control-Allow-Credentials?

The VPS admin dashboard at `packages/server-vps/src/admin/routes.ts` includes `Access-Control-Allow-Credentials: true` (line 30). However, the CF admin dashboard does **not** need this header because:

1. **Cookies are not used for cross-origin auth:** Tokens are sent via `Authorization: Bearer <token>` headers from JavaScript, not cookies
2. **VPS uses cookies:** The VPS dashboard sets a cookie after extracting the token from the URL (routes.ts:52), which is why it needs `Access-Control-Allow-Credentials`
3. **CF admin is same-origin:** The inline dashboard makes same-origin requests, so credentials are automatically included without CORS

**Conclusion:** `Access-Control-Allow-Credentials` is **not** needed for the CF admin worker.

---

### 9.2 Why Not Use Strict-Transport-Security Here?

The `Strict-Transport-Security` (HSTS) header is proposed in Story 008. However, the bootstrap server's `cors.js` (line 33) already includes it:

```javascript
'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
```

For consistency, **Story 006 does NOT include HSTS** to avoid duplication with Story 008. If Story 008 is not implemented, HSTS should be added to the CORS utility in a follow-up commit.

---

### 9.3 Localhost Wildcard Pattern

The `http://localhost:*` pattern allows any port on localhost for development flexibility:
- `http://localhost:3000` (React dev server)
- `http://localhost:8787` (Wrangler dev server)
- `http://localhost:5173` (Vite dev server)

**Security Note:** This is safe for development because:
1. Localhost is only accessible from the local machine
2. Production uses HTTPS with specific domain names
3. The wildcard pattern explicitly checks `hostname === 'localhost'` and `protocol === 'http:'`

**Alternative Approach:** If strict security is required even in development, remove the wildcard pattern and require developers to set `ADMIN_ALLOWED_ORIGINS` in `.dev.vars`:
```
ADMIN_ALLOWED_ORIGINS=http://localhost:8787
```

---

### 9.4 Cache Poisoning Prevention

The `Vary: Origin` header is critical to prevent cache poisoning:
- Cloudflare's CDN caches responses based on URL by default
- If `Access-Control-Allow-Origin` varies per request (based on Origin header), the cache key must include the Origin
- `Vary: Origin` tells Cloudflare to cache separate responses for each origin

**Example Attack Without Vary:**
1. Attacker sends request from `https://evil.com` with `Origin: https://admin.zajel.hamzalabs.dev`
2. Server responds with `Access-Control-Allow-Origin: https://admin.zajel.hamzalabs.dev`
3. Response is cached by Cloudflare
4. Legitimate user from `https://admin.zajel.hamzalabs.dev` requests same URL
5. Cached response includes `Access-Control-Allow-Origin: https://admin.zajel.hamzalabs.dev`, allowing the attacker's origin
6. Attacker can now read cross-origin responses

**Mitigation:** `Vary: Origin` ensures each origin gets its own cached response.

---

### 9.5 Same-Origin Dashboard Behavior

The inline dashboard served from `/admin/` makes same-origin requests:
- Browser does **not** send `Origin` header for same-origin requests
- Server does **not** set `Access-Control-Allow-Origin` header (unnecessary for same-origin)
- Dashboard functionality is unaffected by CORS changes

**Testing Note:** E2E tests run from the same origin as the API, so they may not trigger CORS logic. Unit tests explicitly set the `Origin` header to test cross-origin scenarios.

---

## 10. Follow-Up Tasks

### Immediate (Part of This Story)
- [ ] Implement CORS utility module
- [ ] Update main handler to use CORS utility
- [ ] Add unit tests
- [ ] Update E2E tests
- [ ] Deploy to QA and test

### Short-Term (Next Sprint)
- [ ] Implement Story 007 (JWT Token in URL)
- [ ] Update Story 008 scope to exclude X-Content-Type-Options and X-Frame-Options
- [ ] Add HSTS header if Story 008 is delayed

### Long-Term (Future)
- [ ] Consider adding Content-Security-Policy (CSP) for inline dashboard
- [ ] Evaluate adding Referrer-Policy header
- [ ] Document CORS configuration in developer onboarding guide

---

**Plan Created:** 2026-03-03
**Plan Author:** Security Implementation Team
**Story Reference:** [Story 006: Fix Admin Portal CORS Wildcard](../stories/story-006-admin-cors-wildcard.md)
