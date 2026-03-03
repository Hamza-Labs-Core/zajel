# Story 008: Add Missing Security Headers

## Priority: THIS WEEK
## Severity: MEDIUM
## Component: packages/admin-cf, packages/server

## Summary

The admin dashboard served by `packages/admin-cf/src/index.ts` is missing critical HTTP security headers including `Content-Security-Policy`, `Referrer-Policy`, `Permissions-Policy`, and `X-Frame-Options`. The main server at `packages/server/src/cors.js` includes some headers (`X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`) but is also missing `Referrer-Policy` and `Content-Security-Policy`. The admin dashboard is particularly sensitive because it serves an inline HTML application with embedded JavaScript that handles JWT tokens.

## Current Behavior

### Admin CF Worker (`packages/admin-cf/src/index.ts`)

The dashboard HTML response at lines 956-961 sets only two headers:

```typescript
// index.ts:956-961
return new Response(html, {
  headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
  },
});
```

Missing headers:
- **No `Content-Security-Policy`**: The inline dashboard uses `<script type="module">` with inline JavaScript (lines 510-952). Without CSP, any injected script would execute. There is no protection against XSS via script injection.
- **No `Referrer-Policy`**: Defaults to the browser's default (`strict-origin-when-cross-origin` in modern browsers), which still sends the origin and path to external sites. This is especially dangerous when tokens are in URLs (Story 007), as the full URL including the token would be sent in `Referer` headers.
- **No `X-Frame-Options`**: The dashboard can be embedded in an iframe on any site, enabling clickjacking attacks.
- **No `X-Content-Type-Options`**: Missing, allowing MIME-type sniffing.
- **No `Strict-Transport-Security`**: The admin dashboard does not enforce HTTPS via HSTS.
- **No `Permissions-Policy`**: No restriction on browser features (camera, microphone, geolocation, etc.).

The CORS headers object at lines 30-35 does not include any security headers either. JSON API responses (via `jsonResponse()` at lines 967-980) include `Cache-Control: no-store` but no security headers.

### Bootstrap Server (`packages/server/src/cors.js`)

The server's CORS module includes some security headers (lines 26-34):

```javascript
// cors.js:26-34
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

Present: `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`, `Cache-Control`.
Missing: `Referrer-Policy`, `Content-Security-Policy`, `Permissions-Policy`.

### VPS Admin Dashboard (`packages/server-vps/src/admin/routes.ts`)

The VPS dashboard HTML response at lines 183-188 sets only:

```typescript
// routes.ts:183-188
res.writeHead(200, {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-cache',
});
```

Same missing headers as the CF admin dashboard. No security headers at all on the HTML response.

## Expected Behavior

All dashboard and API responses should include appropriate security headers:

1. **`Content-Security-Policy`**: Restrict script sources, style sources, connections, and frame ancestors.
2. **`Referrer-Policy: strict-origin-when-cross-origin`** (or stricter: `no-referrer` for admin pages).
3. **`X-Frame-Options: DENY`**: Prevent iframe embedding.
4. **`X-Content-Type-Options: nosniff`**: Prevent MIME sniffing.
5. **`Strict-Transport-Security: max-age=31536000; includeSubDomains`**: Enforce HTTPS.
6. **`Permissions-Policy`**: Disable unnecessary browser features.

## Root Cause Analysis

The admin-cf worker was implemented with inline HTML (the entire dashboard is a string in `serveDashboard()` at lines 151-961). Because the JavaScript is inline (within `<script type="module">` tags), adding a strict CSP requires either:
- Using `'unsafe-inline'` (defeats much of CSP's purpose), or
- Adding a `nonce` attribute to the script tag and including it in the CSP header.

The nonce approach is preferable. Since the HTML is generated server-side on every request (no static file caching), a fresh nonce can be generated per request.

The `Referrer-Policy` omission is particularly dangerous in combination with Story 007 (JWT tokens in URLs). Without `Referrer-Policy: no-referrer`, the full URL (including `?token=<jwt>`) is sent to any external resource loaded by the page. Even after Story 007 is fixed, a strict `Referrer-Policy` provides defense-in-depth.

The VPS dashboard (`routes.ts`) has the same issues with a separate inline HTML response (lines 194-1038).

## Affected Code

| File | Lines | Description |
|------|-------|-------------|
| `packages/admin-cf/src/index.ts` | 956-961 | Dashboard HTML response headers |
| `packages/admin-cf/src/index.ts` | 967-980 | `jsonResponse()` helper |
| `packages/admin-cf/src/index.ts` | 30-35 | CORS headers (no security headers) |
| `packages/admin-cf/src/index.ts` | 38-40 | Preflight response |
| `packages/server/src/cors.js` | 26-34 | Server CORS headers (partial security headers) |
| `packages/server-vps/src/admin/routes.ts` | 183-188 | VPS dashboard HTML response headers |
| `packages/server-vps/src/admin/auth.ts` | 134-139 | `sendJson()` response headers |

## Reproduction Steps

1. Open the admin dashboard in a browser.
2. Open DevTools -> Network tab.
3. Inspect the response headers for the HTML document request.
4. Observe the absence of `Content-Security-Policy`, `Referrer-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, and `Strict-Transport-Security`.
5. Create a page on another domain that iframes the admin dashboard: `<iframe src="https://<admin-url>/admin/"></iframe>`.
6. Observe that the iframe loads successfully (no `X-Frame-Options` protection).
7. If the admin has a token in localStorage, the iframe could potentially perform actions.

