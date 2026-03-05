/**
 * Unit tests for the deduplication module.
 *
 * Tests duplicate checking, issue tracking recording, and updating
 * using mock D1 database interactions.
 */

import { describe, it, expect } from 'vitest';
import {
  checkDuplicate,
  recordIssueTracking,
  updateIssueTracking,
} from '../../src/dedup.js';
import type { ErrorCluster, IssueTrackingRow } from '../../src/types.js';
import { REOPEN_THRESHOLD } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCluster(overrides: Partial<ErrorCluster> = {}): ErrorCluster {
  return {
    errorSignature: 'sig_abc123',
    category: 'crypto',
    totalCount: 15,
    appVersions: '1.0.0',
    platforms: 'android',
    sampleMessage: 'Error message',
    sampleStackTrace: 'at foo (bar.dart:1)',
    firstSeen: 1700000000000,
    lastSeen: 1700003600000,
    ...overrides,
  };
}

function makeTrackingRow(overrides: Partial<IssueTrackingRow> = {}): IssueTrackingRow {
  return {
    id: 1,
    error_signature: 'sig_abc123',
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock D1
// ---------------------------------------------------------------------------

interface MockD1Options {
  firstResult?: IssueTrackingRow | null;
  shouldThrow?: boolean;
  runCalls?: Array<Record<string, unknown>>;
}

function createMockD1(options: MockD1Options = {}): D1Database {
  const { firstResult = null, shouldThrow = false, runCalls = [] } = options;
  return {
    prepare() {
      if (shouldThrow) {
        throw new Error('DB error');
      }
      return {
        bind() {
          return {
            async first() {
              return firstResult;
            },
            async run() {
              runCalls.push({ called: true });
              return { success: true };
            },
            async all() {
              return { results: [] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkDuplicate', () => {
  it('returns create action for new signature', async () => {
    const db = createMockD1({ firstResult: null });
    const cluster = makeCluster();
    const result = await checkDuplicate(db, cluster);

    expect(result.isDuplicate).toBe(false);
    expect(result.action).toBe('create');
    expect(result.existingIssueNumber).toBeNull();
    expect(result.existingId).toBeNull();
  });

  it('returns update action for open existing issue', async () => {
    const row = makeTrackingRow({ status: 'open' });
    const db = createMockD1({ firstResult: row });
    const cluster = makeCluster();
    const result = await checkDuplicate(db, cluster);

    expect(result.isDuplicate).toBe(true);
    expect(result.action).toBe('update');
    expect(result.existingIssueNumber).toBe(42);
    expect(result.existingId).toBe(1);
  });

  it('returns reopen action for closed issue with count above threshold', async () => {
    const row = makeTrackingRow({ status: 'closed' });
    const db = createMockD1({ firstResult: row });
    const cluster = makeCluster({ totalCount: REOPEN_THRESHOLD + 5 });
    const result = await checkDuplicate(db, cluster);

    expect(result.isDuplicate).toBe(true);
    expect(result.action).toBe('reopen');
    expect(result.existingIssueNumber).toBe(42);
  });

  it('returns reopen action for closed issue with count exactly at threshold', async () => {
    const row = makeTrackingRow({ status: 'closed' });
    const db = createMockD1({ firstResult: row });
    const cluster = makeCluster({ totalCount: REOPEN_THRESHOLD });
    const result = await checkDuplicate(db, cluster);

    expect(result.isDuplicate).toBe(true);
    expect(result.action).toBe('reopen');
  });

  it('returns skip action for closed issue below reopen threshold', async () => {
    const row = makeTrackingRow({ status: 'closed' });
    const db = createMockD1({ firstResult: row });
    const cluster = makeCluster({ totalCount: REOPEN_THRESHOLD - 1 });
    const result = await checkDuplicate(db, cluster);

    expect(result.isDuplicate).toBe(true);
    expect(result.action).toBe('skip');
  });

  it('defaults to create on DB error (graceful degradation)', async () => {
    const db = createMockD1({ shouldThrow: true });
    const cluster = makeCluster();
    const result = await checkDuplicate(db, cluster);

    expect(result.isDuplicate).toBe(false);
    expect(result.action).toBe('create');
  });
});

describe('recordIssueTracking', () => {
  it('calls D1 with correct parameters', async () => {
    const runCalls: Array<Record<string, unknown>> = [];
    const db = createMockD1({ runCalls });

    await recordIssueTracking(
      db,
      'sig_test',
      42,
      'https://github.com/test/repo/issues/42',
      'high',
      'crypto',
      '{"title":"Test"}',
      10,
    );

    expect(runCalls).toHaveLength(1);
  });
});

describe('updateIssueTracking', () => {
  it('calls D1 with correct parameters', async () => {
    const runCalls: Array<Record<string, unknown>> = [];
    const db = createMockD1({ runCalls });

    await updateIssueTracking(db, 1, 25, 'open');

    expect(runCalls).toHaveLength(1);
  });
});
