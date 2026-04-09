/**
 * Unit tests for D1 aggregation logic.
 *
 * Tests upsert operations: first insert, duplicate key update (count increment,
 * timestamp update), and percentile approximation math.
 *
 * Uses a mock D1Database that tracks prepared statements and their bindings
 * to verify the SQL operations without an actual D1 instance.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getTimeBucket,
  aggregateErrors,
  aggregatePerformance,
  aggregateNetwork,
  updateHeartbeat,
} from '../../src/aggregation.js';
import type { DiagnosticReport } from '../../src/types.js';

/**
 * Factory for a valid diagnostic report.
 */
function createReport(overrides: Partial<DiagnosticReport> = {}): DiagnosticReport {
  return {
    sessionHash: 'a'.repeat(64),
    appVersion: '1.2.3',
    buildNumber: '42',
    platform: 'android',
    platformVersion: 'Android 14',
    locale: 'en-US',
    timestamp: 1709380800000, // 2024-03-02T12:00:00.000Z
    ...overrides,
  };
}

/**
 * Mock D1 prepared statement.
 * Tracks bound values and records calls for assertions.
 */
class MockD1PreparedStatement {
  sql: string;
  boundValues: unknown[] = [];
  runCalled = false;

  constructor(sql: string) {
    this.sql = sql;
  }

  bind(...values: unknown[]): MockD1PreparedStatement {
    this.boundValues = values;
    return this;
  }

  async run(): Promise<D1Result> {
    this.runCalled = true;
    return {
      success: true,
      results: [],
      meta: {
        duration: 0,
        rows_read: 0,
        rows_written: 1,
        last_row_id: 1,
        changed_db: true,
        changes: 1,
        size_after: 0,
      },
    };
  }

  async first(): Promise<unknown> {
    return null;
  }

  async all(): Promise<D1Result> {
    return {
      success: true,
      results: [],
      meta: {
        duration: 0,
        rows_read: 0,
        rows_written: 0,
        last_row_id: 0,
        changed_db: false,
        changes: 0,
        size_after: 0,
      },
    };
  }

  async raw(): Promise<unknown[][]> {
    return [];
  }
}

/**
 * Mock D1Database.
 */
class MockD1Database {
  preparedStatements: MockD1PreparedStatement[] = [];
  batchStatements: MockD1PreparedStatement[][] = [];

  prepare(sql: string): MockD1PreparedStatement {
    const stmt = new MockD1PreparedStatement(sql);
    this.preparedStatements.push(stmt);
    return stmt;
  }

  async batch(statements: MockD1PreparedStatement[]): Promise<D1Result[]> {
    this.batchStatements.push(statements);
    return statements.map(() => ({
      success: true,
      results: [],
      meta: {
        duration: 0,
        rows_read: 0,
        rows_written: 1,
        last_row_id: 1,
        changed_db: true,
        changes: 1,
        size_after: 0,
      },
    }));
  }
}

describe('getTimeBucket', () => {
  it('should truncate to the hour', () => {
    // 2024-03-02T12:34:56.789Z -> 2024-03-02T12:00:00Z
    const bucket = getTimeBucket(1709383696789);
    expect(bucket).toBe('2024-03-02T12:00:00Z');
  });

  it('should handle exact hour timestamps', () => {
    // 2024-03-02T12:00:00.000Z
    const bucket = getTimeBucket(1709380800000);
    expect(bucket).toBe('2024-03-02T12:00:00Z');
  });

  it('should handle midnight', () => {
    // 2024-03-02T00:00:00.000Z
    const bucket = getTimeBucket(1709337600000);
    expect(bucket).toBe('2024-03-02T00:00:00Z');
  });

  it('should handle end of day', () => {
    // 2024-03-02T23:59:59.999Z
    const bucket = getTimeBucket(1709423999999);
    expect(bucket).toBe('2024-03-02T23:00:00Z');
  });
});