## Impact Assessment

- **XSS amplification**: Without CSP, any XSS vulnerability (e.g., from a future code change that fails to escape user input) would have full access to the page's JavaScript context, including the JWT token in localStorage.
- **Clickjacking**: The admin dashboard can be embedded in an iframe and overlaid with a deceptive UI, tricking admins into clicking buttons (delete users, etc.).
- **Token leakage via Referer**: Without `Referrer-Policy: no-referrer`, tokens in URLs (Story 007) are sent to external sites via the `Referer` header.
- **MIME sniffing attacks**: Without `X-Content-Type-Options: nosniff`, a response could be reinterpreted as a different content type.
- **Protocol downgrade**: Without HSTS, an attacker could intercept the first request and downgrade from HTTPS to HTTP.

## Proposed Fix

### 1. Admin CF Dashboard (index.ts)

Update `serveDashboard()` to include security headers with a CSP nonce:

```typescript
function serveDashboard(): Response {
  // Generate a per-request nonce for CSP
  const nonce = btoa(String.fromCharCode(
    ...crypto.getRandomValues(new Uint8Array(16))
  ));

  // Insert nonce into the script tag
  const html = getDashboardHtml().replace(
    '<script type="module">',
    `<script type="module" nonce="${nonce}">`
  );

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      'Content-Security-Policy': [
        `default-src 'none'`,
        `script-src 'nonce-${nonce}'`,
        `style-src 'unsafe-inline'`,  // Inline styles in the HTML
        `connect-src 'self'`,
        `frame-ancestors 'none'`,
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

### 2. Admin CF API Responses

Add security headers to the `jsonResponse()` helper and the CORS headers object:

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

### 3. Bootstrap Server (cors.js)

Add the missing headers:

```javascript
const headers = {
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Expose-Headers': 'X-Bootstrap-Signature, X-Attestation-Token',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Referrer-Policy': 'no-referrer',                          // NEW
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',  // NEW
};
```

### 4. VPS Dashboard (routes.ts)

Apply the same nonce-based CSP and security headers to the VPS dashboard HTML response. Also add headers to `sendJson()` in `auth.ts`.

## Acceptance Criteria

- [ ] Admin CF dashboard HTML response includes `Content-Security-Policy` with a per-request nonce for inline scripts
- [ ] Admin CF dashboard HTML response includes `Referrer-Policy: no-referrer`
- [ ] Admin CF dashboard HTML response includes `X-Frame-Options: DENY`
- [ ] Admin CF dashboard HTML response includes `X-Content-Type-Options: nosniff`
- [ ] Admin CF dashboard HTML response includes `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- [ ] Admin CF dashboard HTML response includes `Permissions-Policy` disabling unnecessary features
- [ ] Admin CF API (JSON) responses include `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and `Strict-Transport-Security`
- [ ] Bootstrap server (`cors.js`) includes `Referrer-Policy: no-referrer` and `Permissions-Policy`
- [ ] VPS admin dashboard includes the same security headers as the CF admin dashboard
- [ ] CSP does not break the inline JavaScript functionality (nonce correctly applied)
- [ ] CSP `connect-src` allows `'self'` for API calls and WebSocket connections from the VPS dashboard

## Test Requirements

- **Unit test**: Dashboard HTML response includes all required security headers.
- **Unit test**: CSP header contains a valid nonce that matches the script tag's nonce attribute.
- **Unit test**: Each request generates a unique nonce (not reused).
- **Unit test**: JSON API responses include security headers.
- **Unit test**: Bootstrap server responses include `Referrer-Policy` and `Permissions-Policy`.
- **E2E test**: Admin dashboard loads and functions correctly with CSP enabled (no console errors about blocked resources).
- **E2E test**: Attempting to iframe the admin dashboard fails (frame-ancestors 'none').
- **Browser test**: Verify that `Referer` header is not sent when navigating away from the admin dashboard (Referrer-Policy: no-referrer).

## Dependencies

- Story 006 (Admin CORS Wildcard): Security headers should be added alongside the CORS fix. The headers can be part of the CORS headers object.
- Story 007 (JWT Token in URL): `Referrer-Policy: no-referrer` provides defense-in-depth against token leakage. Should be deployed before or simultaneously with Story 007.
