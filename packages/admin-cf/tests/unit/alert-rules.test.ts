/**
 * Unit tests for Alert Rules CRUD endpoints
 *
 * Tests auth enforcement, super-admin requirement, validation,
 * CRUD operations, and edge cases with mock D1.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- JWT Helpers ---

function base64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function createTestJwt(
  payload: Record<string, unknown>,
  secret: string
): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { iat: now, exp: now + 900, ...payload };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signatureInput));
  const encodedSig = base64UrlEncode(String.fromCharCode(...new Uint8Array(sig)));

  return `${signatureInput}.${encodedSig}`;
}

// --- Mock D1 ---

interface MockRow {
  [key: string]: unknown;
}

function createMockD1(rows: MockRow[] = []) {
  let storedRows = [...rows];
  let lastInsertId = rows.length;

  const mockFirst = vi.fn(async () => {
    return storedRows[0] ?? null;
  });

  const mockAll = vi.fn(async () => {
    return { results: storedRows, success: true };
  });

  const mockRun = vi.fn(async () => {
    lastInsertId++;
    return { meta: { last_row_id: lastInsertId, changes: storedRows.length > 0 ? 1 : 0 }, success: true };
  });

  const mockBind = vi.fn((..._args: unknown[]) => ({
    first: mockFirst,
    all: mockAll,
    run: mockRun,
  }));

  const mockPrepare = vi.fn((_query: string) => ({
    bind: mockBind,
    first: mockFirst,
    all: mockAll,
    run: mockRun,
  }));

  const mockBatch = vi.fn(async (stmts: Array<{ all: () => Promise<unknown> }>) => {
    return Promise.all(stmts.map((s) => s.all()));
  });

  return {
    prepare: mockPrepare,
    batch: mockBatch,
    _mockFirst: mockFirst,
    _mockAll: mockAll,
    _mockRun: mockRun,
    _mockBind: mockBind,
    _mockBatch: mockBatch,
    _setRows: (newRows: MockRow[]) => { storedRows = [...newRows]; },
    _getLastInsertId: () => lastInsertId,
  };
}

// --- Mock Env Builder ---

const JWT_SECRET = 'test-secret-key-for-unit-tests-1234';

function createMockEnv(overrides: Record<string, unknown> = {}) {
  return {
    ADMIN_USERS: {} as unknown,
    ZAJEL_ADMIN_JWT_SECRET: JWT_SECRET,
    ...overrides,
  };
}

// --- Import worker ---

// We test via the worker fetch handler to exercise routing + handlers together
async function importWorker() {
  const mod = await import('../../src/index.js');
  return mod.default;
}

// --- Tests ---

describe('Alert Rules API', () => {
  let worker: { fetch: (request: Request, env: unknown) => Promise<Response> };
  let superAdminToken: string;
  let adminToken: string;

  beforeEach(async () => {
    worker = await importWorker();

    superAdminToken = await createTestJwt(
      { sub: 'user-1', username: 'superadmin', role: 'super-admin' },
      JWT_SECRET
    );

    adminToken = await createTestJwt(
      { sub: 'user-2', username: 'regularadmin', role: 'admin' },
      JWT_SECRET
    );
  });

  // ─────────────────────────────────────────────
  // Auth Enforcement
  // ─────────────────────────────────────────────

  describe('Auth enforcement', () => {
    it('GET /admin/api/alerts/rules returns 401 without token', async () => {
      const env = createMockEnv();
      const req = new Request('http://localhost/admin/api/alerts/rules');
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(401);
      const body = await res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Unauthorized');
    });

    it('GET /admin/api/alerts/rules/1 returns 401 without token', async () => {
      const env = createMockEnv();
      const req = new Request('http://localhost/admin/api/alerts/rules/1');
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(401);
      const body = await res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
    });

    it('POST /admin/api/alerts/rules returns 401 without token', async () => {
      const env = createMockEnv();
      const req = new Request('http://localhost/admin/api/alerts/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test' }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(401);
    });

    it('PUT /admin/api/alerts/rules/1 returns 401 without token', async () => {
      const env = createMockEnv();
      const req = new Request('http://localhost/admin/api/alerts/rules/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test' }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(401);
    });

    it('DELETE /admin/api/alerts/rules/1 returns 401 without token', async () => {
      const env = createMockEnv();
      const req = new Request('http://localhost/admin/api/alerts/rules/1', {
        method: 'DELETE',
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(401);
    });
  });

  // ─────────────────────────────────────────────
  // Super-admin requirement for write operations
  // ─────────────────────────────────────────────

  describe('Super-admin requirement', () => {
    it('POST /admin/api/alerts/rules returns 403 for regular admin', async () => {
      const env = createMockEnv({ DIAGNOSTICS_DB: createMockD1() });
      const req = new Request('http://localhost/admin/api/alerts/rules', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          name: 'Test Rule',
          conditionType: 'error_rate',
          severity: 'warning',
          channels: ['dashboard'],
        }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(403);
      const body = await res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Super-admin access required');
    });

    it('PUT /admin/api/alerts/rules/1 returns 403 for regular admin', async () => {
      const env = createMockEnv({ DIAGNOSTICS_DB: createMockD1() });
      const req = new Request('http://localhost/admin/api/alerts/rules/1', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ name: 'Updated' }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(403);
      const body = await res.json() as { success: boolean; error: string };
      expect(body.error).toBe('Super-admin access required');
    });

    it('DELETE /admin/api/alerts/rules/1 returns 403 for regular admin', async () => {
      const env = createMockEnv({ DIAGNOSTICS_DB: createMockD1() });
      const req = new Request('http://localhost/admin/api/alerts/rules/1', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(403);
      const body = await res.json() as { success: boolean; error: string };
      expect(body.error).toBe('Super-admin access required');
    });

    it('GET /admin/api/alerts/rules allows regular admin (read-only)', async () => {
      const env = createMockEnv({ DIAGNOSTICS_DB: createMockD1() });
      const req = new Request('http://localhost/admin/api/alerts/rules', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; data: { rules: unknown[]; total: number } };
      expect(body.success).toBe(true);
    });
  });

  // ─────────────────────────────────────────────
  // Empty data when no DIAGNOSTICS_DB
  // ─────────────────────────────────────────────

  describe('No DIAGNOSTICS_DB', () => {
    it('GET /admin/api/alerts/rules returns empty array', async () => {
      const env = createMockEnv();
      const req = new Request('http://localhost/admin/api/alerts/rules', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; data: { rules: unknown[]; total: number } };
      expect(body.success).toBe(true);
      expect(body.data.rules).toEqual([]);
      expect(body.data.total).toBe(0);
    });

    it('GET /admin/api/alerts/rules/1 returns 404', async () => {
      const env = createMockEnv();
      const req = new Request('http://localhost/admin/api/alerts/rules/1', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(404);
    });

    it('POST /admin/api/alerts/rules returns 503', async () => {
      const env = createMockEnv();
      const req = new Request('http://localhost/admin/api/alerts/rules', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${superAdminToken}`,
        },
        body: JSON.stringify({
          name: 'Test',
          conditionType: 'error_rate',
          severity: 'warning',
          channels: ['dashboard'],
        }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(503);
      const body = await res.json() as { success: boolean; error: string };
      expect(body.error).toBe('Diagnostics database not configured');
    });

    it('DELETE /admin/api/alerts/rules/1 returns 404', async () => {
      const env = createMockEnv();
      const req = new Request('http://localhost/admin/api/alerts/rules/1', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────
  // Validation
  // ─────────────────────────────────────────────

  describe('Validation', () => {
    it('rejects missing name', async () => {
      const env = createMockEnv({ DIAGNOSTICS_DB: createMockD1() });
      const req = new Request('http://localhost/admin/api/alerts/rules', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${superAdminToken}`,
        },
        body: JSON.stringify({
          conditionType: 'error_rate',
          severity: 'warning',
          channels: ['dashboard'],
        }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Name is required');
    });

    it('rejects empty name', async () => {
      const env = createMockEnv({ DIAGNOSTICS_DB: createMockD1() });
      const req = new Request('http://localhost/admin/api/alerts/rules', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${superAdminToken}`,
        },
        body: JSON.stringify({
          name: '  ',
          conditionType: 'error_rate',
          severity: 'warning',
          channels: ['dashboard'],
        }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Name is required');
    });

    it('rejects invalid condition_type', async () => {
      const env = createMockEnv({ DIAGNOSTICS_DB: createMockD1() });
      const req = new Request('http://localhost/admin/api/alerts/rules', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${superAdminToken}`,
        },
        body: JSON.stringify({
          name: 'Test Rule',
          conditionType: 'invalid_type',
          severity: 'warning',
          channels: ['dashboard'],
        }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('Invalid condition type');
    });

    it('rejects invalid severity', async () => {
      const env = createMockEnv({ DIAGNOSTICS_DB: createMockD1() });
      const req = new Request('http://localhost/admin/api/alerts/rules', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${superAdminToken}`,
        },
        body: JSON.stringify({
          name: 'Test Rule',
          conditionType: 'error_rate',
          severity: 'emergency',
          channels: ['dashboard'],
        }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('Invalid severity');
    });

    it('rejects invalid channels (not an array)', async () => {
      const env = createMockEnv({ DIAGNOSTICS_DB: createMockD1() });
      const req = new Request('http://localhost/admin/api/alerts/rules', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${superAdminToken}`,
        },
        body: JSON.stringify({
          name: 'Test Rule',
          conditionType: 'error_rate',
          severity: 'warning',
          channels: 'dashboard',
        }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('Invalid channels');
    });

    it('rejects empty channels array', async () => {
      const env = createMockEnv({ DIAGNOSTICS_DB: createMockD1() });
      const req = new Request('http://localhost/admin/api/alerts/rules', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${superAdminToken}`,
        },
        body: JSON.stringify({
          name: 'Test Rule',
          conditionType: 'error_rate',
          severity: 'warning',
          channels: [],
        }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('Invalid channels');
    });

    it('rejects channels with invalid values', async () => {
      const env = createMockEnv({ DIAGNOSTICS_DB: createMockD1() });
      const req = new Request('http://localhost/admin/api/alerts/rules', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${superAdminToken}`,
        },
        body: JSON.stringify({
          name: 'Test Rule',
          conditionType: 'error_rate',
          severity: 'warning',
          channels: ['dashboard', 'sms'],
        }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('Invalid channels');
    });

    it('rejects invalid threshold unit', async () => {
      const env = createMockEnv({ DIAGNOSTICS_DB: createMockD1() });
      const req = new Request('http://localhost/admin/api/alerts/rules', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${superAdminToken}`,
        },
        body: JSON.stringify({
          name: 'Test Rule',
          conditionType: 'error_rate',
          severity: 'warning',
          channels: ['dashboard'],
          thresholdUnit: 'per_second',
        }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('Invalid threshold unit');
    });

    it('rejects cooldown minutes less than 1', async () => {
      const env = createMockEnv({ DIAGNOSTICS_DB: createMockD1() });
      const req = new Request('http://localhost/admin/api/alerts/rules', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${superAdminToken}`,
        },
        body: JSON.stringify({
          name: 'Test Rule',
          conditionType: 'error_rate',
          severity: 'warning',
          channels: ['dashboard'],
          cooldownMinutes: 0,
        }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('Cooldown minutes must be a positive number');
    });

    it('rejects non-numeric cooldown minutes', async () => {
      const env = createMockEnv({ DIAGNOSTICS_DB: createMockD1() });
      const req = new Request('http://localhost/admin/api/alerts/rules', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${superAdminToken}`,
        },
        body: JSON.stringify({
          name: 'Test Rule',
          conditionType: 'error_rate',
          severity: 'warning',
          channels: ['dashboard'],
          cooldownMinutes: 'sixty',
        }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('Cooldown minutes must be a positive number');
    });

    it('rejects invalid JSON body', async () => {
      const env = createMockEnv({ DIAGNOSTICS_DB: createMockD1() });
      const req = new Request('http://localhost/admin/api/alerts/rules', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${superAdminToken}`,
        },
        body: 'not json',
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Invalid JSON body');
    });

    it('rejects invalid rule ID (non-numeric)', async () => {
      const env = createMockEnv({ DIAGNOSTICS_DB: createMockD1() });
      // Non-numeric IDs won't match the regex route, so they fall through to 404
      const req = new Request('http://localhost/admin/api/alerts/rules/abc', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });
      const res = await worker.fetch(req, env);
      // The regex /^\/admin\/api\/alerts\/rules\/\d+$/ won't match 'abc'
      expect(res.status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────
  // CRUD Operations
  // ─────────────────────────────────────────────

  describe('CRUD operations', () => {
    it('creates an alert rule with all fields', async () => {
      const mockRow = {
        id: 1,
        name: 'High Error Rate',
        condition_type: 'error_rate',
        threshold_value: 50,
        threshold_unit: 'per_hour',
        severity: 'critical',
        channels: '["dashboard","email"]',
        enabled: 1,
        cooldown_minutes: 30,
        created_by: 'superadmin',
        created_at: Date.now(),
        last_triggered_at: null,
      };

      const mockDb = createMockD1([mockRow]);
      const env = createMockEnv({ DIAGNOSTICS_DB: mockDb });

      const req = new Request('http://localhost/admin/api/alerts/rules', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${superAdminToken}`,
        },
        body: JSON.stringify({
          name: 'High Error Rate',
          conditionType: 'error_rate',
          thresholdValue: 50,
          thresholdUnit: 'per_hour',
          severity: 'critical',
          channels: ['dashboard', 'email'],
          cooldownMinutes: 30,
        }),
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(201);

      const body = await res.json() as {
        success: boolean;
        data: {
          id: number;
          name: string;
          conditionType: string;
          thresholdValue: number;
          thresholdUnit: string;
          severity: string;
          channels: string[];
          enabled: boolean;
          cooldownMinutes: number;
          createdBy: string;
        };
      };
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('High Error Rate');
      expect(body.data.conditionType).toBe('error_rate');
      expect(body.data.thresholdValue).toBe(50);
      expect(body.data.thresholdUnit).toBe('per_hour');
      expect(body.data.severity).toBe('critical');
      expect(body.data.channels).toEqual(['dashboard', 'email']);
      expect(body.data.enabled).toBe(true);
      expect(body.data.cooldownMinutes).toBe(30);
      expect(body.data.createdBy).toBe('superadmin');
    });

    it('creates an alert rule with default enabled and cooldown', async () => {
      const now = Date.now();
      const mockRow = {
        id: 2,
        name: 'Server Offline',
        condition_type: 'server_offline',
        threshold_value: null,
        threshold_unit: null,
        severity: 'warning',
        channels: '["dashboard"]',
        enabled: 1,
        cooldown_minutes: 60,
        created_by: 'superadmin',
        created_at: now,
        last_triggered_at: null,
      };

      const mockDb = createMockD1([mockRow]);
      const env = createMockEnv({ DIAGNOSTICS_DB: mockDb });

      const req = new Request('http://localhost/admin/api/alerts/rules', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${superAdminToken}`,
        },
        body: JSON.stringify({
          name: 'Server Offline',
          conditionType: 'server_offline',
          severity: 'warning',
          channels: ['dashboard'],
        }),
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(201);

      const body = await res.json() as {
        success: boolean;
        data: { enabled: boolean; cooldownMinutes: number };
      };
      expect(body.data.enabled).toBe(true);
      expect(body.data.cooldownMinutes).toBe(60);
    });

    it('lists alert rules', async () => {
      const mockRows = [
        {
          id: 1,
          name: 'Rule 1',
          condition_type: 'error_rate',
          threshold_value: 10,
          threshold_unit: 'per_hour',
          severity: 'info',
          channels: '["dashboard"]',
          enabled: 1,
          cooldown_minutes: 60,
          created_by: 'admin',
          created_at: Date.now(),
          last_triggered_at: null,
        },
        {
          id: 2,
          name: 'Rule 2',
          condition_type: 'server_offline',
          threshold_value: null,
          threshold_unit: null,
          severity: 'critical',
          channels: '["dashboard","email","webhook"]',
          enabled: 0,
          cooldown_minutes: 120,
          created_by: 'admin',
          created_at: Date.now(),
          last_triggered_at: Date.now() - 3600000,
        },
      ];

      const mockDb = createMockD1(mockRows);
      const env = createMockEnv({ DIAGNOSTICS_DB: mockDb });

      const req = new Request('http://localhost/admin/api/alerts/rules', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as {
        success: boolean;
        data: {
          rules: Array<{ id: number; name: string; enabled: boolean }>;
          total: number;
        };
      };
      expect(body.success).toBe(true);
      expect(body.data.rules).toHaveLength(2);
      expect(body.data.rules[0].name).toBe('Rule 1');
      expect(body.data.rules[1].enabled).toBe(false);
    });

    it('lists alert rules with enabled filter', async () => {
      const mockRows = [
        {
          id: 1,
          name: 'Enabled Rule',
          condition_type: 'error_rate',
          threshold_value: 10,
          threshold_unit: 'per_hour',
          severity: 'info',
          channels: '["dashboard"]',
          enabled: 1,
          cooldown_minutes: 60,
          created_by: 'admin',
          created_at: Date.now(),
          last_triggered_at: null,
        },
      ];

      const mockDb = createMockD1(mockRows);
      const env = createMockEnv({ DIAGNOSTICS_DB: mockDb });

      const req = new Request('http://localhost/admin/api/alerts/rules?enabled=1', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as { success: boolean; data: { rules: unknown[] } };
      expect(body.success).toBe(true);

      // Verify the prepare was called with the WHERE clause
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('WHERE enabled = ?')
      );
    });

    it('gets a single alert rule by ID', async () => {
      const mockRow = {
        id: 5,
        name: 'Attack Detected',
        condition_type: 'attack_detected',
        threshold_value: 3,
        threshold_unit: 'per_hour',
        severity: 'critical',
        channels: '["dashboard","email","webhook"]',
        enabled: 1,
        cooldown_minutes: 15,
        created_by: 'superadmin',
        created_at: Date.now(),
        last_triggered_at: null,
      };

      const mockDb = createMockD1([mockRow]);
      const env = createMockEnv({ DIAGNOSTICS_DB: mockDb });

      const req = new Request('http://localhost/admin/api/alerts/rules/5', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as {
        success: boolean;
        data: { id: number; name: string; conditionType: string };
      };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe(5);
      expect(body.data.name).toBe('Attack Detected');
      expect(body.data.conditionType).toBe('attack_detected');
    });

    it('returns 404 for non-existent rule', async () => {
      const mockDb = createMockD1();
      // Override first() to return null (no row found)
      mockDb._mockFirst.mockResolvedValue(null);
      const env = createMockEnv({ DIAGNOSTICS_DB: mockDb });

      const req = new Request('http://localhost/admin/api/alerts/rules/999', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Alert rule not found');
    });

    it('updates an alert rule', async () => {
      const existingRow = {
        id: 1,
        name: 'Updated Rule',
        condition_type: 'error_rate',
        threshold_value: 100,
        threshold_unit: 'per_hour',
        severity: 'critical',
        channels: '["dashboard","email"]',
        enabled: 1,
        cooldown_minutes: 60,
        created_by: 'superadmin',
        created_at: Date.now(),
        last_triggered_at: null,
      };

      const mockDb = createMockD1([existingRow]);
      const env = createMockEnv({ DIAGNOSTICS_DB: mockDb });

      const req = new Request('http://localhost/admin/api/alerts/rules/1', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${superAdminToken}`,
        },
        body: JSON.stringify({
          name: 'Updated Rule',
          severity: 'critical',
          thresholdValue: 100,
        }),
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as {
        success: boolean;
        data: { name: string; severity: string };
      };
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('Updated Rule');
    });

    it('rejects update with no fields', async () => {
      const existingRow = {
        id: 1,
        name: 'Rule',
        condition_type: 'error_rate',
        threshold_value: null,
        threshold_unit: null,
        severity: 'info',
        channels: '["dashboard"]',
        enabled: 1,
        cooldown_minutes: 60,
        created_by: 'admin',
        created_at: Date.now(),
        last_triggered_at: null,
      };

      const mockDb = createMockD1([existingRow]);
      const env = createMockEnv({ DIAGNOSTICS_DB: mockDb });

      const req = new Request('http://localhost/admin/api/alerts/rules/1', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${superAdminToken}`,
        },
        body: JSON.stringify({}),
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('No fields to update');
    });

    it('rejects update with empty name', async () => {
      const existingRow = {
        id: 1,
        name: 'Rule',
        condition_type: 'error_rate',
        threshold_value: null,
        threshold_unit: null,
        severity: 'info',
        channels: '["dashboard"]',
        enabled: 1,
        cooldown_minutes: 60,
        created_by: 'admin',
        created_at: Date.now(),
        last_triggered_at: null,
      };

      const mockDb = createMockD1([existingRow]);
      const env = createMockEnv({ DIAGNOSTICS_DB: mockDb });

      const req = new Request('http://localhost/admin/api/alerts/rules/1', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${superAdminToken}`,
        },
        body: JSON.stringify({ name: '' }),
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Name cannot be empty');
    });

    it('deletes an alert rule', async () => {
      const existingRow = { id: 1 };

      const mockDb = createMockD1([existingRow]);
      const env = createMockEnv({ DIAGNOSTICS_DB: mockDb });

      const req = new Request('http://localhost/admin/api/alerts/rules/1', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as {
        success: boolean;
        data: { message: string };
      };
      expect(body.success).toBe(true);
      expect(body.data.message).toBe('Alert rule deleted');
    });

    it('returns 404 when deleting non-existent rule', async () => {
      const mockDb = createMockD1();
      // No rows → run() returns meta.changes: 0 → 404
      const env = createMockEnv({ DIAGNOSTICS_DB: mockDb });

      const req = new Request('http://localhost/admin/api/alerts/rules/999', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Alert rule not found');
    });
  });

  // ─────────────────────────────────────────────
  // CORS headers
  // ─────────────────────────────────────────────

  describe('CORS headers', () => {
    it('responses include CORS headers', async () => {
      const env = createMockEnv({ ADMIN_ALLOWED_ORIGINS: 'http://localhost' });
      const req = new Request('http://localhost/admin/api/alerts/rules', {
        headers: { Authorization: `Bearer ${superAdminToken}`, Origin: 'http://localhost' },
      });
      const res = await worker.fetch(req, env);
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost');
      expect(res.headers.get('access-control-allow-methods')).toContain('GET');
    });

    it('401 responses include CORS headers', async () => {
      const env = createMockEnv({ ADMIN_ALLOWED_ORIGINS: 'http://localhost' });
      const req = new Request('http://localhost/admin/api/alerts/rules', {
        headers: { Origin: 'http://localhost' },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(401);
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost');
    });
  });

  // ─────────────────────────────────────────────
  // All valid condition types accepted
  // ─────────────────────────────────────────────

  describe('All condition types', () => {
    const validTypes = [
      'error_rate',
      'server_offline',
      'attack_detected',
      'ai_issue',
      'error_spike',
      'rate_limit_violations',
    ];

    for (const condType of validTypes) {
      it(`accepts condition type: ${condType}`, async () => {
        const mockRow = {
          id: 1,
          name: `Test ${condType}`,
          condition_type: condType,
          threshold_value: null,
          threshold_unit: null,
          severity: 'info',
          channels: '["dashboard"]',
          enabled: 1,
          cooldown_minutes: 60,
          created_by: 'superadmin',
          created_at: Date.now(),
          last_triggered_at: null,
        };

        const mockDb = createMockD1([mockRow]);
        const env = createMockEnv({ DIAGNOSTICS_DB: mockDb });

        const req = new Request('http://localhost/admin/api/alerts/rules', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${superAdminToken}`,
          },
          body: JSON.stringify({
            name: `Test ${condType}`,
            conditionType: condType,
            severity: 'info',
            channels: ['dashboard'],
          }),
        });

        const res = await worker.fetch(req, env);
        expect(res.status).toBe(201);
      });
    }
  });
});
