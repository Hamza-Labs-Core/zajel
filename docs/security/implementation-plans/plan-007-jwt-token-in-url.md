# Implementation Plan 007: Remove JWT Tokens from URL Query Parameters

**Story Reference**: `/home/meywd/zajel-ddos/docs/security/stories/story-007-jwt-token-in-url.md`
**Priority**: THIS WEEK
**Severity**: HIGH
**Estimated Effort**: 8-12 hours
**Last Updated**: 2026-03-03

---

## 1. Summary

Replace the current pattern of passing JWT tokens in URL query parameters (`?token=<jwt>`) with a short-lived, single-use authorization code exchange pattern. This eliminates token exposure in browser history, server logs, Referer headers, and proxy logs while maintaining seamless cross-origin authentication between the CF admin dashboard and VPS dashboards.

**Current Flow (Insecure)**:
1. User clicks server card in CF admin → `window.open(vps_url + '?token=' + jwt)`
2. VPS receives full JWT in URL, sets cookie, redirects
3. JWT is now in browser history, server logs, potential Referer headers

**New Flow (Secure)**:
1. User clicks server card in CF admin → Generate 30-second auth code → `window.open(vps_url + '?code=' + code)`
2. VPS receives code, makes server-to-server call to CF admin to exchange code for JWT
3. VPS receives JWT, sets cookie, redirects
4. Code is invalidated (single-use), browser history only contains the short-lived code

---

## 2. Files to Modify

### 2.1 Cloudflare Admin Worker (`packages/admin-cf/`)

| File | Lines | Changes |
|------|-------|---------|
| `src/types.ts` | Add after line 96 | Add `AuthCode`, `GenerateCodeData`, `ExchangeCodeRequest`, `ExchangeCodeData` interfaces |
| `src/admin-users-do.ts` | Add after line 73 | Add authorization code storage and exchange handlers |
| `src/routes/auth-code.ts` | New file | Create new route handlers for code generation and exchange |
| `src/index.ts` | Lines 67-105 | Add routes for `/admin/api/auth/code` (POST) and `/admin/api/auth/exchange` (POST) |
| `src/index.ts` | Lines 715-716 | Replace direct JWT passing with code generation in `openVpsDashboard()` |
| `src/index.ts` | Lines 550-554 | Replace redirect with code generation in post-verify flow |
| `src/index.ts` | Lines 631-635 | Replace redirect with code generation in post-login flow |

### 2.2 VPS Server (`packages/server-vps/`)

| File | Lines | Changes |
|------|-------|---------|
| `src/admin/routes.ts` | Lines 42-64 | Replace `?token=` handling with `?code=` exchange logic |
| `src/admin/auth.ts` | Lines 72-77 | Remove query parameter token extraction from `extractToken()` |
| `src/config.ts` | Lines 94-99 | Add `cfAdminUrl` to admin config (already exists, verify usage) |

### 2.3 Tests

| File | Changes |
|------|---------|
| `packages/admin-cf/tests/e2e/admin-e2e.test.ts` | Add authorization code generation and exchange tests |
| `packages/server-vps/tests/unit/admin-auth.test.ts` | New file: Test VPS auth code exchange flow |
| `packages/admin-cf/tests/unit/auth-code.test.ts` | New file: Unit tests for code generation, expiry, single-use |

---

## 3. Implementation Steps

### 3.1 Phase 1: Add Authorization Code Infrastructure to CF Admin

#### Step 1.1: Add Type Definitions

**File**: `/home/meywd/zajel-ddos/packages/admin-cf/src/types.ts`

**Before** (line 96):
```typescript
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
```

**After** (add after line 96):
```typescript
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Authorization code for cross-origin auth (JWT token exchange)
 */
export interface AuthCode {
  code: string;
  payload: JwtPayload;  // JWT claims from authenticated user
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

/**
 * Request/response types for auth code endpoints
 */
export interface GenerateCodeData {
  code: string;
}

export interface ExchangeCodeRequest {
  code: string;
}

export interface ExchangeCodeData {
  token: string;
}
```

#### Step 1.2: Add Authorization Code Storage to AdminUsersDO

**File**: `/home/meywd/zajel-ddos/packages/admin-cf/src/admin-users-do.ts`

**Before** (line 60):
```typescript
      if (path === '/init' && method === 'POST') {
        return this.handleInit(request);
      }

      return this.jsonResponse({ success: false, error: 'Not found' }, 404);
```

**After** (replace lines 60-66):
```typescript
      if (path === '/init' && method === 'POST') {
        return this.handleInit(request);
      }

      if (path === '/auth-codes' && method === 'POST') {
        return this.handleStoreAuthCode(request);
      }

      if (path === '/auth-codes/exchange' && method === 'POST') {
        return this.handleExchangeAuthCode(request);
      }

      return this.jsonResponse({ success: false, error: 'Not found' }, 404);
```

