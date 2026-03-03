# Story 006: Fix Admin Portal CORS Wildcard

## Priority: THIS WEEK
## Severity: HIGH
## Component: packages/admin-cf

## Summary

The Cloudflare Workers admin dashboard (`packages/admin-cf/src/index.ts`) sets `Access-Control-Allow-Origin: *` on all API responses, allowing any website on the internet to make authenticated cross-origin requests to the admin API. Combined with the fact that JWT tokens are stored in `localStorage` and sent via `Authorization` headers (not cookies), any malicious page the admin visits could exfiltrate the token from the response or perform actions on behalf of the admin.

## Current Behavior

In `packages/admin-cf/src/index.ts`, lines 30-35, the CORS headers are hardcoded with a wildcard origin:

```typescript
// index.ts:30-35
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};
```

These headers are applied to every response:
- Preflight `OPTIONS` responses (line 38-40)
- All API responses via the `newHeaders` merge at lines 108-116
- Error responses (line 119-123)
- Health check responses (line 47-56)

Meanwhile, the main bootstrap server at `packages/server/src/cors.js` properly implements origin-allowlisting with `getCorsHeaders()` (lines 22-42), checking against an `ALLOWED_ORIGINS` environment variable. The admin-cf worker does not use this pattern at all.

JWT tokens are stored in the browser's `localStorage` (line 623: `localStorage.setItem('zajel_admin_token', state.token)`) and sent as `Authorization: Bearer <token>` headers on every API call (lines 585, 600, 667, 693). Because `localStorage` is not automatically sent cross-origin (unlike cookies), the direct risk is not automatic CSRF, but rather:

1. A malicious site can probe admin API responses since `Access-Control-Allow-Origin: *` allows reading cross-origin responses.
2. If combined with any XSS vector or token-in-URL leakage (see Story 007), the wildcard CORS allows the attacking origin to use the stolen token freely.

The VPS admin dashboard at `packages/server-vps/src/admin/routes.ts` handles CORS more carefully: it only sets `Access-Control-Allow-Origin` to the specific `cfAdminUrl` when configured (lines 28-31), and never falls back to `*`.

## Expected Behavior

1. The admin-cf worker should only allow cross-origin requests from known, trusted origins.
2. The `Access-Control-Allow-Origin` header should be set to the requesting origin only when it matches an allowlist.
3. The allowlist should be configurable via an environment variable (e.g., `ADMIN_ALLOWED_ORIGINS`).
4. The `Vary: Origin` header must be included when the `Access-Control-Allow-Origin` value changes per request (to prevent CDN/cache poisoning).
5. If no matching origin is found, the response should omit the `Access-Control-Allow-Origin` header entirely.

## Root Cause Analysis

The admin-cf worker was built as a self-contained Cloudflare Worker that serves both the inline HTML dashboard and the API endpoints from the same origin. For same-origin requests from the inline dashboard, CORS headers are technically unnecessary. The wildcard was likely added for development convenience or to support the VPS-to-CF cross-origin flow (where VPS dashboards redirect to the CF admin for authentication).

The flow works like this:
1. User visits VPS dashboard at `https://<vps-ip>/admin/`
2. VPS dashboard redirects to CF admin: `CF_ADMIN_URL + '/admin/?redirect=' + returnUrl` (routes.ts:777)
3. User authenticates on CF admin
4. CF admin redirects back to VPS with token in URL: `url.searchParams.set('token', state.token)` (index.ts:552, 633)
5. VPS admin extracts token from URL and sets a cookie (routes.ts:44-54)

This cross-origin redirect flow does not actually require CORS -- it uses full-page redirects with tokens in URLs (a separate problem addressed in Story 007). The wildcard CORS is therefore unnecessary for the intended architecture but opens a vulnerability surface.

The `Access-Control-Allow-Credentials: true` header is notably absent from the CF admin (it IS present on the VPS side at routes.ts:30), which means cookies are not sent cross-origin. However, since tokens are sent via `Authorization` headers from JavaScript, any page that obtains the token can call the API with it from any origin.

## Affected Code

| File | Lines | Description |
|------|-------|-------------|
| `packages/admin-cf/src/index.ts` | 30-35 | Wildcard CORS headers definition |
| `packages/admin-cf/src/index.ts` | 38-40 | Preflight response with wildcard |
| `packages/admin-cf/src/index.ts` | 108-116 | Wildcard applied to all API responses |
| `packages/admin-cf/src/index.ts` | 119-123 | Wildcard applied to error responses |
| `packages/admin-cf/src/index.ts` | 47-56 | Wildcard applied to health check |

