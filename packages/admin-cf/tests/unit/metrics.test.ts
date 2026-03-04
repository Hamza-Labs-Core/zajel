/**
 * Unit tests for Epic 3 metrics handlers.
 *
 * Tests cover:
 * - C-1: determineHealthStatus checks both CPU and memory thresholds
 * - C-2: Server overview query includes LIMIT
 * - C-3: Federation handler runs queries in parallel via Promise.all()
 * - H-1: Error responses use generic messages (no raw D1 errors leaked)
 * - H-2: All handlers return 200 with empty data when DIAGNOSTICS_DB is unbound
 * - H-3: Server detail history bounded to last 7 days
 * - H-4: Federation latest-per-server query has time bound
 * - H-5: Federation accepts '7d' as a valid range
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  determineHealthStatus,
  handleServerMetrics,
  handleServerMetricsDetail,
  handleAppMetrics,
  handleNetworkMetrics,
  handleFederationMetrics,
  CPU_WARNING,
  CPU_CRITICAL,
  MEMORY_WARNING,
  MEMORY_CRITICAL,
} from '../../src/routes/metrics.js';
import type { Env } from '../../src/types.js';

// ── Mock helpers ───────────────────────────────────────────────────

/** Create a mock D1 prepared statement */
function mockPreparedStatement(returnValue: unknown = { results: [], success: true }) {
  const stmt: any = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue(returnValue),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue(returnValue),
    raw: vi.fn().mockResolvedValue([]),
  };
  return stmt;
}

/** Create a mock D1 database */
function mockD1(stmtOrFactory?: any) {
  return {
    prepare: vi.fn().mockImplementation(() => {
      if (typeof stmtOrFactory === 'function') return stmtOrFactory();
      return stmtOrFactory || mockPreparedStatement();
    }),
    batch: vi.fn(),
    exec: vi.fn(),
  };
}

/**
 * Minimal Env with a valid JWT secret and a mock requireAuth pass-through.
 * We mock requireAuth at module level below.
 */
function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    ADMIN_USERS: {} as any,
    ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    ...overrides,
  } as Env;
}

function makeRequest(url = 'https://admin.test/admin/api/metrics/server'): Request {
  return new Request(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer valid-token' },
  });
}

// Mock requireAuth to always pass
vi.mock('../../src/routes/auth.js', () => ({
  requireAuth: vi.fn().mockResolvedValue({
    sub: 'user-1',
    username: 'admin',
    role: 'super-admin',
    iat: 0,
    exp: 9999999999,
  }),
}));

// ── determineHealthStatus (C-1) ────────────────────────────────────

describe('determineHealthStatus', () => {
  it('returns healthy when CPU and memory are below warning', () => {
    expect(determineHealthStatus(50, 256)).toBe('healthy');
  });

  it('returns healthy at just below CPU warning', () => {
    expect(determineHealthStatus(CPU_WARNING - 1, 0)).toBe('healthy');
  });

  it('returns healthy at just below memory warning', () => {
    expect(determineHealthStatus(0, MEMORY_WARNING - 1)).toBe('healthy');
  });

  it('returns degraded when CPU is at warning threshold', () => {
    expect(determineHealthStatus(CPU_WARNING, 0)).toBe('degraded');
  });

  it('returns degraded when memory is at warning threshold', () => {
    expect(determineHealthStatus(0, MEMORY_WARNING)).toBe('degraded');
  });

  it('returns degraded when CPU exceeds warning but below critical', () => {
    expect(determineHealthStatus(90, 100)).toBe('degraded');
  });

  it('returns degraded when memory exceeds warning but below critical', () => {
    expect(determineHealthStatus(50, 800)).toBe('degraded');
  });

  it('returns critical when CPU is at critical threshold', () => {
    expect(determineHealthStatus(CPU_CRITICAL, 0)).toBe('critical');
  });

  it('returns critical when memory is at critical threshold', () => {
    expect(determineHealthStatus(0, MEMORY_CRITICAL)).toBe('critical');
  });

  it('returns critical when CPU exceeds critical', () => {
    expect(determineHealthStatus(99, 100)).toBe('critical');
  });

  it('returns critical when memory exceeds critical', () => {
    expect(determineHealthStatus(10, 2048)).toBe('critical');
  });

  it('returns critical when both CPU and memory exceed critical', () => {
    expect(determineHealthStatus(99, 2048)).toBe('critical');
  });

  it('returns critical when CPU is critical even if memory is low', () => {
    expect(determineHealthStatus(CPU_CRITICAL, 0)).toBe('critical');
  });

  it('returns critical when memory is critical even if CPU is low', () => {
    expect(determineHealthStatus(0, MEMORY_CRITICAL)).toBe('critical');
  });

  it('returns degraded when one metric is warning and other is ok', () => {
    expect(determineHealthStatus(CPU_WARNING, MEMORY_WARNING - 1)).toBe('degraded');
    expect(determineHealthStatus(CPU_WARNING - 1, MEMORY_WARNING)).toBe('degraded');
  });

  // Edge: both at warning
  it('returns degraded when both at warning', () => {
    expect(determineHealthStatus(CPU_WARNING, MEMORY_WARNING)).toBe('degraded');
  });

  // Edge: CPU warning, memory critical -> critical wins
  it('critical trumps degraded when CPU warning but memory critical', () => {
    expect(determineHealthStatus(CPU_WARNING, MEMORY_CRITICAL)).toBe('critical');
  });
});

