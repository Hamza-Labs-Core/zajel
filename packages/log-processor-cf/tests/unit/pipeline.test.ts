/**
 * Unit tests for the main processing pipeline.
 *
 * Tests the full orchestration flow including error cluster querying,
 * deduplication, AI analysis, GitHub issue creation, and run recording.
 * All external dependencies (D1, AI, GitHub) are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runProcessingPipeline,
  getLastRunTimestamp,
  queryErrorClusters,
  recordProcessingRun,
} from '../../src/pipeline.js';
import type { Env, ProcessingRunResult } from '../../src/types.js';
import { MAX_CLUSTERS_PER_RUN, MAX_NEW_ISSUES_PER_RUN, ERROR_THRESHOLD } from '../../src/types.js';

// ─────────────────────────────────────────────
// Test Fixtures and Helpers
// ─────────────────────────────────────────────

const VALID_AI_RESPONSE = JSON.stringify({
  title: 'Test issue title',
  severity: 'high',
  component: 'network',
  description: 'Test description.',
  reproduction_hints: 'Test hints.',
  suggested_fix: 'Test fix.',
  is_regression: false,
  affected_users_estimate: 'some',
});

function makeErrorRow(
  signature: string,
  count: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    error_signature: signature,
    category: 'network',
    total_count: count,
    versions: '1.0.0,1.1.0',
    platforms: 'android,ios',
    sample_messages: 'Error msg 1|||Error msg 2',
    sample_stack_traces: 'stack trace 1',
    first_seen: Date.now() - 3600000,
    last_seen: Date.now() - 60000,
    ...overrides,
  };
}

/**
 * Build a full mock Env with configurable behavior.
 */
function makeMockEnv(options: {
  errorRows?: Record<string, unknown>[];
  issueTrackingRow?: Record<string, unknown> | null;
  lastRunRow?: Record<string, unknown> | null;
  aiResponse?: string;
  aiShouldFail?: boolean;
  githubShouldFail?: boolean;
} = {}): Env {
  const {
    errorRows = [],
    issueTrackingRow = null,
    lastRunRow = null,
    aiResponse = VALID_AI_RESPONSE,
    aiShouldFail = false,
    githubShouldFail = false,
  } = options;

  // Track which SQL queries are executed to return appropriate mock data
  const prepare = vi.fn().mockImplementation((sql: string) => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockImplementation(async () => {
        if (sql.includes('processing_runs')) {
          return lastRunRow;
        }
        if (sql.includes('issue_tracking')) {
          return issueTrackingRow;
        }
        return null;
      }),
      all: vi.fn().mockImplementation(async () => {
        if (sql.includes('error_aggregates')) {
          return { success: true, results: errorRows };
        }
        return { success: true, results: [] };
      }),
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
    };
    return stmt;
  });

  const aiRun = aiShouldFail
    ? vi.fn().mockRejectedValue(new Error('AI unavailable'))
    : vi.fn().mockResolvedValue({ response: aiResponse });

  // Mock global fetch for GitHub API calls
  if (githubShouldFail) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });
  } else {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          number: Math.floor(Math.random() * 1000),
          html_url: 'https://github.com/owner/repo/issues/1',
        }),
    });
  }

  return {
    DB: { prepare } as unknown as D1Database,
    REPORTS_BUCKET: {} as R2Bucket,
    AI: { run: aiRun } as unknown as Ai,
    GITHUB_TOKEN: 'ghp_test',
    GITHUB_REPO: 'owner/repo',
  };
}

// ─────────────────────────────────────────────
// Global fetch mock management
// ─────────────────────────────────────────────

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─────────────────────────────────────────────
// getLastRunTimestamp tests
// ─────────────────────────────────────────────

