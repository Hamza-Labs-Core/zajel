/**
 * Unit tests for cleanup module.
 *
 * Tests that the cleanup function runs deletion queries for all configured
 * tables and returns correct results.
 */

import { describe, it, expect, vi } from 'vitest';
import { runCleanup } from '../../src/cleanup.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockD1(deletedCounts: Record<string, number> = {}) {
  let callIndex = 0;
  const deletedValues = Object.values(deletedCounts);

  return {
    prepare: vi.fn().mockImplementation(() => ({
      bind: vi.fn().mockImplementation(function () {
        const idx = callIndex++;
        const changes = deletedValues[idx] ?? 0;
        return {
          run: vi.fn().mockResolvedValue({
            success: true,
            meta: { changes },
          }),
        };
      }),
    })),
  } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runCleanup', () => {
  it('runs cleanup for all expected tables and returns results', async () => {
    const db = createMockD1({});
    const results = await runCleanup(db);

    // We expect 13 cleanup tasks
    expect(results.length).toBe(13);

    // Check table names are present
    const tables = results.map((r) => r.table);
    expect(tables).toContain('server_logs');
    expect(tables).toContain('app_logs');
    expect(tables).toContain('error_aggregates');
    expect(tables).toContain('client_heartbeats');
    expect(tables).toContain('security_events');
    expect(tables).toContain('alert_history');
    expect(tables).toContain('notifications');
    expect(tables).toContain('performance_aggregates');
    expect(tables).toContain('network_aggregates');
  });

  it('reports correct deleted counts', async () => {
    // Create a mock that returns different counts for each call
    let callIndex = 0;
    const counts = [5, 3, 1, 10, 2, 0, 7, 15, 4, 6, 8, 2, 1];
    const db = {
      prepare: vi.fn().mockImplementation(() => ({
        bind: vi.fn().mockImplementation(function () {
          const idx = callIndex++;
          return {
            run: vi.fn().mockResolvedValue({
              success: true,
              meta: { changes: counts[idx] ?? 0 },
            }),
          };
        }),
      })),
    } as unknown as D1Database;

    const results = await runCleanup(db);
    expect(results.length).toBe(13);

    // Verify the deleted counts match
    for (let i = 0; i < results.length; i++) {
      expect(results[i]!.deleted).toBe(counts[i]);
    }
  });

  it('has 3 server_logs cleanup tasks (by severity)', async () => {
    const db = createMockD1({});
    const results = await runCleanup(db);

    const serverLogTasks = results.filter((r) => r.table === 'server_logs');
    expect(serverLogTasks.length).toBe(3);
    expect(serverLogTasks[0]!.condition).toContain('debug');
    expect(serverLogTasks[1]!.condition).toContain('warn');
    expect(serverLogTasks[2]!.condition).toContain('error');
  });

  it('has 3 app_logs cleanup tasks (by severity)', async () => {
    const db = createMockD1({});
    const results = await runCleanup(db);

    const appLogTasks = results.filter((r) => r.table === 'app_logs');
    expect(appLogTasks.length).toBe(3);
    expect(appLogTasks[0]!.condition).toContain('debug');
    expect(appLogTasks[1]!.condition).toContain('warn');
    expect(appLogTasks[2]!.condition).toContain('error');
  });

  it('continues cleanup even if one table fails', async () => {
    let callIndex = 0;
    const db = {
      prepare: vi.fn().mockImplementation(() => ({
        bind: vi.fn().mockImplementation(function () {
          const idx = callIndex++;
          if (idx === 2) {
            // Third task fails
            return {
              run: vi.fn().mockRejectedValue(new Error('Table not found')),
            };
          }
          return {
            run: vi.fn().mockResolvedValue({
              success: true,
              meta: { changes: 1 },
            }),
          };
        }),
      })),
    } as unknown as D1Database;

    const results = await runCleanup(db);

    // All 13 tasks should have results
    expect(results.length).toBe(13);

    // The failed task should show 0 deleted
    expect(results[2]!.deleted).toBe(0);

    // Other tasks should show 1 deleted
    expect(results[0]!.deleted).toBe(1);
    expect(results[1]!.deleted).toBe(1);
    expect(results[3]!.deleted).toBe(1);
  });

  it('calls prepare on db for each task', async () => {
    const db = createMockD1({});
    await runCleanup(db);

    // 13 prepare calls
    expect((db as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare).toHaveBeenCalledTimes(13);
  });
});