// ── H-2: All handlers return 200 with empty data when DB not bound ──

describe('graceful degradation without DIAGNOSTICS_DB (H-2)', () => {
  const envNoDB = baseEnv(); // no DIAGNOSTICS_DB

  it('handleServerMetrics returns 200 with empty servers', async () => {
    const res = await handleServerMetrics(makeRequest(), envNoDB);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.servers).toEqual([]);
  });

  it('handleServerMetricsDetail returns 200 with null current and empty history', async () => {
    const res = await handleServerMetricsDetail(
      makeRequest('https://admin.test/admin/api/metrics/server/srv-01'),
      envNoDB,
      'srv-01'
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.current).toBeNull();
    expect(body.data.history).toEqual([]);
  });

  it('handleAppMetrics returns 200 with empty metrics', async () => {
    const res = await handleAppMetrics(
      makeRequest('https://admin.test/admin/api/metrics/app'),
      envNoDB
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.metrics).toEqual([]);
    expect(body.data.range).toBe('24h');
  });

  it('handleNetworkMetrics returns 200 with empty metrics', async () => {
    const res = await handleNetworkMetrics(
      makeRequest('https://admin.test/admin/api/metrics/network'),
      envNoDB
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.metrics).toEqual([]);
    expect(body.data.range).toBe('24h');
  });

  it('handleFederationMetrics returns 200 with empty data', async () => {
    const res = await handleFederationMetrics(
      makeRequest('https://admin.test/admin/api/metrics/federation'),
      envNoDB
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.current).toEqual([]);
    expect(body.data.history).toEqual([]);
    expect(body.data.range).toBe('24h');
  });
});

// ── H-1: Error responses use generic messages ──────────────────────

