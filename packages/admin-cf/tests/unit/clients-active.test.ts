/**
 * Unit tests for GET /admin/api/clients/active
 *
 * Auth enforcement test lives in errors.test.ts (isolate: true)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../src/types.js';

// Mock auth — always succeed
vi.mock('../../src/routes/auth.js', () => ({
  requireAuth: vi.fn().mockResolvedValue({
    sub: 'user-1',
    username: 'admin',
    role: 'admin',
    iat: Date.now(),
    exp: Date.now() + 3600000,
  }),
}));

// Import after mocks
const { handleActiveClients } = await import('../../src/routes/clients.js');

function makeRequest(query = ''): Request {
  return new Request(`https://admin.example.com/admin/api/clients/active${query}`, {
    method: 'GET',
    headers: { Authorization: 'Bearer fake-token' },
  });
}

function makeD1Mock(
  countResults: Record<string, unknown>[] = [],
  sparklineResults: Record<string, unknown>[] = []
) {
  let callIndex = 0;
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockImplementation(() => {
          const result = callIndex === 0
            ? { results: countResults }
            : { results: sparklineResults };
          callIndex++;
          return Promise.resolve(result);
        }),
      }),
    }),
  };
}

describe('GET /admin/api/clients/active', () => {
  let baseEnv: Env;

  beforeEach(() => {
    baseEnv = {
      ADMIN_USERS: {} as Env['ADMIN_USERS'],
      ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    };
  });

  it('returns 200 with active count and sparkline from D1', async () => {
    const now = Date.now();
    const bucket1 = Math.floor(now / 300000) * 300000 - 300000;
    const bucket2 = Math.floor(now / 300000) * 300000;

    const env: Env = {
      ...baseEnv,
      DIAGNOSTICS_DB: makeD1Mock(
        [{ active_count: 42 }],
        [
          { bucket: bucket1, count: 10 },
          { bucket: bucket2, count: 15 },
        ]
      ) as unknown as D1Database,
    };

    const res = await handleActiveClients(makeRequest(), env);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.activeCount).toBe(42);
    expect(body.data.sparkline).toHaveLength(2);
    expect(body.data.sparkline[0].timestamp).toBe(bucket1);
    expect(body.data.sparkline[0].count).toBe(10);
    expect(body.data.sparkline[1].timestamp).toBe(bucket2);
    expect(body.data.sparkline[1].count).toBe(15);
    expect(typeof body.data.lastUpdated).toBe('number');
  });

  it('returns 200 with activeCount:0 when DIAGNOSTICS_DB not bound', async () => {
    const res = await handleActiveClients(makeRequest(), baseEnv);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.activeCount).toBe(0);
    expect(body.data.sparkline).toEqual([]);
    expect(typeof body.data.lastUpdated).toBe('number');
  });

  it('returns 200 with empty sparkline when no heartbeat data', async () => {
    const env: Env = {
      ...baseEnv,
      DIAGNOSTICS_DB: makeD1Mock(
        [{ active_count: 0 }],
        []
      ) as unknown as D1Database,
    };

    const res = await handleActiveClients(makeRequest(), env);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.activeCount).toBe(0);
    expect(body.data.sparkline).toEqual([]);
  });

  it('validates hours param - rejects values greater than 168', async () => {
    const env: Env = {
      ...baseEnv,
      DIAGNOSTICS_DB: makeD1Mock() as unknown as D1Database,
    };

    const res = await handleActiveClients(makeRequest('?hours=200'), env);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('hours must be between 1 and 168');
  });

  it('validates hours param - rejects negative values', async () => {
    const env: Env = {
      ...baseEnv,
      DIAGNOSTICS_DB: makeD1Mock() as unknown as D1Database,
    };

    const res = await handleActiveClients(makeRequest('?hours=-5'), env);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('hours must be between 1 and 168');
  });

  it('validates hours param - rejects zero', async () => {
    const env: Env = {
      ...baseEnv,
      DIAGNOSTICS_DB: makeD1Mock() as unknown as D1Database,
    };

    const res = await handleActiveClients(makeRequest('?hours=0'), env);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('hours must be between 1 and 168');
  });

  it('validates hours param - rejects non-numeric values', async () => {
    const env: Env = {
      ...baseEnv,
      DIAGNOSTICS_DB: makeD1Mock() as unknown as D1Database,
    };

    const res = await handleActiveClients(makeRequest('?hours=abc'), env);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('hours must be between 1 and 168');
  });

  it('returns 500 when D1 query fails', async () => {
    const env: Env = {
      ...baseEnv,
      DIAGNOSTICS_DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            all: vi.fn().mockRejectedValue(new Error('D1 internal error')),
          }),
        }),
      } as unknown as D1Database,
    };

    const res = await handleActiveClients(makeRequest(), env);
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Failed to query active clients');
  });

  it('handles empty D1 results gracefully', async () => {
    const env: Env = {
      ...baseEnv,
      DIAGNOSTICS_DB: makeD1Mock([], []) as unknown as D1Database,
    };

    const res = await handleActiveClients(makeRequest(), env);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    // When results array is empty, activeCount defaults to 0 via ?? operator
    expect(body.data.activeCount).toBe(0);
    expect(body.data.sparkline).toEqual([]);
  });

  it('sparkline entries are sorted by timestamp ascending', async () => {
    const now = Date.now();
    const bucket1 = Math.floor(now / 300000) * 300000 - 600000;
    const bucket2 = Math.floor(now / 300000) * 300000 - 300000;
    const bucket3 = Math.floor(now / 300000) * 300000;

    // D1 returns them in ASC order (ORDER BY bucket ASC in query)
    const env: Env = {
      ...baseEnv,
      DIAGNOSTICS_DB: makeD1Mock(
        [{ active_count: 5 }],
        [
          { bucket: bucket1, count: 3 },
          { bucket: bucket2, count: 7 },
          { bucket: bucket3, count: 2 },
        ]
      ) as unknown as D1Database,
    };

    const res = await handleActiveClients(makeRequest(), env);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.sparkline).toHaveLength(3);
    expect(body.data.sparkline[0].timestamp).toBe(bucket1);
    expect(body.data.sparkline[1].timestamp).toBe(bucket2);
    expect(body.data.sparkline[2].timestamp).toBe(bucket3);
    // Verify ascending order
    for (let i = 1; i < body.data.sparkline.length; i++) {
      expect(body.data.sparkline[i].timestamp).toBeGreaterThan(
        body.data.sparkline[i - 1].timestamp
      );
    }
  });

  it('multiple concurrent sessions counted correctly via COUNT(DISTINCT session_hash)', async () => {
    // This test verifies that the query uses COUNT(DISTINCT session_hash)
    // The mock simulates D1 returning already-aggregated data
    const now = Date.now();
    const bucket = Math.floor(now / 300000) * 300000;

    const env: Env = {
      ...baseEnv,
      DIAGNOSTICS_DB: makeD1Mock(
        [{ active_count: 100 }],
        [{ bucket, count: 50 }]
      ) as unknown as D1Database,
    };

    const res = await handleActiveClients(makeRequest(), env);
    expect(res.status).toBe(200);

    const body = await res.json();
    // 100 active clients total, 50 distinct sessions in this bucket
    expect(body.data.activeCount).toBe(100);
    expect(body.data.sparkline[0].count).toBe(50);

    // Verify the SQL uses DISTINCT — check that prepare was called with the right query
    const db = env.DIAGNOSTICS_DB as unknown as { prepare: ReturnType<typeof vi.fn> };
    const calls = db.prepare.mock.calls;
    expect(calls.length).toBe(2);
    // First call: active count query
    expect(calls[0]![0]).toContain('COUNT(*)');
    expect(calls[0]![0]).toContain('client_heartbeats');
    // Second call: sparkline query
    expect(calls[1]![0]).toContain('COUNT(DISTINCT session_hash)');
    expect(calls[1]![0]).toContain('GROUP BY bucket');
    expect(calls[1]![0]).toContain('ORDER BY bucket ASC');
  });

  it('accepts valid hours param within range', async () => {
    const env: Env = {
      ...baseEnv,
      DIAGNOSTICS_DB: makeD1Mock(
        [{ active_count: 5 }],
        []
      ) as unknown as D1Database,
    };

    const res = await handleActiveClients(makeRequest('?hours=48'), env);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('accepts hours=168 (maximum allowed)', async () => {
    const env: Env = {
      ...baseEnv,
      DIAGNOSTICS_DB: makeD1Mock(
        [{ active_count: 0 }],
        []
      ) as unknown as D1Database,
    };

    const res = await handleActiveClients(makeRequest('?hours=168'), env);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
  });
});
