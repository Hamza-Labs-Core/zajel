/**
 * Unit tests for Alert History endpoints
 *
 * Tests auth enforcement, pagination, ruleId filter,
 * acknowledge flow, and edge cases with mock D1.
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

  const mockFirst = vi.fn(async () => {
    return storedRows[0] ?? null;
  });

  const mockAll = vi.fn(async () => {
    return { results: storedRows, success: true };
  });

  const mockRun = vi.fn(async () => {
    return { meta: { last_row_id: 1 }, success: true };
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

async function importWorker() {
  const mod = await import('../../src/index.js');
  return mod.default;
}

// --- Tests ---

describe('Alert History API', () => {
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
    it('GET /admin/api/alerts/history returns 401 without token', async () => {
      const env = createMockEnv();
      const req = new Request('http://localhost/admin/api/alerts/history');
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(401);
      const body = await res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Unauthorized');
    });

    it('POST /admin/api/alerts/history/1/acknowledge returns 401 without token', async () => {
      const env = createMockEnv();
      const req = new Request('http://localhost/admin/api/alerts/history/1/acknowledge', {
        method: 'POST',
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(401);
      const body = await res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
    });
  });

  // ─────────────────────────────────────────────
  // No DIAGNOSTICS_DB
  // ─────────────────────────────────────────────

  describe('No DIAGNOSTICS_DB', () => {
    it('GET /admin/api/alerts/history returns empty array', async () => {
      const env = createMockEnv();
      const req = new Request('http://localhost/admin/api/alerts/history', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      const body = await res.json() as {
        success: boolean;
        data: { entries: unknown[]; total: number };
      };
      expect(body.success).toBe(true);
      expect(body.data.entries).toEqual([]);
      expect(body.data.total).toBe(0);
    });

    it('POST /admin/api/alerts/history/1/acknowledge returns 404', async () => {
      const env = createMockEnv();
      const req = new Request('http://localhost/admin/api/alerts/history/1/acknowledge', {
        method: 'POST',
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────
  // List alert history
  // ─────────────────────────────────────────────

  describe('List alert history', () => {
    it('returns paginated history entries', async () => {
      const now = Date.now();
      const mockRows = [
        {
          id: 1,
          rule_id: 10,
          triggered_at: now - 3600000,
          message: 'Error rate exceeded threshold',
          channels_notified: '["dashboard","email"]',
          acknowledged_at: null,
          acknowledged_by: null,
        },
        {
          id: 2,
          rule_id: 20,
          triggered_at: now - 1800000,
          message: 'Server went offline',
          channels_notified: '["dashboard"]',
          acknowledged_at: now - 900000,
          acknowledged_by: 'admin',
        },
      ];

      const mockDb = createMockD1(mockRows);
      const env = createMockEnv({ DIAGNOSTICS_DB: mockDb });

      const req = new Request('http://localhost/admin/api/alerts/history', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as {
        success: boolean;
        data: {
          entries: Array<{
            id: number;
            ruleId: number;
            message: string;
            channelsNotified: string[];
            acknowledgedAt: number | null;
            acknowledgedBy: string | null;
          }>;
          total: number;
        };
      };
      expect(body.success).toBe(true);
      expect(body.data.entries).toHaveLength(2);
      expect(body.data.entries[0].ruleId).toBe(10);
      expect(body.data.entries[0].channelsNotified).toEqual(['dashboard', 'email']);
      expect(body.data.entries[0].acknowledgedAt).toBeNull();
      expect(body.data.entries[1].acknowledgedBy).toBe('admin');
    });

    it('filters by ruleId', async () => {
      const mockRows = [
        {
          id: 1,
          rule_id: 10,
          triggered_at: Date.now(),
          message: 'Alert for rule 10',
          channels_notified: '["dashboard"]',
          acknowledged_at: null,
          acknowledged_by: null,
        },
      ];

      const mockDb = createMockD1(mockRows);
      const env = createMockEnv({ DIAGNOSTICS_DB: mockDb });

      const req = new Request('http://localhost/admin/api/alerts/history?ruleId=10', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);

      // Verify the query included WHERE rule_id = ?
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('WHERE rule_id = ?')
      );
    });

    it('rejects invalid ruleId', async () => {
      const mockDb = createMockD1();
      const env = createMockEnv({ DIAGNOSTICS_DB: mockDb });

      const req = new Request('http://localhost/admin/api/alerts/history?ruleId=abc', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Invalid ruleId');
    });

    it('respects limit parameter', async () => {
      const mockDb = createMockD1([]);
      const env = createMockEnv({ DIAGNOSTICS_DB: mockDb });

      const req = new Request('http://localhost/admin/api/alerts/history?limit=10', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      await worker.fetch(req, env);

      // Verify the query used limit=10
      expect(mockDb._mockBind).toHaveBeenCalledWith(10, 0);
    });

    it('caps limit at 200', async () => {
      const mockDb = createMockD1([]);
      const env = createMockEnv({ DIAGNOSTICS_DB: mockDb });

      const req = new Request('http://localhost/admin/api/alerts/history?limit=500', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      await worker.fetch(req, env);

      // limit=500 is invalid (> 200), so default 50 should be used
      expect(mockDb._mockBind).toHaveBeenCalledWith(50, 0);
    });

    it('respects offset parameter', async () => {
      const mockDb = createMockD1([]);
      const env = createMockEnv({ DIAGNOSTICS_DB: mockDb });

      const req = new Request('http://localhost/admin/api/alerts/history?offset=20', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      await worker.fetch(req, env);

      expect(mockDb._mockBind).toHaveBeenCalledWith(50, 20);
    });

    it('allows regular admin to read history', async () => {
      const mockDb = createMockD1([]);
      const env = createMockEnv({ DIAGNOSTICS_DB: mockDb });

      const req = new Request('http://localhost/admin/api/alerts/history', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
    });
  });

  // ─────────────────────────────────────────────
  // Acknowledge alert
  // ─────────────────────────────────────────────

  describe('Acknowledge alert', () => {
    it('acknowledges an unacknowledged alert', async () => {
      const now = Date.now();
      const mockRow = {
        id: 1,
        rule_id: 10,
        triggered_at: now - 3600000,
        message: 'Error rate exceeded',
        channels_notified: '["dashboard"]',
        acknowledged_at: null,
        acknowledged_by: null,
      };

      const acknowledgedRow = {
        ...mockRow,
        acknowledged_at: now,
        acknowledged_by: 'regularadmin',
      };

      const mockDb = createMockD1([mockRow]);

      // batch([UPDATE, SELECT]) should return acknowledged row in SELECT result
      mockDb._mockBatch.mockResolvedValueOnce([
        { results: [], success: true },
        { results: [acknowledgedRow], success: true },
      ]);

      const env = createMockEnv({ DIAGNOSTICS_DB: mockDb });

      const req = new Request('http://localhost/admin/api/alerts/history/1/acknowledge', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as {
        success: boolean;
        data: {
          id: number;
          acknowledgedAt: number;
          acknowledgedBy: string;
        };
      };
      expect(body.success).toBe(true);
      expect(body.data.acknowledgedBy).toBe('regularadmin');
      expect(body.data.acknowledgedAt).toBe(now);
    });

    it('returns 409 for already acknowledged alert', async () => {
      const now = Date.now();
      const mockRow = {
        id: 1,
        rule_id: 10,
        triggered_at: now - 3600000,
        message: 'Error rate exceeded',
        channels_notified: '["dashboard"]',
        acknowledged_at: now - 1800000,
        acknowledged_by: 'otheradmin',
      };

      const mockDb = createMockD1([mockRow]);
      const env = createMockEnv({ DIAGNOSTICS_DB: mockDb });

      const req = new Request('http://localhost/admin/api/alerts/history/1/acknowledge', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(409);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Alert already acknowledged');
    });

    it('returns 404 for non-existent history entry', async () => {
      const mockDb = createMockD1();
      mockDb._mockFirst.mockResolvedValue(null);
      const env = createMockEnv({ DIAGNOSTICS_DB: mockDb });

      const req = new Request('http://localhost/admin/api/alerts/history/999/acknowledge', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Alert history entry not found');
    });

    it('allows regular admin to acknowledge', async () => {
      const now = Date.now();
      const mockRow = {
        id: 1,
        rule_id: 10,
        triggered_at: now - 3600000,
        message: 'Test alert',
        channels_notified: '["dashboard"]',
        acknowledged_at: null,
        acknowledged_by: null,
      };

      const acknowledgedRow = {
        ...mockRow,
        acknowledged_at: now,
        acknowledged_by: 'regularadmin',
      };

      const mockDb = createMockD1([mockRow]);
      mockDb._mockBatch.mockResolvedValueOnce([
        { results: [], success: true },
        { results: [acknowledgedRow], success: true },
      ]);

      const env = createMockEnv({ DIAGNOSTICS_DB: mockDb });

      const req = new Request('http://localhost/admin/api/alerts/history/1/acknowledge', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      const res = await worker.fetch(req, env);
      // Regular admin should be allowed (requireAuth, not requireSuperAdmin)
      expect(res.status).toBe(200);
    });

    it('non-numeric history ID in URL falls through to 404', async () => {
      const env = createMockEnv({ DIAGNOSTICS_DB: createMockD1() });
      // The regex only matches \d+, so 'abc' won't match
      const req = new Request('http://localhost/admin/api/alerts/history/abc/acknowledge', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────
  // CORS headers
  // ─────────────────────────────────────────────

  describe('CORS headers', () => {
    it('history responses include CORS headers', async () => {
      const env = createMockEnv();
      const req = new Request('http://localhost/admin/api/alerts/history', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });
      const res = await worker.fetch(req, env);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('acknowledge responses include CORS headers', async () => {
      const env = createMockEnv();
      const req = new Request('http://localhost/admin/api/alerts/history/1/acknowledge', {
        method: 'POST',
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });
      const res = await worker.fetch(req, env);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });
  });
});
