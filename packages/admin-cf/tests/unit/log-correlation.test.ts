/**
 * Unit tests for the log-diagnostic correlation endpoint
 *
 * Tests the handleLogDiagnosticCorrelation handler directly,
 * mocking the requireAuth function and D1 database bindings.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleLogDiagnosticCorrelation } from '../../src/routes/log-correlation.js';
import type { Env } from '../../src/types.js';

// Mock the auth module
vi.mock('../../src/routes/auth.js', () => ({
  requireAuth: vi.fn(),
}));

import { requireAuth } from '../../src/routes/auth.js';
const mockRequireAuth = vi.mocked(requireAuth);

/**
 * Helper: create a mock Env with optional DIAGNOSTICS_DB
 */
function createMockEnv(diagnosticsDb?: unknown): Env {
  return {
    ADMIN_USERS: {} as DurableObjectNamespace,
    ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    DIAGNOSTICS_DB: diagnosticsDb as Env['DIAGNOSTICS_DB'],
  };
}

/**
 * Helper: create a GET request with query params
 */
function makeRequest(params: Record<string, string>): Request {
  const url = new URL('https://admin.example.com/admin/api/logs/correlation');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Request(url.toString(), {
    method: 'GET',
    headers: { Authorization: 'Bearer valid-token' },
  });
}

/**
 * Helper: parse JSON response body
 */
