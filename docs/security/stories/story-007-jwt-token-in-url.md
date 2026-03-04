# Story 007: Remove JWT Tokens from URL Query Parameters

## Priority: THIS WEEK
## Severity: HIGH
## Component: packages/admin-cf, packages/server-vps

## Summary

JWT tokens are passed as URL query parameters (`?token=<jwt>`) when navigating between the CF admin dashboard and VPS dashboards. This exposes tokens to browser history, `Referer` headers sent to external resources, web server access logs, browser extensions, and proxy/CDN logs. The tokens have a 4-hour lifetime, giving a wide window for exploitation.

## Current Behavior

There are three distinct locations where tokens are placed in URLs:

### 1. CF Admin -> VPS Dashboard Navigation (index.ts:715)

When an admin clicks a server card, the `openVpsDashboard()` function opens the VPS dashboard with the token in the URL:

```javascript
// packages/admin-cf/src/index.ts:715
window.open(baseUrl + '/admin/?token=' + encodeURIComponent(state.token), '_blank');
```

### 2. CF Admin -> VPS Redirect After Login (index.ts:552, 633)

When the CF admin dashboard receives a `?redirect=<url>` parameter (from a VPS that redirected the user for authentication), it appends the token to the redirect URL after successful verification or login:

```javascript
// packages/admin-cf/src/index.ts:550-554 (post-verify redirect)
if (url.protocol === 'https:' && url.pathname.startsWith('/admin')) {
  url.searchParams.set('token', state.token);
  window.location.href = url.toString();
  return;
}

// packages/admin-cf/src/index.ts:631-635 (post-login redirect)
if (url.protocol === 'https:' && url.pathname.startsWith('/admin')) {
  url.searchParams.set('token', state.token);
  window.location.href = url.toString();
  return;
}
```

### 3. VPS Dashboard Accepts Token from URL (routes.ts:42-64, auth.ts:72-77)

The VPS admin routes extract the token from the URL query parameter:

```typescript
// packages/server-vps/src/admin/routes.ts:42-54
if (path === '/admin/' || path === '/admin') {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const queryToken = url.searchParams.get('token');

  if (queryToken) {
    const payload = verifyJwt(queryToken, this.config.jwtSecret);
    if (payload) {
      setAuthCookie(res, queryToken, isSecure);
      // Redirect to remove token from URL
      res.writeHead(302, { Location: '/admin/' });
      res.end();
      return true;
    }
  }
}
```

And `extractToken()` in `auth.ts:65-89` checks the URL query as a fallback for all API requests:

```typescript
// packages/server-vps/src/admin/auth.ts:72-77
const url = new URL(req.url || '/', `http://${req.headers.host}`);
const queryToken = url.searchParams.get('token');
if (queryToken) {
  return queryToken;
}
```

While the VPS dashboard does redirect to `/admin/` after setting a cookie (removing the token from the URL), the token still appears in:
- The browser's address bar briefly before the redirect
- Browser history (the pre-redirect URL with token is recorded)
- The `Referer` header if any sub-resource loads before the redirect completes
- Server access logs (the VPS HTTP server logs the full URL)
- Any intermediate proxy or CDN logs

## Expected Behavior

JWT tokens should never appear in URL query parameters. Cross-origin authentication between the CF admin and VPS dashboards should use a short-lived, single-use authorization code pattern:

1. CF admin generates a short-lived authorization code (e.g., 30-second TTL, single-use).
2. The code is passed in the URL instead of the full JWT.
3. The VPS dashboard exchanges the code for the actual JWT via a back-channel server-to-server call.
4. The code is invalidated after first use.

## Root Cause Analysis

The CF admin and VPS dashboards are on different origins (CF admin is on a Cloudflare domain, VPS dashboards are on individual VPS IP addresses). Standard cookie-based session sharing does not work cross-origin. The developers chose the simplest approach: pass the token in the URL.

The redirect flow works as follows:

1. User visits VPS dashboard (`https://<vps-ip>/admin/`)
2. VPS has no cookie -> redirects to CF admin: `CF_ADMIN_URL + '/admin/?redirect=' + returnUrl` (routes.ts:777)
3. User authenticates on CF admin (or is already authenticated)
4. CF admin redirects back to VPS: `url.searchParams.set('token', state.token); window.location.href = url.toString()` (index.ts:552)
5. VPS receives `?token=<jwt>`, verifies it, sets an HttpOnly cookie, and redirects to `/admin/` (routes.ts:47-54)

