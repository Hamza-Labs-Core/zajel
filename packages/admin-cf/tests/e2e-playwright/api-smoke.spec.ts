import { test, expect, BASE_URL } from './fixtures.js';

test.describe('API Smoke Tests', () => {
  const AUTHED_ENDPOINTS = [
    '/admin/api/servers',
    '/admin/api/users',
    '/admin/api/clients/active',
    '/admin/api/clients/platforms',
    '/admin/api/clients/versions',
    '/admin/api/clients/connections',
    '/admin/api/errors',
    '/admin/api/errors/trends',
    '/admin/api/errors/regressions',
    '/admin/api/metrics/app',
    '/admin/api/metrics/network',
    '/admin/api/metrics/federation',
    '/admin/api/servers/health',
    '/admin/api/servers/heartbeat-timeline',
    '/admin/api/logs',
    '/admin/api/security/rate-limits',
    '/admin/api/security/attacks',
    '/admin/api/security/bad-clients',
    '/admin/api/security/pairing-abuse',
    '/admin/api/alerts/rules',
    '/admin/api/alerts/history',
    '/admin/api/notifications',
    '/admin/api/notifications/unread-count',
    '/admin/api/notifications/config',
    '/admin/api/issues',
    '/admin/api/ai/costs',
  ] as const;

  test('all endpoints reject unauthenticated requests', async () => {
    for (const path of AUTHED_ENDPOINTS) {
      const res = await fetch(`${BASE_URL}${path}`);
      expect(res.status, `${path} should be 401`).toBe(401);
    }
  });

  for (const path of AUTHED_ENDPOINTS) {
    test(`GET ${path} returns valid JSON with auth`, async ({ authToken }) => {
      const res = await fetch(`${BASE_URL}${path}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });

      // Accept 200, 500, or 502 (service binding not connected locally) — NOT 401/403
      expect(res.status, `${path} should not be auth error`).not.toBe(401);
      expect(res.status, `${path} should not be forbidden`).not.toBe(403);

      const body = await res.json() as { success: boolean };
      expect(body).toHaveProperty('success');
    });
  }

  test('auth/verify returns valid response with token', async ({ authToken }) => {
    const res = await fetch(`${BASE_URL}/admin/api/auth/verify`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);

    const body = await res.json() as { success: boolean; data?: { username: string } };
    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty('username');
  });

  test('auth/verify rejects invalid token', async () => {
    const res = await fetch(`${BASE_URL}/admin/api/auth/verify`, {
      headers: { Authorization: 'Bearer invalid.token.here' },
    });
    // Returns 401 with success:false
    expect(res.status).toBe(401);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(false);
  });

  test('init endpoint rejects when already initialized', async () => {
    const res = await fetch(`${BASE_URL}/admin/api/auth/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ignored', password: 'AlsoIgnored!2026' }),
    });
    // Returns 400 when already initialized
    expect(res.status).toBe(400);
    const body = await res.json() as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('Already initialized');
  });
});