**Add before `handleInit` method** (after line 75):
```typescript
  /**
   * Store a short-lived authorization code
   * Called by CF Worker when generating a code for VPS redirect
   */
  private async handleStoreAuthCode(request: Request): Promise<Response> {
    const body = await request.json() as {
      code: string;
      payload: JwtPayload;
      expiresAt: number;
    };

    if (!body.code || !body.payload || !body.expiresAt) {
      return this.jsonResponse(
        { success: false, error: 'Invalid request' },
        400
      );
    }

    const authCode: AuthCode = {
      code: body.code,
      payload: body.payload,
      createdAt: Date.now(),
      expiresAt: body.expiresAt,
      used: false,
    };

    await this.state.storage.put(`authcode:${body.code}`, authCode);

    // Set alarm for cleanup (30 seconds + 5 second buffer)
    const cleanupDelay = body.expiresAt - Date.now() + 5000;
    if (cleanupDelay > 0) {
      await this.state.storage.setAlarm(Date.now() + cleanupDelay);
    }

    return this.jsonResponse({ success: true });
  }

  /**
   * Exchange an authorization code for a JWT token
   * Called by VPS server via server-to-server request
   */
  private async handleExchangeAuthCode(request: Request): Promise<Response> {
    const body = await request.json() as { code: string };

    if (!body.code) {
      return this.jsonResponse(
        { success: false, error: 'Code required' },
        400
      );
    }

    const authCode = await this.state.storage.get<AuthCode>(`authcode:${body.code}`);

    if (!authCode) {
      return this.jsonResponse(
        { success: false, error: 'Invalid or expired code' },
        401
      );
    }

    // Check expiration
    if (Date.now() > authCode.expiresAt) {
      await this.state.storage.delete(`authcode:${body.code}`);
      return this.jsonResponse(
        { success: false, error: 'Code expired' },
        401
      );
    }

    // Check single-use
    if (authCode.used) {
      return this.jsonResponse(
        { success: false, error: 'Code already used' },
        401
      );
    }

    // Mark as used and delete immediately (single-use)
    await this.state.storage.delete(`authcode:${body.code}`);

    // Generate a new JWT with the stored payload
    const token = await generateJwt(
      {
        sub: authCode.payload.sub,
        username: authCode.payload.username,
        role: authCode.payload.role,
      },
      this.env.ZAJEL_ADMIN_JWT_SECRET,
      240 // 4 hours
    );

    return this.jsonResponse({
      success: true,
      data: { token },
    });
  }

  /**
   * Alarm handler for cleaning up expired auth codes
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    const allKeys = await this.state.storage.list<AuthCode>({ prefix: 'authcode:' });

    for (const [key, authCode] of allKeys.entries()) {
      if (authCode.expiresAt < now) {
        await this.state.storage.delete(key);
      }
    }
  }
```

**Import addition** (add to import block at top):
```typescript
import type {
  AdminUser,
  AdminUserPublic,
  JwtPayload,
  LoginRequest,
  CreateUserRequest,
  ApiResponse,
  AuthCode,  // ADD THIS
} from './types.js';
```

#### Step 1.3: Create Auth Code Route Handlers

**File**: `/home/meywd/zajel-ddos/packages/admin-cf/src/routes/auth-code.ts` (NEW FILE)

```typescript
/**
 * Authorization code generation and exchange routes
 * Implements OAuth2-style code exchange for cross-origin auth
 */

import type { Env, GenerateCodeData, ExchangeCodeRequest, ExchangeCodeData, JwtPayload } from '../types.js';
import { verifyJwt } from '../crypto.js';

/**
 * Generate a short-lived authorization code for VPS redirect
 * Requires authentication
 */
export async function handleGenerateCode(request: Request, env: Env): Promise<Response> {
  // Verify the user is authenticated
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse(
      { success: false, error: 'Missing authorization header' },
      401
    );
  }

  const token = authHeader.substring(7);
  const payload = await verifyJwt<JwtPayload>(token, env.ZAJEL_ADMIN_JWT_SECRET);
  if (!payload) {
    return jsonResponse(
      { success: false, error: 'Invalid or expired token' },
      401
    );
  }

  // Generate a cryptographically secure random code
  const codeBytes = new Uint8Array(32);
  crypto.getRandomValues(codeBytes);
  const code = Array.from(codeBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Store the code in AdminUsersDO with 30-second TTL
  const expiresAt = Date.now() + 30_000; // 30 seconds

  const id = env.ADMIN_USERS.idFromName('admin-users');
  const stub = env.ADMIN_USERS.get(id);

  const storeRes = await stub.fetch(new Request('http://do/auth-codes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      payload: {
        sub: payload.sub,
        username: payload.username,
        role: payload.role,
      },
      expiresAt,
    }),
  }));

  if (!storeRes.ok) {
    return jsonResponse(
      { success: false, error: 'Failed to store authorization code' },
      500
    );
  }

  return jsonResponse({
    success: true,
    data: { code } as GenerateCodeData,
  });
}

/**
 * Exchange an authorization code for a JWT token
 * Called by VPS servers (server-to-server)
 */
export async function handleExchangeCode(request: Request, env: Env): Promise<Response> {
  let body: ExchangeCodeRequest;
  try {
    body = await request.json() as ExchangeCodeRequest;
  } catch {
    return jsonResponse(
      { success: false, error: 'Invalid JSON body' },
      400
    );
  }

  if (!body.code) {
    return jsonResponse(
      { success: false, error: 'Code required' },
      400
    );
  }

  // Exchange code for token via AdminUsersDO
  const id = env.ADMIN_USERS.idFromName('admin-users');
  const stub = env.ADMIN_USERS.get(id);

  const exchangeRes = await stub.fetch(new Request('http://do/auth-codes/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: body.code }),
  }));

  const exchangeData = await exchangeRes.json();

  // Return the DO's response directly (it handles validation and error messages)
  return new Response(JSON.stringify(exchangeData), {
    status: exchangeRes.status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function jsonResponse<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
```

#### Step 1.4: Add Routes to CF Worker

**File**: `/home/meywd/zajel-ddos/packages/admin-cf/src/index.ts`

