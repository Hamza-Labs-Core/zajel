/**
 * Unit tests for the servers-health route handler (US-5.1)
 *
 * These tests mock authentication and the D1 database to exercise
 * the handler logic in isolation — no live CF Worker needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleServersHealth,
  computeHealthScore,
  classifyStatus,
} from '../../src/routes/servers-health.js';
import type { Env } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/**
 * Stub requireAuth so every request is treated as authenticated.
 * We mock at the module level so the handler's dynamic `import` picks it up.
 */
vi.mock('../../src/routes/auth.js', () => ({
  requireAuth: vi.fn().mockResolvedValue({
    sub: 'test-user-id',
    username: 'admin',
    role: 'super-admin',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
}));

/** Helper: build a minimal Request */
function makeRequest(): Request {
  return new Request('https://admin.zajel.test/admin/api/servers/health', {
    method: 'GET',
    headers: { Authorization: 'Bearer fake-token' },
  });
}

/** Helper: build a mock D1 database */
function mockD1(rows: unknown[] = [], shouldThrow = false): D1Database {
  const all = shouldThrow
    ? vi.fn().mockRejectedValue(new Error('D1 connection failed'))
    : vi.fn().mockResolvedValue({ results: rows });

  const bind = vi.fn().mockReturnValue({ all });
  const prepare = vi.fn().mockReturnValue({ bind, all });

  return { prepare } as unknown as D1Database;
}

/** Helper: build a minimal Env */
function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ADMIN_USERS: {} as DurableObjectNamespace,
    ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    ...overrides,
  } as Env;
}

/** Helper: parse JSON response body */
async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Pure-function tests (no mocking needed)
// ---------------------------------------------------------------------------

describe('computeHealthScore', () => {
  it('returns 100 for ideal metrics (0% CPU, 0 MB memory, >0 connections)', () => {
    expect(computeHealthScore(0, 0, 10)).toBe(100);
  });

  it('returns a lower score for high CPU', () => {
    // 100% CPU => cpuScore = 0, memoryScore = 30, connectivityScore = 30
    expect(computeHealthScore(100, 0, 10)).toBe(60);
  });

  it('returns a lower score for high memory', () => {
    // 0% CPU => cpuScore = 40, memoryMb = 2048 => memoryScore = 0, connections > 0 => 30
    expect(computeHealthScore(0, 2048, 10)).toBe(70);
  });

  it('returns reduced connectivity score for 0 connections', () => {
    // 0 connections => 15 instead of 30
    expect(computeHealthScore(0, 0, 0)).toBe(85);
  });

  it('returns minimum score for worst-case metrics', () => {
    // 100% CPU, >= 2048 MB, 0 connections
    expect(computeHealthScore(100, 2048, 0)).toBe(15);
  });

  it('clamps CPU above 100% to 100%', () => {
    // 200% CPU should be treated as 100% CPU
    expect(computeHealthScore(200, 0, 10)).toBe(60);
  });

  it('clamps memory above 2048 MB to 2048 MB', () => {
    // 4096 MB should be treated as 2048 MB
    expect(computeHealthScore(0, 4096, 10)).toBe(70);
  });

  it('handles mid-range CPU (50%)', () => {
    // cpuScore = 40 * (1 - 50/100) = 20, memory 0 => 30, connections > 0 => 30
    expect(computeHealthScore(50, 0, 10)).toBe(80);
  });

  it('handles mid-range memory (1024 MB)', () => {
    // cpu 0 => 40, memory 1024 => 30 * (1 - 1024/2048) = 15, connections > 0 => 30
    expect(computeHealthScore(0, 1024, 10)).toBe(85);
  });
});

describe('classifyStatus', () => {
  it('returns "healthy" when lastSeen is within 2 minutes', () => {
    const now = Date.now();
    expect(classifyStatus(now - 60_000, now)).toBe('healthy');  // 1 min ago
  });

  it('returns "healthy" when lastSeen is exactly now', () => {
    const now = Date.now();
    expect(classifyStatus(now, now)).toBe('healthy');
  });

  it('returns "degraded" when lastSeen is between 2 and 5 minutes', () => {
    const now = Date.now();
    expect(classifyStatus(now - 3 * 60_000, now)).toBe('degraded');  // 3 min ago
  });

  it('returns "degraded" at exactly 2 minutes + 1 ms', () => {
    const now = Date.now();
    expect(classifyStatus(now - 2 * 60_000 - 1, now)).toBe('degraded');
  });

  it('returns "offline" when lastSeen is more than 5 minutes ago', () => {
    const now = Date.now();
    expect(classifyStatus(now - 6 * 60_000, now)).toBe('offline');  // 6 min ago
  });

  it('returns "offline" when lastSeen is very old', () => {
    const now = Date.now();
    expect(classifyStatus(now - 3600_000, now)).toBe('offline');  // 1 hour ago
  });
});