describe('generic error messages (H-1)', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  function failingD1() {
    return mockD1(
      (() => {
        const stmt = mockPreparedStatement();
        stmt.all.mockRejectedValue(new Error('UNIQUE constraint failed: too many columns'));
        stmt.bind.mockReturnValue(stmt);
        return stmt;
      })()
    );
  }

  it('handleServerMetrics does not leak D1 error details', async () => {
    const env = baseEnv({ DIAGNOSTICS_DB: failingD1() as any });
    const res = await handleServerMetrics(makeRequest(), env);
    expect(res.status).toBe(500);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Failed to retrieve server metrics');
    expect(body.error).not.toContain('UNIQUE constraint');
    expect(consoleSpy).toHaveBeenCalledWith(
      'Failed to query server metrics:',
      expect.stringContaining('UNIQUE constraint')
    );
  });

  it('handleServerMetricsDetail does not leak D1 error details', async () => {
    const db = mockD1();
    const failStmt = mockPreparedStatement();
    failStmt.first.mockRejectedValue(new Error('table not found'));
    failStmt.bind.mockReturnValue(failStmt);
    db.prepare.mockReturnValue(failStmt);

    const env = baseEnv({ DIAGNOSTICS_DB: db as any });
    const res = await handleServerMetricsDetail(
      makeRequest('https://admin.test/admin/api/metrics/server/srv-01'),
      env,
      'srv-01'
    );
    expect(res.status).toBe(500);
    const body = await res.json() as any;
    expect(body.error).toBe('Failed to retrieve server metrics detail');
    expect(body.error).not.toContain('table not found');
  });

  it('handleAppMetrics does not leak D1 error details', async () => {
    const env = baseEnv({ DIAGNOSTICS_DB: failingD1() as any });
    const res = await handleAppMetrics(
      makeRequest('https://admin.test/admin/api/metrics/app'),
      env
    );
    expect(res.status).toBe(500);
    const body = await res.json() as any;
    expect(body.error).toBe('Failed to retrieve app metrics');
    expect(body.error).not.toContain('UNIQUE constraint');
  });

  it('handleNetworkMetrics does not leak D1 error details', async () => {
    const env = baseEnv({ DIAGNOSTICS_DB: failingD1() as any });
    const res = await handleNetworkMetrics(
      makeRequest('https://admin.test/admin/api/metrics/network'),
      env
    );
    expect(res.status).toBe(500);
    const body = await res.json() as any;
    expect(body.error).toBe('Failed to retrieve network metrics');
    expect(body.error).not.toContain('UNIQUE constraint');
  });

  it('handleFederationMetrics does not leak D1 error details', async () => {
    const env = baseEnv({ DIAGNOSTICS_DB: failingD1() as any });
    const res = await handleFederationMetrics(
      makeRequest('https://admin.test/admin/api/metrics/federation'),
      env
    );
    expect(res.status).toBe(500);
    const body = await res.json() as any;
    expect(body.error).toBe('Failed to retrieve federation metrics');
    expect(body.error).not.toContain('UNIQUE constraint');
  });
});

// ── C-2: Server overview LIMIT ─────────────────────────────────────

describe('handleServerMetrics (C-2: LIMIT)', () => {
  it('query includes LIMIT clause', async () => {
    const db = mockD1();
    const env = baseEnv({ DIAGNOSTICS_DB: db as any });
    await handleServerMetrics(makeRequest(), env);

    expect(db.prepare).toHaveBeenCalledTimes(1);
    const sql: string = db.prepare.mock.calls[0][0];
    expect(sql).toMatch(/LIMIT\s+500/i);
  });

  it('returns formatted server data with health status', async () => {
    const stmt = mockPreparedStatement({
      results: [
        {
          server_id: 'srv-01',
          region: 'us-east',
          cpu_percent: 50,
          memory_mb: 256,
          connections_total: 100,
          connections_relay: 10,
          connections_signaling: 90,
          active_codes: 50,
          message_rate_per_sec: 5,
          uptime_seconds: 3600,
          timestamp: Date.now(),
        },
      ],
      success: true,
    });
    const db = mockD1(stmt);
    const env = baseEnv({ DIAGNOSTICS_DB: db as any });
    const res = await handleServerMetrics(makeRequest(), env);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.servers).toHaveLength(1);
    expect(body.data.servers[0].health).toBe('healthy');
    expect(body.data.servers[0].serverId).toBe('srv-01');
    expect(body.data.servers[0].connections.total).toBe(100);
  });

  it('applies memory-based health in server overview', async () => {
    const stmt = mockPreparedStatement({
      results: [
        {
          server_id: 'srv-high-mem',
          region: 'eu-west',
          cpu_percent: 20,
          memory_mb: MEMORY_CRITICAL + 100,
          connections_total: 5,
          connections_relay: 0,
          connections_signaling: 5,
          active_codes: 1,
          message_rate_per_sec: 0,
          uptime_seconds: 100,
          timestamp: Date.now(),
        },
      ],
      success: true,
    });
    const db = mockD1(stmt);
    const env = baseEnv({ DIAGNOSTICS_DB: db as any });
    const res = await handleServerMetrics(makeRequest(), env);
    const body = await res.json() as any;
    expect(body.data.servers[0].health).toBe('critical');
  });
});

// ── H-3: Server detail history bounded ─────────────────────────────

