/**
 * Unit tests for version adoption route handler (US-4.3)
 *
 * Tests handleVersionAdoption with mock D1 bindings and mock auth,
 * following the same pattern as server-metrics.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleVersionAdoption } from '../../src/routes/clients.js';
import type { Env } from '../../src/types.js';

// ─────────────────────────────────────────────
// Mock auth module — bypass JWT verification
// ─────────────────────────────────────────────

vi.mock('../../src/routes/auth.js', () => ({
  requireAuth: vi.fn().mockResolvedValue({
    sub: 'user-1',
    username: 'admin',
    role: 'admin',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
}));

// ─────────────────────────────────────────────
// Mock D1 helpers
// ─────────────────────────────────────────────

interface MockD1Statement {
  bind: (...args: unknown[]) => MockD1Statement;
  all: <T = unknown>() => Promise<{ results: T[]; success: boolean }>;
  first: <T = unknown>() => Promise<T | null>;
  run: () => Promise<{ success: boolean; meta: { changes: number } }>;
}

function createMockStatement(
  allResults: unknown[] = [],
  firstResult: unknown = null,
): MockD1Statement {
  const stmt: MockD1Statement = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue({ results: allResults, success: true }),
    first: vi.fn().mockResolvedValue(firstResult),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
  };
  return stmt;
}

interface PrepareCall {
  query: string;
  allResults?: unknown[];
  firstResult?: unknown;
}

function createMockD1(prepareCalls: PrepareCall[]): D1Database {
  const prepareFn = vi.fn().mockImplementation((query: string) => {
    for (const call of prepareCalls) {
      if (query.includes(call.query)) {
        return createMockStatement(call.allResults || [], call.firstResult || null);
      }
    }
    return createMockStatement([], null);
  });

  return { prepare: prepareFn } as unknown as D1Database;
}

function createRequest(urlPath: string): Request {
  return new Request(`https://admin.example.com${urlPath}`, {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

function createEnv(db?: D1Database): Env {
  return {
    ADMIN_USERS: {} as DurableObjectNamespace,
    ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    DIAGNOSTICS_DB: db,
  };
}

// ─────────────────────────────────────────────
// handleVersionAdoption tests
// ─────────────────────────────────────────────

describe('handleVersionAdoption', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  // ─── Successful responses ───

  it('returns 200 with version adoption data', async () => {
    const now = Date.now();
    const bucket1 = Math.floor(now / 300000) * 300000 - 600000;
    const bucket2 = Math.floor(now / 300000) * 300000 - 300000;
    const db = createMockD1([
      {
        query: 'version_history',
        allResults: [
          { time_bucket: bucket1, app_version: '2.0.0', active_count: 10 },
          { time_bucket: bucket1, app_version: '1.5.0', active_count: 5 },
          { time_bucket: bucket2, app_version: '2.0.0', active_count: 12 },
          { time_bucket: bucket2, app_version: '1.5.0', active_count: 3 },
        ],
      },
    ]);

    const req = createRequest('/admin/api/clients/versions?range=7d');
    const env = createEnv(db);

    const res = await handleVersionAdoption(req, env);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      success: boolean;
      data: {
        range: string;
        buckets: Array<{ timestamp: number; counts: Record<string, number> }>;
        versions: string[];
        lastUpdated: number;
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.range).toBe('7d');
    expect(body.data.versions).toContain('2.0.0');
    expect(body.data.versions).toContain('1.5.0');
    expect(body.data.buckets.length).toBeGreaterThan(0);
    expect(typeof body.data.lastUpdated).toBe('number');
  });

  // ─── Range resolution ───

  it('handles 24h range (5-min resolution)', async () => {
    const now = Date.now();
    const bucket = Math.floor(now / 300000) * 300000 - 300000;
    const db = createMockD1([
      {
        query: 'version_history',
        allResults: [
          { time_bucket: bucket, app_version: '1.0.0', active_count: 5 },
        ],
      },
    ]);

    const req = createRequest('/admin/api/clients/versions?range=24h');
    const env = createEnv(db);

    const res = await handleVersionAdoption(req, env);
    expect(res.status).toBe(200);

    const body = await res.json() as { success: boolean; data: { range: string } };
    expect(body.data.range).toBe('24h');
  });

  it('handles 7d range (hourly buckets)', async () => {
    const now = Date.now();
    const hourBucket = Math.floor(now / 3600000) * 3600000;
    const db = createMockD1([
      {
        query: 'version_history',
        allResults: [
          { time_bucket: hourBucket, app_version: '1.0.0', active_count: 10 },
        ],
      },
    ]);

    const req = createRequest('/admin/api/clients/versions?range=7d');
    const env = createEnv(db);

    const res = await handleVersionAdoption(req, env);
    expect(res.status).toBe(200);

    const body = await res.json() as { success: boolean; data: { range: string } };
    expect(body.data.range).toBe('7d');
  });

  it('handles 30d range (6-hour buckets)', async () => {
    const now = Date.now();
    const sixHourBucket = Math.floor(now / 21600000) * 21600000;
    const db = createMockD1([
      {
        query: 'version_history',
        allResults: [
          { time_bucket: sixHourBucket, app_version: '1.0.0', active_count: 20 },
        ],
      },
    ]);

    const req = createRequest('/admin/api/clients/versions?range=30d');
    const env = createEnv(db);

    const res = await handleVersionAdoption(req, env);
    expect(res.status).toBe(200);

    const body = await res.json() as { success: boolean; data: { range: string } };
    expect(body.data.range).toBe('30d');
  });

  // ─── Validation ───

  it('rejects invalid range parameter', async () => {
    const db = createMockD1([]);
    const req = createRequest('/admin/api/clients/versions?range=1h');
    const env = createEnv(db);

    const res = await handleVersionAdoption(req, env);
    expect(res.status).toBe(400);

    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('Invalid range');
  });

  // ─── Semver sorting ───

  it('sorts versions by semver (newest first)', async () => {
    const now = Date.now();
    const bucket = Math.floor(now / 300000) * 300000;
    const db = createMockD1([
      {
        query: 'version_history',
        allResults: [
          { time_bucket: bucket, app_version: '1.0.0', active_count: 1 },
          { time_bucket: bucket, app_version: '2.1.0', active_count: 1 },
          { time_bucket: bucket, app_version: '1.5.0', active_count: 1 },
          { time_bucket: bucket, app_version: '2.0.0', active_count: 1 },
          { time_bucket: bucket, app_version: '1.0.1', active_count: 1 },
        ],
      },
    ]);

    const req = createRequest('/admin/api/clients/versions?range=7d');
    const env = createEnv(db);

    const res = await handleVersionAdoption(req, env);
    expect(res.status).toBe(200);

    const body = await res.json() as { data: { versions: string[] } };
    expect(body.data.versions).toEqual(['2.1.0', '2.0.0', '1.5.0', '1.0.1', '1.0.0']);
  });

  // ─── Version grouping ───

  it('groups old versions into "other" when >8', async () => {
    const now = Date.now();
    const bucket = Math.floor(now / 300000) * 300000;
    // Create 10 versions
    const versions = ['3.0.0', '2.9.0', '2.8.0', '2.7.0', '2.6.0', '2.5.0', '2.4.0', '2.3.0', '2.2.0', '2.1.0'];
    const allResults = versions.map(v => ({
      time_bucket: bucket,
      app_version: v,
      active_count: 1,
    }));

    const db = createMockD1([
      {
        query: 'version_history',
        allResults,
      },
    ]);

    const req = createRequest('/admin/api/clients/versions?range=7d');
    const env = createEnv(db);

    const res = await handleVersionAdoption(req, env);
    expect(res.status).toBe(200);

    const body = await res.json() as { data: { versions: string[]; buckets: Array<{ counts: Record<string, number> }> } };
    // Should have 8 named versions + "other"
    expect(body.data.versions).toHaveLength(9);
    expect(body.data.versions[body.data.versions.length - 1]).toBe('other');
    // First 8 should be newest versions sorted
    expect(body.data.versions[0]).toBe('3.0.0');
    expect(body.data.versions[7]).toBe('2.3.0');

    // "other" should have aggregated count from 2.2.0 and 2.1.0
    const otherCount = body.data.buckets[0].counts['other'];
    expect(otherCount).toBe(2);
  });

  // ─── Empty data ───

  it('handles empty data', async () => {
    const db = createMockD1([
      { query: 'version_history', allResults: [] },
    ]);

    const req = createRequest('/admin/api/clients/versions?range=7d');
    const env = createEnv(db);

    const res = await handleVersionAdoption(req, env);
    expect(res.status).toBe(200);

    const body = await res.json() as { success: boolean; data: { buckets: unknown[]; versions: string[] } };
    expect(body.success).toBe(true);
    expect(body.data.buckets).toEqual([]);
    expect(body.data.versions).toEqual([]);
  });

  // ─── Graceful degradation ───

  it('returns 200 with empty data when DIAGNOSTICS_DB not bound', async () => {
    const req = createRequest('/admin/api/clients/versions?range=7d');
    const env = createEnv(undefined);

    const res = await handleVersionAdoption(req, env);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      success: boolean;
      data: { range: string; buckets: unknown[]; versions: string[]; lastUpdated: number };
    };
    expect(body.success).toBe(true);
    expect(body.data.range).toBe('7d');
    expect(body.data.buckets).toEqual([]);
    expect(body.data.versions).toEqual([]);
    expect(typeof body.data.lastUpdated).toBe('number');
  });

  // ─── D1 error handling ───

  it('returns 500 when D1 fails', async () => {
    const db = {
      prepare: vi.fn().mockImplementation(() => ({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockRejectedValue(new Error('D1 is unavailable')),
        first: vi.fn().mockRejectedValue(new Error('D1 is unavailable')),
        run: vi.fn().mockRejectedValue(new Error('D1 is unavailable')),
      })),
    } as unknown as D1Database;

    const req = createRequest('/admin/api/clients/versions?range=7d');
    const env = createEnv(db);

    const res = await handleVersionAdoption(req, env);
    expect(res.status).toBe(500);

    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('Failed to query version adoption');
  });

  // ─── Response structure ───

  describe('response structure', () => {
    it('returns correct JSON structure with all expected fields', async () => {
      const now = Date.now();
      const bucket = Math.floor(now / 300000) * 300000;
      const db = createMockD1([
        {
          query: 'version_history',
          allResults: [
            { time_bucket: bucket, app_version: '1.0.0', active_count: 5 },
          ],
        },
      ]);

      const req = createRequest('/admin/api/clients/versions?range=24h');
      const env = createEnv(db);

      const res = await handleVersionAdoption(req, env);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/json');
      expect(res.headers.get('Cache-Control')).toBe('no-store');

      const body = await res.json() as {
        success: boolean;
        data: {
          range: string;
          buckets: Array<{ timestamp: number; counts: Record<string, number> }>;
          versions: string[];
          lastUpdated: number;
        };
      };

      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
      expect(typeof body.data.range).toBe('string');
      expect(Array.isArray(body.data.buckets)).toBe(true);
      expect(Array.isArray(body.data.versions)).toBe(true);
      expect(typeof body.data.lastUpdated).toBe('number');

      const bucket0 = body.data.buckets[0]!;
      expect(typeof bucket0.timestamp).toBe('number');
      expect(typeof bucket0.counts).toBe('object');
    });
  });

  // ─── Default range ───

  it('defaults to 7d range when no range parameter provided', async () => {
    const db = createMockD1([
      { query: 'version_history', allResults: [] },
    ]);

    const req = createRequest('/admin/api/clients/versions');
    const env = createEnv(db);

    const res = await handleVersionAdoption(req, env);
    expect(res.status).toBe(200);

    const body = await res.json() as { data: { range: string } };
    expect(body.data.range).toBe('7d');
  });
});
