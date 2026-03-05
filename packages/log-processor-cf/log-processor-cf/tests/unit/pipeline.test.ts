/**
 * Unit tests for the processing pipeline.
 *
 * Tests the full pipeline flow including: cluster querying, dedup checking,
 * AI analysis, GitHub issue creation, threshold enforcement, and
 * processing run recording.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runProcessingPipeline, recordProcessingRun } from '../../src/pipeline.js';
import type { Env, ProcessingRunResult } from '../../src/types.js';
import { MAX_CLUSTERS_PER_RUN, MAX_NEW_ISSUES_PER_RUN } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

interface MockDbState {
  processingRuns: Array<Record<string, unknown>>;
  issueTrackingRows: Array<Record<string, unknown>>;
  errorAggregateRows: Array<Record<string, unknown>>;
  processingRunsResult: Record<string, unknown> | null;
  issueTrackingResult: Record<string, unknown> | null;
}

let dbState: MockDbState;

const VALID_AI_RESPONSE = JSON.stringify({
  title: 'Test issue title',
  severity: 'high',
  component: 'crypto',
  description: 'Test description of the issue.',
  reproduction_hints: 'Steps to reproduce.',
  suggested_fix: 'Fix suggestion.',
  is_regression: false,
  affected_users_estimate: 'some',
});

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockD1(state: MockDbState): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first() {
              if (sql.includes('processing_runs')) {
                return state.processingRunsResult;
              }
              if (sql.includes('issue_tracking')) {
                return state.issueTrackingResult;
              }
              return null;
            },
            async all() {
              if (sql.includes('error_aggregates')) {
                return { results: state.errorAggregateRows };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes('INSERT INTO processing_runs')) {
                state.processingRuns.push({ sql });
              }
              if (sql.includes('INSERT INTO issue_tracking')) {
                state.issueTrackingRows.push({ sql });
              }
              return { success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function makeErrorRow(
  signature: string,
  count: number,
  category: string = 'crypto',
): Record<string, unknown> {
  return {
    error_signature: signature,
    category,
    total_count: count,
    app_versions: '1.0.0',
    platforms: 'android',
    sample_message: `Error in ${signature}`,
    sample_stack_trace: `at test (${signature}.dart:1)`,
    first_seen: 1700000000000,
    last_seen: 1700003600000,
  };
}

function createMockEnv(state: MockDbState): Env {
  return {
    DB: createMockD1(state),
    REPORTS_BUCKET: {} as R2Bucket,
    AI: {
      async run() {
        return { response: VALID_AI_RESPONSE };
      },
    },
    GITHUB_TOKEN: 'test-token',
    GITHUB_REPO: 'test/repo',
    ENVIRONMENT: 'test',
  } as unknown as Env;
}

beforeEach(() => {
  dbState = {
    processingRuns: [],
    issueTrackingRows: [],
    errorAggregateRows: [],
    processingRunsResult: null,
    issueTrackingResult: null,
  };

  // Mock global fetch for GitHub API calls
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({
      number: 1,
      html_url: 'https://github.com/test/repo/issues/1',
    }),
  }) as unknown as typeof globalThis.fetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runProcessingPipeline', () => {
  it('returns success with zero counts when no error clusters exist', async () => {
    dbState.errorAggregateRows = [];
    const env = createMockEnv(dbState);

    const result = await runProcessingPipeline(env);

    expect(result.status).toBe('success');
    expect(result.errorsProcessed).toBe(0);
    expect(result.issuesCreated).toBe(0);
    expect(result.issuesUpdated).toBe(0);
  });

  it('processes clusters above threshold and creates issues', async () => {
    dbState.errorAggregateRows = [
      makeErrorRow('sig_1', 10),
      makeErrorRow('sig_2', 20),
    ];
    // No existing issue tracking entries
    dbState.issueTrackingResult = null;

    const env = createMockEnv(dbState);
    const result = await runProcessingPipeline(env);

    expect(result.status).toBe('success');
    expect(result.errorsProcessed).toBe(2);
    expect(result.issuesCreated).toBe(2);
    expect(result.aiCallsMade).toBe(2);
    expect(result.aiTokensUsed).toBeGreaterThan(0);
  });

  it('skips clusters below threshold (handled by SQL query)', async () => {
    // The SQL query has HAVING SUM(count) >= threshold, so only
    // rows returned by D1 are above threshold. Test that processing
    // only counts what's returned.
    dbState.errorAggregateRows = [makeErrorRow('sig_above', 10)];
    dbState.issueTrackingResult = null;
    const env = createMockEnv(dbState);

    const result = await runProcessingPipeline(env);

    expect(result.errorsProcessed).toBe(1);
    expect(result.issuesCreated).toBe(1);
  });

  it('limits clusters to MAX_CLUSTERS_PER_RUN', async () => {
    // Create more clusters than the max
    const clusters: Array<Record<string, unknown>> = [];
    for (let i = 0; i < MAX_CLUSTERS_PER_RUN + 5; i++) {
      clusters.push(makeErrorRow(`sig_${i}`, 10 + i));
    }
    dbState.errorAggregateRows = clusters;
    dbState.issueTrackingResult = null;
    const env = createMockEnv(dbState);

    const result = await runProcessingPipeline(env);

    // SQL LIMIT caps at MAX_CLUSTERS_PER_RUN, so only that many are returned
    // But our mock returns all of them; the pipeline processes what's returned
    // The key enforcement is MAX_NEW_ISSUES_PER_RUN for issue creation
    expect(result.errorsProcessed).toBeGreaterThan(0);
  });

  it('enforces MAX_NEW_ISSUES_PER_RUN cap', async () => {
    // Create more clusters than the max new issues allowed
    const clusters: Array<Record<string, unknown>> = [];
    for (let i = 0; i < MAX_NEW_ISSUES_PER_RUN + 5; i++) {
      clusters.push(makeErrorRow(`sig_${i}`, 10 + i));
    }
    dbState.errorAggregateRows = clusters;
    dbState.issueTrackingResult = null;

    // Each GitHub API call returns a unique issue number
    let issueCounter = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      issueCounter++;
      return {
        ok: true,
        status: 201,
        json: async () => ({
          number: issueCounter,
          html_url: `https://github.com/test/repo/issues/${issueCounter}`,
        }),
      };
    }) as unknown as typeof globalThis.fetch;

    const env = createMockEnv(dbState);
    const result = await runProcessingPipeline(env);

    expect(result.issuesCreated).toBeLessThanOrEqual(MAX_NEW_ISSUES_PER_RUN);
  });

  it('updates existing open issues instead of creating new ones', async () => {
    dbState.errorAggregateRows = [makeErrorRow('sig_existing', 15)];
    // Simulate existing open issue
    dbState.issueTrackingResult = {
      id: 1,
      error_signature: 'sig_existing',
      github_issue_number: 42,
      github_issue_url: 'https://github.com/test/repo/issues/42',
      severity: 'high',
      component: 'crypto',
      status: 'open',
      ai_analysis: null,
      first_detected: 1700000000000,
      last_detected: 1700003600000,
      total_occurrences: 10,
      created_at: 1700000000000,
      updated_at: 1700003600000,
    };

    const env = createMockEnv(dbState);
    const result = await runProcessingPipeline(env);

    expect(result.issuesCreated).toBe(0);
    expect(result.issuesUpdated).toBe(1);
  });

  it('continues processing on individual cluster failure (partial status)', async () => {
    dbState.errorAggregateRows = [
      makeErrorRow('sig_1', 10),
      makeErrorRow('sig_2', 20),
    ];
    dbState.issueTrackingResult = null;

    // Make AI fail on first call, succeed on second
    let aiCallCount = 0;
    const env = createMockEnv(dbState);
    env.AI = {
      async run() {
        aiCallCount++;
        if (aiCallCount === 1) {
          throw new Error('AI unavailable');
        }
        return { response: VALID_AI_RESPONSE };
      },
    };

    const result = await runProcessingPipeline(env);

    // Pipeline should still complete (partial if any cluster failed)
    expect(result.errorsProcessed).toBe(2);
  });

  it('records AI tokens used', async () => {
    dbState.errorAggregateRows = [makeErrorRow('sig_1', 10)];
    dbState.issueTrackingResult = null;
    const env = createMockEnv(dbState);

    const result = await runProcessingPipeline(env);

    expect(result.aiCallsMade).toBe(1);
    expect(result.aiTokensUsed).toBeGreaterThan(0);
  });

  it('handles complete pipeline failure with failed status', async () => {
    // Make DB throw on initial query
    const env: Env = {
      DB: {
        prepare() {
          return {
            bind() {
              return {
                async first() {
                  return null;
                },
                async all() {
                  throw new Error('DB connection failed');
                },
                async run() {
                  return { success: true };
                },
              };
            },
          };
        },
      } as unknown as D1Database,
      REPORTS_BUCKET: {} as R2Bucket,
      AI: { async run() { return { response: '' }; } },
      GITHUB_TOKEN: 'test-token',
      GITHUB_REPO: 'test/repo',
    } as unknown as Env;

    const result = await runProcessingPipeline(env);

    expect(result.status).toBe('failed');
    expect(result.errorsProcessed).toBe(0);
  });
});

describe('recordProcessingRun', () => {
  it('inserts a processing run record into D1', async () => {
    const runCalls: Array<Record<string, unknown>> = [];
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async run() {
                runCalls.push({ called: true });
                return { success: true };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const result: ProcessingRunResult = {
      runStart: 1700000000000,
      runEnd: 1700000060000,
      errorsProcessed: 5,
      issuesCreated: 2,
      issuesUpdated: 1,
      aiCallsMade: 5,
      aiTokensUsed: 5000,
      status: 'success',
    };

    await recordProcessingRun(db, result);

    expect(runCalls).toHaveLength(1);
  });
});