describe('handleServerMetricsDetail (H-3: bounded history)', () => {
  it('history query includes WHERE timestamp > ? clause', async () => {
    const calls: Array<{ sql: string; binds: unknown[] }> = [];

    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        const entry = { sql, binds: [] as unknown[] };
        calls.push(entry);
        const stmt: any = {
          bind: vi.fn().mockImplementation((...args: unknown[]) => {
            entry.binds = args;
            return stmt;
          }),
          all: vi.fn().mockResolvedValue({ results: [], success: true }),
          first: vi.fn().mockResolvedValue(null),
        };
        return stmt;
      }),
      batch: vi.fn(),
      exec: vi.fn(),
    };

    const env = baseEnv({ DIAGNOSTICS_DB: db as any });
    await handleServerMetricsDetail(
      makeRequest('https://admin.test/admin/api/metrics/server/srv-01'),
      env,
      'srv-01'
    );

    // Two queries: current + history
    expect(db.prepare).toHaveBeenCalledTimes(2);

    // History query (second call) should have timestamp bound
    const historySql = calls[1].sql;
    expect(historySql).toMatch(/timestamp\s*>\s*\?/i);
    expect(historySql).toMatch(/LIMIT\s+1000/i);

    // The timestamp bound should be approximately 7 days ago
    const bound = calls[1].binds[1] as number;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const expectedMin = Date.now() - sevenDaysMs - 1000;
    expect(bound).toBeGreaterThan(expectedMin);
  });

  it('returns current and history data', async () => {
    const currentRow = {
      server_id: 'srv-01',
      region: 'us-east',
      cpu_percent: 90,
      memory_mb: 600,
      connections_total: 200,
      connections_relay: 50,
      connections_signaling: 150,
      active_codes: 80,
      message_rate_per_sec: 10,
      uptime_seconds: 7200,
      timestamp: Date.now(),
    };

    let callIdx = 0;
    const db = {
      prepare: vi.fn().mockImplementation(() => {
        const idx = callIdx++;
        const stmt: any = {
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(idx === 0 ? currentRow : null),
          all: vi.fn().mockResolvedValue({
            results: idx === 1 ? [{ cpu_percent: 85, memory_mb: 500, connections_total: 190, message_rate_per_sec: 8, timestamp: Date.now() - 3600000 }] : [],
            success: true,
          }),
        };
        return stmt;
      }),
      batch: vi.fn(),
      exec: vi.fn(),
    };

    const env = baseEnv({ DIAGNOSTICS_DB: db as any });
    const res = await handleServerMetricsDetail(
      makeRequest('https://admin.test/admin/api/metrics/server/srv-01'),
      env,
      'srv-01'
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.current).not.toBeNull();
    expect(body.data.current.health).toBe('degraded'); // cpu=90 >= CPU_WARNING
    expect(body.data.history).toHaveLength(1);
  });
});

// ── C-3: Federation uses Promise.all() ─────────────────────────────

describe('handleFederationMetrics (C-3: parallel queries)', () => {
  it('runs two queries and returns both results', async () => {
    const stmts: any[] = [];
    const db = {
      prepare: vi.fn().mockImplementation(() => {
        const stmt = {
          bind: vi.fn().mockReturnThis(),
          all: vi.fn().mockResolvedValue({
            results: [{ server_id: 'srv-01', alive_members: 3, total_members: 5, gossip_latency_ms: 10, sync_completeness: 0.8, timestamp: Date.now() }],
            success: true,
          }),
        };
        stmts.push(stmt);
        return stmt;
      }),
      batch: vi.fn(),
      exec: vi.fn(),
    };

    const env = baseEnv({ DIAGNOSTICS_DB: db as any });
    const res = await handleFederationMetrics(
      makeRequest('https://admin.test/admin/api/metrics/federation'),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.current).toHaveLength(1);
    expect(body.data.history).toHaveLength(1);
    // Both queries were prepared
    expect(db.prepare).toHaveBeenCalledTimes(2);
    // Both stmts' all() were called
    expect(stmts[0].all).toHaveBeenCalledTimes(1);
    expect(stmts[1].all).toHaveBeenCalledTimes(1);
  });

  it('both queries are started before either resolves (parallel execution)', async () => {
    const callOrder: string[] = [];
    let resolveFirst!: (v: any) => void;
    let resolveSecond!: (v: any) => void;

    const firstPromise = new Promise(r => { resolveFirst = r; });
    const secondPromise = new Promise(r => { resolveSecond = r; });

    let callIdx = 0;
    const db = {
      prepare: vi.fn().mockImplementation(() => {
        const idx = callIdx++;
        return {
          bind: vi.fn().mockReturnThis(),
          all: vi.fn().mockImplementation(() => {
            callOrder.push(`query-${idx}-started`);
            return idx === 0 ? firstPromise : secondPromise;
          }),
        };
      }),
      batch: vi.fn(),
      exec: vi.fn(),
    };

    const env = baseEnv({ DIAGNOSTICS_DB: db as any });
    const promise = handleFederationMetrics(
      makeRequest('https://admin.test/admin/api/metrics/federation'),
      env
    );

    // Wait a tick for Promise.all to invoke both
    await new Promise(r => setTimeout(r, 10));

    // Both queries should have been started before either resolved
    expect(callOrder).toContain('query-0-started');
    expect(callOrder).toContain('query-1-started');

    // Now resolve
    resolveFirst({ results: [], success: true });
    resolveSecond({ results: [], success: true });
    const res = await promise;
    expect(res.status).toBe(200);
  });
});

