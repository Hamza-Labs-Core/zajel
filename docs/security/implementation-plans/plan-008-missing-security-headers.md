# Implementation Plan 008: Add Missing Security Headers

**Story:** [Story 008: Add Missing Security Headers](../stories/story-008-missing-security-headers.md)
**Priority:** THIS WEEK
**Severity:** MEDIUM
**Estimated Effort:** 4-6 hours
**Created:** 2026-03-03

---

## 1. Summary

This plan addresses the missing HTTP security headers in the admin dashboards and bootstrap server. The admin dashboard served by `packages/admin-cf/src/index.ts` lacks critical security headers including `Content-Security-Policy`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, and `Strict-Transport-Security`. The VPS admin dashboard at `packages/server-vps/src/admin/routes.ts` has the same issues. The bootstrap server at `packages/server/src/cors.js` has some security headers but is missing `Referrer-Policy`, `Content-Security-Policy`, and `Permissions-Policy`.

The implementation will:
1. Add CSP with nonce-based inline script support to both admin dashboards
2. Add comprehensive security headers to all HTML and API responses
3. Enhance the bootstrap server's CORS module with missing headers
4. Add unit and E2E tests to verify headers are present and correct

---

## 2. Files to Modify

All paths are absolute from repository root `/home/meywd/zajel-ddos/`:

| File | Lines | Modification Type |
|------|-------|-------------------|
| `packages/admin-cf/src/index.ts` | 151-961 | Modify `serveDashboard()` to add CSP with nonce |
| `packages/admin-cf/src/index.ts` | 967-980 | Modify `jsonResponse()` to add security headers |
| `packages/admin-cf/src/index.ts` | 30-35 | Modify `corsHeaders` to include security headers |
| `packages/server/src/cors.js` | 26-34 | Add missing headers to `getCorsHeaders()` |
| `packages/server-vps/src/admin/routes.ts` | 182-188 | Modify `serveDashboard()` to add CSP with nonce |
| `packages/server-vps/src/admin/auth.ts` | 134-139 | Modify `sendJson()` to add security headers |
| `packages/admin-cf/tests/e2e/admin-e2e.test.ts` | New section | Add security headers verification tests |
| `packages/server/tests/e2e/bootstrap.test.js` | New section | Add security headers verification tests |

---

## 3. Implementation Steps

### 3.1 Admin CF Dashboard HTML Response

**File:** `packages/admin-cf/src/index.ts`
**Lines:** 151-961

**Current Code:**
```typescript
function serveDashboard(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Zajel Admin Dashboard</title>
  <style>
    /* ... styles ... */
  </style>
</head>
<body>
  <!-- ... dashboard HTML ... -->
  <script type="module">
    // State
    let state = {
      user: null,
      token: null,
      // ... more state ...
    };
    // ... JavaScript code ...
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}
```

**New Code:**
```typescript
function serveDashboard(): Response {
  // Generate a per-request nonce for CSP (16 bytes = 128 bits of entropy)
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = btoa(String.fromCharCode(...nonceBytes));

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Zajel Admin Dashboard</title>
  <style>
    /* ... styles ... */
  </style>
</head>
<body>
  <!-- ... dashboard HTML ... -->
  <script type="module" nonce="${nonce}">
    // State
    let state = {
      user: null,
      token: null,
      // ... more state ...
    };
    // ... JavaScript code ...
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      'Content-Security-Policy': [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        "style-src 'unsafe-inline'",  // Inline styles in <style> tag
        "connect-src 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    },
  });
}
```

**Changes:**
- Generate a cryptographically random nonce per request using `crypto.getRandomValues()`
- Inject nonce into the `<script type="module">` tag
- Add `Content-Security-Policy` header with nonce-based script execution
- Set `default-src 'none'` to deny all by default
- Allow styles via `'unsafe-inline'` (required for inline `<style>` tag)
- Allow `connect-src 'self'` for same-origin API calls
- Set `frame-ancestors 'none'` to prevent embedding (redundant with `X-Frame-Options` but CSP-compliant)
- Add `Referrer-Policy: no-referrer` to prevent URL leakage
- Add `X-Frame-Options: DENY` for clickjacking protection
- Add `X-Content-Type-Options: nosniff` to prevent MIME sniffing
- Add `Strict-Transport-Security` for HTTPS enforcement
- Add `Permissions-Policy` to disable unnecessary browser features
- Upgrade `Cache-Control` from `no-cache` to `no-cache, no-store`