## Reproduction Steps

1. Deploy the admin-cf worker and create an admin user.
2. Log in to the admin dashboard and note the JWT token in `localStorage`.
3. Open a different website (e.g., `http://evil.example.com`).
4. From that site's JavaScript console, run:
   ```javascript
   fetch('https://<admin-cf-url>/admin/api/servers', {
     headers: { 'Authorization': 'Bearer <stolen-token>' }
   }).then(r => r.json()).then(console.log);
   ```
5. Observe that the response is readable cross-origin due to `Access-Control-Allow-Origin: *`.
6. The attacker can read server lists, user lists, and perform admin actions.

## Impact Assessment

- **Information disclosure**: Any website can read admin API responses if it possesses a valid JWT token. Server topology, user lists, and health metrics can be exfiltrated.
- **Privilege escalation**: Combined with token leakage (Story 007), an attacker who captures a token from a `Referer` header or browser history can use it from any origin.
- **Admin action execution**: User creation, user deletion, and other admin operations can be performed cross-origin.
- **Blast radius**: All admin-cf deployments are affected. The wildcard is hardcoded, not configurable.

## Proposed Fix

Replace the hardcoded wildcard with origin-based CORS, similar to the pattern in `packages/server/src/cors.js`:

```typescript
function getCorsHeaders(request: Request, env: Env): Record<string, string> {
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

function isOriginAllowed(origin: string, env: Env): boolean {
  // Parse from environment, e.g., comma-separated list
  const allowedOrigins = (env.ADMIN_ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  // Always allow same-origin (admin-cf serving its own dashboard)
  // The inline dashboard makes same-origin requests, so CORS headers
  // aren't needed, but we include them for completeness.

  if (allowedOrigins.includes(origin)) {
    return true;
  }

  // Allow localhost for development
  try {
    const url = new URL(origin);
    if (url.hostname === 'localhost' && allowedOrigins.includes('http://localhost:*')) {
      return true;
    }
  } catch {
    // invalid origin
  }

  return false;
}
```

Update the `Env` interface in `types.ts` to include:
```typescript
ADMIN_ALLOWED_ORIGINS?: string;
```

In the worker's `fetch` handler, replace the static `corsHeaders` with:
```typescript
const corsHeaders = getCorsHeaders(request, env);
```

## Acceptance Criteria

- [ ] `Access-Control-Allow-Origin: *` is removed from all admin-cf responses
- [ ] CORS origin is validated against a configurable allowlist (`ADMIN_ALLOWED_ORIGINS` environment variable)
- [ ] `Vary: Origin` header is included when `Access-Control-Allow-Origin` is set to a specific origin
- [ ] Requests from non-allowed origins receive responses without `Access-Control-Allow-Origin` (browser blocks cross-origin read)
- [ ] Preflight `OPTIONS` responses respect the same origin allowlist
- [ ] The inline dashboard (same-origin) continues to work without configuration changes
- [ ] VPS-to-CF redirect flow continues to work (this uses full-page navigation, not CORS)
- [ ] `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY` are added as security headers

## Test Requirements

- **Unit test**: Request from an allowed origin receives `Access-Control-Allow-Origin: <origin>` and `Vary: Origin`.
- **Unit test**: Request from a disallowed origin receives no `Access-Control-Allow-Origin` header.
- **Unit test**: Request with no `Origin` header receives no `Access-Control-Allow-Origin` header.
- **Unit test**: Preflight `OPTIONS` from an allowed origin returns correct CORS headers.
- **Unit test**: Preflight `OPTIONS` from a disallowed origin returns no allow-origin header.
- **E2E test**: Inline dashboard (same-origin) API calls succeed.
- **E2E test**: Cross-origin API call from a non-listed origin is blocked by the browser.

## Dependencies

- Story 007 (JWT Token in URL): The CORS fix reduces the blast radius of token leakage but does not eliminate the root cause. Both should be addressed together.
- Story 008 (Missing Security Headers): The `X-Content-Type-Options` and `X-Frame-Options` headers proposed here overlap with Story 008. Coordinate to avoid duplication.
