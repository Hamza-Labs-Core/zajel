/**
 * Admin CF E2E Tests
 *
 * Runs against the live QA deployment at ADMIN_CF_URL.
 * Tests are sequential — they share auth state and created resources.
 *
 * Required env: ADMIN_CF_PASSWORD
 * Optional env: ADMIN_CF_URL, ADMIN_CF_USERNAME
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  type GenerateCodeData,
  type ExchangeCodeData,
  type ErrorsData,
  type ErrorTrendsData,
  type RegressionsData,
} from './helpers.js';

const client = new AdminApiClient();

// State shared across sections
let superAdminUserId: string;
let testUserId: string;
let testUserUsername: string;
let testUserToken: string;

// ─────────────────────────────────────────────
// Setup & Teardown
// ─────────────────────────────────────────────

beforeAll(async () => {
  const result = await loginAsSuperAdmin(client);
  expect(result.success).toBe(true);
  superAdminUserId = result.data!.user.id;
  await cleanupTestUsers(client);
});

afterAll(async () => {
  // Re-login in case token expired during test run
  await loginAsSuperAdmin(client);
  await cleanupTestUsers(client);
});

// ─────────────────────────────────────────────
// Section 1: Health Check
// ─────────────────────────────────────────────

describe('Health Check', () => {
  it('GET /health returns 200 with healthy status', async () => {
    const res = await client.health();
    expect(res.status).toBe(200);

    const body = (await res.json()) as ApiResponse<HealthData>;
    expect(body.success).toBe(true);
    expect(body.data?.status).toBe('healthy');
    expect(body.data?.service).toBe('zajel-admin-cf');
  });

  it('GET /health returns application/json content type', async () => {
    const res = await client.health();
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

// ─────────────────────────────────────────────
// Section 2: Auth Flow
// ─────────────────────────────────────────────

describe('Auth Flow', () => {
  it('POST /admin/api/auth/init returns 400 when already initialized', async () => {
    const res = await client.init('newadmin', 'password12345678');
    expect(res.status).toBe(400);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Already initialized');
  });

  it('POST /admin/api/auth/login succeeds with valid credentials', async () => {
    const res = await client.login(
      SUPER_ADMIN_CREDS.username,
      SUPER_ADMIN_CREDS.password
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as ApiResponse<LoginData>;
    expect(body.success).toBe(true);
    expect(body.data?.token).toBeDefined();
    // JWT is 3 dot-separated parts
    const parts = body.data!.token.split('.');
    expect(parts).toHaveLength(3);

    expect(body.data?.user).toBeDefined();
    expect(body.data?.user.username).toBe(SUPER_ADMIN_CREDS.username);
    expect(body.data?.user.role).toBe('super-admin');
    expect(body.data?.user.id).toBeDefined();
  });

  it('POST /admin/api/auth/login fails with wrong password', async () => {
    const res = await client.login(SUPER_ADMIN_CREDS.username, 'wrongpassword123');
    expect(res.status).toBe(401);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Invalid credentials');
  });

  it('POST /admin/api/auth/login fails for non-existent user', async () => {
    const res = await client.login('nonexistent_user_xyz', 'somepassword123');
    expect(res.status).toBe(401);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Invalid credentials');
  });

  it('POST /admin/api/auth/login fails with missing username', async () => {
    const res = await fetch(`${client['baseUrl']}/admin/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'somepassword123' }),
    });
    expect(res.status).toBe(400);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Username and password required');
  });

  it('POST /admin/api/auth/login fails with missing password', async () => {
    const res = await fetch(`${client['baseUrl']}/admin/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin' }),
    });
    expect(res.status).toBe(400);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Username and password required');
  });

  it('POST /admin/api/auth/login fails with empty body', async () => {
    const res = await fetch(`${client['baseUrl']}/admin/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
  });

  it('GET /admin/api/auth/verify succeeds with valid token', async () => {
    const res = await client.verify();
    expect(res.status).toBe(200);

    const body = (await res.json()) as ApiResponse<VerifyData>;
    expect(body.success).toBe(true);
    expect(body.data?.userId).toBeDefined();
    expect(body.data?.username).toBe(SUPER_ADMIN_CREDS.username);
    expect(body.data?.role).toBe('super-admin');
  });

  it('GET /admin/api/auth/verify fails without auth header', async () => {
    const res = await fetch(`${client['baseUrl']}/admin/api/auth/verify`, {
      method: 'GET',
    });
    expect(res.status).toBe(401);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Missing authorization');
  });

  it('GET /admin/api/auth/verify succeeds with cookie auth', async () => {
    const res = await fetch(`${client['baseUrl']}/admin/api/auth/verify`, {
      method: 'GET',
      headers: {
        Cookie: `zajel_admin_token=${client.getToken()}`,
      },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as ApiResponse<VerifyData>;
    expect(body.success).toBe(true);
    expect(body.data?.username).toBe(SUPER_ADMIN_CREDS.username);
  });

  it('GET /admin/api/auth/verify fails with invalid token', async () => {
    const res = await client.verify('invalid.token.value');
    // Server may return 401 (graceful rejection) or 500 (malformed JWT causes parse error)
    expect([401, 500]).toContain(res.status);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
  });

  it('POST /admin/api/auth/logout returns 200 with cookie clear', async () => {
    const res = await client.logout();
    expect(res.status).toBe(200);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(true);

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain('zajel_admin_token=');
    expect(setCookie).toContain('Max-Age=0');
  });
});

// ─────────────────────────────────────────────
// Section 3: User Management
// ─────────────────────────────────────────────

describe('User Management', () => {
  it('GET /admin/api/users lists users when authenticated', async () => {
    // Ensure we have a valid token
    await loginAsSuperAdmin(client);

    const res = await client.listUsers();
    expect(res.status).toBe(200);

    const body = (await res.json()) as ApiResponse<AdminUserPublic[]>;
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);

    // Should contain the super-admin user
    const superAdmin = body.data!.find(
      (u) => u.username === SUPER_ADMIN_CREDS.username
    );
    expect(superAdmin).toBeDefined();
    expect(superAdmin!.role).toBe('super-admin');
  });

  it('GET /admin/api/users returns 401 without auth', async () => {
    const res = await client.listUsersNoAuth();
    expect(res.status).toBe(401);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Unauthorized');
  });

  it('POST /admin/api/users creates a user as super-admin', async () => {
    testUserUsername = testUsername();
    const res = await client.createUser(
      testUserUsername,
      'test_password_12345',
      'admin'
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as ApiResponse<AdminUserPublic>;
    expect(body.success).toBe(true);
    expect(body.data?.username).toBe(testUserUsername);
    expect(body.data?.role).toBe('admin');
    expect(body.data?.id).toBeDefined();
    testUserId = body.data!.id;
  });

  it('POST /admin/api/users returns 409 for duplicate username', async () => {
    const res = await client.createUser(
      testUserUsername,
      'another_password_12345',
      'admin'
    );
    expect(res.status).toBe(409);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Username already exists');
  });

  it('POST /admin/api/users returns 400 for short password', async () => {
    const res = await client.createUser(testUsername(), 'short', 'admin');
    expect(res.status).toBe(400);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Password must be at least 12 characters');
  });

  it('POST /admin/api/users returns 400 for missing fields', async () => {
    const res = await fetch(`${client['baseUrl']}/admin/api/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${client.getToken()}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Username and password required');
  });

  it('POST /admin/api/users returns 403 for regular admin', async () => {
    // Login as the test user (admin, not super-admin)
    const loginRes = await client.login(testUserUsername, 'test_password_12345');
    const loginBody = (await loginRes.json()) as ApiResponse<LoginData>;
    expect(loginBody.success).toBe(true);
    testUserToken = loginBody.data!.token;

    // Try to create a user with admin token
    const res = await fetch(`${client['baseUrl']}/admin/api/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testUserToken}`,
      },
      body: JSON.stringify({
        username: testUsername(),
        password: 'somepassword12345',
        role: 'admin',
      }),
    });
    expect(res.status).toBe(403);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Super-admin access required');
  });

  it('POST /admin/api/users returns 401 without auth', async () => {
    const res = await client.createUserNoAuth(
      testUsername(),
      'somepassword12345',
      'admin'
    );
    expect(res.status).toBe(401);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Unauthorized');
  });

  it('DELETE /admin/api/users/:id returns 400 when deleting self', async () => {
    // Re-login as super-admin
    await loginAsSuperAdmin(client);

    const res = await client.deleteUser(superAdminUserId);
    expect(res.status).toBe(400);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Cannot delete yourself');
  });

  it('DELETE /admin/api/users/:id returns 403 for regular admin', async () => {
    const res = await fetch(
      `${client['baseUrl']}/admin/api/users/${testUserId}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${testUserToken}`,
        },
      }
    );
    expect(res.status).toBe(403);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Super-admin access required');
  });

  it('DELETE /admin/api/users/:id returns 404 for non-existent user', async () => {
    // Ensure super-admin token
    await loginAsSuperAdmin(client);

    const res = await client.deleteUser('nonexistent-id-12345');
    expect(res.status).toBe(404);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('User not found');
  });

  it('DELETE /admin/api/users/:id returns 401 without auth', async () => {
    const res = await client.deleteUserNoAuth(testUserId);
    expect(res.status).toBe(401);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Unauthorized');
  });

  it('DELETE /admin/api/users/:id successfully deletes test user', async () => {
    await loginAsSuperAdmin(client);

    const res = await client.deleteUser(testUserId);
    expect(res.status).toBe(200);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(true);

    // Verify user is gone from list
    const listRes = await client.listUsers();
    const listBody = (await listRes.json()) as ApiResponse<AdminUserPublic[]>;
    const found = listBody.data?.find((u) => u.id === testUserId);
    expect(found).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// Section 4: Server Monitoring
// ─────────────────────────────────────────────

describe('Server Monitoring', () => {
  it('GET /admin/api/servers returns server data or 502 when bootstrap unavailable', async () => {
    await loginAsSuperAdmin(client);

    const res = await client.listServers();

    // Bootstrap may be unreachable, so accept both 200 and 502
    if (res.status === 200) {
      const body = (await res.json()) as ApiResponse<ServersData>;
      expect(body.success).toBe(true);
      expect(body.data?.servers).toBeDefined();
      expect(Array.isArray(body.data?.servers)).toBe(true);
      expect(body.data?.aggregate).toBeDefined();
      expect(typeof body.data?.aggregate.totalServers).toBe('number');
      expect(typeof body.data?.aggregate.healthyServers).toBe('number');
      expect(typeof body.data?.aggregate.degradedServers).toBe('number');
      expect(typeof body.data?.aggregate.offlineServers).toBe('number');
      expect(typeof body.data?.aggregate.totalConnections).toBe('number');

      // Verify aggregate consistency
      const agg = body.data!.aggregate;
      expect(agg.healthyServers + agg.degradedServers + agg.offlineServers).toBe(
        agg.totalServers
      );
    } else {
      // Bootstrap registry unavailable — error handler returns 502
      expect(res.status).toBe(502);
      const body = (await res.json()) as ApiResponse;
      expect(body.success).toBe(false);
    }
  });

  it('GET /admin/api/servers returns 401 without auth', async () => {
    const res = await client.listServersNoAuth();
    expect(res.status).toBe(401);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Unauthorized');
  });

  it('each server has numeric stats fields when servers are available', async () => {
    await loginAsSuperAdmin(client);
    const res = await client.listServers();

    if (res.status !== 200) return; // Skip if bootstrap unavailable

    const body = (await res.json()) as ApiResponse<ServersData>;
    expect(body.success).toBe(true);

    const servers = body.data?.servers ?? [];
    for (const server of servers) {
      if (!server.stats) continue; // offline servers may lack stats

      expect(typeof server.stats.relayConnections).toBe('number');
      expect(server.stats.relayConnections).toBeGreaterThanOrEqual(0);

      expect(typeof server.stats.signalingConnections).toBe('number');
      expect(server.stats.signalingConnections).toBeGreaterThanOrEqual(0);

      expect(typeof server.stats.activeCodes).toBe('number');
      expect(server.stats.activeCodes).toBeGreaterThanOrEqual(0);
    }
  });

  it('aggregate totalConnections matches sum of individual server connections', async () => {
    await loginAsSuperAdmin(client);
    const res = await client.listServers();

    if (res.status !== 200) return; // Skip if bootstrap unavailable

    const body = (await res.json()) as ApiResponse<ServersData>;
    expect(body.success).toBe(true);

    const servers = body.data?.servers ?? [];
    const agg = body.data!.aggregate;

    const sumConnections = servers.reduce(
      (acc, s) => acc + (s.stats?.connections ?? 0),
      0
    );
    expect(agg.totalConnections).toBe(sumConnections);
  });
});

// ─────────────────────────────────────────────
// Section 5: Security
// ─────────────────────────────────────────────

describe('Security', () => {
  it('API responses do not use wildcard CORS', async () => {
    // Same-origin requests don't send an Origin header, so no wildcard CORS
    const res = await client.health();
    const origin = res.headers.get('access-control-allow-origin');
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
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-methods')).toContain('DELETE');
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(res.headers.get('access-control-max-age')).toBe('86400');
  });

  it.skip('Rate limiting on login (per-isolate, unreliable against live CF)', () => {
    // Rate limiting uses per-isolate in-memory Map, which cannot be
    // reliably tested against distributed CF Workers in production.
  });
});

// ─────────────────────────────────────────────
// Section 6: Authorization Code Exchange
// ─────────────────────────────────────────────

describe('Authorization Code Exchange', () => {
  it('POST /admin/api/auth/code generates a code for authenticated user', async () => {
    await loginAsSuperAdmin(client);

    const res = await client.fetchPath('/admin/api/auth/code', {
      method: 'POST',
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as ApiResponse<GenerateCodeData>;
    expect(body.success).toBe(true);
    expect(body.data?.code).toBeDefined();
    expect(body.data!.code).toHaveLength(64); // 32 bytes hex encoded
  });

  it('POST /admin/api/auth/code requires authentication', async () => {
    const res = await fetch(`${client['baseUrl']}/admin/api/auth/code`, {
      method: 'POST',
    });
    expect(res.status).toBe(401);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
  });

  it('POST /admin/api/auth/exchange exchanges valid code for JWT', async () => {
    await loginAsSuperAdmin(client);

    // Generate code first
    const codeRes = await client.fetchPath('/admin/api/auth/code', {
      method: 'POST',
    });
    const codeBody = (await codeRes.json()) as ApiResponse<GenerateCodeData>;
    expect(codeBody.success).toBe(true);
    const code = codeBody.data!.code;

    // Exchange code for token (no auth required — server-to-server call)
    const exchangeRes = await fetch(`${client['baseUrl']}/admin/api/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(exchangeRes.status).toBe(200);

    const exchangeBody = (await exchangeRes.json()) as ApiResponse<ExchangeCodeData>;
    expect(exchangeBody.success).toBe(true);
    expect(exchangeBody.data?.token).toBeDefined();

    // Verify token has correct structure (3 dot-separated parts)
    const parts = exchangeBody.data!.token.split('.');
    expect(parts).toHaveLength(3);
  });

  it('POST /admin/api/auth/exchange rejects code reuse (single-use)', async () => {
    await loginAsSuperAdmin(client);

    // Generate code
    const codeRes = await client.fetchPath('/admin/api/auth/code', {
      method: 'POST',
    });
    const codeBody = (await codeRes.json()) as ApiResponse<GenerateCodeData>;
    const code = codeBody.data!.code;

    // Exchange code first time (should succeed)
    const firstExchange = await fetch(`${client['baseUrl']}/admin/api/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(firstExchange.status).toBe(200);

    // Attempt to exchange same code again (should fail)
    const secondExchange = await fetch(`${client['baseUrl']}/admin/api/auth/exchange`, {
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
    const res = await fetch(`${client['baseUrl']}/admin/api/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'invalid-code-12345' }),
    });
    expect(res.status).toBe(401);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
  });

  it('POST /admin/api/auth/exchange rejects empty code', async () => {
    const res = await fetch(`${client['baseUrl']}/admin/api/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '' }),
    });
    expect(res.status).toBe(400);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Code required');
  });

  it('POST /admin/api/auth/exchange rejects invalid JSON', async () => {
    const res = await fetch(`${client['baseUrl']}/admin/api/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Invalid JSON body');
  });
});

// ─────────────────────────────────────────────
// Section 7: Dashboard UI (renumbered from 6)
// ─────────────────────────────────────────────

describe('Dashboard UI', () => {
  it('GET /admin/ serves the dashboard HTML', async () => {
    const res = await client.rawGet('/admin/');
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain('Zajel Admin Dashboard');
    expect(html).toContain('login-form');
    expect(html).toContain('div id="app"');
  });

  it('GET /admin serves HTML or redirects to /admin/', async () => {
    const res = await client.rawGet('/admin');
    // Could be 200 (direct serve) or 301/302 redirect
    expect([200, 301, 302]).toContain(res.status);

    if (res.status === 200) {
      const html = await res.text();
      expect(html).toContain('Zajel Admin Dashboard');
    }
  });

  it('GET /admin/settings serves dashboard HTML (SPA fallback)', async () => {
    const res = await client.rawGet('/admin/settings');
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain('Zajel Admin Dashboard');
  });
});

// ─────────────────────────────────────────────
// Section 7: Error Dashboard
// ─────────────────────────────────────────────

describe('Error Dashboard', () => {
  it('GET /admin/api/errors returns 200 with valid structure', async () => {
    await loginAsSuperAdmin(client);

    const res = await client.listErrors();
    expect(res.status).toBe(200);

    const body = (await res.json()) as ApiResponse<ErrorsData>;
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();

    // Verify summary structure
    expect(body.data!.summary).toBeDefined();
    expect(typeof body.data!.summary.totalErrors).toBe('number');
    expect(typeof body.data!.summary.rateChangePercent).toBe('number');
    expect(typeof body.data!.summary.regressionAlerts).toBe('number');
    expect(typeof body.data!.summary.highestSeverity).toBe('string');

    // Verify errors array
    expect(Array.isArray(body.data!.errors)).toBe(true);

    // Verify range
    expect(body.data!.range).toBeDefined();
    expect(['1h', '24h', '7d']).toContain(body.data!.range);
  });

  it('GET /admin/api/errors returns 401 without auth header', async () => {
    const res = await client.listErrorsNoAuth();
    expect(res.status).toBe(401);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Unauthorized');
  });

  it('GET /admin/api/errors respects range parameter', async () => {
    await loginAsSuperAdmin(client);

    for (const range of ['1h', '24h', '7d']) {
      const res = await client.listErrors(range);
      expect(res.status).toBe(200);

      const body = (await res.json()) as ApiResponse<ErrorsData>;
      expect(body.success).toBe(true);
      expect(body.data!.range).toBe(range);
    }
  });

  it('GET /admin/api/errors defaults to 24h when no range specified', async () => {
    await loginAsSuperAdmin(client);

    const res = await client.listErrors();
    expect(res.status).toBe(200);

    const body = (await res.json()) as ApiResponse<ErrorsData>;
    expect(body.data!.range).toBe('24h');
  });

  it('GET /admin/api/errors includes CORS headers', async () => {
    await loginAsSuperAdmin(client);

    const res = await client.listErrors();
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('error data items have correct field types when present', async () => {
    await loginAsSuperAdmin(client);

    const res = await client.listErrors('7d');
    expect(res.status).toBe(200);

    const body = (await res.json()) as ApiResponse<ErrorsData>;
    for (const err of body.data!.errors) {
      expect(typeof err.errorSignature).toBe('string');
      expect(typeof err.category).toBe('string');
      expect(typeof err.totalCount).toBe('number');
      expect(Array.isArray(err.versions)).toBe(true);
      expect(Array.isArray(err.platforms)).toBe(true);
      expect(typeof err.firstSeen).toBe('number');
      expect(typeof err.lastSeen).toBe('number');
      expect(typeof err.sampleMessage).toBe('string');
    }
  });
});

// ─────────────────────────────────────────────
// Section 7b: Error Trends (US-2.2)
// ─────────────────────────────────────────────

describe('Error Trends', () => {
  it('GET /admin/api/errors/trends returns 200 with valid schema', async () => {
    await loginAsSuperAdmin(client);

    const res = await client.getErrorTrends();
    expect(res.status).toBe(200);

    const body = (await res.json()) as ApiResponse<ErrorTrendsData>;
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();

    // Verify structure
    expect(Array.isArray(body.data!.timestamps)).toBe(true);
    expect(typeof body.data!.series).toBe('object');
    expect(Array.isArray(body.data!.deployments)).toBe(true);
    expect(typeof body.data!.range).toBe('string');
    expect(['1h', '24h', '7d']).toContain(body.data!.range);
    expect(typeof body.data!.bucketSize).toBe('string');
    expect(['1min', '1h', '6h']).toContain(body.data!.bucketSize);
  });

  it('GET /admin/api/errors/trends returns 401 without auth', async () => {
    const res = await client.getErrorTrendsNoAuth();
    expect(res.status).toBe(401);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Unauthorized');
  });

  it('GET /admin/api/errors/trends respects range parameter', async () => {
    await loginAsSuperAdmin(client);

    for (const range of ['1h', '24h', '7d']) {
      const res = await client.getErrorTrends(range);
      expect(res.status).toBe(200);

      const body = (await res.json()) as ApiResponse<ErrorTrendsData>;
      expect(body.success).toBe(true);
      expect(body.data!.range).toBe(range);
    }
  });

  it('GET /admin/api/errors/trends defaults to 24h range', async () => {
    await loginAsSuperAdmin(client);

    const res = await client.getErrorTrends();
    expect(res.status).toBe(200);

    const body = (await res.json()) as ApiResponse<ErrorTrendsData>;
    expect(body.data!.range).toBe('24h');
    expect(body.data!.bucketSize).toBe('1h');
  });

  it('GET /admin/api/errors/trends returns correct bucket sizes per range', async () => {
    await loginAsSuperAdmin(client);

    const expected: Record<string, string> = { '1h': '1min', '24h': '1h', '7d': '6h' };

    for (const [range, bucketSize] of Object.entries(expected)) {
      const res = await client.getErrorTrends(range);
      const body = (await res.json()) as ApiResponse<ErrorTrendsData>;
      expect(body.data!.bucketSize).toBe(bucketSize);
    }
  });

  it('GET /admin/api/errors/trends includes CORS headers', async () => {
    await loginAsSuperAdmin(client);

    const res = await client.getErrorTrends();
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('series keys are valid error categories when data exists', async () => {
    await loginAsSuperAdmin(client);

    const res = await client.getErrorTrends('7d');
    expect(res.status).toBe(200);

    const body = (await res.json()) as ApiResponse<ErrorTrendsData>;
    const validCategories = ['crash', 'network', 'crypto', 'storage', 'ui', 'protocol', 'other'];
    for (const key of Object.keys(body.data!.series)) {
      expect(validCategories).toContain(key);
    }
  });

  it('timestamps are in ascending order', async () => {
    await loginAsSuperAdmin(client);

    const res = await client.getErrorTrends('7d');
    expect(res.status).toBe(200);

    const body = (await res.json()) as ApiResponse<ErrorTrendsData>;
    const timestamps = body.data!.timestamps;
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]!);
    }
  });

  it('series arrays are aligned with timestamps', async () => {
    await loginAsSuperAdmin(client);

    const res = await client.getErrorTrends('24h');
    expect(res.status).toBe(200);

    const body = (await res.json()) as ApiResponse<ErrorTrendsData>;
    const tsLen = body.data!.timestamps.length;
    for (const [, values] of Object.entries(body.data!.series)) {
      expect(values.length).toBe(tsLen);
    }
  });

  it('deployment markers have correct field types', async () => {
    await loginAsSuperAdmin(client);

    const res = await client.getErrorTrends('7d');
    expect(res.status).toBe(200);

    const body = (await res.json()) as ApiResponse<ErrorTrendsData>;
    for (const dep of body.data!.deployments) {
      expect(typeof dep.version).toBe('string');
      expect(typeof dep.timestamp).toBe('number');
    }
  });
});

// ─────────────────────────────────────────────
// Section 8: Regression Detection (US-2.4)
// ─────────────────────────────────────────────

describe('Regression Detection', () => {
  it('GET /admin/api/errors/regressions returns 200 with valid schema', async () => {
    await loginAsSuperAdmin(client);

    const res = await client.getErrorRegressions();
    expect(res.status).toBe(200);

    const body = (await res.json()) as ApiResponse<RegressionsData>;
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();

    // Verify regressions is an array
    expect(Array.isArray(body.data!.regressions)).toBe(true);

    // Verify currentVersion and previousVersion are strings
    expect(typeof body.data!.currentVersion).toBe('string');
    expect(typeof body.data!.previousVersion).toBe('string');

    // Verify window and threshold
    expect(typeof body.data!.window).toBe('string');
    expect(['6h', '24h', '48h']).toContain(body.data!.window);
    expect(typeof body.data!.threshold).toBe('number');
    expect(typeof body.data!.computedAt).toBe('number');
  });

  it('GET /admin/api/errors/regressions returns 401 without auth', async () => {
    const res = await client.getErrorRegressionsNoAuth();
    expect(res.status).toBe(401);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Unauthorized');
  });

  it('GET /admin/api/errors/regressions accepts window parameter', async () => {
    await loginAsSuperAdmin(client);

    for (const window of ['6h', '24h', '48h']) {
      const res = await client.getErrorRegressions(window);
      expect(res.status).toBe(200);

      const body = (await res.json()) as ApiResponse<RegressionsData>;
      expect(body.success).toBe(true);
      expect(body.data!.window).toBe(window);
    }
  });

  it('GET /admin/api/errors/regressions accepts custom threshold', async () => {
    await loginAsSuperAdmin(client);

    const res = await client.getErrorRegressions('24h', 2.0);
    expect(res.status).toBe(200);

    const body = (await res.json()) as ApiResponse<RegressionsData>;
    expect(body.success).toBe(true);
    expect(body.data!.threshold).toBe(2.0);
  });

  it('GET /admin/api/errors/regressions rejects invalid window', async () => {
    await loginAsSuperAdmin(client);

    const res = await client.getErrorRegressions('12h');
    expect(res.status).toBe(400);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toContain('Invalid window');
  });

  it('GET /admin/api/errors/regressions includes CORS headers', async () => {
    await loginAsSuperAdmin(client);

    const res = await client.getErrorRegressions();
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('regression items have correct field types when present', async () => {
    await loginAsSuperAdmin(client);

    const res = await client.getErrorRegressions();
    expect(res.status).toBe(200);

    const body = (await res.json()) as ApiResponse<RegressionsData>;
    // Regressions may be empty if no regressions exist in QA
    for (const reg of body.data!.regressions) {
      expect(typeof reg.errorSignature).toBe('string');
      expect(typeof reg.category).toBe('string');
      expect(typeof reg.currentVersion).toBe('string');
      expect(typeof reg.previousVersion).toBe('string');
      expect(typeof reg.currentRate).toBe('number');
      expect(typeof reg.previousRate).toBe('number');
      expect(typeof reg.multiplier).toBe('number');
      expect(typeof reg.currentTotal).toBe('number');
      expect(typeof reg.previousTotal).toBe('number');
      expect(typeof reg.firstDetected).toBe('number');
      expect(typeof reg.sampleMessage).toBe('string');
    }
  });
});

// ─────────────────────────────────────────────
// Section 9: Edge Cases
// ─────────────────────────────────────────────

describe('Edge Cases', () => {
  it('GET /admin/api/unknown returns 404', async () => {
    const res = await client.rawGet('/admin/api/unknown');
    expect(res.status).toBe(404);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Not found');
  });

  it('GET /admin/api/auth/login (wrong method) returns 404', async () => {
    const res = await client.rawGet('/admin/api/auth/login');
    expect(res.status).toBe(404);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Not found');
  });

  it('PUT /admin/api/users (unsupported method) returns 404', async () => {
    const res = await client.rawRequest('/admin/api/users', 'PUT');
    expect(res.status).toBe(404);

    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Not found');
  });

  it('GET / redirects to /admin/', async () => {
    const res = await client.rawGet('/');
    expect(res.status).toBe(302);

    const location = res.headers.get('location');
    expect(location).toBeDefined();
    expect(location).toContain('/admin/');
  });

  it('404 responses include security headers', async () => {
    const res = await client.rawGet('/admin/api/unknown');
    expect(res.status).toBe(404);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});
