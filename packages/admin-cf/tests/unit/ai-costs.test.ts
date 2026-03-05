/**
 * Unit tests for AI Cost Monitoring (US-6.5)
 *
 * Tests handleAiCosts route handler with mocked auth and D1 database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env, AiCostsData, ApiResponse } from '../../src/types.js';

// Mock auth module — behavior set per-test via beforeEach
vi.mock('../../src/routes/auth.js', () => ({
  requireAuth: vi.fn(),
}));

// Import after mock setup
import { handleAiCosts } from '../../src/routes/ai-costs.js';
import { requireAuth } from '../../src/routes/auth.js';

// ─── Test Data ──────────────────────────────────

const NOW = 1709510400000; // 2024-03-04T00:00:00.000Z
const DAY_MS = 86400000;

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    run_start: NOW - 3600000,      // 1 hour ago
    run_end: NOW - 3500000,        // 100s duration
    errors_processed: 5,
    issues_created: 2,
    issues_updated: 1,
    ai_calls_made: 3,
    ai_tokens_used: 1500,
    status: 'success',
    ...overrides,
  };
}

// ─── D1 Mock Helpers ────────────────────────────

interface MockD1PreparedStatement {
  bind: (...args: unknown[]) => MockD1PreparedStatement;
  all: () => Promise<{ results: Record<string, unknown>[] }>;
}

function createMockD1(
  summaryRows: Record<string, unknown>[],
  dailyRows: Record<string, unknown>[],
  recentRows: Record<string, unknown>[]
) {
  let callIndex = 0;
  const allResults = [summaryRows, dailyRows, recentRows];

  const mockStatement: MockD1PreparedStatement = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockImplementation(() => {
      const results = allResults[callIndex] || [];
      callIndex++;
      return Promise.resolve({ results });
    }),
  };

  return {
    prepare: vi.fn().mockReturnValue(mockStatement),
    _statement: mockStatement,
  };
}

function createFailingD1() {
  const mockStatement = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockRejectedValue(new Error('D1 connection failed')),
  };
  return {
    prepare: vi.fn().mockReturnValue(mockStatement),
  };
}

// ─── Env Helper ─────────────────────────────────

function makeEnv(diagnosticsDb?: unknown): Env {
  return {
    ADMIN_USERS: {} as unknown as DurableObjectNamespace,
    ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    ...(diagnosticsDb !== undefined ? { DIAGNOSTICS_DB: diagnosticsDb as Env['DIAGNOSTICS_DB'] } : {}),
  };
}

function makeRequest(range?: string): Request {
  const params = range ? `?range=${range}` : '';
  return new Request(`https://admin.example.com/admin/api/ai/costs${params}`, {
    method: 'GET',
    headers: { Authorization: 'Bearer valid-token' },
  });
}

async function parseResponse(response: Response): Promise<ApiResponse<AiCostsData>> {
  return response.json() as Promise<ApiResponse<AiCostsData>>;
}

// ─── Tests ──────────────────────────────────────

describe('handleAiCosts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset requireAuth to succeed by default
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  // ─── Summary totals ──────────────────────────

  it('returns 200 with correct summary totals', async () => {
    const summaryRows = [{
      total_runs: 10,
      successful_runs: 8,
      failed_runs: 2,
      total_errors_processed: 50,
      total_issues_created: 20,
      total_issues_updated: 15,
      total_ai_calls: 30,
      total_tokens_used: 5000,
    }];

    const mockD1 = createMockD1(summaryRows, [], []);
    const env = makeEnv(mockD1);
    const response = await handleAiCosts(makeRequest('7d'), env);
    const body = await parseResponse(response);

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data!.summary.totalRuns).toBe(10);
    expect(body.data!.summary.successfulRuns).toBe(8);
    expect(body.data!.summary.failedRuns).toBe(2);
    expect(body.data!.summary.totalErrorsProcessed).toBe(50);
    expect(body.data!.summary.totalIssuesCreated).toBe(20);
    expect(body.data!.summary.totalIssuesUpdated).toBe(15);
    expect(body.data!.summary.totalAiCalls).toBe(30);
    expect(body.data!.summary.totalTokensUsed).toBe(5000);
  });

  // ─── Daily breakdown ──────────────────────────

  it('returns daily breakdown grouped correctly', async () => {
    const day1Bucket = Math.floor(NOW / DAY_MS) * DAY_MS;
    const day2Bucket = day1Bucket - DAY_MS;

    const dailyRows = [
      {
        day_bucket: day2Bucket,
        runs: 3,
        errors_processed: 10,
        issues_created: 4,
        ai_calls: 8,
        tokens_used: 2000,
      },
      {
        day_bucket: day1Bucket,
        runs: 5,
        errors_processed: 15,
        issues_created: 6,
        ai_calls: 12,
        tokens_used: 3000,
      },
    ];

    const mockD1 = createMockD1([{
      total_runs: 8, successful_runs: 8, failed_runs: 0,
      total_errors_processed: 25, total_issues_created: 10,
      total_issues_updated: 5, total_ai_calls: 20, total_tokens_used: 5000,
    }], dailyRows, []);

    const env = makeEnv(mockD1);
    const response = await handleAiCosts(makeRequest('7d'), env);
    const body = await parseResponse(response);

    expect(response.status).toBe(200);
    expect(body.data!.dailyBreakdown).toHaveLength(2);

    // First entry should be the earlier day (ASC order from SQL)
    expect(body.data!.dailyBreakdown[0].runs).toBe(3);
    expect(body.data!.dailyBreakdown[0].tokensUsed).toBe(2000);
    expect(body.data!.dailyBreakdown[1].runs).toBe(5);
    expect(body.data!.dailyBreakdown[1].tokensUsed).toBe(3000);
  });

  // ─── Recent runs ─────────────────────────────

  it('returns recent runs sorted by start time DESC, limited to 20', async () => {
    const runs = Array.from({ length: 20 }, (_, i) => makeRun({
      id: 20 - i,
      run_start: NOW - (i + 1) * 3600000,
      run_end: NOW - (i + 1) * 3600000 + 100000,
    }));

    const mockD1 = createMockD1([{
      total_runs: 20, successful_runs: 20, failed_runs: 0,
      total_errors_processed: 100, total_issues_created: 40,
      total_issues_updated: 20, total_ai_calls: 60, total_tokens_used: 30000,
    }], [], runs);

    const env = makeEnv(mockD1);
    const response = await handleAiCosts(makeRequest('7d'), env);
    const body = await parseResponse(response);

    expect(response.status).toBe(200);
    expect(body.data!.recentRuns).toHaveLength(20);
    // First run should have the highest run_start (most recent)
    expect(body.data!.recentRuns[0].runStart).toBeGreaterThan(
      body.data!.recentRuns[1].runStart
    );
  });

  // ─── Range validation ─────────────────────────

  it('rejects invalid range values', async () => {
    const env = makeEnv(createMockD1([], [], []));
    const response = await handleAiCosts(makeRequest('invalid'), env);
    const body = await parseResponse(response);

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain('Invalid range');
  });

  it('defaults range to 7d when not specified', async () => {
    const mockD1 = createMockD1([{
      total_runs: 0, successful_runs: 0, failed_runs: 0,
      total_errors_processed: 0, total_issues_created: 0,
      total_issues_updated: 0, total_ai_calls: 0, total_tokens_used: 0,
    }], [], []);

    const env = makeEnv(mockD1);
    const response = await handleAiCosts(makeRequest(), env);
    const body = await parseResponse(response);

    expect(response.status).toBe(200);
    expect(body.data!.range).toBe('7d');
  });

  it('accepts range 24h', async () => {
    const mockD1 = createMockD1([{
      total_runs: 0, successful_runs: 0, failed_runs: 0,
      total_errors_processed: 0, total_issues_created: 0,
      total_issues_updated: 0, total_ai_calls: 0, total_tokens_used: 0,
    }], [], []);

    const env = makeEnv(mockD1);
    const response = await handleAiCosts(makeRequest('24h'), env);
    const body = await parseResponse(response);

    expect(response.status).toBe(200);
    expect(body.data!.range).toBe('24h');
  });

  it('accepts range 30d', async () => {
    const mockD1 = createMockD1([{
      total_runs: 0, successful_runs: 0, failed_runs: 0,
      total_errors_processed: 0, total_issues_created: 0,
      total_issues_updated: 0, total_ai_calls: 0, total_tokens_used: 0,
    }], [], []);

    const env = makeEnv(mockD1);
    const response = await handleAiCosts(makeRequest('30d'), env);
    const body = await parseResponse(response);

    expect(response.status).toBe(200);
    expect(body.data!.range).toBe('30d');
  });

  // ─── Cost calculation ─────────────────────────

  it('calculates estimated cost correctly (tokens * 0.011 / 1000)', async () => {
    const summaryRows = [{
      total_runs: 1,
      successful_runs: 1,
      failed_runs: 0,
      total_errors_processed: 5,
      total_issues_created: 2,
      total_issues_updated: 1,
      total_ai_calls: 3,
      total_tokens_used: 10000,
    }];

    const mockD1 = createMockD1(summaryRows, [], []);
    const env = makeEnv(mockD1);
    const response = await handleAiCosts(makeRequest('7d'), env);
    const body = await parseResponse(response);

    // 10000 * 0.011 / 1000 = 0.11
    expect(body.data!.summary.estimatedCostUsd).toBeCloseTo(0.11, 6);
  });

  it('calculates daily breakdown estimated cost correctly', async () => {
    const dayBucket = Math.floor(NOW / DAY_MS) * DAY_MS;
    const dailyRows = [{
      day_bucket: dayBucket,
      runs: 2,
      errors_processed: 10,
      issues_created: 4,
      ai_calls: 6,
      tokens_used: 5000,
    }];

    const mockD1 = createMockD1([{
      total_runs: 2, successful_runs: 2, failed_runs: 0,
      total_errors_processed: 10, total_issues_created: 4,
      total_issues_updated: 2, total_ai_calls: 6, total_tokens_used: 5000,
    }], dailyRows, []);

    const env = makeEnv(mockD1);
    const response = await handleAiCosts(makeRequest('7d'), env);
    const body = await parseResponse(response);

    // 5000 * 0.011 / 1000 = 0.055
    expect(body.data!.dailyBreakdown[0].estimatedCostUsd).toBeCloseTo(0.055, 6);
  });

  // ─── Empty data ───────────────────────────────

  it('returns 200 with empty/zero data when no runs exist', async () => {
    const summaryRows = [{
      total_runs: 0,
      successful_runs: 0,
      failed_runs: 0,
      total_errors_processed: null,
      total_issues_created: null,
      total_issues_updated: null,
      total_ai_calls: null,
      total_tokens_used: null,
    }];

    const mockD1 = createMockD1(summaryRows, [], []);
    const env = makeEnv(mockD1);
    const response = await handleAiCosts(makeRequest('7d'), env);
    const body = await parseResponse(response);

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data!.summary.totalRuns).toBe(0);
    expect(body.data!.summary.totalTokensUsed).toBe(0);
    expect(body.data!.summary.estimatedCostUsd).toBe(0);
    expect(body.data!.dailyBreakdown).toHaveLength(0);
    expect(body.data!.recentRuns).toHaveLength(0);
  });

  // ─── No DIAGNOSTICS_DB ────────────────────────

  it('returns 200 with empty data when DIAGNOSTICS_DB not bound', async () => {
    const env = makeEnv(); // no DIAGNOSTICS_DB
    const response = await handleAiCosts(makeRequest('7d'), env);
    const body = await parseResponse(response);

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data!.range).toBe('7d');
    expect(body.data!.summary.totalRuns).toBe(0);
    expect(body.data!.summary.totalTokensUsed).toBe(0);
    expect(body.data!.summary.estimatedCostUsd).toBe(0);
    expect(body.data!.dailyBreakdown).toHaveLength(0);
    expect(body.data!.recentRuns).toHaveLength(0);
    expect(body.data!.lastUpdated).toBeGreaterThan(0);
  });

  // ─── D1 failure ───────────────────────────────

  it('returns 500 with generic error on D1 failure', async () => {
    const mockD1 = createFailingD1();
    const env = makeEnv(mockD1);
    const response = await handleAiCosts(makeRequest('7d'), env);
    const body = await parseResponse(response);

    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Failed to fetch AI cost data');
    // Must NOT leak D1 error details
    expect(JSON.stringify(body)).not.toContain('D1 connection failed');
  });

  // ─── Duration calculation ─────────────────────

  it('calculates duration correctly (runEnd - runStart)', async () => {
    const run = makeRun({
      id: 1,
      run_start: 1700000000000,
      run_end: 1700000150000,   // 150 seconds later
    });

    const mockD1 = createMockD1([{
      total_runs: 1, successful_runs: 1, failed_runs: 0,
      total_errors_processed: 5, total_issues_created: 2,
      total_issues_updated: 1, total_ai_calls: 3, total_tokens_used: 1500,
    }], [], [run]);

    const env = makeEnv(mockD1);
    const response = await handleAiCosts(makeRequest('7d'), env);
    const body = await parseResponse(response);

    expect(body.data!.recentRuns[0].durationMs).toBe(150000);
  });

  // ─── Daily breakdown date format ──────────────

  it('daily breakdown date format is correct ISO date (YYYY-MM-DD)', async () => {
    // 2024-03-04T00:00:00.000Z bucket
    const dayBucket = Math.floor(NOW / DAY_MS) * DAY_MS;
    const expectedDate = new Date(dayBucket).toISOString().split('T')[0];

    const dailyRows = [{
      day_bucket: dayBucket,
      runs: 1,
      errors_processed: 5,
      issues_created: 2,
      ai_calls: 3,
      tokens_used: 1500,
    }];

    const mockD1 = createMockD1([{
      total_runs: 1, successful_runs: 1, failed_runs: 0,
      total_errors_processed: 5, total_issues_created: 2,
      total_issues_updated: 1, total_ai_calls: 3, total_tokens_used: 1500,
    }], dailyRows, []);

    const env = makeEnv(mockD1);
    const response = await handleAiCosts(makeRequest('7d'), env);
    const body = await parseResponse(response);

    expect(body.data!.dailyBreakdown[0].date).toBe(expectedDate);
    // Verify YYYY-MM-DD format
    expect(body.data!.dailyBreakdown[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // ─── Auth enforcement ─────────────────────────

  it('returns 401 when auth fails', async () => {
    vi.mocked(requireAuth).mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const env = makeEnv(createMockD1([], [], []));
    const response = await handleAiCosts(makeRequest('7d'), env);

    expect(response.status).toBe(401);
    const body = await response.json() as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error).toBe('Unauthorized');
  });

  // ─── Response shape ───────────────────────────

  it('response includes lastUpdated timestamp', async () => {
    const before = Date.now();
    const mockD1 = createMockD1([{
      total_runs: 0, successful_runs: 0, failed_runs: 0,
      total_errors_processed: null, total_issues_created: null,
      total_issues_updated: null, total_ai_calls: null, total_tokens_used: null,
    }], [], []);

    const env = makeEnv(mockD1);
    const response = await handleAiCosts(makeRequest('7d'), env);
    const body = await parseResponse(response);
    const after = Date.now();

    expect(body.data!.lastUpdated).toBeGreaterThanOrEqual(before);
    expect(body.data!.lastUpdated).toBeLessThanOrEqual(after);
  });

  it('response has correct content-type and cache-control headers', async () => {
    const mockD1 = createMockD1([{
      total_runs: 0, successful_runs: 0, failed_runs: 0,
      total_errors_processed: null, total_issues_created: null,
      total_issues_updated: null, total_ai_calls: null, total_tokens_used: null,
    }], [], []);

    const env = makeEnv(mockD1);
    const response = await handleAiCosts(makeRequest('7d'), env);

    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  // ─── SQL parameterization ─────────────────────

  it('passes time cutoff as parameterized bind value', async () => {
    const mockD1 = createMockD1([{
      total_runs: 0, successful_runs: 0, failed_runs: 0,
      total_errors_processed: null, total_issues_created: null,
      total_issues_updated: null, total_ai_calls: null, total_tokens_used: null,
    }], [], []);

    const env = makeEnv(mockD1);
    await handleAiCosts(makeRequest('7d'), env);

    // All 3 prepare calls use .bind() with the cutoff
    const statement = mockD1._statement;
    expect(statement.bind).toHaveBeenCalledTimes(3);
    // Each bind call gets a numeric cutoff
    for (const call of vi.mocked(statement.bind).mock.calls) {
      expect(typeof call[0]).toBe('number');
      expect(call[0]).toBeGreaterThan(0);
    }
  });
});