The vulnerability window is steps 4-5, where the JWT is in the URL. Even though step 5 does a redirect to strip the token, the damage is done -- the URL with the token has already been committed to browser history and potentially to `Referer` headers.

Additionally, `extractToken()` in `auth.ts:72-77` accepts tokens from URL query parameters for ALL requests, not just the initial redirect. This means any VPS API endpoint can be called with a token in the URL, amplifying the exposure.

## Affected Code

| File | Lines | Description |
|------|-------|-------------|
| `packages/admin-cf/src/index.ts` | 715 | `openVpsDashboard()` -- passes token in URL to VPS |
| `packages/admin-cf/src/index.ts` | 550-554 | Post-verify redirect with token in URL |
| `packages/admin-cf/src/index.ts` | 631-635 | Post-login redirect with token in URL |
| `packages/server-vps/src/admin/routes.ts` | 42-54 | Accepts token from URL, sets cookie, redirects |
| `packages/server-vps/src/admin/auth.ts` | 72-77 | `extractToken()` -- reads token from query params for all requests |
| `packages/server-vps/src/admin/auth.ts` | 145-154 | `setAuthCookie()` -- sets cookie from URL-provided token |

## Reproduction Steps

1. Log in to the CF admin dashboard.
2. Click on a server card to open its VPS dashboard.
3. Observe the browser opens: `https://<vps-ip>/admin/?token=eyJhbGciOiJIUzI1NiIs...`
4. Check browser history -- the full URL with the JWT token is recorded.
5. On the VPS side, check HTTP access logs -- the full URL with the token is logged.
6. If the VPS dashboard loads any external resource (analytics, font, etc.) before the redirect completes, check the `Referer` header sent to that external service.

## Impact Assessment

- **Token exposure via browser history**: Anyone with access to the admin's browser (shared computer, browser sync, browser extensions) can extract the JWT from history.
- **Token exposure via Referer headers**: If any external resource is loaded from the page (even indirectly), the `Referer` header leaks the full URL including the token.
- **Token exposure via server logs**: VPS HTTP server logs contain the full URL. Anyone with log access (or if logs are shipped to a log aggregation service) can extract tokens.
- **Token exposure via proxy/CDN logs**: Any intermediate proxy logging request URLs will capture the token.
- **Long exploitation window**: JWT tokens are valid for 4 hours (admin-users-do.ts:152: `240 // 4 hours`), giving attackers a substantial window.
- **Privilege level**: These are admin JWT tokens with full dashboard access (user management, server monitoring, federation control).

## Proposed Fix

### Phase 1: Short-lived Authorization Code Exchange

Replace the token-in-URL pattern with a short-lived, single-use authorization code:

**CF Admin Side (admin-cf):**

```typescript
// New endpoint: POST /admin/api/auth/code
// Generates a short-lived authorization code
async function handleGenerateCode(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;

  // Generate a random code
  const code = crypto.randomUUID();

  // Store in Durable Object with 30-second TTL and the associated JWT claims
  const id = env.ADMIN_USERS.idFromName('admin-users');
  const stub = env.ADMIN_USERS.get(id);
  await stub.fetch(new Request('http://do/auth-codes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      payload: authResult, // JWT claims
      expiresAt: Date.now() + 30_000, // 30 seconds
    }),
  }));

  return jsonResponse({ success: true, data: { code } });
}

// New endpoint: POST /admin/api/auth/exchange
// Exchanges a code for a JWT token (called by VPS server-side)
async function handleExchangeCode(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { code: string };

  const id = env.ADMIN_USERS.idFromName('admin-users');
  const stub = env.ADMIN_USERS.get(id);
  const res = await stub.fetch(new Request('http://do/auth-codes/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: body.code }),
  }));

  return res; // Returns JWT or error
}
```