describe('aggregateErrors', () => {
  let db: MockD1Database;

  beforeEach(() => {
    db = new MockD1Database();
  });

  it('should skip aggregation when no errors present', async () => {
    const report = createReport();
    await aggregateErrors(db as unknown as D1Database, report);
    expect(db.batchStatements).toHaveLength(0);
    expect(db.preparedStatements).toHaveLength(0);
  });

  it('should skip aggregation when errors array is empty', async () => {
    const report = createReport({ errors: [] });
    await aggregateErrors(db as unknown as D1Database, report);
    expect(db.batchStatements).toHaveLength(0);
  });

  it('should create upsert statements for each error', async () => {
    const report = createReport({
      errors: [
        {
          category: 'crypto',
          message: 'decrypt failed',
          signature: 'sig1',
          count: 3,
          firstOccurrence: 1709380700000,
          lastOccurrence: 1709380800000,
          stackTrace: 'at line 42',
        },
        {
          category: 'network',
          message: 'connection timeout',
          signature: 'sig2',
          count: 1,
          firstOccurrence: 1709380750000,
          lastOccurrence: 1709380750000,
        },
      ],
    });

    await aggregateErrors(db as unknown as D1Database, report);

    // Should batch all statements together
    expect(db.batchStatements).toHaveLength(1);
    expect(db.batchStatements[0]).toHaveLength(2);

    // Verify first error statement
    const stmt1 = db.batchStatements[0]![0]!;
    expect(stmt1.sql).toContain('INSERT INTO error_aggregates');
    expect(stmt1.sql).toContain('ON CONFLICT');
    expect(stmt1.boundValues[0]).toBe('2024-03-02T12:00:00Z'); // time_bucket
    expect(stmt1.boundValues[1]).toBe('sig1'); // error_signature
    expect(stmt1.boundValues[2]).toBe('crypto'); // category
    expect(stmt1.boundValues[3]).toBe('1.2.3'); // app_version
    expect(stmt1.boundValues[4]).toBe('android'); // platform
    expect(stmt1.boundValues[5]).toBe('production'); // environment
    expect(stmt1.boundValues[6]).toBe(3); // count
    expect(stmt1.boundValues[7]).toBe(1709380700000); // first_seen
    expect(stmt1.boundValues[8]).toBe(1709380800000); // last_seen
    expect(stmt1.boundValues[9]).toBe('decrypt failed'); // sample_message
    expect(stmt1.boundValues[10]).toBe('at line 42'); // sample_stack_trace

    // Verify second error statement
    const stmt2 = db.batchStatements[0]![1]!;
    expect(stmt2.boundValues[1]).toBe('sig2');
    expect(stmt2.boundValues[2]).toBe('network');
    expect(stmt2.boundValues[10]).toBeNull(); // no stackTrace
  });

  it('should use ON CONFLICT DO UPDATE for count and timestamps', async () => {
    const report = createReport({
      errors: [
        {
          category: 'crash',
          message: 'crash!',
          signature: 'crash-sig',
          count: 5,
          firstOccurrence: 1000,
          lastOccurrence: 2000,
        },
      ],
    });

    await aggregateErrors(db as unknown as D1Database, report);

    const sql = db.batchStatements[0]![0]!.sql;
    expect(sql).toContain('count = count + excluded.count');
    expect(sql).toContain('first_seen = MIN(first_seen, excluded.first_seen)');
    expect(sql).toContain('last_seen = MAX(last_seen, excluded.last_seen)');
  });
});

describe('aggregatePerformance', () => {
  let db: MockD1Database;

  beforeEach(() => {
    db = new MockD1Database();
  });

  it('should skip when no performance data', async () => {
    const report = createReport();
    await aggregatePerformance(db as unknown as D1Database, report);
    expect(db.batchStatements).toHaveLength(0);
  });

  it('should create a statement for each defined metric', async () => {
    const report = createReport({
      performance: {
        startupTimeMs: 1200,
        frameRateAvg: 58.5,
      },
    });

    await aggregatePerformance(db as unknown as D1Database, report);

    expect(db.batchStatements).toHaveLength(1);
    expect(db.batchStatements[0]).toHaveLength(2);

    // Verify startupTimeMs
    const stmt1 = db.batchStatements[0]![0]!;
    expect(stmt1.sql).toContain('INSERT INTO performance_aggregates');
    expect(stmt1.boundValues[0]).toBe('2024-03-02T12:00:00Z'); // time_bucket
    expect(stmt1.boundValues[1]).toBe('android'); // platform
    expect(stmt1.boundValues[2]).toBe('1.2.3'); // app_version
    expect(stmt1.boundValues[3]).toBe('startupTimeMs'); // metric_name
    expect(stmt1.boundValues[4]).toBe(1200); // p50
    expect(stmt1.boundValues[5]).toBe(1200); // p95
    expect(stmt1.boundValues[6]).toBe(1200); // p99

    // Verify frameRateAvg
    const stmt2 = db.batchStatements[0]![1]!;
    expect(stmt2.boundValues[3]).toBe('frameRateAvg');
    expect(stmt2.boundValues[4]).toBe(58.5);
  });

  it('should skip undefined metrics', async () => {
    const report = createReport({
      performance: {
        startupTimeMs: 1200,
        // other metrics undefined
      },
    });

    await aggregatePerformance(db as unknown as D1Database, report);

    expect(db.batchStatements).toHaveLength(1);
    expect(db.batchStatements[0]).toHaveLength(1);
  });

  it('should use weighted average in ON CONFLICT UPDATE for percentiles', async () => {
    const report = createReport({
      performance: { startupTimeMs: 1000 },
    });

    await aggregatePerformance(db as unknown as D1Database, report);

    const sql = db.batchStatements[0]![0]!.sql;
    expect(sql).toContain('p50 = (p50 * sample_count + excluded.p50) / (sample_count + 1)');
    expect(sql).toContain('sample_count = sample_count + 1');
  });

  it('should not batch when all metrics are undefined', async () => {
    const report = createReport({
      performance: {},
    });

    await aggregatePerformance(db as unknown as D1Database, report);

    expect(db.batchStatements).toHaveLength(0);
  });
});

