/**
 * Unit tests for the deduplication module.
 *
 * Tests the logic for detecting duplicate error signatures,
 * deciding when to reopen closed issues, and recording/updating
 * issue tracking data in D1.
 */

import { describe, it, expect, vi } from 'vitest';
import { checkDuplicate, recordIssue, updateIssueStatus } from '../../src/dedup.js';
import type { Env, ErrorCluster } from '../../src/types.js';
import { REOPEN_THRESHOLD } from '../../src/types.js';

// ─────────────────────────────────────────────
// Test Fixtures
// ─────────────────────────────────────────────

function makeCluster(overrides: Partial<ErrorCluster> = {}): ErrorCluster {
  return {
    errorSignature: 'crypto:handshake_failed',
    category: 'crypto',
    totalCount: 30,
    versions: ['1.0.0'],
    platforms: ['android'],
    sampleMessages: ['Handshake failed'],
    sampleStackTraces: [],
    firstSeen: Date.now() - 3600000,
    lastSeen: Date.now() - 60000,
    ...overrides,
  };
}

// ─────────────────────────────────────────────
// Mock D1 helpers
// ─────────────────────────────────────────────

function makeMockDb(firstResult: Record<string, unknown> | null = null): {
  db: D1Database;
  runMock: ReturnType<typeof vi.fn>;
} {
  const runMock = vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } });

  const db = {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(firstResult),
      run: runMock,
      all: vi.fn().mockResolvedValue({ success: true, results: [] }),
    }),
  } as unknown as D1Database;

  return { db, runMock };
}

function makeEnv(
  firstResult: Record<string, unknown> | null = null,
): { env: Env; runMock: ReturnType<typeof vi.fn> } {
  const { db, runMock } = makeMockDb(firstResult);
  return {
    env: {
      DB: db,
      REPORTS_BUCKET: {} as R2Bucket,
      AI: {} as Ai,
      GITHUB_TOKEN: 'ghp_test',
      GITHUB_REPO: 'owner/repo',
    },
    runMock,
  };
}

// ─────────────────────────────────────────────
// checkDuplicate tests
// ─────────────────────────────────────────────

describe('checkDuplicate', () => {
  it('returns isDuplicate=false for brand new signature', async () => {
    const { env } = makeEnv(null);
    const cluster = makeCluster();

    const result = await checkDuplicate(env, cluster);

    expect(result.isDuplicate).toBe(false);
    expect(result.existingIssueNumber).toBeUndefined();
    expect(result.existingStatus).toBeUndefined();
  });

  it('returns isDuplicate=true for existing open issue', async () => {
    const { env } = makeEnv({
      github_issue_number: 42,
      status: 'open',
      total_occurrences: 20,
    });
    const cluster = makeCluster();

    const result = await checkDuplicate(env, cluster);

    expect(result.isDuplicate).toBe(true);
    expect(result.existingIssueNumber).toBe(42);
    expect(result.existingStatus).toBe('open');
  });

  it('returns isDuplicate=false for closed issue with significant new occurrences (reopen)', async () => {
    const previousCount = 20;
    const newCount = previousCount + REOPEN_THRESHOLD; // Exactly at threshold

    const { env } = makeEnv({
      github_issue_number: 55,
      status: 'closed',
      total_occurrences: previousCount,
    });
    const cluster = makeCluster({ totalCount: newCount });

    const result = await checkDuplicate(env, cluster);

    expect(result.isDuplicate).toBe(false);
    expect(result.existingIssueNumber).toBe(55);
    expect(result.existingStatus).toBe('closed');
  });

  it('returns isDuplicate=true for closed issue below reopen threshold', async () => {
    const previousCount = 20;
    const newCount = previousCount + REOPEN_THRESHOLD - 1; // Just below threshold

    const { env } = makeEnv({
      github_issue_number: 55,
      status: 'closed',
      total_occurrences: previousCount,
    });
    const cluster = makeCluster({ totalCount: newCount });

    const result = await checkDuplicate(env, cluster);

    expect(result.isDuplicate).toBe(true);
    expect(result.existingIssueNumber).toBe(55);
    expect(result.existingStatus).toBe('closed');
  });

  it('handles D1 query failure gracefully (fail open)', async () => {
    const env: Env = {
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockRejectedValue(new Error('D1 unavailable')),
        }),
      } as unknown as D1Database,
      REPORTS_BUCKET: {} as R2Bucket,
      AI: {} as Ai,
      GITHUB_TOKEN: 'ghp_test',
      GITHUB_REPO: 'owner/repo',
    };
    const cluster = makeCluster();

    const result = await checkDuplicate(env, cluster);

    // Fail open: treat as not duplicate (better to create than miss)
    expect(result.isDuplicate).toBe(false);
  });

  it('uses parameterized query with error_signature', async () => {
    const { env } = makeEnv(null);
    const cluster = makeCluster({ errorSignature: 'test:sig_123' });

    await checkDuplicate(env, cluster);

    const prepareMock = env.DB.prepare as ReturnType<typeof vi.fn>;
    expect(prepareMock).toHaveBeenCalledWith(
      expect.stringContaining('WHERE error_signature = ?'),
    );
  });

  it('handles row with null github_issue_number', async () => {
    const { env } = makeEnv({
      github_issue_number: null,
      status: 'open',
      total_occurrences: 5,
    });
    const cluster = makeCluster();

    const result = await checkDuplicate(env, cluster);

    expect(result.isDuplicate).toBe(true);
    expect(result.existingIssueNumber).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// recordIssue tests
// ─────────────────────────────────────────────

describe('recordIssue', () => {
  it('inserts new issue tracking record with parameterized query', async () => {
    const { env, runMock } = makeEnv();
    const cluster = makeCluster({ errorSignature: 'net:timeout' });

    await recordIssue(
      env,
      cluster,
      42,
      'https://github.com/owner/repo/issues/42',
      'high',
      'network',
      '{"severity":"high"}',
      'open',
    );

    expect(runMock).toHaveBeenCalledTimes(1);

    const prepareMock = env.DB.prepare as ReturnType<typeof vi.fn>;
    expect(prepareMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO issue_tracking'),
    );
    expect(prepareMock).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT(error_signature) DO UPDATE'),
    );
  });

  it('handles null issue number and URL (pending state)', async () => {
    const { env, runMock } = makeEnv();
    const cluster = makeCluster();

    await recordIssue(env, cluster, null, null, 'medium', 'crypto', null, 'pending');

    expect(runMock).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────
// updateIssueStatus tests
// ─────────────────────────────────────────────

describe('updateIssueStatus', () => {
  it('updates status, total_occurrences, and last_detected', async () => {
    const { env, runMock } = makeEnv();
    const now = Date.now();

    await updateIssueStatus(env, 'crypto:handshake_failed', 'open', 50, now);

    expect(runMock).toHaveBeenCalledTimes(1);

    const prepareMock = env.DB.prepare as ReturnType<typeof vi.fn>;
    expect(prepareMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE issue_tracking'),
    );
    expect(prepareMock).toHaveBeenCalledWith(
      expect.stringContaining('WHERE error_signature = ?'),
    );
  });
});
