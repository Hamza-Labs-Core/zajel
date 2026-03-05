/**
 * Unit tests for aggregateConnectionTypes
 *
 * Tests the scheduled aggregation that computes connection type
 * distribution from client_heartbeats into connection_type_history.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { aggregateConnectionTypes } from '../../src/aggregation.js';

/** Helper to create a mock D1Database with tracking */
function createMockDB(options: {
  runError?: Error;
} = {}) {
  const bindCalls: unknown[][] = [];
  const runCalls: number[] = [];
  let callIndex = 0;

  const db = {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockImplementation((...args: unknown[]) => {
        bindCalls.push(args);
        const idx = callIndex++;
        return {
          run: vi.fn().mockImplementation(() => {
            runCalls.push(idx);
            if (options.runError) {
              return Promise.reject(options.runError);
            }
            return Promise.resolve({ success: true, meta: {} });
          }),
        };
      }),
    }),
    bindCalls,
    runCalls,
  };

  return db;
}

describe('aggregateConnectionTypes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts connection type counts into history', async () => {
    const mock = createMockDB();
    const db = mock as unknown as D1Database;

    await aggregateConnectionTypes(db);

    // Should call prepare twice (insert + cleanup)
    expect(mock.runCalls).toHaveLength(2);
    expect((db as { prepare: ReturnType<typeof vi.fn> }).prepare).toHaveBeenCalledTimes(2);

    // First call: INSERT OR REPLACE with time_bucket and cutoff
    const insertArgs = mock.bindCalls[0]!;
    expect(insertArgs).toHaveLength(2);

    // time_bucket should be aligned to 5-minute boundary
    const timeBucket = insertArgs[0] as number;
    expect(timeBucket % 300000).toBe(0);

    // cutoff should be ~10 minutes before now
    const cutoff = insertArgs[1] as number;
    expect(Date.now() - cutoff).toBeGreaterThan(590000);
    expect(Date.now() - cutoff).toBeLessThan(610000);
  });

  it('handles null connection_type via COALESCE in the SQL query', async () => {
    const mock = createMockDB();
    const db = mock as unknown as D1Database;

    await aggregateConnectionTypes(db);

    // The SQL uses COALESCE(connection_type, 'none') which handles nulls
    // Verify the INSERT query was prepared (first prepare call)
    const prepareCall = (db as { prepare: ReturnType<typeof vi.fn> }).prepare;
    const firstQuery = prepareCall.mock.calls[0]![0] as string;
    expect(firstQuery).toContain('COALESCE(connection_type,');
    expect(firstQuery).toContain("'none'");
  });

  it('cleans up old data beyond 30 days', async () => {
    const mock = createMockDB();
    const db = mock as unknown as D1Database;

    await aggregateConnectionTypes(db);

    // Second call: DELETE with retention cutoff
    const deleteArgs = mock.bindCalls[1]!;
    expect(deleteArgs).toHaveLength(1);

    // Retention cutoff should be ~30 days ago
    const retentionCutoff = deleteArgs[0] as number;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const expectedCutoff = Date.now() - thirtyDaysMs;

    // Allow 1 second of drift
    expect(Math.abs(retentionCutoff - expectedCutoff)).toBeLessThan(1000);
  });

  it('handles empty heartbeats (no active clients)', async () => {
    // When there are no rows in client_heartbeats, the GROUP BY
    // returns 0 rows, and INSERT OR REPLACE does nothing.
    // This should not throw.
    const mock = createMockDB();
    const db = mock as unknown as D1Database;

    await expect(aggregateConnectionTypes(db)).resolves.toBeUndefined();

    // Both queries should still execute
    expect(mock.runCalls).toHaveLength(2);
  });

  it('handles D1 errors', async () => {
    const mock = createMockDB({ runError: new Error('D1_ERROR: database locked') });
    const db = mock as unknown as D1Database;

    await expect(aggregateConnectionTypes(db)).rejects.toThrow('D1_ERROR');
  });
});