describe('aggregateNetwork', () => {
  let db: MockD1Database;

  beforeEach(() => {
    db = new MockD1Database();
  });

  it('should skip when no network data', async () => {
    const report = createReport();
    await aggregateNetwork(db as unknown as D1Database, report);
    expect(db.preparedStatements).toHaveLength(0);
  });

  it('should convert rates to counts correctly', async () => {
    const report = createReport({
      network: {
        signalingConnectSuccessRate: 0.8,
        signalingConnectAttempts: 10,
        webrtcEstablishSuccessRate: 0.5,
        webrtcEstablishAttempts: 6,
        relayUsageRate: 0.3,
        avgLatencyMs: 45.5,
      },
      connectionType: 'direct_p2p',
    });

    await aggregateNetwork(db as unknown as D1Database, report);

    expect(db.preparedStatements).toHaveLength(1);
    const stmt = db.preparedStatements[0]!;
    expect(stmt.sql).toContain('INSERT INTO network_aggregates');
    expect(stmt.boundValues[0]).toBe('2024-03-02T12:00:00Z'); // time_bucket
    expect(stmt.boundValues[1]).toBe('android'); // platform
    expect(stmt.boundValues[2]).toBe('1.2.3'); // app_version
    expect(stmt.boundValues[3]).toBe(8);  // signaling_success = round(10 * 0.8)
    expect(stmt.boundValues[4]).toBe(2);  // signaling_failure = 10 - 8
    expect(stmt.boundValues[5]).toBe(3);  // webrtc_success = round(6 * 0.5)
    expect(stmt.boundValues[6]).toBe(3);  // webrtc_failure = 6 - 3
    expect(stmt.boundValues[7]).toBe(1);  // relay_usage (rate > 0)
    expect(stmt.boundValues[8]).toBe(1);  // direct_p2p (connectionType === 'direct_p2p')
    expect(stmt.boundValues[9]).toBe(45.5); // avg_latency_ms
    expect(stmt.runCalled).toBe(true);
  });

  it('should default to zero counts when rates/attempts not provided', async () => {
    const report = createReport({
      network: {},
    });

    await aggregateNetwork(db as unknown as D1Database, report);

    const stmt = db.preparedStatements[0]!;
    expect(stmt.boundValues[3]).toBe(0); // signaling_success
    expect(stmt.boundValues[4]).toBe(0); // signaling_failure
    expect(stmt.boundValues[5]).toBe(0); // webrtc_success
    expect(stmt.boundValues[6]).toBe(0); // webrtc_failure
    expect(stmt.boundValues[7]).toBe(0); // relay_usage
    expect(stmt.boundValues[8]).toBe(0); // direct_p2p
    expect(stmt.boundValues[9]).toBeNull(); // avg_latency_ms
  });

  it('should use ON CONFLICT to increment counts', async () => {
    const report = createReport({
      network: { avgLatencyMs: 10 },
    });

    await aggregateNetwork(db as unknown as D1Database, report);

    const sql = db.preparedStatements[0]!.sql;
    expect(sql).toContain('signaling_success_count = signaling_success_count + excluded.signaling_success_count');
    expect(sql).toContain('sample_count = sample_count + 1');
  });
});

describe('updateHeartbeat', () => {
  let db: MockD1Database;

  beforeEach(() => {
    db = new MockD1Database();
  });

  it('should upsert client heartbeat record', async () => {
    const report = createReport({
      connectionType: 'direct_p2p',
    });

    await updateHeartbeat(db as unknown as D1Database, report);

    expect(db.preparedStatements).toHaveLength(1);
    const stmt = db.preparedStatements[0]!;
    expect(stmt.sql).toContain('INSERT INTO client_heartbeats');
    expect(stmt.sql).toContain('ON CONFLICT(session_hash)');
    expect(stmt.boundValues[0]).toBe('a'.repeat(64)); // session_hash
    expect(stmt.boundValues[1]).toBe('android'); // platform
    expect(stmt.boundValues[2]).toBe('1.2.3'); // app_version
    expect(stmt.boundValues[3]).toBe('direct_p2p'); // connection_type
    expect(stmt.boundValues[4]).toBe(1709380800000); // last_seen (and session_start)
    expect(stmt.runCalled).toBe(true);
  });

  it('should set null connection_type when not provided', async () => {
    const report = createReport();
    await updateHeartbeat(db as unknown as D1Database, report);

    const stmt = db.preparedStatements[0]!;
    expect(stmt.boundValues[3]).toBeNull();
  });

  it('should update last_seen on conflict', async () => {
    const report = createReport();
    await updateHeartbeat(db as unknown as D1Database, report);

    const sql = db.preparedStatements[0]!.sql;
    expect(sql).toContain('last_seen = excluded.last_seen');
  });
});