**Before** (line 10):
```typescript
import type { Env } from './types.js';
import { handleLogin, handleLogout, handleVerify, handleInit } from './routes/auth.js';
import { handleListUsers, handleCreateUser, handleDeleteUser } from './routes/users.js';
import { handleListServers } from './routes/servers.js';
```

**After**:
```typescript
import type { Env } from './types.js';
import { handleLogin, handleLogout, handleVerify, handleInit } from './routes/auth.js';
import { handleListUsers, handleCreateUser, handleDeleteUser } from './routes/users.js';
import { handleListServers } from './routes/servers.js';
import { handleGenerateCode, handleExchangeCode } from './routes/auth-code.js';
```

**Before** (line 92):
```typescript
      } else if (path === '/admin/api/servers' && method === 'GET') {
        response = await handleListServers(request, env);
      } else if (path.startsWith('/admin/api/')) {
```

**After** (add routes before the 404 handler):
```typescript
      } else if (path === '/admin/api/servers' && method === 'GET') {
        response = await handleListServers(request, env);
      } else if (path === '/admin/api/auth/code' && method === 'POST') {
        response = await handleGenerateCode(request, env);
      } else if (path === '/admin/api/auth/exchange' && method === 'POST') {
        response = await handleExchangeCode(request, env);
      } else if (path.startsWith('/admin/api/')) {
```

#### Step 1.5: Update CF Admin Dashboard JavaScript

**File**: `/home/meywd/zajel-ddos/packages/admin-cf/src/index.ts`

**Before** (lines 710-716):
```javascript
    function openVpsDashboard(server) {
      // Convert WS endpoint to HTTP base URL (strip any path component)
      const wsUrl = new URL(server.endpoint.replace('wss://', 'https://').replace('ws://', 'http://'));
      const baseUrl = wsUrl.protocol + '//' + wsUrl.host;
      // Pass token in URL for initial auth
      window.open(baseUrl + '/admin/?token=' + encodeURIComponent(state.token), '_blank');
    }
```

**After**:
```javascript
    async function openVpsDashboard(server) {
      // Generate a short-lived authorization code
      try {
        const res = await fetch('/admin/api/auth/code', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + state.token,
          },
        });

        if (!res.ok) {
          console.error('Failed to generate auth code:', await res.text());
          alert('Failed to authenticate with VPS dashboard. Please try again.');
          return;
        }

        const data = await res.json();
        if (!data.success || !data.data?.code) {
          console.error('Invalid auth code response:', data);
          alert('Failed to authenticate with VPS dashboard. Please try again.');
          return;
        }

        // Convert WS endpoint to HTTP base URL (strip any path component)
        const wsUrl = new URL(server.endpoint.replace('wss://', 'https://').replace('ws://', 'http://'));
        const baseUrl = wsUrl.protocol + '//' + wsUrl.host;

        // Pass the short-lived CODE (not the JWT) in the URL
        window.open(baseUrl + '/admin/?code=' + encodeURIComponent(data.data.code), '_blank');
      } catch (error) {
        console.error('Error opening VPS dashboard:', error);
        alert('Failed to authenticate with VPS dashboard. Please try again.');
      }
    }
```

**Before** (lines 545-557):
```javascript
              const params = new URLSearchParams(window.location.search);
              const redirectUrl = params.get('redirect');
              if (redirectUrl) {
                try {
                  const url = new URL(redirectUrl);
                  // Only allow redirects to HTTPS URLs with /admin/ path
                  if (url.protocol === 'https:' && url.pathname.startsWith('/admin')) {
                    url.searchParams.set('token', state.token);
                    window.location.href = url.toString();
                    return; // Stop init — we're redirecting
                  }
                } catch { /* invalid URL, ignore */ }
              }
```

**After** (lines 545-572):
```javascript
              const params = new URLSearchParams(window.location.search);
              const redirectUrl = params.get('redirect');
              if (redirectUrl) {
                try {
                  const url = new URL(redirectUrl);
                  // Only allow redirects to HTTPS URLs with /admin/ path
                  if (url.protocol === 'https:' && url.pathname.startsWith('/admin')) {
                    // Generate authorization code for redirect
                    const codeRes = await fetch('/admin/api/auth/code', {
                      method: 'POST',
                      headers: { 'Authorization': 'Bearer ' + state.token },
                    });

                    if (codeRes.ok) {
                      const codeData = await codeRes.json();
                      if (codeData.success && codeData.data?.code) {
                        url.searchParams.set('code', codeData.data.code);
                        window.location.href = url.toString();
                        return; // Stop init — we're redirecting
                      }
                    }

                    // If code generation failed, fall through to normal load
                    console.warn('Failed to generate auth code for redirect');
                  }
                } catch { /* invalid URL, ignore */ }
              }
```

**Before** (lines 625-638):
```javascript
          // Check if we should redirect back to a VPS dashboard
          const params = new URLSearchParams(window.location.search);
          const redirectUrl = params.get('redirect');
          if (redirectUrl) {
            try {
              const url = new URL(redirectUrl);
              // Only allow redirects to HTTPS URLs with /admin/ path
              if (url.protocol === 'https:' && url.pathname.startsWith('/admin')) {
                url.searchParams.set('token', state.token);
                window.location.href = url.toString();
                return;
              }
            } catch { /* invalid URL, ignore */ }
          }
```