async function parseResponse(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

/**
 * Helper: create a mock D1 database that returns given results from batch()
 */
function createMockD1(
  serverLogsResults: Record<string, unknown>[] = [],
  clientErrorsResults: Record<string, unknown>[] = []
) {
  const mockPreparedStatement = {
    bind: vi.fn().mockReturnThis(),
  };

  const mockDb = {
    prepare: vi.fn().mockReturnValue(mockPreparedStatement),
    batch: vi.fn().mockResolvedValue([
      { results: serverLogsResults },
      { results: clientErrorsResults },
    ]),
  };

  return { mockDb, mockPreparedStatement };
}

// ─────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: auth succeeds (returns JWT payload, not a Response)
  mockRequireAuth.mockResolvedValue({
    sub: 'user-1',
    username: 'admin',
    role: 'super-admin',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
});

// ─────────────────────────────────────────────
// Auth enforcement
// ─────────────────────────────────────────────

describe('Auth enforcement', () => {
  it('returns 401 when requireAuth rejects', async () => {
    mockRequireAuth.mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const request = makeRequest({ startTime: '1000', endTime: '2000' });
    const env = createMockEnv();

    const response = await handleLogDiagnosticCorrelation(request, env);
    expect(response.status).toBe(401);

    const body = await parseResponse(response);
    expect(body['success']).toBe(false);
    expect(body['error']).toBe('Unauthorized');
  });
});

// ─────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────

describe('Query parameter validation', () => {
  it('returns 400 when startTime is missing', async () => {
    const request = makeRequest({ endTime: '2000' });
    const env = createMockEnv();

    const response = await handleLogDiagnosticCorrelation(request, env);
    expect(response.status).toBe(400);

    const body = await parseResponse(response);
    expect(body['success']).toBe(false);
    expect(body['error']).toContain('startTime');
    expect(body['error']).toContain('endTime');
  });

  it('returns 400 when endTime is missing', async () => {
    const request = makeRequest({ startTime: '1000' });
    const env = createMockEnv();

    const response = await handleLogDiagnosticCorrelation(request, env);
    expect(response.status).toBe(400);

    const body = await parseResponse(response);
    expect(body['success']).toBe(false);
  });

  it('returns 400 when startTime is not a valid number', async () => {
    const request = makeRequest({ startTime: 'abc', endTime: '2000' });
    const env = createMockEnv();

    const response = await handleLogDiagnosticCorrelation(request, env);
    expect(response.status).toBe(400);

    const body = await parseResponse(response);
    expect(body['success']).toBe(false);
    expect(body['error']).toContain('valid numbers');
  });

  it('returns 400 when endTime is not a valid number', async () => {
    const request = makeRequest({ startTime: '1000', endTime: 'xyz' });
    const env = createMockEnv();

    const response = await handleLogDiagnosticCorrelation(request, env);
    expect(response.status).toBe(400);

    const body = await parseResponse(response);
    expect(body['success']).toBe(false);
    expect(body['error']).toContain('valid numbers');
  });

  it('returns 400 when endTime is equal to startTime', async () => {
    const request = makeRequest({ startTime: '1000', endTime: '1000' });
    const env = createMockEnv();

    const response = await handleLogDiagnosticCorrelation(request, env);
    expect(response.status).toBe(400);

    const body = await parseResponse(response);
    expect(body['success']).toBe(false);
    expect(body['error']).toContain('endTime must be greater than startTime');
  });

  it('returns 400 when endTime is less than startTime', async () => {
    const request = makeRequest({ startTime: '2000', endTime: '1000' });
    const env = createMockEnv();

    const response = await handleLogDiagnosticCorrelation(request, env);
    expect(response.status).toBe(400);

    const body = await parseResponse(response);
    expect(body['success']).toBe(false);
    expect(body['error']).toContain('endTime must be greater than startTime');
  });

  it('returns 400 when startTime is negative', async () => {
    const request = makeRequest({ startTime: '-100', endTime: '2000' });
    const env = createMockEnv();

    const response = await handleLogDiagnosticCorrelation(request, env);
    expect(response.status).toBe(400);

    const body = await parseResponse(response);
    expect(body['success']).toBe(false);
    expect(body['error']).toContain('non-negative');
  });

  it('returns 400 when time window exceeds 7 days', async () => {
    const start = 1000;
    const eightDays = 8 * 24 * 60 * 60 * 1000;
    const request = makeRequest({ startTime: String(start), endTime: String(start + eightDays) });
    const env = createMockEnv();

    const response = await handleLogDiagnosticCorrelation(request, env);
    expect(response.status).toBe(400);

    const body = await parseResponse(response);
    expect(body['success']).toBe(false);
    expect(body['error']).toContain('7 days');
  });

  it('accepts time window of exactly 7 days', async () => {
    const start = 1000;
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const { mockDb } = createMockD1([], []);
    const request = makeRequest({ startTime: String(start), endTime: String(start + sevenDays) });
    const env = createMockEnv(mockDb);

    const response = await handleLogDiagnosticCorrelation(request, env);
    expect(response.status).toBe(200);
  });

  it('returns 400 when limit is 0', async () => {
    const request = makeRequest({ startTime: '1000', endTime: '2000', limit: '0' });
    const env = createMockEnv();

    const response = await handleLogDiagnosticCorrelation(request, env);
    expect(response.status).toBe(400);

    const body = await parseResponse(response);
    expect(body['success']).toBe(false);
    expect(body['error']).toContain('limit');
  });

  it('returns 400 when limit exceeds 500', async () => {
    const request = makeRequest({ startTime: '1000', endTime: '2000', limit: '501' });
    const env = createMockEnv();

    const response = await handleLogDiagnosticCorrelation(request, env);
    expect(response.status).toBe(400);

    const body = await parseResponse(response);
    expect(body['success']).toBe(false);
    expect(body['error']).toContain('500');
  });

  it('returns 400 when limit is a float', async () => {
    const request = makeRequest({ startTime: '1000', endTime: '2000', limit: '10.5' });
    const env = createMockEnv();

    const response = await handleLogDiagnosticCorrelation(request, env);
    expect(response.status).toBe(400);

    const body = await parseResponse(response);
    expect(body['success']).toBe(false);
    expect(body['error']).toContain('integer');
  });

  it('returns 400 when limit is not a number', async () => {
    const request = makeRequest({ startTime: '1000', endTime: '2000', limit: 'abc' });
    const env = createMockEnv();

    const response = await handleLogDiagnosticCorrelation(request, env);
    expect(response.status).toBe(400);

    const body = await parseResponse(response);
    expect(body['success']).toBe(false);
    expect(body['error']).toContain('limit');
  });
});

// ─────────────────────────────────────────────
// No DIAGNOSTICS_DB binding
// ─────────────────────────────────────────────

describe('No DIAGNOSTICS_DB binding', () => {
  it('returns 200 with empty data when DIAGNOSTICS_DB is not bound', async () => {
    const request = makeRequest({ startTime: '1000', endTime: '2000' });
    const env = createMockEnv(undefined);

    const response = await handleLogDiagnosticCorrelation(request, env);
    expect(response.status).toBe(200);

    const body = await parseResponse(response) as {
      success: boolean;
      data: {
        timeRange: { startTime: number; endTime: number };
        serverLogs: unknown[];
        clientErrors: unknown[];
        summary: {
          serverLogCount: number;
          clientErrorCount: number;
          overlappingCategories: unknown[];
        };
        lastUpdated: number;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.timeRange).toEqual({ startTime: 1000, endTime: 2000 });
    expect(body.data.serverLogs).toEqual([]);
    expect(body.data.clientErrors).toEqual([]);
    expect(body.data.summary.serverLogCount).toBe(0);
    expect(body.data.summary.clientErrorCount).toBe(0);
    expect(body.data.summary.overlappingCategories).toEqual([]);
    expect(typeof body.data.lastUpdated).toBe('number');
  });
});

// ─────────────────────────────────────────────
// Normal operation
// ─────────────────────────────────────────────

describe('Normal operation', () => {
  it('returns correlated server logs and client errors', async () => {
    const serverLogsRows = [
      { id: 1, server_id: 'vps-1', timestamp: 1500, severity: 'error', category: 'network', message: 'Connection timeout' },
      { id: 2, server_id: 'vps-1', timestamp: 1600, severity: 'warn', category: 'crypto', message: 'Key mismatch' },
    ];
    const clientErrorsRows = [
      { time_bucket: '2026-03-04T10:00:00Z', error_signature: 'sig-abc', category: 'network', count: 5, app_version: '1.0.0', platform: 'android', sample_message: 'Timeout error' },
      { time_bucket: '2026-03-04T10:00:00Z', error_signature: 'sig-def', category: 'crypto', count: 3, app_version: '1.0.0', platform: 'ios', sample_message: null },
    ];

    const { mockDb } = createMockD1(serverLogsRows, clientErrorsRows);
    const request = makeRequest({ startTime: '1000', endTime: '2000' });
    const env = createMockEnv(mockDb);

    const response = await handleLogDiagnosticCorrelation(request, env);
    expect(response.status).toBe(200);

    const body = await parseResponse(response) as {
      success: boolean;
      data: {
        timeRange: { startTime: number; endTime: number };
        serverLogs: Array<{ id: number; serverId: string; timestamp: number; severity: string; category: string; message: string }>;
        clientErrors: Array<{ timeBucket: string; errorSignature: string; category: string; count: number; appVersion: string; platform: string; sampleMessage: string | null }>;
        summary: {
          serverLogCount: number;
          clientErrorCount: number;
          overlappingCategories: string[];
        };
        lastUpdated: number;
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.timeRange).toEqual({ startTime: 1000, endTime: 2000 });

    // Server logs
    expect(body.data.serverLogs).toHaveLength(2);
    expect(body.data.serverLogs[0]!.serverId).toBe('vps-1');
    expect(body.data.serverLogs[0]!.severity).toBe('error');
    expect(body.data.serverLogs[0]!.category).toBe('network');
    expect(body.data.serverLogs[0]!.message).toBe('Connection timeout');

    // Client errors
    expect(body.data.clientErrors).toHaveLength(2);
    expect(body.data.clientErrors[0]!.errorSignature).toBe('sig-abc');
    expect(body.data.clientErrors[0]!.count).toBe(5);
    expect(body.data.clientErrors[1]!.sampleMessage).toBeNull();

    // Summary
    expect(body.data.summary.serverLogCount).toBe(2);
    expect(body.data.summary.clientErrorCount).toBe(2);
    expect(body.data.summary.overlappingCategories).toContain('network');
    expect(body.data.summary.overlappingCategories).toContain('crypto');
    expect(body.data.summary.overlappingCategories).toHaveLength(2);

    expect(typeof body.data.lastUpdated).toBe('number');
  });

  it('returns empty results when no data matches the time range', async () => {
    const { mockDb } = createMockD1([], []);
    const request = makeRequest({ startTime: '1000', endTime: '2000' });
    const env = createMockEnv(mockDb);

    const response = await handleLogDiagnosticCorrelation(request, env);
    expect(response.status).toBe(200);

    const body = await parseResponse(response) as {
      success: boolean;
      data: {
        serverLogs: unknown[];
        clientErrors: unknown[];
        summary: { serverLogCount: number; clientErrorCount: number; overlappingCategories: unknown[] };
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.serverLogs).toEqual([]);
    expect(body.data.clientErrors).toEqual([]);
    expect(body.data.summary.serverLogCount).toBe(0);
    expect(body.data.summary.clientErrorCount).toBe(0);
    expect(body.data.summary.overlappingCategories).toEqual([]);
  });

  it('correctly computes overlapping categories with partial overlap', async () => {
    const serverLogsRows = [
      { id: 1, server_id: 'vps-1', timestamp: 1500, severity: 'error', category: 'network', message: 'msg1' },
      { id: 2, server_id: 'vps-1', timestamp: 1600, severity: 'error', category: 'auth', message: 'msg2' },
    ];
    const clientErrorsRows = [
      { time_bucket: '2026-03-04T10:00:00Z', error_signature: 'sig-1', category: 'network', count: 1, app_version: '1.0.0', platform: 'android', sample_message: 'msg' },
      { time_bucket: '2026-03-04T10:00:00Z', error_signature: 'sig-2', category: 'storage', count: 1, app_version: '1.0.0', platform: 'android', sample_message: 'msg' },
    ];

    const { mockDb } = createMockD1(serverLogsRows, clientErrorsRows);
    const request = makeRequest({ startTime: '1000', endTime: '2000' });
    const env = createMockEnv(mockDb);

    const response = await handleLogDiagnosticCorrelation(request, env);
    expect(response.status).toBe(200);

    const body = await parseResponse(response) as {
      success: boolean;
      data: {
        summary: { overlappingCategories: string[] };
      };
    };
    expect(body.data.summary.overlappingCategories).toEqual(['network']);
  });

  it('passes serverId filter to query when provided', async () => {
    const { mockDb, mockPreparedStatement } = createMockD1([], []);
    const request = makeRequest({ startTime: '1000', endTime: '2000', serverId: 'vps-42' });
    const env = createMockEnv(mockDb);

    await handleLogDiagnosticCorrelation(request, env);

    // The first prepare() should include the serverId in the bind args
    expect(mockPreparedStatement.bind).toHaveBeenCalledWith(1000, 2000, 'vps-42', 100);
  });

  it('uses default limit of 100 when not specified', async () => {
    const { mockDb, mockPreparedStatement } = createMockD1([], []);
    const request = makeRequest({ startTime: '1000', endTime: '2000' });
    const env = createMockEnv(mockDb);

    await handleLogDiagnosticCorrelation(request, env);

    // Server logs bind: startTime, endTime, limit=100
    expect(mockPreparedStatement.bind).toHaveBeenCalledWith(1000, 2000, 100);
  });

  it('uses custom limit when specified', async () => {
    const { mockDb, mockPreparedStatement } = createMockD1([], []);
    const request = makeRequest({ startTime: '1000', endTime: '2000', limit: '50' });
    const env = createMockEnv(mockDb);

    await handleLogDiagnosticCorrelation(request, env);

    // Server logs bind: startTime, endTime, limit=50
    expect(mockPreparedStatement.bind).toHaveBeenCalledWith(1000, 2000, 50);
  });

  it('accepts limit of 1 (minimum)', async () => {
    const { mockDb } = createMockD1([], []);
    const request = makeRequest({ startTime: '1000', endTime: '2000', limit: '1' });
    const env = createMockEnv(mockDb);

    const response = await handleLogDiagnosticCorrelation(request, env);
    expect(response.status).toBe(200);
  });

  it('accepts limit of 500 (maximum)', async () => {
    const { mockDb } = createMockD1([], []);
    const request = makeRequest({ startTime: '1000', endTime: '2000', limit: '500' });
    const env = createMockEnv(mockDb);

    const response = await handleLogDiagnosticCorrelation(request, env);
    expect(response.status).toBe(200);
  });
});

// ─────────────────────────────────────────────
// batch() usage verification
// ─────────────────────────────────────────────

describe('D1 batch usage', () => {
  it('uses batch() for both queries in a single roundtrip', async () => {
    const { mockDb } = createMockD1([], []);
    const request = makeRequest({ startTime: '1000', endTime: '2000' });
    const env = createMockEnv(mockDb);

    await handleLogDiagnosticCorrelation(request, env);

    // batch() should be called exactly once with two prepared statements
    expect(mockDb.batch).toHaveBeenCalledTimes(1);
    const batchArgs = mockDb.batch.mock.calls[0]![0] as unknown[];
    expect(batchArgs).toHaveLength(2);
  });

  it('calls prepare() twice (one for each query)', async () => {
    const { mockDb } = createMockD1([], []);
    const request = makeRequest({ startTime: '1000', endTime: '2000' });
    const env = createMockEnv(mockDb);

    await handleLogDiagnosticCorrelation(request, env);

    expect(mockDb.prepare).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────
// D1 error handling
// ─────────────────────────────────────────────

describe('D1 error handling', () => {
  it('returns 500 with generic message when D1 throws', async () => {
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
      }),
      batch: vi.fn().mockRejectedValue(new Error('D1_ERROR: SQLITE_CONSTRAINT')),
    };

    const request = makeRequest({ startTime: '1000', endTime: '2000' });
    const env = createMockEnv(mockDb);

    const response = await handleLogDiagnosticCorrelation(request, env);
    expect(response.status).toBe(500);

    const body = await parseResponse(response);
    expect(body['success']).toBe(false);
    expect(body['error']).toBe('Failed to query diagnostic data');
    // Ensure no D1 internal details leak
    expect(JSON.stringify(body)).not.toContain('SQLITE');
    expect(JSON.stringify(body)).not.toContain('D1_ERROR');
  });
});

// ─────────────────────────────────────────────
// Response headers
// ─────────────────────────────────────────────

describe('Response headers', () => {
  it('returns application/json content type', async () => {
    const request = makeRequest({ startTime: '1000', endTime: '2000' });
    const env = createMockEnv(undefined);

    const response = await handleLogDiagnosticCorrelation(request, env);
    expect(response.headers.get('content-type')).toBe('application/json');
  });

  it('returns cache-control no-store', async () => {
    const request = makeRequest({ startTime: '1000', endTime: '2000' });
    const env = createMockEnv(undefined);

    const response = await handleLogDiagnosticCorrelation(request, env);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

// ─────────────────────────────────────────────
// CORS headers (applied by index.ts wrapper)
// ─────────────────────────────────────────────

describe('CORS via index.ts integration', () => {
  it('handler returns a proper Response that index.ts can decorate with CORS', async () => {
    const request = makeRequest({ startTime: '1000', endTime: '2000' });
    const env = createMockEnv(undefined);

    const response = await handleLogDiagnosticCorrelation(request, env);
    // The handler returns a plain Response; CORS headers are added by the index.ts wrapper
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);

    // Simulate what index.ts does: add CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    const newHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders)) {
      newHeaders.set(key, value);
    }
    const corsResponse = new Response(response.body, {
      status: response.status,
      headers: newHeaders,
    });

    expect(corsResponse.headers.get('access-control-allow-origin')).toBe('*');
    expect(corsResponse.headers.get('access-control-allow-methods')).toContain('GET');
  });
});