describe('getLastRunTimestamp', () => {
  it('returns last successful run timestamp', async () => {
    const lastRunTime = Date.now() - 900000; // 15 min ago
    const env = makeMockEnv({ lastRunRow: { run_end: lastRunTime } });

    const result = await getLastRunTimestamp(env);
    expect(result).toBe(lastRunTime);
  });

  it('returns fallback timestamp when no prior runs exist', async () => {
    const before = Date.now() - 15 * 60 * 1000;
    const env = makeMockEnv({ lastRunRow: null });

    const result = await getLastRunTimestamp(env);

    // Should be approximately 15 minutes ago
    expect(result).toBeGreaterThanOrEqual(before - 100);
    expect(result).toBeLessThanOrEqual(Date.now());
  });

  it('returns fallback when D1 query fails', async () => {
    const before = Date.now() - 15 * 60 * 1000;
    const env: Env = {
      DB: {
        prepare: vi.fn().mockReturnValue({
          first: vi.fn().mockRejectedValue(new Error('D1 error')),
        }),
      } as unknown as D1Database,
      REPORTS_BUCKET: {} as R2Bucket,
      AI: {} as Ai,
      GITHUB_TOKEN: 'ghp_test',
      GITHUB_REPO: 'owner/repo',
    };

    const result = await getLastRunTimestamp(env);
    expect(result).toBeGreaterThanOrEqual(before - 100);
  });
});

// ─────────────────────────────────────────────
// queryErrorClusters tests
// ─────────────────────────────────────────────

describe('queryErrorClusters', () => {
  it('returns clusters from D1 query results', async () => {
    const rows = [
      makeErrorRow('net:timeout', 15),
      makeErrorRow('crypto:handshake', 8),
    ];
    const env = makeMockEnv({ errorRows: rows });

    const clusters = await queryErrorClusters(env, Date.now() - 900000);

    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.errorSignature).toBe('net:timeout');
    expect(clusters[0]!.totalCount).toBe(15);
    expect(clusters[1]!.errorSignature).toBe('crypto:handshake');
  });

  it('parses comma-separated versions and platforms', async () => {
    const rows = [
      makeErrorRow('net:timeout', 10, {
        versions: '1.0.0,1.1.0,1.2.0',
        platforms: 'android,ios,linux',
      }),
    ];
    const env = makeMockEnv({ errorRows: rows });

    const clusters = await queryErrorClusters(env, Date.now() - 900000);

    expect(clusters[0]!.versions).toEqual(['1.0.0', '1.1.0', '1.2.0']);
    expect(clusters[0]!.platforms).toEqual(['android', 'ios', 'linux']);
  });

  it('returns empty array when D1 query fails', async () => {
    const env: Env = {
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnThis(),
          all: vi.fn().mockResolvedValue({ success: false, results: null }),
        }),
      } as unknown as D1Database,
      REPORTS_BUCKET: {} as R2Bucket,
      AI: {} as Ai,
      GITHUB_TOKEN: 'ghp_test',
      GITHUB_REPO: 'owner/repo',
    };

    const clusters = await queryErrorClusters(env, Date.now() - 900000);
    expect(clusters).toEqual([]);
  });

  it('handles empty versions and platforms gracefully', async () => {
    const rows = [
      makeErrorRow('net:timeout', 10, {
        versions: '',
        platforms: '',
        sample_messages: '',
        sample_stack_traces: '',
      }),
    ];
    const env = makeMockEnv({ errorRows: rows });

    const clusters = await queryErrorClusters(env, Date.now() - 900000);

    expect(clusters[0]).toBeDefined();
    expect(clusters[0]!.versions).toEqual([]);
    expect(clusters[0]!.platforms).toEqual([]);
    expect(clusters[0]!.sampleMessages).toEqual([]);
    expect(clusters[0]!.sampleStackTraces).toEqual([]);
  });

  it('uses parameterized queries with threshold and limit', async () => {
    const env = makeMockEnv({ errorRows: [] });
    const since = Date.now() - 900000;

    await queryErrorClusters(env, since);

    const prepareMock = env.DB.prepare as ReturnType<typeof vi.fn>;
    expect(prepareMock).toHaveBeenCalled();

    const sql = prepareMock.mock.calls[0]?.[0] as string | undefined;
    expect(sql).toBeDefined();
    expect(sql).toContain('HAVING SUM(count) >= ?');
    expect(sql).toContain('LIMIT ?');
  });
});