**After** (lines 625-653):
```javascript
          // Check if we should redirect back to a VPS dashboard
          const params = new URLSearchParams(window.location.search);
          const redirectUrl = params.get('redirect');
          if (redirectUrl) {
            try {
              const url = new URL(redirectUrl);
              // Only allow redirects to HTTPS URLs with /admin/ path
              if (url.protocol === 'https:' && url.pathname.startsWith('/admin')) {
                // Generate authorization code for redirect
                const codeRes = await fetch('/admin/api/auth/code', {
                  method: 'POST',
                  headers: { 'Authorization': 'Bearer ' + state.token },
                });

                if (codeRes.ok) {
                  const codeData = await codeRes.json();
                  if (codeData.success && codeData.data?.code) {
                    url.searchParams.set('code', codeData.data.code);
                    window.location.href = url.toString();
                    return;
                  }
                }

                // If code generation failed, fall through to normal render
                console.warn('Failed to generate auth code for redirect');
              }
            } catch { /* invalid URL, ignore */ }
          }
```

---

### 3.2 Phase 2: Update VPS Server to Use Authorization Codes

#### Step 2.1: Update VPS Admin Routes

**File**: `/home/meywd/zajel-ddos/packages/server-vps/src/admin/routes.ts`

**Before** (lines 41-64):
```typescript
    // Handle token from URL (set cookie and redirect)
    if (path === '/admin/' || path === '/admin') {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const queryToken = url.searchParams.get('token');

      if (queryToken) {
        // Verify token before setting cookie
        const payload = verifyJwt(queryToken, this.config.jwtSecret);
        if (payload) {
          const isSecure = req.headers['x-forwarded-proto'] === 'https'
            || (req.connection as { encrypted?: boolean })?.encrypted === true;
          setAuthCookie(res, queryToken, isSecure);
          // Redirect to remove token from URL
          res.writeHead(302, { Location: '/admin/' });
          res.end();
          return true;
        }
        // Token invalid/expired — redirect to CF admin if configured
        if (this.config.cfAdminUrl) {
          res.writeHead(302, { Location: this.config.cfAdminUrl });
          res.end();
          return true;
        }
      }

      // Serve dashboard HTML
      this.serveDashboard(res);
      return true;
    }
```

**After**:
```typescript
    // Handle authorization code from URL (exchange for token, set cookie, redirect)
    if (path === '/admin/' || path === '/admin') {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const queryCode = url.searchParams.get('code');

      if (queryCode) {
        try {
          // Exchange code for JWT token via CF admin server-to-server call
          if (!this.config.cfAdminUrl) {
            throw new Error('CF admin URL not configured');
          }

          const exchangeUrl = `${this.config.cfAdminUrl}/admin/api/auth/exchange`;
          const exchangeRes = await fetch(exchangeUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: queryCode }),
          });

          if (!exchangeRes.ok) {
            const errorText = await exchangeRes.text();
            console.error('[VPS Admin] Code exchange failed:', exchangeRes.status, errorText);
            throw new Error('Code exchange failed');
          }

          const exchangeData = await exchangeRes.json();
          if (!exchangeData.success || !exchangeData.data?.token) {
            console.error('[VPS Admin] Invalid exchange response:', exchangeData);
            throw new Error('Invalid exchange response');
          }

          const token = exchangeData.data.token;

          // Verify the received token
          const payload = verifyJwt(token, this.config.jwtSecret);
          if (!payload) {
            console.error('[VPS Admin] Received invalid token from exchange');
            throw new Error('Invalid token from exchange');
          }

          // Set auth cookie and redirect to remove code from URL
          const isSecure = req.headers['x-forwarded-proto'] === 'https'
            || (req.connection as { encrypted?: boolean })?.encrypted === true;
          setAuthCookie(res, token, isSecure);
          res.writeHead(302, { Location: '/admin/' });
          res.end();
          return true;
        } catch (error) {
          console.error('[VPS Admin] Authorization code exchange error:', error);
          // Redirect to CF admin for re-authentication
          if (this.config.cfAdminUrl) {
            res.writeHead(302, { Location: this.config.cfAdminUrl });
            res.end();
            return true;
          }
        }
      }

      // Serve dashboard HTML
      this.serveDashboard(res);
      return true;
    }
```

#### Step 2.2: Remove Query Parameter Token Extraction

**File**: `/home/meywd/zajel-ddos/packages/server-vps/src/admin/auth.ts`

