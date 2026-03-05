/**
 * Unit tests for GET /admin/api/clients/connections
 *
 * Tests the connection type distribution endpoint which provides:
 * - Current connection type breakdown (donut chart data)
 * - Historical trend data (line chart data)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleConnectionTypes } from '../../src/routes/clients.js';
import type { Env } from '../../src/types.js';

// Mock the auth module
vi.mock('../../src/routes/auth.js', () => ({
  requireAuth: vi.fn().mockResolvedValue({
    sub: 'user-1',
    username: 'admin',
    role: 'admin',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
}));

/** Helper to create a mock D1 result */
function mockD1Result<T>(results: T[]) {
  return { results, success: true, meta: {} };
}

/** Helper to create a mock D1Database */
function createMockDB(
  currentResults: Array<{ connection_type: string; count: number }>,
  trendResults: Array<{ time_bucket: number; connection_type: string; active_count: number }>
) {
  let callIndex = 0;
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockImplementation(() => {
          const result = callIndex === 0
            ? mockD1Result(currentResults)
            : mockD1Result(trendResults);
          callIndex++;
          return Promise.resolve(result);
        }),
      }),
    }),
  } as unknown as D1Database;
}

/** Helper to create a request with auth */
function makeRequest(trendHours?: string): Request {
  const url = trendHours
    ? `https://admin.example.com/admin/api/clients/connections?trendHours=${trendHours}`
    : 'https://admin.example.com/admin/api/clients/connections';
  return new Request(url, {
    headers: { Authorization: 'Bearer test-token' },
  });
}

/** Minimal mock env */
function createEnv(db?: D1Database): Env {
  return {
    ADMIN_USERS: {} as DurableObjectNamespace,
    ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    DIAGNOSTICS_DB: db,
  } as Env;
}