// ---------------------------------------------------------------------------
// Handler integration tests (with mocked auth + D1)
// ---------------------------------------------------------------------------

describe('handleServersHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 with server health data', async () => {
    const now = Date.now();
    const db = mockD1([
      {
        server_id: 'vps-us-east-1',
        region: 'us-east',

        timestamp: now - 30_000,  // 30s ago — healthy
        cpu_percent: 25,
        memory_mb: 512,
        connections_total: 42,
        uptime_seconds: 86400,
      },
      {
        server_id: 'vps-eu-west-1',
        region: 'eu-west',

        timestamp: now - 4 * 60_000,  // 4 min ago — degraded
        cpu_percent: 80,
        memory_mb: 1500,
        connections_total: 5,
        uptime_seconds: 3600,
      },
    ]);

    const env = makeEnv({ DIAGNOSTICS_DB: db });
    const response = await handleServersHealth(makeRequest(), env);

    expect(response.status).toBe(200);

    const body = await bodyOf(response);
    expect(body['success']).toBe(true);

    const data = body['data'] as { servers: unknown[]; lastUpdated: number };
    expect(data.servers).toHaveLength(2);
    expect(typeof data.lastUpdated).toBe('number');

    // First server: healthy
    const server1 = data.servers[0] as Record<string, unknown>;
    expect(server1['serverId']).toBe('vps-us-east-1');
    expect(server1['status']).toBe('healthy');
    expect(server1['region']).toBe('us-east');
    expect(server1['endpoint']).toBe('');
    expect(server1['cpuPercent']).toBe(25);
    expect(server1['memoryMb']).toBe(512);
    expect(server1['connectionsTotal']).toBe(42);
    expect(server1['uptimeSeconds']).toBe(86400);
    expect(typeof server1['healthScore']).toBe('number');
    expect(server1['healthScore']).toBeGreaterThan(0);
    expect(server1['healthScore']).toBeLessThanOrEqual(100);

    // Second server: degraded
    const server2 = data.servers[1] as Record<string, unknown>;
    expect(server2['serverId']).toBe('vps-eu-west-1');
    expect(server2['status']).toBe('degraded');
  });

  it('returns 200 with empty array when no servers exist', async () => {
    const db = mockD1([]);
    const env = makeEnv({ DIAGNOSTICS_DB: db });
    const response = await handleServersHealth(makeRequest(), env);

    expect(response.status).toBe(200);

    const body = await bodyOf(response);
    expect(body['success']).toBe(true);

    const data = body['data'] as { servers: unknown[]; lastUpdated: number };
    expect(data.servers).toHaveLength(0);
    expect(typeof data.lastUpdated).toBe('number');
  });

  it('returns 200 with empty array when DIAGNOSTICS_DB is not bound', async () => {
    const env = makeEnv(); // No DIAGNOSTICS_DB
    const response = await handleServersHealth(makeRequest(), env);

    expect(response.status).toBe(200);

    const body = await bodyOf(response);
    expect(body['success']).toBe(true);

    const data = body['data'] as { servers: unknown[]; lastUpdated: number };
    expect(data.servers).toHaveLength(0);
    expect(typeof data.lastUpdated).toBe('number');
  });

  it('returns 500 on D1 error', async () => {
    const db = mockD1([], true);
    const env = makeEnv({ DIAGNOSTICS_DB: db });
    const response = await handleServersHealth(makeRequest(), env);

    expect(response.status).toBe(500);

    const body = await bodyOf(response);
    expect(body['success']).toBe(false);
    expect(body['error']).toBe('Failed to fetch server health data');
  });

  it('correctly computes health score from database row', async () => {
    const now = Date.now();
    const db = mockD1([
      {
        server_id: 'test-srv',
        region: 'test',

        timestamp: now,
        cpu_percent: 50,
        memory_mb: 1024,
        connections_total: 100,
        uptime_seconds: 7200,
      },
    ]);

    const env = makeEnv({ DIAGNOSTICS_DB: db });
    const response = await handleServersHealth(makeRequest(), env);
    const body = await bodyOf(response);
    const data = body['data'] as { servers: Record<string, unknown>[] };

    // cpuScore = 40 * (1 - 50/100) = 20
    // memoryScore = 30 * (1 - 1024/2048) = 15
    // connectivityScore = 30 (connections > 0)
    // total = 65
    const expectedScore = computeHealthScore(50, 1024, 100);
    expect(data.servers[0]!['healthScore']).toBe(expectedScore);
    expect(expectedScore).toBe(65);
  });

  it('classifies servers correctly based on lastSeen', async () => {
    const now = Date.now();
    const db = mockD1([
      {
        server_id: 'healthy-srv',
        region: 'test',

        timestamp: now - 30_000,  // 30 seconds ago — healthy
        cpu_percent: 10,
        memory_mb: 256,
        connections_total: 5,
        uptime_seconds: 1000,
      },
      {
        server_id: 'degraded-srv',
        region: 'test',

        timestamp: now - 3 * 60_000,  // 3 minutes ago — degraded
        cpu_percent: 10,
        memory_mb: 256,
        connections_total: 5,
        uptime_seconds: 1000,
      },
      {
        server_id: 'offline-srv',
        region: 'test',

        timestamp: now - 10 * 60_000,  // 10 minutes ago — offline
        cpu_percent: 10,
        memory_mb: 256,
        connections_total: 5,
        uptime_seconds: 1000,
      },
    ]);

    const env = makeEnv({ DIAGNOSTICS_DB: db });
    const response = await handleServersHealth(makeRequest(), env);
    const body = await bodyOf(response);
    const data = body['data'] as { servers: Record<string, unknown>[] };

    expect(data.servers).toHaveLength(3);
    expect(data.servers[0]!['status']).toBe('healthy');
    expect(data.servers[1]!['status']).toBe('degraded');
    expect(data.servers[2]!['status']).toBe('offline');
  });

  it('handles null/missing metric fields gracefully', async () => {
    const now = Date.now();
    const db = mockD1([
      {
        server_id: 'sparse-srv',
        region: null,

        timestamp: now,
        cpu_percent: null,
        memory_mb: null,
        connections_total: null,
        uptime_seconds: null,
      },
    ]);

    const env = makeEnv({ DIAGNOSTICS_DB: db });
    const response = await handleServersHealth(makeRequest(), env);

    expect(response.status).toBe(200);

    const body = await bodyOf(response);
    const data = body['data'] as { servers: Record<string, unknown>[] };
    const server = data.servers[0]!;

    expect(server['region']).toBe('unknown');
    expect(server['endpoint']).toBe('');
    expect(server['cpuPercent']).toBe(0);
    expect(server['memoryMb']).toBe(0);
    expect(server['connectionsTotal']).toBe(0);
    expect(server['uptimeSeconds']).toBe(0);
    expect(typeof server['healthScore']).toBe('number');
  });

  it('returns JSON content type', async () => {
    const env = makeEnv();
    const response = await handleServersHealth(makeRequest(), env);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('returns no-store cache control', async () => {
    const env = makeEnv();
    const response = await handleServersHealth(makeRequest(), env);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('verifies D1 query uses correct SQL with latest-per-server join', async () => {
    const db = mockD1([]);
    const env = makeEnv({ DIAGNOSTICS_DB: db });
    await handleServersHealth(makeRequest(), env);

    const prepare = db.prepare as ReturnType<typeof vi.fn>;
    expect(prepare).toHaveBeenCalledTimes(1);

    const sql = prepare.mock.calls[0]![0] as string;
    expect(sql).toContain('SELECT');
    expect(sql).toContain('sm.server_id');
    expect(sql).toContain('sm.timestamp');
    expect(sql).toContain('INNER JOIN');
    expect(sql).toContain('MAX(timestamp)');
    expect(sql).toContain('GROUP BY server_id');
    expect(sql).toContain('ORDER BY sm.region, sm.server_id');
    // Should NOT query non-existent columns
    expect(sql).not.toContain('endpoint');
    expect(sql).not.toContain('last_seen');
  });
});