### 3.2 Admin CF API JSON Responses

**File:** `packages/admin-cf/src/index.ts`
**Lines:** 967-980

**Current Code:**
```typescript
function jsonResponse<T>(
  data: { success: boolean; data?: T; error?: string },
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}
```

**New Code:**
```typescript
function jsonResponse<T>(
  data: { success: boolean; data?: T; error?: string },
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      ...extraHeaders,
    },
  });
}
```

**Changes:**
- Add `X-Content-Type-Options: nosniff` to prevent MIME type sniffing
- Add `X-Frame-Options: DENY` for consistency (JSON responses shouldn't be framed anyway)
- Add `Referrer-Policy: no-referrer` to prevent URL leakage from API responses
- Add `Strict-Transport-Security` to enforce HTTPS

**Note:** `Content-Security-Policy` is not needed for JSON responses. `Permissions-Policy` is also not critical for API responses.

### 3.3 Admin CF CORS Headers (Preflight Responses)

**File:** `packages/admin-cf/src/index.ts`
**Lines:** 30-40

**Current Code:**
```typescript
// CORS headers for dashboard
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

// Handle CORS preflight
if (method === 'OPTIONS') {
  return new Response(null, { status: 204, headers: corsHeaders });
}
```

**New Code:**
```typescript
// CORS headers for dashboard
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',  // Will be fixed in Story 006
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

// Handle CORS preflight
if (method === 'OPTIONS') {
  return new Response(null, { status: 204, headers: corsHeaders });
}
```

**Changes:**
- Add security headers to the `corsHeaders` object
- These headers will be included in preflight `OPTIONS` responses
- Add a comment noting that Story 006 will fix the wildcard origin

**Note:** The `corsHeaders` object is also merged into non-preflight responses at lines 108-116, so this change will add security headers to all responses that use this merge.

### 3.4 Bootstrap Server CORS Headers

**File:** `packages/server/src/cors.js`
**Lines:** 26-34

**Current Code:**
```javascript
const headers = {
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Expose-Headers': 'X-Bootstrap-Signature, X-Attestation-Token',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};
```

**New Code:**
```javascript
const headers = {
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Expose-Headers': 'X-Bootstrap-Signature, X-Attestation-Token',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};
```

**Changes:**
- Add `Referrer-Policy: no-referrer` to prevent URL leakage
- Add `Permissions-Policy` to disable unnecessary browser features

**Note:** The bootstrap server primarily serves JSON API responses, not HTML, so `Content-Security-Policy` is not needed. The CSP would only be relevant if the server served HTML pages.

### 3.5 VPS Admin Dashboard HTML Response

**File:** `packages/server-vps/src/admin/routes.ts`
**Lines:** 182-188, 194-1038

**Current Code:**
```typescript
private serveDashboard(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(getDashboardHtml(this.config.cfAdminUrl));
}
```

And later (line 194+):
```typescript
function getDashboardHtml(cfAdminUrl?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Zajel VPS Dashboard</title>
  <style>
    /* ... styles ... */
  </style>
</head>
<body>
  <!-- ... dashboard HTML ... -->
  <script type="module">
    // CF Admin URL for authentication redirect
    const CF_ADMIN_URL = ${JSON.stringify(cfAdminUrl || null)};
    // ... JavaScript code ...
  </script>
</body>
</html>`;
}
```

**New Code:**
```typescript
private serveDashboard(res: ServerResponse): void {
  // Generate a per-request nonce for CSP (16 bytes = 128 bits of entropy)
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Buffer.from(nonceBytes).toString('base64');

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    'Content-Security-Policy': [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'unsafe-inline'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  });
  res.end(getDashboardHtml(this.config.cfAdminUrl, nonce));
}
```

And update `getDashboardHtml()`:
```typescript
function getDashboardHtml(cfAdminUrl?: string, nonce?: string): string {
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Zajel VPS Dashboard</title>
  <style>
    /* ... styles ... */
  </style>
</head>
<body>
  <!-- ... dashboard HTML ... -->
  <script type="module"${nonceAttr}>
    // CF Admin URL for authentication redirect
    const CF_ADMIN_URL = ${JSON.stringify(cfAdminUrl || null)};
    // ... JavaScript code ...
  </script>
</body>
</html>`;
}
```

**Changes:**
- Generate a cryptographically random nonce using Node.js `crypto.getRandomValues()` and `Buffer.toString('base64')`
- Pass the nonce to `getDashboardHtml()` as a parameter
- Inject the nonce into the `<script type="module">` tag
- Add all security headers matching the CF admin dashboard
- Upgrade `Cache-Control` from `no-cache` to `no-cache, no-store`

**Note:** VPS dashboard uses WebSocket for live updates, so `connect-src 'self'` must allow WebSocket connections to the same origin.

### 3.6 VPS Admin JSON Responses

**File:** `packages/server-vps/src/admin/auth.ts`
**Lines:** 134-139

**Current Code:**
```typescript
export function sendJson<T>(
  res: ServerResponse,
  data: ApiResponse<T>,
  status = 200,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(data));
}
```

**New Code:**
```typescript
export function sendJson<T>(
  res: ServerResponse,
  data: ApiResponse<T>,
  status = 200,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    ...headers,
  });
  res.end(JSON.stringify(data));
}
```

**Changes:**
- Add the same security headers as the CF admin's `jsonResponse()` helper

---

## 4. Test Plan

### 4.1 Unit Tests for Admin CF

**File:** `packages/admin-cf/tests/e2e/admin-e2e.test.ts`
**New Section:** Add at the end of the test file

```typescript
describe('Security Headers', () => {
  it('should include all security headers on dashboard HTML response', async () => {
    const response = await fetch(`${BASE_URL}/admin/`, {
      method: 'GET',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
    expect(response.headers.get('Permissions-Policy')).toContain('camera=()');
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });

  it('should include CSP header with nonce on dashboard HTML response', async () => {
    const response = await fetch(`${BASE_URL}/admin/`, {
      method: 'GET',
    });

    const csp = response.headers.get('Content-Security-Policy');
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");

    // Extract nonce from CSP header
    const nonceMatch = csp.match(/script-src 'nonce-([^']+)'/);
    expect(nonceMatch).toBeTruthy();
    const nonce = nonceMatch![1];
    expect(nonce.length).toBeGreaterThan(16); // Base64 encoded 16 bytes = ~24 chars

    // Verify the nonce is in the script tag
    const html = await response.text();
    expect(html).toContain(`<script type="module" nonce="${nonce}">`);
  });

  it('should generate unique nonces per request', async () => {
    const response1 = await fetch(`${BASE_URL}/admin/`);
    const response2 = await fetch(`${BASE_URL}/admin/`);

    const csp1 = response1.headers.get('Content-Security-Policy')!;
    const csp2 = response2.headers.get('Content-Security-Policy')!;

    const nonce1 = csp1.match(/script-src 'nonce-([^']+)'/)![1];
    const nonce2 = csp2.match(/script-src 'nonce-([^']+)'/)![1];

    expect(nonce1).not.toBe(nonce2);
  });

  it('should include security headers on API JSON responses', async () => {
    // Login to get a token
    const loginResponse = await client.login(
      SUPER_ADMIN_CREDS.username,
      SUPER_ADMIN_CREDS.password
    );
    expect(loginResponse.success).toBe(true);

    // Check headers on verify endpoint
    const verifyResponse = await fetch(`${BASE_URL}/admin/verify`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${loginResponse.data!.token}`,
      },
    });

    expect(verifyResponse.status).toBe(200);
    expect(verifyResponse.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(verifyResponse.headers.get('X-Frame-Options')).toBe('DENY');
    expect(verifyResponse.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(verifyResponse.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
    expect(verifyResponse.headers.get('Cache-Control')).toBe('no-store');
  });

  it('should include security headers on CORS preflight responses', async () => {
    const response = await fetch(`${BASE_URL}/admin/login`, {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://example.com',
        'Access-Control-Request-Method': 'POST',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
  });
});
```

### 4.2 Unit Tests for Bootstrap Server

**File:** `packages/server/tests/e2e/bootstrap.test.js`
**New Section:** Add at the end of the test file

```javascript
describe('Security Headers', () => {
  it('should include Referrer-Policy on API responses', async () => {
    const request = createRequest('GET', '/health');
    const response = await worker.fetch(request, env);

    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('should include Permissions-Policy on API responses', async () => {
    const request = createRequest('GET', '/health');
    const response = await worker.fetch(request, env);

    const permissionsPolicy = response.headers.get('Permissions-Policy');
    expect(permissionsPolicy).toBeTruthy();
    expect(permissionsPolicy).toContain('camera=()');
    expect(permissionsPolicy).toContain('microphone=()');
    expect(permissionsPolicy).toContain('geolocation=()');
  });

  it('should include all security headers on server registration', async () => {
    const serverData = {
      serverId: 'ed25519:test-server-headers',
      endpoint: 'wss://test-headers.example.com',
      publicKey: 'base64-public-key-data',
      region: 'us-east',
    };

    const request = createRequest('POST', '/servers', serverData);
    const response = await serverRegistry.fetch(request);

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Permissions-Policy')).toBeTruthy();
  });
});
```

### 4.3 Manual Testing for VPS Dashboard

Since there are no automated E2E tests for the VPS admin dashboard, manual testing is required:

1. **Start the VPS server locally:**
   ```bash
   cd packages/server-vps
   npm run dev
   ```

2. **Open the VPS dashboard in a browser:**
   ```
   http://localhost:8080/admin/
   ```

3. **Open DevTools -> Network tab and inspect the HTML response headers:**
   - Verify `Content-Security-Policy` is present with a nonce
   - Verify `Referrer-Policy: no-referrer`
   - Verify `X-Frame-Options: DENY`
   - Verify `X-Content-Type-Options: nosniff`
   - Verify `Strict-Transport-Security` is present
   - Verify `Permissions-Policy` is present

4. **Inspect the HTML source:**
   - Find the `<script type="module">` tag
   - Verify it has a `nonce="..."` attribute
   - Copy the nonce value and verify it matches the nonce in the CSP header

5. **Check the browser console:**
   - Verify there are no CSP violation errors
   - Verify the dashboard loads and functions correctly

6. **Test API responses:**
   - Authenticate and make an API call (e.g., GET `/admin/metrics`)
   - Inspect the response headers
   - Verify `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and `Strict-Transport-Security` are present

7. **Test iframe embedding (should fail):**
   - Create a test HTML file on a different origin:
     ```html
     <!DOCTYPE html>
     <html>
     <body>
       <iframe src="http://localhost:8080/admin/"></iframe>
     </body>
     </html>
     ```
   - Open this file in a browser
   - Verify that the iframe does not load due to `X-Frame-Options: DENY` or CSP `frame-ancestors 'none'`
   - Check the browser console for a frame blocking error

### 4.4 Test Cases Summary

| Test Case | Component | Type | Description |
|-----------|-----------|------|-------------|
| Dashboard HTML headers | Admin CF | Unit | Verify all security headers on HTML response |
| CSP with nonce | Admin CF | Unit | Verify CSP header includes nonce matching script tag |
| Unique nonces | Admin CF | Unit | Verify each request gets a unique nonce |
| API JSON headers | Admin CF | Unit | Verify security headers on API responses |
| CORS preflight headers | Admin CF | Unit | Verify security headers on OPTIONS responses |
| Bootstrap Referrer-Policy | Server | Unit | Verify Referrer-Policy header |
| Bootstrap Permissions-Policy | Server | Unit | Verify Permissions-Policy header |
| Bootstrap all headers | Server | Unit | Verify all security headers on API responses |
| VPS dashboard HTML headers | Server-VPS | Manual | Verify all security headers on VPS HTML response |
| VPS CSP with nonce | Server-VPS | Manual | Verify CSP nonce in header and script tag |
| VPS API JSON headers | Server-VPS | Manual | Verify security headers on VPS API responses |
| Iframe blocking | Admin CF, VPS | Manual | Verify dashboard cannot be embedded in iframe |
| Dashboard functionality | Admin CF, VPS | Manual | Verify CSP doesn't break dashboard JavaScript |

---

## 5. Rollback Risk

**Risk Level:** LOW-MEDIUM

### Potential Issues

1. **CSP Blocking Legitimate Resources:**
   - **Risk:** If the CSP is too strict or the nonce is not correctly applied, the inline JavaScript will be blocked and the dashboard will break.
   - **Mitigation:** The implementation uses `'nonce-${nonce}'` and injects the same nonce into the script tag. This is a well-established pattern. The use of `'unsafe-inline'` for styles is necessary for the inline `<style>` tag.
   - **Rollback:** If the CSP breaks the dashboard, remove the `Content-Security-Policy` header and the nonce attribute from the script tag. The dashboard will revert to working without CSP protection.

2. **connect-src Blocking API Calls or WebSocket:**
   - **Risk:** The VPS dashboard uses WebSocket for live updates. If `connect-src 'self'` doesn't cover the WebSocket protocol, connections will fail.
   - **Mitigation:** `'self'` should cover both HTTP(S) and WS(S) connections to the same origin. Test WebSocket connectivity after deployment.
   - **Rollback:** If WebSocket connections fail, add `ws:` or `wss:` to the `connect-src` directive, or temporarily remove the CSP.

3. **HSTS Preload Issues:**
   - **Risk:** `Strict-Transport-Security` enforces HTTPS. If the admin dashboard is accidentally accessed over HTTP, the browser will refuse to connect after the first HTTPS visit.
   - **Mitigation:** The admin dashboard should always be served over HTTPS in production. The header includes `max-age=31536000` (1 year), which is standard but not preloaded.
   - **Rollback:** If HSTS causes issues, remove the `Strict-Transport-Security` header. Existing clients will need to wait for the max-age to expire (or clear browser HSTS cache).

4. **Referrer-Policy Breaking Analytics or Debugging:**
   - **Risk:** `Referrer-Policy: no-referrer` prevents the `Referer` header from being sent. Some logging or analytics tools rely on the `Referer` header.
   - **Mitigation:** The admin dashboard does not use external analytics. Internal logging should not depend on the `Referer` header.
   - **Rollback:** If needed, change to `Referrer-Policy: strict-origin-when-cross-origin` (which still prevents token leakage but sends the origin for same-origin requests).

5. **Permissions-Policy Not Recognized:**
   - **Risk:** Older browsers may not recognize the `Permissions-Policy` header and could log warnings.
   - **Mitigation:** The header is safely ignored by older browsers. Modern browsers will respect it.
   - **Rollback:** Remove the `Permissions-Policy` header if it causes issues (unlikely).

### Rollback Plan

1. **Immediate Rollback (within 1 hour of deployment):**
   - Revert the git commit that added security headers
   - Redeploy the previous version
   - Monitor for any lingering client-side HSTS issues (should be minimal within 1 hour)

2. **Partial Rollback (if specific headers cause issues):**
   - Remove only the problematic header (e.g., CSP or HSTS)
   - Keep the other headers in place
   - Redeploy with the modified header set

3. **Gradual Rollout (recommended for production):**
   - Deploy to a staging/QA environment first
   - Test all dashboard functionality, including WebSocket connections
   - Monitor browser console for CSP violations
   - Deploy to production only after successful QA

### Success Criteria Before Considering Rollback

- Dashboard HTML loads without console errors
- Inline JavaScript executes correctly (state management, API calls, UI updates)
- WebSocket connections (VPS dashboard) establish successfully
- API calls return expected data with security headers
- No user reports of broken functionality
- Security scanners (e.g., securityheaders.com) show improved scores

---

## 6. Dependencies on Other Stories

### 6.1 Story 006: Fix Admin Portal CORS Wildcard

**Relationship:** COMPLEMENTARY (can be done in parallel)

- Story 006 fixes `Access-Control-Allow-Origin: *` to use origin allowlisting
- Story 008 adds security headers including `Referrer-Policy` and CSP
- The two stories modify overlapping code in `packages/admin-cf/src/index.ts` (the `corsHeaders` object)
- **Merge Strategy:** If both are implemented in parallel, Story 006 should merge first. Story 008 can then rebase and add security headers to the updated CORS implementation.
- **No Blocking Dependency:** The security headers added in Story 008 do not depend on the CORS fix. However, deploying both together provides better overall security.

### 6.2 Story 007: Remove JWT Token from URL Query Parameters

**Relationship:** DEFENSE-IN-DEPTH (should deploy together or Story 008 first)

- Story 007 removes JWT tokens from URL query parameters
- Story 008 adds `Referrer-Policy: no-referrer` to prevent token leakage via `Referer` headers
- **Deployment Order:** Story 008 should be deployed BEFORE or simultaneously with Story 007. If Story 007 is deployed first, there is a window where tokens in URLs (if any remain during rollout) are still sent via `Referer` headers.
- **Combined Benefit:** `Referrer-Policy: no-referrer` provides defense-in-depth even after Story 007 is deployed, protecting against future regressions or other sensitive data in URLs.

### 6.3 No Other Dependencies

- Story 001 (Federation Reconnect Bug): No dependency
- Story 002 (Trusted Keys Deny Default): No dependency
- Story 003 (Attestation Log Leakage): No dependency
- Story 004 (Registry Secret Bypass): No dependency
- Story 005 (Heartbeat Replay Protection): No dependency
- Story 009 (Key Read Audit Log): No dependency

---

## 7. Implementation Checklist

- [ ] Modify `packages/admin-cf/src/index.ts` to add CSP with nonce to `serveDashboard()`
- [ ] Modify `packages/admin-cf/src/index.ts` to add security headers to `jsonResponse()`
- [ ] Modify `packages/admin-cf/src/index.ts` to add security headers to `corsHeaders`
- [ ] Modify `packages/server/src/cors.js` to add `Referrer-Policy` and `Permissions-Policy`
- [ ] Modify `packages/server-vps/src/admin/routes.ts` to add CSP with nonce to `serveDashboard()`
- [ ] Modify `packages/server-vps/src/admin/routes.ts` to update `getDashboardHtml()` signature to accept nonce
- [ ] Modify `packages/server-vps/src/admin/auth.ts` to add security headers to `sendJson()`
- [ ] Add unit tests to `packages/admin-cf/tests/e2e/admin-e2e.test.ts` for security headers
- [ ] Add unit tests to `packages/server/tests/e2e/bootstrap.test.js` for security headers
- [ ] Run admin CF tests: `cd packages/admin-cf && npm test`
- [ ] Run server tests: `cd packages/server && npm test`
- [ ] Manually test VPS dashboard with DevTools
- [ ] Manually test iframe blocking on both dashboards
- [ ] Verify no console errors on dashboards after CSP is applied
- [ ] Test WebSocket connections on VPS dashboard still work
- [ ] Deploy to staging/QA environment
- [ ] Run E2E tests on staging
- [ ] Security scan with securityheaders.com or similar tool
- [ ] Deploy to production
- [ ] Monitor error logs for CSP violations or failed requests
- [ ] Verify dashboards are functional in production

---

## 8. Estimated Timeline

| Phase | Duration | Description |
|-------|----------|-------------|
| Implementation | 2-3 hours | Code changes across 4 files |
| Unit Tests | 1 hour | Write and verify tests for admin CF and server |
| Manual Testing | 1 hour | Test VPS dashboard and iframe blocking |
| Code Review | 30 min | Review PR, address feedback |
| Staging Deployment | 15 min | Deploy to QA, run E2E tests |
| Production Deployment | 15 min | Deploy to production, monitor |
| **Total** | **4-6 hours** | End-to-end implementation and deployment |

---

## 9. References

- [MDN: Content-Security-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [MDN: Referrer-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Referrer-Policy)
- [MDN: X-Frame-Options](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Frame-Options)
- [MDN: Strict-Transport-Security](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Strict-Transport-Security)
- [OWASP: Secure Headers Project](https://owasp.org/www-project-secure-headers/)
- [CSP Nonce Best Practices](https://csp.withgoogle.com/docs/adopting-csp.html)

---

## 10. Notes

- The nonce generation uses `crypto.getRandomValues()` which provides cryptographically secure random bytes. In the Admin CF worker (Cloudflare Workers runtime), `crypto.getRandomValues()` is available globally. In the VPS server (Node.js), `crypto.getRandomValues()` is available via the global `crypto` object (Node 16+).
- The use of `btoa()` in the CF worker and `Buffer.toString('base64')` in Node.js both produce base64-encoded strings from byte arrays. These are equivalent and safe for CSP nonces.
- `'unsafe-inline'` for `style-src` is necessary because both dashboards have inline `<style>` tags. To eliminate `'unsafe-inline'`, we would need to move styles to external files or use nonces for styles as well. This is out of scope for this story.
- `frame-ancestors 'none'` in CSP is the modern replacement for `X-Frame-Options: DENY`. We include both for compatibility with older browsers.
- The `Permissions-Policy` header disables camera, microphone, geolocation, and payment features. The admin dashboards do not use any of these browser APIs, so this is a defense-in-depth measure.
