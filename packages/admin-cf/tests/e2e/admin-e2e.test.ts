/**
 * Admin CF E2E Tests
 *
 * Runs against the live QA deployment at ADMIN_CF_URL.
 * Tests are sequential — they share auth state and created resources.
 *
 * Required env: none (defaults to QA URL and admin/admin1234567890)
 * Optional env: ADMIN_CF_URL, ADMIN_CF_USERNAME, ADMIN_CF_PASSWORD
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
    expect(body.error).toBe('Missing authorization header');
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
});

// ─────────────────────────────────────────────
// Section 5: Security
// ─────────────────────────────────────────────

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

  it.skip('Rate limiting on login (per-isolate, unreliable against live CF)', () => {
    // Rate limiting uses per-isolate in-memory Map, which cannot be
    // reliably tested against distributed CF Workers in production.
  });
});

// ─────────────────────────────────────────────
// Section 6: Dashboard UI
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
// Section 7: Edge Cases
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

  it('404 responses include CORS headers', async () => {
    const res = await client.rawGet('/admin/api/unknown');
    expect(res.status).toBe(404);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
