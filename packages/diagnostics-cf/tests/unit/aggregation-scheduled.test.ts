/**
 * Unit tests for scheduled version history aggregation.
 *
 * Tests aggregateVersionHistory which snapshots active client
 * version distribution from client_heartbeats into version_history.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { aggregateVersionHistory } from '../../src/aggregation-scheduled.js';

// ─────────────────────────────────────────────
// Mock D1 helpers
// ─────────────────────────────────────────────

class MockD1PreparedStatement {
  sql: string;
  boundValues: unknown[] = [];
  private _runResult: { success: boolean; meta: { changes: number } };

  constructor(sql: string, changes = 0) {
    this.sql = sql;
    this._runResult = { success: true, meta: { changes } };
  }

  bind(...values: unknown[]): MockD1PreparedStatement {
    this.boundValues = values;
    return this;
  }

  async run(): Promise<{ success: boolean; meta: { changes: number } }> {
    return this._runResult;
  }

  async first(): Promise<unknown> {
    return null;
  }

  async all(): Promise<{ success: boolean; results: unknown[] }> {
    return { success: true, results: [] };
  }
}

class MockD1Database {
  preparedStatements: MockD1PreparedStatement[] = [];
  private _changesByQuery: Map<string, number>;

  constructor(changesByQuery: Map<string, number> = new Map()) {
    this._changesByQuery = changesByQuery;
  }

  prepare(sql: string): MockD1PreparedStatement {
    let changes = 0;
    for (const [key, val] of this._changesByQuery) {
      if (sql.includes(key)) {
        changes = val;
        break;
      }
    }
    const stmt = new MockD1PreparedStatement(sql, changes);
    this.preparedStatements.push(stmt);
    return stmt;
  }
}

// ─────────────────────────────────────────────
// aggregateVersionHistory tests
// ─────────────────────────────────────────────

describe('aggregateVersionHistory', () => {
  it('inserts version counts from client_heartbeats', async () => {
    const changes = new Map<string, number>();
    changes.set('INSERT', 3);
    changes.set('DELETE', 0);

    const db = new MockD1Database(changes);
    const result = await aggregateVersionHistory(db as unknown as D1Database);

    expect(result.inserted).toBe(3);
    expect(db.preparedStatements).toHaveLength(2);

    // Verify the INSERT statement
    const insertStmt = db.preparedStatements[0]!;
    expect(insertStmt.sql).toContain('INSERT OR REPLACE INTO version_history');
    expect(insertStmt.sql).toContain('client_heartbeats');
    expect(insertStmt.sql).toContain('GROUP BY app_version');

    // Verify bind params: time_bucket (5-min aligned) and activeThreshold
    const timeBucket = insertStmt.boundValues[0] as number;
    expect(timeBucket % 300000).toBe(0); // 5-min aligned
    const activeThreshold = insertStmt.boundValues[1] as number;
    expect(timeBucket - activeThreshold).toBeGreaterThanOrEqual(0);
  });

  it('cleans up old data beyond 30 days', async () => {
    const changes = new Map<string, number>();
    changes.set('INSERT', 0);
    changes.set('DELETE', 5);

    const db = new MockD1Database(changes);
    const result = await aggregateVersionHistory(db as unknown as D1Database);

    expect(result.cleaned).toBe(5);

    // Verify the DELETE statement
    const deleteStmt = db.preparedStatements[1]!;
    expect(deleteStmt.sql).toContain('DELETE FROM version_history');
    expect(deleteStmt.sql).toContain('time_bucket <');

    // Verify cleanup threshold is approximately 30 days ago
    const cleanupThreshold = deleteStmt.boundValues[0] as number;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const diff = Date.now() - cleanupThreshold;
    // Allow 5 seconds of drift
    expect(diff).toBeGreaterThan(thirtyDaysMs - 5000);
    expect(diff).toBeLessThan(thirtyDaysMs + 5000);
  });

  it('handles empty heartbeats table', async () => {
    const changes = new Map<string, number>();
    changes.set('INSERT', 0);
    changes.set('DELETE', 0);

    const db = new MockD1Database(changes);
    const result = await aggregateVersionHistory(db as unknown as D1Database);

    expect(result.inserted).toBe(0);
    expect(result.cleaned).toBe(0);
  });

  it('handles D1 errors gracefully', async () => {
    const db = {
      prepare: vi.fn().mockImplementation(() => ({
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockRejectedValue(new Error('D1 unavailable')),
        all: vi.fn().mockRejectedValue(new Error('D1 unavailable')),
      })),
    } as unknown as D1Database;

    await expect(aggregateVersionHistory(db)).rejects.toThrow('D1 unavailable');
  });
});