// ── H-4: Federation latest-per-server time bound ───────────────────

describe('handleFederationMetrics (H-4: time bound on latest query)', () => {
  it('latest-per-server query includes timestamp > ? clause', async () => {
    const calls: Array<{ sql: string }> = [];
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        calls.push({ sql });
        return {
          bind: vi.fn().mockReturnThis(),
          all: vi.fn().mockResolvedValue({ results: [], success: true }),
        };
      }),
      batch: vi.fn(),
      exec: vi.fn(),
    };

    const env = baseEnv({ DIAGNOSTICS_DB: db as any });
    await handleFederationMetrics(
      makeRequest('https://admin.test/admin/api/metrics/federation'),
      env
    );

    // First query is the latest-per-server query
    expect(calls[0].sql).toMatch(/timestamp\s*>\s*\?/i);
    // Second query is the history query
    expect(calls[1].sql).toMatch(/timestamp\s*>\s*\?/i);
  });
});

// ── H-5: Federation accepts '7d' range ─────────────────────────────

describe('handleFederationMetrics (H-5: 7d range)', () => {
  it('accepts 7d as a valid range parameter', async () => {
    const binds: unknown[][] = [];
    const db = {
      prepare: vi.fn().mockImplementation(() => ({
        bind: vi.fn().mockImplementation((...args: unknown[]) => {
          binds.push(args);
          return {
            all: vi.fn().mockResolvedValue({ results: [], success: true }),
          };
        }),
      })),
      batch: vi.fn(),
      exec: vi.fn(),
    };

    const env = baseEnv({ DIAGNOSTICS_DB: db as any });
    const res = await handleFederationMetrics(
      makeRequest('https://admin.test/admin/api/metrics/federation?range=7d'),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.range).toBe('7d');

    // The timestamp bound should reflect 7 days
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const bound = binds[0][0] as number;
    const expected = Date.now() - sevenDaysMs;
    // Allow 2 second tolerance for test timing
    expect(bound).toBeGreaterThan(expected - 2000);
    expect(bound).toBeLessThanOrEqual(expected + 2000);
  });

  it('defaults to 24h for invalid range', async () => {
    const db = {
      prepare: vi.fn().mockImplementation(() => ({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [], success: true }),
      })),
      batch: vi.fn(),
      exec: vi.fn(),
    };

    const env = baseEnv({ DIAGNOSTICS_DB: db as any });
    const res = await handleFederationMetrics(
      makeRequest('https://admin.test/admin/api/metrics/federation?range=invalid'),
      env
    );
    const body = await res.json() as any;
    expect(body.data.range).toBe('24h');
  });

  it('accepts 1h range', async () => {
    const db = {
      prepare: vi.fn().mockImplementation(() => ({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [], success: true }),
      })),
      batch: vi.fn(),
      exec: vi.fn(),
    };

    const env = baseEnv({ DIAGNOSTICS_DB: db as any });
    const res = await handleFederationMetrics(
      makeRequest('https://admin.test/admin/api/metrics/federation?range=1h'),
      env
    );
    const body = await res.json() as any;
    expect(body.data.range).toBe('1h');
  });

  it('accepts 6h range', async () => {
    const db = {
      prepare: vi.fn().mockImplementation(() => ({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [], success: true }),
      })),
      batch: vi.fn(),
      exec: vi.fn(),
    };

    const env = baseEnv({ DIAGNOSTICS_DB: db as any });
    const res = await handleFederationMetrics(
      makeRequest('https://admin.test/admin/api/metrics/federation?range=6h'),
      env
    );
    const body = await res.json() as any;
    expect(body.data.range).toBe('6h');
  });
});