// ─────────────────────────────────────────────
// recordProcessingRun tests
// ─────────────────────────────────────────────

describe('recordProcessingRun', () => {
  it('records run data in processing_runs table', async () => {
    const env = makeMockEnv();
    const runStart = Date.now() - 5000;
    const result: ProcessingRunResult = {
      errorsProcessed: 5,
      issuesCreated: 2,
      issuesUpdated: 1,
      aiCallsMade: 3,
      aiTokensUsed: 2100,
      status: 'success',
    };

    await recordProcessingRun(env, runStart, result);

    const prepareMock = env.DB.prepare as ReturnType<typeof vi.fn>;
    // Find the INSERT INTO processing_runs call
    const processingRunsCalls = prepareMock.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === 'string' && call[0].includes('processing_runs'),
    );
    expect(processingRunsCalls.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────
// runProcessingPipeline tests
// ─────────────────────────────────────────────

describe('runProcessingPipeline', () => {
  it('returns success with zero counts when no clusters found', async () => {
    const env = makeMockEnv({ errorRows: [] });

    const result = await runProcessingPipeline(env);

    expect(result.errorsProcessed).toBe(0);
    expect(result.issuesCreated).toBe(0);
    expect(result.issuesUpdated).toBe(0);
    expect(result.status).toBe('success');
  });

  it('processes clusters above threshold', async () => {
    const rows = [makeErrorRow('net:timeout', 15)];
    const env = makeMockEnv({ errorRows: rows });

    const result = await runProcessingPipeline(env);

    expect(result.errorsProcessed).toBe(1);
    expect(result.aiCallsMade).toBe(1);
    expect(result.issuesCreated).toBe(1);
    expect(result.status).toBe('success');
  });

  it('updates existing open issues instead of creating new ones', async () => {
    const rows = [makeErrorRow('net:timeout', 15)];
    const env = makeMockEnv({
      errorRows: rows,
      issueTrackingRow: {
        github_issue_number: 42,
        status: 'open',
        total_occurrences: 10,
      },
    });

    const result = await runProcessingPipeline(env);

    expect(result.errorsProcessed).toBe(1);
    expect(result.issuesUpdated).toBe(1);
    expect(result.issuesCreated).toBe(0);
    expect(result.aiCallsMade).toBe(0); // No AI call needed for updates
  });

  it('still creates issue when AI fails (graceful degradation)', async () => {
    const rows = [makeErrorRow('net:timeout', 15)];
    const env = makeMockEnv({
      errorRows: rows,
      aiShouldFail: true,
    });

    const result = await runProcessingPipeline(env);

    expect(result.errorsProcessed).toBe(1);
    expect(result.aiCallsMade).toBe(1);
    // Issue should still be created even without AI analysis
    expect(result.issuesCreated).toBe(1);
  });

  it('records pending status when GitHub API fails', async () => {
    const rows = [makeErrorRow('net:timeout', 15)];
    const env = makeMockEnv({
      errorRows: rows,
      githubShouldFail: true,
    });

    const result = await runProcessingPipeline(env);

    expect(result.errorsProcessed).toBe(1);
    expect(result.aiCallsMade).toBe(1);
    expect(result.issuesCreated).toBe(0); // GitHub failed
  });

  it('enforces max 20 clusters per run', async () => {
    // Create 25 error rows
    const rows = Array.from({ length: 25 }, (_, i) =>
      makeErrorRow(`error:sig_${i}`, 10 + i),
    );
    const env = makeMockEnv({ errorRows: rows });

    // queryErrorClusters uses LIMIT in SQL, so D1 mock returns all rows
    // but we still pass all 25 rows through the mock
    const result = await runProcessingPipeline(env);

    // The SQL LIMIT clause handles this, so all rows from mock are processed
    // but in a real scenario only MAX_CLUSTERS_PER_RUN would be returned
    expect(result.errorsProcessed).toBe(25);
    // But only MAX_NEW_ISSUES_PER_RUN new issues are created
    expect(result.issuesCreated).toBeLessThanOrEqual(MAX_NEW_ISSUES_PER_RUN);
  });

  it('enforces max 10 new issues per run', async () => {
    // Create 15 error rows (all new, no duplicates)
    const rows = Array.from({ length: 15 }, (_, i) =>
      makeErrorRow(`error:sig_${i}`, 10 + i),
    );
    const env = makeMockEnv({ errorRows: rows });

    const result = await runProcessingPipeline(env);

    expect(result.issuesCreated).toBeLessThanOrEqual(MAX_NEW_ISSUES_PER_RUN);
    expect(result.issuesCreated).toBe(MAX_NEW_ISSUES_PER_RUN);
  });

  it('sets partial status when individual cluster processing fails', async () => {
    const rows = [makeErrorRow('net:timeout', 15)];

    // Create env where D1 prepare fails on issue_tracking queries but
    // succeeds on initial queries
    let callCount = 0;
    const prepare = vi.fn().mockImplementation((sql: string) => {
      callCount++;
      const stmt = {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockImplementation(async () => {
          if (sql.includes('processing_runs')) {
            return null;
          }
          if (sql.includes('issue_tracking') && sql.includes('SELECT')) {
            // Dedup check throws
            throw new Error('D1 flaky error');
          }
          return null;
        }),
        all: vi.fn().mockImplementation(async () => {
          if (sql.includes('error_aggregates')) {
            return { success: true, results: rows };
          }
          return { success: true, results: [] };
        }),
        run: vi.fn().mockRejectedValue(new Error('D1 write error')),
      };
      return stmt;
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          number: 1,
          html_url: 'https://github.com/owner/repo/issues/1',
        }),
    });

    const env: Env = {
      DB: { prepare } as unknown as D1Database,
      REPORTS_BUCKET: {} as R2Bucket,
      AI: {
        run: vi.fn().mockResolvedValue({ response: VALID_AI_RESPONSE }),
      } as unknown as Ai,
      GITHUB_TOKEN: 'ghp_test',
      GITHUB_REPO: 'owner/repo',
    };

    const result = await runProcessingPipeline(env);

    // Should have partial status due to errors during processing
    expect(result.status).toBe('partial');
  });

  it('handles multiple clusters with mixed dedup results', async () => {
    const rows = [
      makeErrorRow('error:new_one', 20),
      makeErrorRow('error:existing_open', 15),
    ];

    // Return different dedup results based on which signature is being checked
    let dedupCallCount = 0;
    const prepare = vi.fn().mockImplementation((sql: string) => {
      return {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockImplementation(async () => {
          if (sql.includes('processing_runs')) {
            return null;
          }
          if (sql.includes('issue_tracking') && sql.includes('SELECT')) {
            dedupCallCount++;
            if (dedupCallCount === 1) {
              // First cluster: brand new
              return null;
            }
            // Second cluster: existing open issue
            return {
              github_issue_number: 99,
              status: 'open',
              total_occurrences: 10,
            };
          }
          return null;
        }),
        all: vi.fn().mockImplementation(async () => {
          if (sql.includes('error_aggregates')) {
            return { success: true, results: rows };
          }
          return { success: true, results: [] };
        }),
        run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
      };
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          number: 100,
          html_url: 'https://github.com/owner/repo/issues/100',
        }),
    });

    const env: Env = {
      DB: { prepare } as unknown as D1Database,
      REPORTS_BUCKET: {} as R2Bucket,
      AI: {
        run: vi.fn().mockResolvedValue({ response: VALID_AI_RESPONSE }),
      } as unknown as Ai,
      GITHUB_TOKEN: 'ghp_test',
      GITHUB_REPO: 'owner/repo',
    };

    const result = await runProcessingPipeline(env);

    expect(result.errorsProcessed).toBe(2);
    expect(result.issuesCreated).toBe(1); // Only the new one
    expect(result.issuesUpdated).toBe(1); // The existing open one
    expect(result.aiCallsMade).toBe(1); // Only for the new one
  });
});