**Updated openVpsDashboard (index.ts):**

```javascript
async function openVpsDashboard(server) {
  // Generate a short-lived code
  const res = await fetch('/admin/api/auth/code', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + state.token }
  });
  const data = await res.json();
  if (!data.success) return;

  const wsUrl = new URL(server.endpoint.replace('wss://', 'https://').replace('ws://', 'http://'));
  const baseUrl = wsUrl.protocol + '//' + wsUrl.host;
  // Pass the short-lived CODE (not the JWT) in the URL
  window.open(baseUrl + '/admin/?code=' + encodeURIComponent(data.data.code), '_blank');
}
```

**VPS Side (routes.ts):**

```typescript
// Instead of accepting a raw JWT in the URL, accept a code and exchange it
if (queryCode) {
  // Server-to-server call to CF admin to exchange code for JWT
  const exchangeRes = await fetch(`${this.config.cfAdminUrl}/admin/api/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: queryCode }),
  });
  const exchangeData = await exchangeRes.json();
  if (exchangeData.success && exchangeData.data.token) {
    setAuthCookie(res, exchangeData.data.token, isSecure);
    res.writeHead(302, { Location: '/admin/' });
    res.end();
    return true;
  }
}
```

### Phase 2: Remove Query Parameter Token Fallback

Remove the query parameter token extraction from `extractToken()` in `auth.ts`:

```typescript
export function extractToken(req: IncomingMessage): string | null {
  // Check Authorization header first
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Check cookie (no more query parameter fallback)
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.match(/zajel_vps_token=([^;]+)/);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}
```

## Acceptance Criteria

- [ ] JWT tokens are never placed in URL query parameters
- [ ] Cross-origin authentication uses a short-lived (30 seconds), single-use authorization code
- [ ] Authorization codes are exchanged for JWTs via a server-to-server back-channel call
- [ ] Authorization codes are invalidated after first use (single-use)
- [ ] Expired codes are rejected
- [ ] `extractToken()` in `auth.ts` no longer accepts tokens from URL query parameters
- [ ] The `openVpsDashboard()` function generates an authorization code instead of passing the JWT
- [ ] The CF-to-VPS redirect flow uses authorization codes
- [ ] Browser history does not contain JWT tokens
- [ ] VPS server logs do not contain JWT tokens
- [ ] Existing cookie-based authentication continues to work

## Test Requirements

- **Unit test**: Authorization code generation returns a valid code with correct TTL.
- **Unit test**: Code exchange returns a JWT token and invalidates the code.
- **Unit test**: Second exchange attempt with the same code fails.
- **Unit test**: Expired code exchange fails.
- **Unit test**: `extractToken()` no longer returns tokens from query parameters.
- **Integration test**: Full flow -- CF admin generates code, VPS exchanges code, VPS sets cookie, subsequent API calls use cookie.
- **E2E test**: Click server card, verify VPS dashboard opens with `?code=` (not `?token=`), verify authentication succeeds.
- **Negative test**: Attempt to use an expired code (after 30 seconds) -- should fail.
- **Negative test**: Attempt to use a code twice -- second attempt should fail.

## Dependencies

- Story 006 (Admin CORS Wildcard): The code exchange endpoint needs proper CORS configuration. The VPS server makes a server-to-server call (not browser-based), so CORS is not needed for the exchange itself, but the code generation endpoint is called from the browser and needs proper CORS.
- The authorization code store needs to be implemented in the `AdminUsersDO` Durable Object or a dedicated Durable Object.