// ── App metrics handler ────────────────────────────────────────────

describe('handleAppMetrics', () => {
  it('passes platform filter to query when provided', async () => {
    const calls: Array<{ sql: string; binds: unknown[] }> = [];
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        const entry = { sql, binds: [] as unknown[] };
        calls.push(entry);
        return {
          bind: vi.fn().mockImplementation((...args: unknown[]) => {
            entry.binds = args;
            return {
              all: vi.fn().mockResolvedValue({ results: [], success: true }),
            };
          }),
        };
      }),
      batch: vi.fn(),
      exec: vi.fn(),
    };

    const env = baseEnv({ DIAGNOSTICS_DB: db as any });
    await handleAppMetrics(
      makeRequest('https://admin.test/admin/api/metrics/app?platform=android'),
      env
    );

    expect(calls[0].sql).toContain('platform = ?');
    expect(calls[0].binds).toContain('android');
  });

  it('does not add platform filter when not provided', async () => {
    const calls: Array<{ sql: string }> = [];
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        calls.push({ sql });
        return {
          bind: vi.fn().mockReturnThis(),
          all: vi.fn().mockResolvedValue({ results: [], success: true }),
        };
      }),
      batch: vi.fn(),
      exec: vi.fn(),
    };

    const env = baseEnv({ DIAGNOSTICS_DB: db as any });
    await handleAppMetrics(
      makeRequest('https://admin.test/admin/api/metrics/app'),
      env
    );

    expect(calls[0].sql).not.toContain('platform = ?');
  });

  it('respects the range parameter', async () => {
    const db = {
      prepare: vi.fn().mockImplementation(() => ({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [], success: true }),
      })),
      batch: vi.fn(),
      exec: vi.fn(),
    };

    const env = baseEnv({ DIAGNOSTICS_DB: db as any });
    const res = await handleAppMetrics(
      makeRequest('https://admin.test/admin/api/metrics/app?range=7d'),
      env
    );
    const body = await res.json() as any;
    expect(body.data.range).toBe('7d');
  });
});

// ── Network metrics handler ────────────────────────────────────────

describe('handleNetworkMetrics', () => {
  it('returns data with range', async () => {
    const stmt = mockPreparedStatement({
      results: [{
        time_bucket: '2026-03-04T12:00:00',
        platform: 'android',
        app_version: '1.0.0',
        signaling_success_count: 95,
        signaling_attempt_count: 100,
        webrtc_success_count: 80,
        webrtc_attempt_count: 100,
        relay_usage_count: 20,
        direct_usage_count: 80,
        avg_latency_ms: 150,
      }],
      success: true,
    });
    const db = mockD1(stmt);
    const env = baseEnv({ DIAGNOSTICS_DB: db as any });
    const res = await handleNetworkMetrics(
      makeRequest('https://admin.test/admin/api/metrics/network?range=1h'),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.metrics).toHaveLength(1);
    expect(body.data.range).toBe('1h');
  });
});

// ── Constant values ────────────────────────────────────────────────

describe('threshold constants', () => {
  it('CPU_WARNING is 80', () => {
    expect(CPU_WARNING).toBe(80);
  });

  it('CPU_CRITICAL is 95', () => {
    expect(CPU_CRITICAL).toBe(95);
  });

  it('MEMORY_WARNING is 512 MB', () => {
    expect(MEMORY_WARNING).toBe(512);
  });

  it('MEMORY_CRITICAL is 1024 MB', () => {
    expect(MEMORY_CRITICAL).toBe(1024);
  });
});