describe('GET /admin/api/clients/connections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 with connection type distribution', async () => {
    const db = createMockDB(
      [
        { connection_type: 'direct_p2p', count: 50 },
        { connection_type: 'relay', count: 30 },
        { connection_type: 'none', count: 20 },
      ],
      []
    );
    const env = createEnv(db);

    const response = await handleConnectionTypes(makeRequest(), env);
    expect(response.status).toBe(200);

    const body = await response.json() as { success: boolean; data: { current: Array<{ connectionType: string; count: number; percentage: number }>; totalActive: number } };
    expect(body.success).toBe(true);
    expect(body.data.current).toHaveLength(3);
    expect(body.data.totalActive).toBe(100);
  });

  it('handles all P2P (100% direct)', async () => {
    const db = createMockDB(
      [{ connection_type: 'direct_p2p', count: 42 }],
      []
    );
    const env = createEnv(db);

    const response = await handleConnectionTypes(makeRequest(), env);
    const body = await response.json() as { success: boolean; data: { current: Array<{ connectionType: string; count: number; percentage: number }>; totalActive: number } };

    expect(body.success).toBe(true);
    expect(body.data.current).toHaveLength(1);
    expect(body.data.current[0]!.connectionType).toBe('direct_p2p');
    expect(body.data.current[0]!.percentage).toBe(100);
    expect(body.data.totalActive).toBe(42);
  });

  it('handles all relay (100% relay)', async () => {
    const db = createMockDB(
      [{ connection_type: 'relay', count: 15 }],
      []
    );
    const env = createEnv(db);

    const response = await handleConnectionTypes(makeRequest(), env);
    const body = await response.json() as { success: boolean; data: { current: Array<{ connectionType: string; count: number; percentage: number }>; totalActive: number } };

    expect(body.success).toBe(true);
    expect(body.data.current).toHaveLength(1);
    expect(body.data.current[0]!.connectionType).toBe('relay');
    expect(body.data.current[0]!.percentage).toBe(100);
  });

  it('handles mixed distribution with correct percentages', async () => {
    const db = createMockDB(
      [
        { connection_type: 'direct_p2p', count: 60 },
        { connection_type: 'relay', count: 30 },
        { connection_type: 'none', count: 10 },
      ],
      []
    );
    const env = createEnv(db);

    const response = await handleConnectionTypes(makeRequest(), env);
    const body = await response.json() as { success: boolean; data: { current: Array<{ connectionType: string; count: number; percentage: number }> } };

    expect(body.success).toBe(true);

    const p2p = body.data.current.find((c: { connectionType: string }) => c.connectionType === 'direct_p2p');
    const relay = body.data.current.find((c: { connectionType: string }) => c.connectionType === 'relay');
    const none = body.data.current.find((c: { connectionType: string }) => c.connectionType === 'none');

    expect(p2p!.percentage).toBe(60);
    expect(relay!.percentage).toBe(30);
    expect(none!.percentage).toBe(10);
  });

  it('handles null connection_type as none', async () => {
    // When connection_type is NULL in the DB, COALESCE maps it to 'none'
    // The SQL query uses COALESCE, so the result comes back as 'none'
    const db = createMockDB(
      [{ connection_type: 'none', count: 5 }],
      []
    );
    const env = createEnv(db);

    const response = await handleConnectionTypes(makeRequest(), env);
    const body = await response.json() as { success: boolean; data: { current: Array<{ connectionType: string; count: number }> } };

    expect(body.success).toBe(true);
    expect(body.data.current[0]!.connectionType).toBe('none');
    expect(body.data.current[0]!.count).toBe(5);
  });

  it('trend data has correct shape', async () => {
    const now = Date.now();
    const bucket = Math.floor(now / 300000) * 300000;

    const db = createMockDB(
      [{ connection_type: 'direct_p2p', count: 10 }],
      [
        { time_bucket: bucket - 300000, connection_type: 'direct_p2p', active_count: 8 },
        { time_bucket: bucket - 300000, connection_type: 'relay', active_count: 3 },
        { time_bucket: bucket, connection_type: 'direct_p2p', active_count: 10 },
        { time_bucket: bucket, connection_type: 'relay', active_count: 5 },
      ]
    );
    const env = createEnv(db);

    const response = await handleConnectionTypes(makeRequest(), env);
    const body = await response.json() as { success: boolean; data: { trend: Array<{ timestamp: number; direct_p2p: number; relay: number; none: number }> } };

    expect(body.success).toBe(true);
    expect(body.data.trend).toHaveLength(2);

    // Each trend point should have all fields
    for (const point of body.data.trend) {
      expect(point).toHaveProperty('timestamp');
      expect(point).toHaveProperty('direct_p2p');
      expect(point).toHaveProperty('relay');
      expect(point).toHaveProperty('none');
      expect(typeof point.timestamp).toBe('number');
      expect(typeof point.direct_p2p).toBe('number');
      expect(typeof point.relay).toBe('number');
      expect(typeof point.none).toBe('number');
    }
  });

  it('trend data pivoted correctly', async () => {
    const bucket1 = 1709500000000;
    const bucket2 = 1709500300000;

    const db = createMockDB(
      [],
      [
        { time_bucket: bucket1, connection_type: 'direct_p2p', active_count: 5 },
        { time_bucket: bucket1, connection_type: 'relay', active_count: 3 },
        { time_bucket: bucket1, connection_type: 'none', active_count: 2 },
        { time_bucket: bucket2, connection_type: 'direct_p2p', active_count: 7 },
        { time_bucket: bucket2, connection_type: 'relay', active_count: 1 },
      ]
    );
    const env = createEnv(db);

    const response = await handleConnectionTypes(makeRequest(), env);
    const body = await response.json() as { success: boolean; data: { trend: Array<{ timestamp: number; direct_p2p: number; relay: number; none: number }> } };

    expect(body.success).toBe(true);
    expect(body.data.trend).toHaveLength(2);

    // First bucket
    expect(body.data.trend[0]!.timestamp).toBe(bucket1);
    expect(body.data.trend[0]!.direct_p2p).toBe(5);
    expect(body.data.trend[0]!.relay).toBe(3);
    expect(body.data.trend[0]!.none).toBe(2);

    // Second bucket (no 'none' entry means it defaults to 0)
    expect(body.data.trend[1]!.timestamp).toBe(bucket2);
    expect(body.data.trend[1]!.direct_p2p).toBe(7);
    expect(body.data.trend[1]!.relay).toBe(1);
    expect(body.data.trend[1]!.none).toBe(0);
  });

  it('validates trendHours param (rejects negative)', async () => {
    const db = createMockDB([], []);
    const env = createEnv(db);

    const response = await handleConnectionTypes(makeRequest('-5'), env);
    expect(response.status).toBe(400);

    const body = await response.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('trendHours');
  });

  it('validates trendHours param (rejects > 168)', async () => {
    const db = createMockDB([], []);
    const env = createEnv(db);

    const response = await handleConnectionTypes(makeRequest('200'), env);
    expect(response.status).toBe(400);

    const body = await response.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('trendHours');
  });

  it('handles empty data (no active clients)', async () => {
    const db = createMockDB([], []);
    const env = createEnv(db);

    const response = await handleConnectionTypes(makeRequest(), env);
    expect(response.status).toBe(200);

    const body = await response.json() as { success: boolean; data: { current: unknown[]; trend: unknown[]; totalActive: number } };
    expect(body.success).toBe(true);
    expect(body.data.current).toHaveLength(0);
    expect(body.data.trend).toHaveLength(0);
    expect(body.data.totalActive).toBe(0);
  });

  it('returns 200 with empty data when DIAGNOSTICS_DB not bound', async () => {
    const env = createEnv(undefined);

    const response = await handleConnectionTypes(makeRequest(), env);
    expect(response.status).toBe(200);

    const body = await response.json() as { success: boolean; data: { current: unknown[]; trend: unknown[]; totalActive: number } };
    expect(body.success).toBe(true);
    expect(body.data.current).toHaveLength(0);
    expect(body.data.trend).toHaveLength(0);
    expect(body.data.totalActive).toBe(0);
  });

  it('returns 500 when D1 fails', async () => {
    const db = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockRejectedValue(new Error('D1_ERROR: database unavailable')),
        }),
      }),
    } as unknown as D1Database;
    const env = createEnv(db);

    const response = await handleConnectionTypes(makeRequest(), env);
    expect(response.status).toBe(500);

    const body = await response.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('Failed to query connection type data');
  });
});
