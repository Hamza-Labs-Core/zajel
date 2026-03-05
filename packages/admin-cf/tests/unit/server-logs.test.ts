/**
 * Unit tests for server logs route handler (US-5.2)
 *
 * Tests the handleServerLogs handler with mocked auth and D1 database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleServerLogs } from '../../src/routes/logs.js';
import type { Env } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Mock auth module — requireAuth returns a valid JwtPayload by default
// ---------------------------------------------------------------------------

const mockRequireAuth = vi.fn();

vi.mock('../../src/routes/auth.js', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));

// ---------------------------------------------------------------------------
// D1 mock helpers
// ---------------------------------------------------------------------------

interface MockD1Row {
  id: number;
  server_id: string;
  timestamp: number;
  severity: string;
  category: string;
  message: string;
  metadata: string | null;
}

interface MockPreparedStatement {
  bind: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
}

function createMockD1(
  rows: MockD1Row[] = [],
  total: number | null = null,
  throwError = false,
): { db: D1Database; prepare: ReturnType<typeof vi.fn> } {
  const actualTotal = total ?? rows.length;

  const mockFirst = vi.fn().mockImplementation(() => {
    if (throwError) throw new Error('D1 query failed');
    return Promise.resolve({ total: actualTotal });
  });

  const mockAll = vi.fn().mockImplementation(() => {
    if (throwError) throw new Error('D1 query failed');
    return Promise.resolve({ results: rows });
  });

  // Each call to prepare() returns a fresh statement that chains via bind()
  const prepare = vi.fn().mockImplementation(() => {
    const stmt: MockPreparedStatement = {
      bind: vi.fn().mockReturnThis(),
      first: mockFirst,
      all: mockAll,
    };
    // bind() returns the same statement for chaining
    stmt.bind.mockReturnValue(stmt);
    return stmt;
  });

  return {
    db: { prepare } as unknown as D1Database,
    prepare,
  };
}

function sampleRows(count: number, overrides: Partial<MockD1Row> = {}): MockD1Row[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    server_id: overrides.server_id ?? 'srv-01',
    timestamp: overrides.timestamp ?? (Date.now() - i * 60000),
    severity: overrides.severity ?? 'info',
    category: overrides.category ?? 'general',
    message: overrides.message ?? `Log message ${i + 1}`,
    metadata: overrides.metadata ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Environment factory
// ---------------------------------------------------------------------------

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ADMIN_USERS: {} as DurableObjectNamespace,
    ZAJEL_ADMIN_JWT_SECRET: 'test-secret-key',
    ...overrides,
  };
}

function makeRequest(params: Record<string, string> = {}): Request {
  const url = new URL('https://admin.test/admin/api/logs');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new Request(url.toString(), {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Default: auth succeeds
  mockRequireAuth.mockResolvedValue({
    sub: 'user-1',
    username: 'admin',
    role: 'admin',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleServerLogs', () => {
  // ── Authentication ──────────────────────────────────────────────────────

  it('returns 401 when not authenticated', async () => {
    const unauthorizedResponse = new Response(
      JSON.stringify({ success: false, error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );
    mockRequireAuth.mockResolvedValue(unauthorizedResponse);

    const res = await handleServerLogs(makeRequest(), makeEnv());
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.success).toBe(false);
  });

  // ── DIAGNOSTICS_DB not bound ────────────────────────────────────────────

  it('returns empty result when DIAGNOSTICS_DB is not bound', async () => {
    const res = await handleServerLogs(makeRequest(), makeEnv());
    expect(res.status).toBe(200);

    const body = await res.json() as { success: boolean; data: { logs: unknown[]; total: number } };
    expect(body.success).toBe(true);
    expect(body.data.logs).toEqual([]);
    expect(body.data.total).toBe(0);
  });

  // ── Basic paginated response ────────────────────────────────────────────

  it('returns paginated logs with default parameters', async () => {
    const rows = sampleRows(3);
    const { db } = createMockD1(rows, 3);
    const env = makeEnv({ DIAGNOSTICS_DB: db });

    const res = await handleServerLogs(makeRequest(), env);
    expect(res.status).toBe(200);

    const body = await res.json() as { success: boolean; data: { logs: unknown[]; total: number; limit: number; offset: number; lastUpdated: number } };
    expect(body.success).toBe(true);
    expect(body.data.logs).toHaveLength(3);
    expect(body.data.total).toBe(3);
    expect(body.data.limit).toBe(100);
    expect(body.data.offset).toBe(0);
    expect(body.data.lastUpdated).toBeGreaterThan(0);
  });

  it('maps D1 row fields correctly (snake_case to camelCase)', async () => {
    const rows: MockD1Row[] = [{
      id: 42,
      server_id: 'srv-05',
      timestamp: 1709000000000,
      severity: 'error',
      category: 'network',
      message: 'Connection refused',
      metadata: JSON.stringify({ port: 443 }),
    }];
    const { db } = createMockD1(rows, 1);
    const env = makeEnv({ DIAGNOSTICS_DB: db });

    const res = await handleServerLogs(makeRequest(), env);
    const body = await res.json() as { data: { logs: Array<{ id: number; serverId: string; severity: string; category: string; message: string; metadata: { port: number } }> } };
    const log = body.data.logs[0]!;

    expect(log.id).toBe(42);
    expect(log.serverId).toBe('srv-05');
    expect(log.severity).toBe('error');
    expect(log.category).toBe('network');
    expect(log.message).toBe('Connection refused');
    expect(log.metadata).toEqual({ port: 443 });
  });

  it('returns null metadata when row metadata is null', async () => {
    const rows = sampleRows(1);
    rows[0]!.metadata = null;
    const { db } = createMockD1(rows, 1);
    const env = makeEnv({ DIAGNOSTICS_DB: db });

    const res = await handleServerLogs(makeRequest(), env);
    const body = await res.json() as { data: { logs: Array<{ metadata: null }> } };
    expect(body.data.logs[0]!.metadata).toBeNull();
  });

  // ── Severity filter ─────────────────────────────────────────────────────

  it('filters by severity parameter', async () => {
    const rows = sampleRows(2, { severity: 'error' });
    const { db, prepare } = createMockD1(rows, 2);
    const env = makeEnv({ DIAGNOSTICS_DB: db });

    const res = await handleServerLogs(makeRequest({ severity: 'error' }), env);
    expect(res.status).toBe(200);

    const body = await res.json() as { data: { logs: Array<{ severity: string }> } };
    expect(body.data.logs).toHaveLength(2);

    // Verify the severity was passed as a bound parameter
    const stmtCalls = prepare.mock.results;
    // The count query should include 'severity = ?'
    const countQuery = prepare.mock.calls[0]?.[0] as string;
    expect(countQuery).toContain('severity = ?');
  });

  it('rejects invalid severity value', async () => {
    const { db } = createMockD1();
    const env = makeEnv({ DIAGNOSTICS_DB: db });

    const res = await handleServerLogs(makeRequest({ severity: 'critical' }), env);
    expect(res.status).toBe(400);

    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('Invalid severity');
  });

  // ── Search filter ───────────────────────────────────────────────────────

  it('filters by search keyword', async () => {
    const rows = sampleRows(1, { message: 'connection timeout on port 443' });
    const { db, prepare } = createMockD1(rows, 1);
    const env = makeEnv({ DIAGNOSTICS_DB: db });

    const res = await handleServerLogs(makeRequest({ search: 'timeout' }), env);
    expect(res.status).toBe(200);

    const body = await res.json() as { data: { logs: unknown[] } };
    expect(body.data.logs).toHaveLength(1);

    // Verify LIKE clause is in the query
    const countQuery = prepare.mock.calls[0]?.[0] as string;
    expect(countQuery).toContain('message LIKE ?');
  });

  it('is SQL injection safe — search param is bound, not interpolated', async () => {
    const { db, prepare } = createMockD1([], 0);
    const env = makeEnv({ DIAGNOSTICS_DB: db });

    // Attempt SQL injection via search parameter
    const maliciousSearch = "'; DROP TABLE server_logs; --";
    const res = await handleServerLogs(
      makeRequest({ search: maliciousSearch }),
      env,
    );
    expect(res.status).toBe(200);

    // The query must use a placeholder, not interpolated string
    const countQuery = prepare.mock.calls[0]?.[0] as string;
    expect(countQuery).toContain('message LIKE ?');
    expect(countQuery).not.toContain('DROP TABLE');

    // The malicious string should be in the bind() params, wrapped with %
    const countStmt = prepare.mock.results[0]?.value;
    const bindArgs = countStmt?.bind.mock.calls[0] as (string | number)[];
    const searchArg = bindArgs.find(
      (arg: string | number) => typeof arg === 'string' && arg.includes('DROP TABLE'),
    );
    expect(searchArg).toBeDefined();
    expect(searchArg).toBe(`%${maliciousSearch}%`);
  });

  // ── Server ID filter ────────────────────────────────────────────────────

  it('filters by serverId', async () => {
    const rows = sampleRows(1, { server_id: 'srv-03' });
    const { db, prepare } = createMockD1(rows, 1);
    const env = makeEnv({ DIAGNOSTICS_DB: db });

    const res = await handleServerLogs(makeRequest({ serverId: 'srv-03' }), env);
    expect(res.status).toBe(200);

    const body = await res.json() as { data: { logs: Array<{ serverId: string }> } };
    expect(body.data.logs).toHaveLength(1);
    expect(body.data.logs[0]!.serverId).toBe('srv-03');

    // Verify server_id is in the query
    const countQuery = prepare.mock.calls[0]?.[0] as string;
    expect(countQuery).toContain('server_id = ?');
  });

  // ── Time range filter ───────────────────────────────────────────────────

  describe('time range filtering', () => {
    it.each([
      ['1h', 60 * 60 * 1000],
      ['6h', 6 * 60 * 60 * 1000],
      ['24h', 24 * 60 * 60 * 1000],
      ['7d', 7 * 24 * 60 * 60 * 1000],
    ] as const)('filters by range=%s', async (range, expectedMs) => {
      const { db, prepare } = createMockD1([], 0);
      const env = makeEnv({ DIAGNOSTICS_DB: db });

      const before = Date.now();
      const res = await handleServerLogs(makeRequest({ range }), env);
      const after = Date.now();
      expect(res.status).toBe(200);

      // The first bound parameter should be the computed sinceTimestamp
      const countStmt = prepare.mock.results[0]?.value;
      const bindArgs = countStmt?.bind.mock.calls[0] as number[];
      const sinceTimestamp = bindArgs[0]!;
      expect(sinceTimestamp).toBeGreaterThanOrEqual(before - expectedMs);
      expect(sinceTimestamp).toBeLessThanOrEqual(after - expectedMs);
    });

    it('defaults to 24h when range is not specified', async () => {
      const { db, prepare } = createMockD1([], 0);
      const env = makeEnv({ DIAGNOSTICS_DB: db });

      const before = Date.now();
      const res = await handleServerLogs(makeRequest(), env);
      const after = Date.now();
      expect(res.status).toBe(200);

      const countStmt = prepare.mock.results[0]?.value;
      const bindArgs = countStmt?.bind.mock.calls[0] as number[];
      const sinceTimestamp = bindArgs[0]!;
      const expectedMs = 24 * 60 * 60 * 1000;
      expect(sinceTimestamp).toBeGreaterThanOrEqual(before - expectedMs);
      expect(sinceTimestamp).toBeLessThanOrEqual(after - expectedMs);
    });

    it('rejects invalid range value', async () => {
      const { db } = createMockD1();
      const env = makeEnv({ DIAGNOSTICS_DB: db });

      const res = await handleServerLogs(makeRequest({ range: '30d' }), env);
      expect(res.status).toBe(400);

      const body = await res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('Invalid range');
    });
  });

  // ── Limit validation ───────────────────────────────────────────────────

  it('validates limit param — caps at 500', async () => {
    const { db } = createMockD1([], 0);
    const env = makeEnv({ DIAGNOSTICS_DB: db });

    const res = await handleServerLogs(makeRequest({ limit: '1000' }), env);
    expect(res.status).toBe(200);

    const body = await res.json() as { data: { limit: number } };
    expect(body.data.limit).toBe(500);
  });

  it('uses custom limit when within bounds', async () => {
    const { db } = createMockD1([], 0);
    const env = makeEnv({ DIAGNOSTICS_DB: db });

    const res = await handleServerLogs(makeRequest({ limit: '50' }), env);
    expect(res.status).toBe(200);

    const body = await res.json() as { data: { limit: number } };
    expect(body.data.limit).toBe(50);
  });

  it('rejects invalid limit value (non-numeric)', async () => {
    const { db } = createMockD1();
    const env = makeEnv({ DIAGNOSTICS_DB: db });

    const res = await handleServerLogs(makeRequest({ limit: 'abc' }), env);
    expect(res.status).toBe(400);

    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('Invalid limit');
  });

  it('rejects limit of zero', async () => {
    const { db } = createMockD1();
    const env = makeEnv({ DIAGNOSTICS_DB: db });

    const res = await handleServerLogs(makeRequest({ limit: '0' }), env);
    expect(res.status).toBe(400);

    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('Invalid limit');
  });

  // ── Offset validation ──────────────────────────────────────────────────

  it('validates offset param', async () => {
    const { db } = createMockD1([], 0);
    const env = makeEnv({ DIAGNOSTICS_DB: db });

    const res = await handleServerLogs(makeRequest({ offset: '50' }), env);
    expect(res.status).toBe(200);

    const body = await res.json() as { data: { offset: number } };
    expect(body.data.offset).toBe(50);
  });

  it('rejects negative offset', async () => {
    const { db } = createMockD1();
    const env = makeEnv({ DIAGNOSTICS_DB: db });

    const res = await handleServerLogs(makeRequest({ offset: '-1' }), env);
    expect(res.status).toBe(400);

    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('Invalid offset');
  });

  it('rejects non-numeric offset', async () => {
    const { db } = createMockD1();
    const env = makeEnv({ DIAGNOSTICS_DB: db });

    const res = await handleServerLogs(makeRequest({ offset: 'xyz' }), env);
    expect(res.status).toBe(400);

    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('Invalid offset');
  });

  // ── D1 error handling ──────────────────────────────────────────────────

  it('returns 500 on D1 error', async () => {
    const { db } = createMockD1([], 0, true);
    const env = makeEnv({ DIAGNOSTICS_DB: db });

    const res = await handleServerLogs(makeRequest(), env);
    expect(res.status).toBe(500);

    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('Failed to query server logs');
  });

  // ── Combined filters ───────────────────────────────────────────────────

  it('applies multiple filters simultaneously', async () => {
    const rows = sampleRows(1, { severity: 'error', server_id: 'srv-02' });
    const { db, prepare } = createMockD1(rows, 1);
    const env = makeEnv({ DIAGNOSTICS_DB: db });

    const res = await handleServerLogs(
      makeRequest({
        severity: 'error',
        serverId: 'srv-02',
        search: 'timeout',
        range: '1h',
        limit: '25',
        offset: '10',
      }),
      env,
    );
    expect(res.status).toBe(200);

    const body = await res.json() as { data: { limit: number; offset: number } };
    expect(body.data.limit).toBe(25);
    expect(body.data.offset).toBe(10);

    // Verify all filter conditions appear in the query
    const countQuery = prepare.mock.calls[0]?.[0] as string;
    expect(countQuery).toContain('timestamp >= ?');
    expect(countQuery).toContain('severity = ?');
    expect(countQuery).toContain('server_id = ?');
    expect(countQuery).toContain('message LIKE ?');
  });

  // ── Response headers ───────────────────────────────────────────────────

  it('returns JSON content type and no-store cache control', async () => {
    const res = await handleServerLogs(makeRequest(), makeEnv());
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  // ── Query structure ────────────────────────────────────────────────────

  it('orders results by timestamp DESC', async () => {
    const { db, prepare } = createMockD1([], 0);
    const env = makeEnv({ DIAGNOSTICS_DB: db });

    await handleServerLogs(makeRequest(), env);

    // The data query (second call to prepare) should contain ORDER BY
    const dataQuery = prepare.mock.calls[1]?.[0] as string;
    expect(dataQuery).toContain('ORDER BY timestamp DESC');
  });

  it('includes LIMIT and OFFSET in the data query', async () => {
    const { db, prepare } = createMockD1([], 0);
    const env = makeEnv({ DIAGNOSTICS_DB: db });

    await handleServerLogs(makeRequest({ limit: '50', offset: '20' }), env);

    const dataQuery = prepare.mock.calls[1]?.[0] as string;
    expect(dataQuery).toContain('LIMIT ?');
    expect(dataQuery).toContain('OFFSET ?');
  });
});