**Before** (lines 65-89):
```typescript
export function extractToken(req: IncomingMessage): string | null {
  // Check Authorization header first
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Check query parameter (for initial redirect from CF dashboard)
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const queryToken = url.searchParams.get('token');
  if (queryToken) {
    return queryToken;
  }

  // Check cookie
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

**After**:
```typescript
export function extractToken(req: IncomingMessage): string | null {
  // Check Authorization header first
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Check cookie
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

**Note**: Remove the query parameter check (lines 72-77 deleted). The authorization code is NOT a token and should never be used for API authentication. The code exchange happens before any API calls are made.

---

### 3.3 Phase 3: Add Tests

#### Step 3.1: Add CF Admin E2E Tests

**File**: `/home/meywd/zajel-ddos/packages/admin-cf/tests/e2e/admin-e2e.test.ts`

**Add new test section after existing auth tests** (around line 150):

```typescript
describe('Authorization Code Exchange', () => {
  it('POST /admin/api/auth/code generates a code for authenticated user', async () => {
    const res = await client.fetch('/admin/api/auth/code', {
      method: 'POST',
      headers: { Authorization: `Bearer ${client.token}` },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as ApiResponse<GenerateCodeData>;
    expect(body.success).toBe(true);
    expect(body.data?.code).toBeDefined();
    expect(body.data!.code).toHaveLength(64); // 32 bytes hex encoded
  });

  it('POST /admin/api/auth/code requires authentication', async () => {
    const res = await client.fetch('/admin/api/auth/code', {
      method: 'POST',
    });
    expect(res.status).toBe(401);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
  });

  it('POST /admin/api/auth/exchange exchanges valid code for JWT', async () => {
    // Generate code first
    const codeRes = await client.fetch('/admin/api/auth/code', {
      method: 'POST',
      headers: { Authorization: `Bearer ${client.token}` },
    });
    const codeBody = (await codeRes.json()) as ApiResponse<GenerateCodeData>;
    const code = codeBody.data!.code;

    // Exchange code for token
    const exchangeRes = await client.fetch('/admin/api/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(exchangeRes.status).toBe(200);

    const exchangeBody = (await exchangeRes.json()) as ApiResponse<ExchangeCodeData>;
    expect(exchangeBody.success).toBe(true);
    expect(exchangeBody.data?.token).toBeDefined();

    // Verify token has correct structure
    const parts = exchangeBody.data!.token.split('.');
    expect(parts).toHaveLength(3);
  });

  it('POST /admin/api/auth/exchange rejects code reuse (single-use)', async () => {
    // Generate code
    const codeRes = await client.fetch('/admin/api/auth/code', {
      method: 'POST',
      headers: { Authorization: `Bearer ${client.token}` },
    });
    const codeBody = (await codeRes.json()) as ApiResponse<GenerateCodeData>;
    const code = codeBody.data!.code;

    // Exchange code first time (should succeed)
    const firstExchange = await client.fetch('/admin/api/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(firstExchange.status).toBe(200);

    // Attempt to exchange same code again (should fail)
    const secondExchange = await client.fetch('/admin/api/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(secondExchange.status).toBe(401);

    const body = (await secondExchange.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/invalid|expired|used/i);
  });

  it('POST /admin/api/auth/exchange rejects invalid code', async () => {
    const res = await client.fetch('/admin/api/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'invalid-code-12345' }),
    });
    expect(res.status).toBe(401);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
  });

  it('Authorization code expires after 30 seconds', async () => {
    // Generate code
    const codeRes = await client.fetch('/admin/api/auth/code', {
      method: 'POST',
      headers: { Authorization: `Bearer ${client.token}` },
    });
    const codeBody = (await codeRes.json()) as ApiResponse<GenerateCodeData>;
    const code = codeBody.data!.code;

    // Wait 31 seconds
    await new Promise(resolve => setTimeout(resolve, 31000));

    // Attempt to exchange expired code
    const exchangeRes = await client.fetch('/admin/api/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(exchangeRes.status).toBe(401);

    const body = (await exchangeRes.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/expired/i);
  }, { timeout: 35000 }); // Increase test timeout to allow for 31s wait
});
```

**Add helper type imports** (at top of file):
```typescript
import {
  AdminApiClient,
  loginAsSuperAdmin,
  cleanupTestUsers,
  testUsername,
  TEST_USER_PREFIX,
  SUPER_ADMIN_CREDS,
  type ApiResponse,
  type LoginData,
  type AdminUserPublic,
  type VerifyData,
  type ServersData,
  type HealthData,
  type GenerateCodeData,  // ADD THIS
  type ExchangeCodeData,  // ADD THIS
} from './helpers.js';
```

#### Step 3.2: Add VPS Unit Tests

**File**: `/home/meywd/zajel-ddos/packages/server-vps/tests/unit/admin-auth-code.test.ts` (NEW FILE)

```typescript
/**
 * VPS Admin Auth Code Exchange Tests
 * Tests the authorization code exchange flow with CF admin
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('VPS Authorization Code Exchange', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should exchange valid code for JWT token', async () => {
    const mockToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';

    // Mock successful exchange response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { token: mockToken },
      }),
    });

    const cfAdminUrl = 'https://admin.example.com';
    const code = 'abc123def456';

    const exchangeUrl = `${cfAdminUrl}/admin/api/auth/exchange`;
    const response = await fetch(exchangeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.data.token).toBe(mockToken);

    // Verify fetch was called with correct parameters
    expect(mockFetch).toHaveBeenCalledWith(
      exchangeUrl,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
    );
  });

  it('should handle invalid code response', async () => {
    // Mock invalid code response
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({
        success: false,
        error: 'Invalid or expired code',
      }),
    });

    const cfAdminUrl = 'https://admin.example.com';
    const code = 'invalid-code';

    const response = await fetch(`${cfAdminUrl}/admin/api/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    expect(response.ok).toBe(false);
    expect(response.status).toBe(401);
  });

  it('should handle network errors gracefully', async () => {
    // Mock network error
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const cfAdminUrl = 'https://admin.example.com';
    const code = 'abc123';

    await expect(
      fetch(`${cfAdminUrl}/admin/api/auth/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
    ).rejects.toThrow('Network error');
  });
});
```

#### Step 3.3: Update Test Helpers

**File**: `/home/meywd/zajel-ddos/packages/admin-cf/tests/e2e/helpers.ts`

**Add type exports** (append to existing exports):
```typescript
export type GenerateCodeData = {
  code: string;
};

export type ExchangeCodeData = {
  token: string;
};
```

---

## 4. Test Plan

### 4.1 Unit Tests

| Test Case | Expected Result | Coverage |
|-----------|----------------|----------|
| Generate auth code with valid JWT | Returns 64-char hex code | Authorization code generation |
| Generate auth code without auth | Returns 401 Unauthorized | Authentication requirement |
| Exchange valid code | Returns valid JWT token | Code exchange success path |
| Exchange same code twice | Second attempt returns 401 | Single-use enforcement |
| Exchange expired code (>30s) | Returns 401 with "expired" error | TTL enforcement |
| Exchange invalid code | Returns 401 | Invalid input handling |
| Exchange code with missing cfAdminUrl | VPS returns error | Configuration validation |

### 4.2 Integration Tests

| Test Case | Expected Result | Coverage |
|-----------|----------------|----------|
| Full flow: CF admin → code → VPS exchange → cookie | VPS sets cookie, redirects to `/admin/` | End-to-end auth flow |
| Redirect flow: VPS → CF admin → code → VPS | User returns to VPS with valid session | Cross-origin redirect |
| Browser history after redirect | Contains `?code=`, NOT `?token=` | Security verification |
| VPS server logs | Do NOT contain JWT tokens | Log security |

### 4.3 E2E Tests

| Test Case | Expected Result | Coverage |
|-----------|----------------|----------|
| Click server card in CF admin | Opens VPS dashboard with `?code=` param | User experience |
| VPS dashboard loads successfully | Dashboard displays, API calls use cookie | Authentication persistence |
| Network tab inspection | No JWT tokens in URLs | Security audit |
| VPS API calls after auth | Use cookie-based auth, NOT query params | API security |

### 4.4 Negative Tests

| Test Case | Expected Result | Coverage |
|-----------|----------------|----------|
| Use code after 30 seconds | Exchange fails with 401 | Expiration |
| Reuse code after first exchange | Second exchange fails with 401 | Single-use |
| Tamper with code value | Exchange fails with 401 | Integrity |
| Exchange code with wrong CF admin URL | VPS returns error | Misconfiguration handling |
| Network failure during exchange | VPS redirects to CF admin for re-auth | Error recovery |

### 4.5 Performance Tests

| Metric | Target | Measurement |
|--------|--------|-------------|
| Code generation latency | < 100ms | Time from `/admin/api/auth/code` request to response |
| Code exchange latency | < 500ms | Time from VPS to CF admin exchange call |
| DO storage lookup | < 50ms | Time to retrieve auth code from Durable Object |

### 4.6 Manual Testing Checklist

- [ ] Log into CF admin, click server card, verify VPS opens
- [ ] Inspect browser history: should show `?code=`, NOT `?token=`
- [ ] Check VPS HTTP server logs: should NOT contain JWT tokens
- [ ] Open browser DevTools Network tab, filter for `admin`, verify no tokens in URLs
- [ ] Verify VPS dashboard loads correctly after code exchange
- [ ] Test redirect flow: directly visit VPS → redirected to CF admin → redirected back to VPS
- [ ] Test session persistence: reload VPS dashboard, should use cookie (no redirect)
- [ ] Test code expiration: generate code, wait 31 seconds, attempt exchange (should fail)
- [ ] Test code reuse: generate code, exchange once, attempt exchange again (should fail)

---

## 5. Rollback Risk

### 5.1 Risk Level: LOW-MEDIUM

**Reasoning**: The changes introduce new endpoints and modify the authentication flow, but they are backward-compatible during deployment and do not affect existing cookie-based sessions.

### 5.2 Failure Scenarios

| Scenario | Impact | Mitigation |
|----------|--------|------------|
| CF admin code generation endpoint fails | Users cannot open VPS dashboards | Show error message, existing cookie-based sessions continue to work |
| VPS code exchange network error | New VPS sessions fail | Redirect to CF admin for re-authentication, existing sessions unaffected |
| Authorization code storage fails in DO | New authentications fail | Existing cookie-based sessions continue, monitor DO health |
| Code generation is slow (>5s) | Poor user experience clicking server cards | Set timeout, show loading indicator, allow retry |

### 5.3 Rollback Procedure

If critical issues are detected in production:

1. **Immediate Rollback** (CF Admin):
   - Revert `src/index.ts` changes to restore `?token=` behavior
   - Deploy CF worker rollback via Wrangler: `npx wrangler deploy --env production`
   - Timeline: 2-5 minutes

2. **Immediate Rollback** (VPS Server):
   - Revert `src/admin/routes.ts` to restore `?token=` handling
   - Redeploy VPS servers via deployment script
   - Timeline: 5-10 minutes per region

3. **Data Cleanup**:
   - Authorization codes in Durable Object have 30-second TTL + alarm cleanup
   - No persistent data to clean up
   - Codes will expire naturally within 35 seconds

### 5.4 Safe Deployment Strategy

1. **Deploy CF Admin first** (Thursday morning, low traffic):
   - Add new endpoints (`/admin/api/auth/code`, `/admin/api/auth/exchange`)
   - Keep old `?token=` behavior in dashboard JavaScript
   - Test endpoints manually via Postman/curl
   - Monitor error rates for 1 hour

2. **Update CF Admin dashboard** (Thursday afternoon):
   - Change `openVpsDashboard()` to use authorization codes
   - Change redirect flows to use codes
   - Monitor error rates for 2 hours
   - VPS servers still accept `?token=` as fallback

3. **Update VPS servers** (Friday morning):
   - Replace `?token=` with `?code=` handling
   - Remove query parameter token extraction from `extractToken()`
   - Deploy to one region first, monitor for 1 hour
   - Deploy to remaining regions if stable

4. **Verification** (Friday afternoon):
   - Test full flow: CF admin → VPS dashboard
   - Check browser history (should show `?code=`)
   - Check VPS logs (should NOT show JWT tokens)
   - Monitor error rates for 24 hours

---

## 6. Dependencies on Other Stories

### 6.1 Required Before This Story

**None**: This story is self-contained and does not depend on other security stories.

### 6.2 Related Stories (Optional Coordination)

| Story | Relationship | Coordination Needed |
|-------|-------------|---------------------|
| Story 006: Admin CORS Wildcard | CORS affects `/admin/api/auth/exchange` endpoint | If Story 006 is implemented first, verify CORS headers allow VPS server-to-server calls (should use restrictive CORS, NOT wildcard for server-to-server endpoints) |

**Note**: The `/admin/api/auth/exchange` endpoint is called server-to-server (VPS → CF admin), NOT from the browser. It does NOT need CORS headers. The `/admin/api/auth/code` endpoint is called from the browser and needs CORS (already covered by existing wildcard CORS in `index.ts` lines 30-35).

### 6.3 Blocking Other Stories

**None**: Other security stories do not depend on this implementation.

---

## 7. Configuration Changes

### 7.1 Environment Variables

| Variable | Location | Required | Description | Example |
|----------|----------|----------|-------------|---------|
| `ZAJEL_CF_ADMIN_URL` | VPS Server | **YES** | CF admin dashboard URL for code exchange | `https://admin.zajel.example.com` |
| `ZAJEL_ADMIN_JWT_SECRET` | CF Admin Worker | **YES** (existing) | JWT signing secret (already required) | `<random-secret>` |

**Action Items**:
- Verify all VPS servers have `ZAJEL_CF_ADMIN_URL` configured
- Document requirement in deployment guide
- Add validation: VPS should log error if `cfAdminUrl` is missing on startup

### 7.2 CF Worker Bindings

No new bindings required. Existing `ADMIN_USERS` Durable Object namespace is used for authorization code storage.

---

## 8. Monitoring & Alerts

### 8.1 Metrics to Monitor

| Metric | Location | Alert Threshold | Description |
|--------|----------|----------------|-------------|
| Auth code generation rate | CF Admin Worker | > 100/min | Detect potential abuse |
| Auth code exchange failures | CF Admin Worker | > 10% error rate | Detect VPS misconfiguration or network issues |
| Auth code expiration rate | CF Admin Worker | > 50% expired before use | User experience issue (network slow?) |
| VPS code exchange latency | VPS Server Logs | > 2 seconds | Network or CF admin performance issue |

### 8.2 Log Messages

**CF Admin Worker**:
- `[AuthCode] Generated code for user {userId}` (DEBUG)
- `[AuthCode] Code exchanged successfully` (INFO)
- `[AuthCode] Code exchange failed: {error}` (ERROR)

**VPS Server**:
- `[VPS Admin] Received authorization code, attempting exchange` (DEBUG)
- `[VPS Admin] Code exchange successful, setting cookie` (INFO)
- `[VPS Admin] Code exchange failed: {error}` (ERROR)

### 8.3 Error Tracking

Add Sentry/CloudWatch error tracking for:
- Code exchange network failures
- Invalid code attempts (potential abuse)
- Missing `ZAJEL_CF_ADMIN_URL` configuration errors

---

## 9. Documentation Updates

### 9.1 Files to Update

| File | Section | Change |
|------|---------|--------|
| `docs/admin/DEPLOYMENT.md` | Configuration | Add `ZAJEL_CF_ADMIN_URL` requirement for VPS servers |
| `docs/admin/ARCHITECTURE.md` | Authentication Flow | Document authorization code exchange pattern |
| `docs/security/CHANGELOG.md` | Story 007 | Mark as completed, link to this plan |

### 9.2 API Documentation

**New Endpoints**:

```markdown
### POST /admin/api/auth/code

Generate a short-lived authorization code for cross-origin authentication.

**Authentication**: Required (Bearer token)

**Response**:
```json
{
  "success": true,
  "data": {
    "code": "64-character hex string"
  }
}
```

**TTL**: 30 seconds

---

### POST /admin/api/auth/exchange

Exchange an authorization code for a JWT token (server-to-server).

**Authentication**: None (server-to-server call)

**Request**:
```json
{
  "code": "authorization-code"
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "token": "JWT token string"
  }
}
```

**Errors**:
- `401`: Invalid, expired, or already-used code
```

---

## 10. Implementation Checklist

### 10.1 Development Tasks

- [ ] Add `AuthCode` types to `packages/admin-cf/src/types.ts`
- [ ] Implement authorization code storage in `AdminUsersDO` (store, exchange, alarm cleanup)
- [ ] Create `packages/admin-cf/src/routes/auth-code.ts` with generate/exchange handlers
- [ ] Add `/admin/api/auth/code` and `/admin/api/auth/exchange` routes to CF worker
- [ ] Update `openVpsDashboard()` in CF admin dashboard JavaScript
- [ ] Update post-verify redirect flow in CF admin
- [ ] Update post-login redirect flow in CF admin
- [ ] Update VPS admin routes to use `?code=` instead of `?token=`
- [ ] Remove query parameter token extraction from VPS `extractToken()`
- [ ] Add unit tests for auth code generation, expiration, single-use
- [ ] Add E2E tests for full auth flow
- [ ] Add VPS integration tests for code exchange

### 10.2 Testing Tasks

- [ ] Run all unit tests: `npm test --workspace=@zajel/admin-cf`
- [ ] Run E2E tests: `npm run test:e2e --workspace=@zajel/admin-cf`
- [ ] Manual test: Generate code, wait 31s, verify expiration
- [ ] Manual test: Generate code, exchange twice, verify single-use
- [ ] Manual test: CF admin → VPS dashboard, check browser history
- [ ] Manual test: Check VPS logs for absence of JWT tokens
- [ ] Performance test: Measure code generation latency (target <100ms)
- [ ] Performance test: Measure code exchange latency (target <500ms)

### 10.3 Deployment Tasks

- [ ] Verify `ZAJEL_CF_ADMIN_URL` is set on all VPS servers
- [ ] Deploy CF admin worker (new endpoints only, old behavior intact)
- [ ] Test new endpoints manually with curl/Postman
- [ ] Monitor CF admin for 1 hour, check error rates
- [ ] Deploy CF admin dashboard changes (use auth codes)
- [ ] Monitor CF admin for 2 hours, check error rates
- [ ] Deploy VPS server changes to one region
- [ ] Monitor VPS region for 1 hour
- [ ] Deploy VPS server changes to remaining regions
- [ ] Monitor all systems for 24 hours
- [ ] Update documentation
- [ ] Mark Story 007 as completed in security changelog

### 10.4 Verification Tasks

- [ ] Verify browser history shows `?code=`, NOT `?token=`
- [ ] Verify VPS server logs do NOT contain JWT tokens
- [ ] Verify VPS dashboard loads correctly after code exchange
- [ ] Verify cookie-based authentication works for API calls
- [ ] Verify redirect flow: VPS → CF admin → VPS works
- [ ] Verify error handling: invalid code shows user-friendly error
- [ ] Verify error handling: network failure redirects to CF admin

---

## 11. Timeline Estimate

| Phase | Tasks | Estimated Time |
|-------|-------|---------------|
| **Development** | Implement code generation, exchange, VPS integration | 4-6 hours |
| **Testing** | Unit, integration, E2E, manual tests | 2-3 hours |
| **Deployment** | Staged rollout (CF → VPS regions) | 2-3 hours |
| **Monitoring** | Post-deployment verification, error tracking | 1-2 hours |
| **Documentation** | Update deployment guides, API docs | 1 hour |
| **TOTAL** | | **10-15 hours** |

**Recommended Schedule**:
- **Day 1 (Thursday)**: Development + testing (6-8 hours)
- **Day 2 (Friday)**: Deployment + monitoring (4-7 hours)

---

## 12. Success Criteria

This implementation is considered successful when:

1. ✅ **No JWT tokens appear in URLs**: Browser history and server logs contain only short-lived authorization codes
2. ✅ **Authorization codes are single-use**: Second exchange attempt fails with 401
3. ✅ **Authorization codes expire**: Codes older than 30 seconds are rejected
4. ✅ **Cross-origin auth works**: CF admin → VPS dashboard flow is seamless
5. ✅ **Redirect flow works**: VPS → CF admin → VPS authentication succeeds
6. ✅ **Cookie-based API auth**: VPS API calls use cookies, NOT query parameters
7. ✅ **Error handling**: Network failures and invalid codes show user-friendly errors
8. ✅ **Backward compatibility**: Existing cookie-based sessions continue to work during deployment
9. ✅ **Performance**: Code generation <100ms, code exchange <500ms (p95)
10. ✅ **All tests pass**: Unit, integration, E2E tests have >90% coverage

---

## 13. Risk Assessment Summary

| Risk Category | Level | Mitigation |
|--------------|-------|------------|
| **Data Loss** | NONE | No persistent data is modified; codes are ephemeral |
| **Downtime** | LOW | Staged deployment allows rollback; existing sessions unaffected |
| **Security Regression** | NONE | Implementation improves security; no existing protections removed |
| **User Experience** | LOW | Minor UX change (auth code in URL instead of token); transparent to users |
| **Performance** | LOW | Code generation/exchange adds <600ms latency once per session |

**Overall Risk**: **LOW** ✅
**Recommended Approval**: **YES** ✅

---

## 14. Open Questions

1. **Should authorization codes be longer than 30 seconds for slow networks?**
   - **Recommendation**: Start with 30 seconds; monitor expiration rate. If >20% of codes expire before use, increase to 60 seconds.

2. **Should we add rate limiting to code generation?**
   - **Recommendation**: Add rate limiting (10 codes/min per user) to prevent abuse. Existing CF worker rate limiting applies to login (5/min), but code generation needs separate limit.

3. **Should we log code usage for audit purposes?**
   - **Recommendation**: Log code exchange events (timestamp, user ID, VPS IP) for security audit trail. Retention: 30 days.

4. **Should we support legacy `?token=` during transition period?**
   - **Recommendation**: NO. The deployment is staged (CF admin first, then VPS), but no parallel support. This avoids confusion and ensures clean cutover.

---

## 15. References

- **OAuth 2.0 Authorization Code Grant**: https://datatracker.ietf.org/doc/html/rfc6749#section-4.1
- **OWASP Sensitive Data Exposure**: https://owasp.org/www-project-top-ten/2017/A3_2017-Sensitive_Data_Exposure
- **CF Workers Durable Objects**: https://developers.cloudflare.com/durable-objects/
- **CF Workers Alarms**: https://developers.cloudflare.com/durable-objects/api/alarms/

---

**Plan Author**: Claude Sonnet 4.5
**Review Status**: Pending Review
**Approved By**: TBD
**Implementation Start Date**: TBD
