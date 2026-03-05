/**
 * Unit tests for the Alert Engine
 *
 * Tests condition evaluators, cooldown logic, default rule seeding,
 * and the main evaluateAlertRules orchestrator.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluateAlertRules, seedDefaultRules } from '../../src/alert-engine.js';
import type { Env, AlertRule } from '../../src/types.js';

// ─── Mock D1 ────────────────────────────────────────────────

interface MockRow {
  [key: string]: unknown;
}

/**
 * Creates a mock D1Database with per-query result routing.
 * queryResults maps a substring of the SQL query to the result rows.
 */
function createMockD1(queryResults: Record<string, MockRow[]> = {}) {
  let lastInsertId = 0;

  const mockPrepare = vi.fn((query: string) => {
    // Find matching result based on query substring
    let matchedRows: MockRow[] = [];
    for (const [pattern, rows] of Object.entries(queryResults)) {
      if (query.includes(pattern)) {
        matchedRows = rows;
        break;
      }
    }

    const stmtObj = {
      bind: vi.fn((..._args: unknown[]) => stmtObj),
      first: vi.fn(async () => matchedRows[0] ?? null),
      all: vi.fn(async () => ({
        results: matchedRows,
        success: true,
      })),
      run: vi.fn(async () => {
        lastInsertId++;
        return {
          meta: { last_row_id: lastInsertId, changes: 1 },
          success: true,
        };
      }),
    };

    return stmtObj;
  });

  const mockBatch = vi.fn(async (stmts: Array<{ all: () => Promise<unknown> }>) => {
    return Promise.all(stmts.map((s) => s.all()));
  });

  return {
    prepare: mockPrepare,
    batch: mockBatch,
    _getLastInsertId: () => lastInsertId,
  };
}

// ─── Mock KV ────────────────────────────────────────────────

function createMockKV(initialData: Record<string, string> = {}) {
  const store = new Map(Object.entries(initialData));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    _store: store,
  };
}

// ─── Mock Env Builder ───────────────────────────────────────

function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    ADMIN_USERS: {} as DurableObjectNamespace,
    ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    ...overrides,
  } as Env;
}

// ─── Helper: create an AlertRule row ────────────────────────

function makeRule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 1,
    name: 'Test Rule',
    condition_type: 'error_rate',
    threshold_value: 100,
    threshold_unit: 'per_hour',
    severity: 'warning',
    channels: JSON.stringify(['dashboard']),
    enabled: 1,
    cooldown_minutes: 60,
    is_default: 0,
    created_by: 'system',
    created_at: Date.now() - 86400000,
    last_triggered_at: null,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────

describe('Alert Engine', () => {

  // ─── seedDefaultRules ─────────────────────────────────────

  describe('seedDefaultRules', () => {
    it('seeds 6 default rules when table is empty', async () => {
      const db = createMockD1({
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [],
      });

      await seedDefaultRules(db as unknown as D1Database);

      // Should have called batch once with INSERT statements
      expect(db.batch).toHaveBeenCalledTimes(1);
      const batchArgs = db.batch.mock.calls[0]![0] as unknown[];
      expect(batchArgs.length).toBe(6);
    });

    it('does not insert duplicates when all defaults exist', async () => {
      const db = createMockD1({
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [
          { condition_type: 'error_rate' },
          { condition_type: 'error_rate_spike' },
          { condition_type: 'server_offline' },
          { condition_type: 'new_critical_crash' },
          { condition_type: 'rate_limit_violations' },
          { condition_type: 'ai_issue' },
        ],
      });

      await seedDefaultRules(db as unknown as D1Database);

      // batch should NOT have been called since there are no missing rules
      expect(db.batch).not.toHaveBeenCalled();
    });

    it('seeds only missing default rules', async () => {
      const db = createMockD1({
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [
          { condition_type: 'error_rate' },
          { condition_type: 'server_offline' },
        ],
      });

      await seedDefaultRules(db as unknown as D1Database);

      expect(db.batch).toHaveBeenCalledTimes(1);
      const batchArgs = db.batch.mock.calls[0]![0] as unknown[];
      // 6 total - 2 existing = 4 to insert
      expect(batchArgs.length).toBe(4);
    });

    it('handles D1 errors gracefully', async () => {
      const db = createMockD1();
      db.prepare = vi.fn(() => { throw new Error('D1 connection failed'); });

      // Should not throw
      await expect(seedDefaultRules(db as unknown as D1Database)).resolves.not.toThrow();
    });
  });

  // ─── evaluateAlertRules (main orchestrator) ───────────────

  describe('evaluateAlertRules', () => {
    it('returns empty array when no DIAGNOSTICS_DB', async () => {
      const env = createMockEnv();
      const results = await evaluateAlertRules(env);
      expect(results).toEqual([]);
    });

    it('evaluates error_rate rule and fires when threshold exceeded', async () => {
      const rule = makeRule({
        id: 1,
        condition_type: 'error_rate',
        threshold_value: 100,
        threshold_unit: 'per_hour',
      });

      const db = createMockD1({
        // seedDefaultRules query - all defaults already exist
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [
          { condition_type: 'error_rate' },
          { condition_type: 'error_rate_spike' },
          { condition_type: 'server_offline' },
          { condition_type: 'new_critical_crash' },
          { condition_type: 'rate_limit_violations' },
          { condition_type: 'ai_issue' },
        ],
        // loadEnabledRules query
        'SELECT * FROM alert_rules WHERE enabled = 1': [rule],
        // evaluateErrorRate query
        'SUM(count)': [{ total: 150 }],
      });

      const kv = createMockKV();
      const env = createMockEnv({
        DIAGNOSTICS_DB: db as unknown as D1Database,
        ADMIN_KV: kv as unknown as KVNamespace,
      });

      const results = await evaluateAlertRules(env);
      expect(results.length).toBe(1);
      expect(results[0]!.ruleId).toBe(1);
      expect(results[0]!.severity).toBe('warning');
      expect(results[0]!.message).toContain('150');
      expect(results[0]!.message).toContain('Error rate exceeded');
    });

    it('does not fire error_rate rule when below threshold', async () => {
      const rule = makeRule({
        id: 1,
        condition_type: 'error_rate',
        threshold_value: 100,
      });

      const db = createMockD1({
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [
          { condition_type: 'error_rate' },
          { condition_type: 'error_rate_spike' },
          { condition_type: 'server_offline' },
          { condition_type: 'new_critical_crash' },
          { condition_type: 'rate_limit_violations' },
          { condition_type: 'ai_issue' },
        ],
        'SELECT * FROM alert_rules WHERE enabled = 1': [rule],
        'SUM(count)': [{ total: 50 }],
      });

      const env = createMockEnv({
        DIAGNOSTICS_DB: db as unknown as D1Database,
      });

      const results = await evaluateAlertRules(env);
      expect(results.length).toBe(0);
    });

    it('respects cooldown period', async () => {
      const rule = makeRule({
        id: 1,
        condition_type: 'error_rate',
        threshold_value: 100,
        cooldown_minutes: 60,
        // Fired 30 minutes ago — still in cooldown
        last_triggered_at: Date.now() - 30 * 60 * 1000,
      });

      const db = createMockD1({
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [
          { condition_type: 'error_rate' },
          { condition_type: 'error_rate_spike' },
          { condition_type: 'server_offline' },
          { condition_type: 'new_critical_crash' },
          { condition_type: 'rate_limit_violations' },
          { condition_type: 'ai_issue' },
        ],
        'SELECT * FROM alert_rules WHERE enabled = 1': [rule],
        'SUM(count)': [{ total: 500 }],
      });

      const env = createMockEnv({
        DIAGNOSTICS_DB: db as unknown as D1Database,
      });

      const results = await evaluateAlertRules(env);
      // Should not fire because cooldown hasn't expired
      expect(results.length).toBe(0);
    });

    it('fires after cooldown expires', async () => {
      const rule = makeRule({
        id: 1,
        condition_type: 'error_rate',
        threshold_value: 100,
        cooldown_minutes: 60,
        // Fired 90 minutes ago — cooldown expired
        last_triggered_at: Date.now() - 90 * 60 * 1000,
      });

      const db = createMockD1({
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [
          { condition_type: 'error_rate' },
          { condition_type: 'error_rate_spike' },
          { condition_type: 'server_offline' },
          { condition_type: 'new_critical_crash' },
          { condition_type: 'rate_limit_violations' },
          { condition_type: 'ai_issue' },
        ],
        'SELECT * FROM alert_rules WHERE enabled = 1': [rule],
        'SUM(count)': [{ total: 150 }],
      });

      const kv = createMockKV();
      const env = createMockEnv({
        DIAGNOSTICS_DB: db as unknown as D1Database,
        ADMIN_KV: kv as unknown as KVNamespace,
      });

      const results = await evaluateAlertRules(env);
      expect(results.length).toBe(1);
    });

    it('skips non-poll condition types (attack_detected)', async () => {
      const rule = makeRule({
        id: 1,
        condition_type: 'attack_detected',
      });

      const db = createMockD1({
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [
          { condition_type: 'error_rate' },
          { condition_type: 'error_rate_spike' },
          { condition_type: 'server_offline' },
          { condition_type: 'new_critical_crash' },
          { condition_type: 'rate_limit_violations' },
          { condition_type: 'ai_issue' },
        ],
        'SELECT * FROM alert_rules WHERE enabled = 1': [rule],
      });

      const env = createMockEnv({
        DIAGNOSTICS_DB: db as unknown as D1Database,
      });

      const results = await evaluateAlertRules(env);
      expect(results.length).toBe(0);
    });

    it('uses KV cache for rules when available', async () => {
      const rule = makeRule({
        id: 1,
        condition_type: 'error_rate',
        threshold_value: 100,
      });

      const db = createMockD1({
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [
          { condition_type: 'error_rate' },
          { condition_type: 'error_rate_spike' },
          { condition_type: 'server_offline' },
          { condition_type: 'new_critical_crash' },
          { condition_type: 'rate_limit_violations' },
          { condition_type: 'ai_issue' },
        ],
        'SUM(count)': [{ total: 50 }],
      });

      const kv = createMockKV({
        alert_rules_cache: JSON.stringify([rule]),
      });

      const env = createMockEnv({
        DIAGNOSTICS_DB: db as unknown as D1Database,
        ADMIN_KV: kv as unknown as KVNamespace,
      });

      const results = await evaluateAlertRules(env);
      // Should have used KV cache, so the D1 "SELECT * FROM alert_rules" prepare
      // should NOT have been called with the enabled query
      expect(kv.get).toHaveBeenCalledWith('alert_rules_cache', 'text');
      expect(results.length).toBe(0); // 50 < 100 threshold
    });
  });

  // ─── Error rate spike evaluator ───────────────────────────

  describe('error_rate_spike evaluator', () => {
    it('fires when current rate exceeds 3x the 24h average', async () => {
      const rule = makeRule({
        id: 2,
        condition_type: 'error_rate_spike',
        threshold_value: 3,
        threshold_unit: 'multiplier',
      });

      // The spike evaluator excludes the current hour from the 24h average (23 hours).
      // 23-hour total = 2300, avg = 2300/23 = 100/hr
      // Current hour = 300, ratio = 300/100 = 3.0x => triggers at threshold 3
      let sumCallCount = 0;
      const db = createMockD1({
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [
          { condition_type: 'error_rate' },
          { condition_type: 'error_rate_spike' },
          { condition_type: 'server_offline' },
          { condition_type: 'new_critical_crash' },
          { condition_type: 'rate_limit_violations' },
          { condition_type: 'ai_issue' },
        ],
        'SELECT * FROM alert_rules WHERE enabled = 1': [rule],
      });

      // Override prepare to handle the two SUM(count) calls differently
      const originalPrepare = db.prepare;
      db.prepare = vi.fn((query: string) => {
        if (query.includes('SUM(count)')) {
          sumCallCount++;
          const result = sumCallCount === 1
            ? [{ total: 300 }]  // current hour
            : [{ total: 2300 }]; // 23 hours excluding current (avg = 100/hr)
          const stmtObj = {
            bind: vi.fn((..._args: unknown[]) => stmtObj),
            first: vi.fn(async () => result[0] ?? null),
            all: vi.fn(async () => ({ results: result, success: true })),
            run: vi.fn(async () => ({ meta: { last_row_id: 0, changes: 0 }, success: true })),
          };
          return stmtObj;
        }
        return originalPrepare(query);
      });

      const kv = createMockKV();
      const env = createMockEnv({
        DIAGNOSTICS_DB: db as unknown as D1Database,
        ADMIN_KV: kv as unknown as KVNamespace,
      });

      const results = await evaluateAlertRules(env);
      expect(results.length).toBe(1);
      expect(results[0]!.message).toContain('spike');
      expect(results[0]!.message).toContain('3.0x');
    });

    it('does not fire when rate is below spike threshold', async () => {
      const rule = makeRule({
        id: 2,
        condition_type: 'error_rate_spike',
        threshold_value: 3,
        threshold_unit: 'multiplier',
      });

      let sumCallCount = 0;
      const db = createMockD1({
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [
          { condition_type: 'error_rate' },
          { condition_type: 'error_rate_spike' },
          { condition_type: 'server_offline' },
          { condition_type: 'new_critical_crash' },
          { condition_type: 'rate_limit_violations' },
          { condition_type: 'ai_issue' },
        ],
        'SELECT * FROM alert_rules WHERE enabled = 1': [rule],
      });

      const originalPrepare = db.prepare;
      db.prepare = vi.fn((query: string) => {
        if (query.includes('SUM(count)')) {
          sumCallCount++;
          const result = sumCallCount === 1
            ? [{ total: 200 }]  // current hour
            : [{ total: 2400 }]; // last 24 hours (avg = 100/hr, ratio = 2x < 3x)
          const stmtObj = {
            bind: vi.fn((..._args: unknown[]) => stmtObj),
            first: vi.fn(async () => result[0] ?? null),
            all: vi.fn(async () => ({ results: result, success: true })),
            run: vi.fn(async () => ({ meta: { last_row_id: 0, changes: 0 }, success: true })),
          };
          return stmtObj;
        }
        return originalPrepare(query);
      });

      const env = createMockEnv({
        DIAGNOSTICS_DB: db as unknown as D1Database,
      });

      const results = await evaluateAlertRules(env);
      expect(results.length).toBe(0);
    });
  });

  // ─── Server offline evaluator ─────────────────────────────

  describe('server_offline evaluator', () => {
    it('fires when a server is offline beyond threshold', async () => {
      const rule = makeRule({
        id: 3,
        condition_type: 'server_offline',
        threshold_value: 5,
        threshold_unit: 'minutes',
      });

      const db = createMockD1({
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [
          { condition_type: 'error_rate' },
          { condition_type: 'error_rate_spike' },
          { condition_type: 'server_offline' },
          { condition_type: 'new_critical_crash' },
          { condition_type: 'rate_limit_violations' },
          { condition_type: 'ai_issue' },
        ],
        'SELECT * FROM alert_rules WHERE enabled = 1': [rule],
      });

      // Mock BOOTSTRAP_SERVICE to return a server with old heartbeat
      const mockBootstrap = {
        fetch: vi.fn(async () => new Response(JSON.stringify({
          servers: [
            { serverId: 'srv-01', endpoint: 'https://srv1.test', lastSeen: Date.now() - 10 * 60 * 1000 },
            { serverId: 'srv-02', endpoint: 'https://srv2.test', lastSeen: Date.now() },
          ],
        }), { status: 200 })),
      };

      const kv = createMockKV();
      const env = createMockEnv({
        DIAGNOSTICS_DB: db as unknown as D1Database,
        BOOTSTRAP_SERVICE: mockBootstrap as unknown as Env['BOOTSTRAP_SERVICE'],
        ADMIN_KV: kv as unknown as KVNamespace,
      });

      const results = await evaluateAlertRules(env);
      expect(results.length).toBe(1);
      expect(results[0]!.message).toContain('srv-01');
      expect(results[0]!.message).toContain('offline');
    });

    it('does not fire when all servers are online', async () => {
      const rule = makeRule({
        id: 3,
        condition_type: 'server_offline',
        threshold_value: 5,
        threshold_unit: 'minutes',
      });

      const db = createMockD1({
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [
          { condition_type: 'error_rate' },
          { condition_type: 'error_rate_spike' },
          { condition_type: 'server_offline' },
          { condition_type: 'new_critical_crash' },
          { condition_type: 'rate_limit_violations' },
          { condition_type: 'ai_issue' },
        ],
        'SELECT * FROM alert_rules WHERE enabled = 1': [rule],
      });

      const mockBootstrap = {
        fetch: vi.fn(async () => new Response(JSON.stringify({
          servers: [
            { serverId: 'srv-01', lastSeen: Date.now() },
          ],
        }), { status: 200 })),
      };

      const env = createMockEnv({
        DIAGNOSTICS_DB: db as unknown as D1Database,
        BOOTSTRAP_SERVICE: mockBootstrap as unknown as Env['BOOTSTRAP_SERVICE'],
      });

      const results = await evaluateAlertRules(env);
      expect(results.length).toBe(0);
    });
  });

  // ─── High latency evaluator ───────────────────────────────

  describe('high_latency evaluator', () => {
    it('fires when p95 latency exceeds threshold', async () => {
      const rule = makeRule({
        id: 4,
        condition_type: 'high_latency',
        threshold_value: 5000,
        threshold_unit: 'ms',
      });

      const db = createMockD1({
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [
          { condition_type: 'error_rate' },
          { condition_type: 'error_rate_spike' },
          { condition_type: 'server_offline' },
          { condition_type: 'new_critical_crash' },
          { condition_type: 'rate_limit_violations' },
          { condition_type: 'ai_issue' },
        ],
        'SELECT * FROM alert_rules WHERE enabled = 1': [rule],
        'MAX(p95)': [{ p95_max: 7500 }],
        'MAX(avg_latency_ms)': [{ max_latency: 3000 }],
      });

      const kv = createMockKV();
      const env = createMockEnv({
        DIAGNOSTICS_DB: db as unknown as D1Database,
        ADMIN_KV: kv as unknown as KVNamespace,
      });

      const results = await evaluateAlertRules(env);
      expect(results.length).toBe(1);
      expect(results[0]!.message).toContain('High latency');
      expect(results[0]!.message).toContain('7500');
    });

    it('does not fire when latency is below threshold', async () => {
      const rule = makeRule({
        id: 4,
        condition_type: 'high_latency',
        threshold_value: 5000,
        threshold_unit: 'ms',
      });

      const db = createMockD1({
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [
          { condition_type: 'error_rate' },
          { condition_type: 'error_rate_spike' },
          { condition_type: 'server_offline' },
          { condition_type: 'new_critical_crash' },
          { condition_type: 'rate_limit_violations' },
          { condition_type: 'ai_issue' },
        ],
        'SELECT * FROM alert_rules WHERE enabled = 1': [rule],
        'MAX(p95)': [{ p95_max: 2000 }],
        'MAX(avg_latency_ms)': [{ max_latency: 1500 }],
      });

      const env = createMockEnv({
        DIAGNOSTICS_DB: db as unknown as D1Database,
      });

      const results = await evaluateAlertRules(env);
      expect(results.length).toBe(0);
    });
  });

  // ─── Low success rate evaluator ───────────────────────────

  describe('low_success_rate evaluator', () => {
    it('fires when signaling success rate is below threshold', async () => {
      const rule = makeRule({
        id: 5,
        condition_type: 'low_success_rate',
        threshold_value: 90,
        threshold_unit: 'percent',
      });

      const db = createMockD1({
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [
          { condition_type: 'error_rate' },
          { condition_type: 'error_rate_spike' },
          { condition_type: 'server_offline' },
          { condition_type: 'new_critical_crash' },
          { condition_type: 'rate_limit_violations' },
          { condition_type: 'ai_issue' },
        ],
        'SELECT * FROM alert_rules WHERE enabled = 1': [rule],
        'signaling_success_count': [{
          sig_success: 70,
          sig_failure: 30,
          webrtc_success: 95,
          webrtc_failure: 5,
        }],
      });

      const kv = createMockKV();
      const env = createMockEnv({
        DIAGNOSTICS_DB: db as unknown as D1Database,
        ADMIN_KV: kv as unknown as KVNamespace,
      });

      const results = await evaluateAlertRules(env);
      expect(results.length).toBe(1);
      expect(results[0]!.message).toContain('signaling success rate');
      expect(results[0]!.message).toContain('70.0%');
    });

    it('fires when WebRTC success rate is below threshold', async () => {
      const rule = makeRule({
        id: 5,
        condition_type: 'low_success_rate',
        threshold_value: 90,
        threshold_unit: 'percent',
      });

      const db = createMockD1({
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [
          { condition_type: 'error_rate' },
          { condition_type: 'error_rate_spike' },
          { condition_type: 'server_offline' },
          { condition_type: 'new_critical_crash' },
          { condition_type: 'rate_limit_violations' },
          { condition_type: 'ai_issue' },
        ],
        'SELECT * FROM alert_rules WHERE enabled = 1': [rule],
        'signaling_success_count': [{
          sig_success: 95,
          sig_failure: 5,
          webrtc_success: 50,
          webrtc_failure: 50,
        }],
      });

      const kv = createMockKV();
      const env = createMockEnv({
        DIAGNOSTICS_DB: db as unknown as D1Database,
        ADMIN_KV: kv as unknown as KVNamespace,
      });

      const results = await evaluateAlertRules(env);
      expect(results.length).toBe(1);
      expect(results[0]!.message).toContain('WebRTC success rate');
      expect(results[0]!.message).toContain('50.0%');
    });

    it('does not fire when both rates are above threshold', async () => {
      const rule = makeRule({
        id: 5,
        condition_type: 'low_success_rate',
        threshold_value: 90,
        threshold_unit: 'percent',
      });

      const db = createMockD1({
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [
          { condition_type: 'error_rate' },
          { condition_type: 'error_rate_spike' },
          { condition_type: 'server_offline' },
          { condition_type: 'new_critical_crash' },
          { condition_type: 'rate_limit_violations' },
          { condition_type: 'ai_issue' },
        ],
        'SELECT * FROM alert_rules WHERE enabled = 1': [rule],
        'signaling_success_count': [{
          sig_success: 95,
          sig_failure: 5,
          webrtc_success: 92,
          webrtc_failure: 8,
        }],
      });

      const env = createMockEnv({
        DIAGNOSTICS_DB: db as unknown as D1Database,
      });

      const results = await evaluateAlertRules(env);
      expect(results.length).toBe(0);
    });
  });

  // ─── Memory usage evaluator ───────────────────────────────

  describe('memory_usage_high evaluator', () => {
    it('fires when server memory exceeds threshold', async () => {
      const rule = makeRule({
        id: 6,
        condition_type: 'memory_usage_high',
        threshold_value: 90,
        threshold_unit: 'percent',
      });

      const db = createMockD1({
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [
          { condition_type: 'error_rate' },
          { condition_type: 'error_rate_spike' },
          { condition_type: 'server_offline' },
          { condition_type: 'new_critical_crash' },
          { condition_type: 'rate_limit_violations' },
          { condition_type: 'ai_issue' },
        ],
        'SELECT * FROM alert_rules WHERE enabled = 1': [rule],
        'MAX(memory_mb)': [{ server_id: 'srv-01', max_memory_mb: 512 }],
      });

      const kv = createMockKV();
      const env = createMockEnv({
        DIAGNOSTICS_DB: db as unknown as D1Database,
        ADMIN_KV: kv as unknown as KVNamespace,
      });

      const results = await evaluateAlertRules(env);
      expect(results.length).toBe(1);
      expect(results[0]!.message).toContain('High memory usage');
      expect(results[0]!.message).toContain('srv-01');
    });

    it('does not fire when memory is within limits', async () => {
      const rule = makeRule({
        id: 6,
        condition_type: 'memory_usage_high',
        threshold_value: 90,
        threshold_unit: 'percent',
      });

      const db = createMockD1({
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [
          { condition_type: 'error_rate' },
          { condition_type: 'error_rate_spike' },
          { condition_type: 'server_offline' },
          { condition_type: 'new_critical_crash' },
          { condition_type: 'rate_limit_violations' },
          { condition_type: 'ai_issue' },
        ],
        'SELECT * FROM alert_rules WHERE enabled = 1': [rule],
        'MAX(memory_mb)': [],
      });

      const env = createMockEnv({
        DIAGNOSTICS_DB: db as unknown as D1Database,
      });

      const results = await evaluateAlertRules(env);
      expect(results.length).toBe(0);
    });
  });

  // ─── Rate limit violations evaluator ──────────────────────

  describe('rate_limit_violations evaluator', () => {
    it('fires when violations exceed threshold', async () => {
      const rule = makeRule({
        id: 7,
        condition_type: 'rate_limit_violations',
        threshold_value: 1000,
        threshold_unit: 'per_hour',
      });

      const db = createMockD1({
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [
          { condition_type: 'error_rate' },
          { condition_type: 'error_rate_spike' },
          { condition_type: 'server_offline' },
          { condition_type: 'new_critical_crash' },
          { condition_type: 'rate_limit_violations' },
          { condition_type: 'ai_issue' },
        ],
        'SELECT * FROM alert_rules WHERE enabled = 1': [rule],
        'rate_limit_violation': [{ total: 1500 }],
      });

      const kv = createMockKV();
      const env = createMockEnv({
        DIAGNOSTICS_DB: db as unknown as D1Database,
        ADMIN_KV: kv as unknown as KVNamespace,
      });

      const results = await evaluateAlertRules(env);
      expect(results.length).toBe(1);
      expect(results[0]!.message).toContain('1500');
      expect(results[0]!.message).toContain('Rate limit violations exceeded');
    });

    it('does not fire when violations are below threshold', async () => {
      const rule = makeRule({
        id: 7,
        condition_type: 'rate_limit_violations',
        threshold_value: 1000,
        threshold_unit: 'per_hour',
      });

      const db = createMockD1({
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [
          { condition_type: 'error_rate' },
          { condition_type: 'error_rate_spike' },
          { condition_type: 'server_offline' },
          { condition_type: 'new_critical_crash' },
          { condition_type: 'rate_limit_violations' },
          { condition_type: 'ai_issue' },
        ],
        'SELECT * FROM alert_rules WHERE enabled = 1': [rule],
        'rate_limit_violation': [{ total: 500 }],
      });

      const env = createMockEnv({
        DIAGNOSTICS_DB: db as unknown as D1Database,
      });

      const results = await evaluateAlertRules(env);
      expect(results.length).toBe(0);
    });
  });

  // ─── Multiple rules ──────────────────────────────────────

  describe('Multiple rules evaluation', () => {
    it('evaluates multiple rules and fires those that match', async () => {
      const rules = [
        makeRule({
          id: 1,
          name: 'Error rate',
          condition_type: 'error_rate',
          threshold_value: 100,
        }),
        makeRule({
          id: 2,
          name: 'Rate limits',
          condition_type: 'rate_limit_violations',
          threshold_value: 1000,
        }),
      ];

      const db = createMockD1({
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [
          { condition_type: 'error_rate' },
          { condition_type: 'error_rate_spike' },
          { condition_type: 'server_offline' },
          { condition_type: 'new_critical_crash' },
          { condition_type: 'rate_limit_violations' },
          { condition_type: 'ai_issue' },
        ],
        'SELECT * FROM alert_rules WHERE enabled = 1': rules,
        'SUM(count)': [{ total: 150 }],        // error_rate fires
        'rate_limit_violation': [{ total: 500 }], // rate_limit does NOT fire
      });

      const kv = createMockKV();
      const env = createMockEnv({
        DIAGNOSTICS_DB: db as unknown as D1Database,
        ADMIN_KV: kv as unknown as KVNamespace,
      });

      const results = await evaluateAlertRules(env);
      // Only error_rate should fire (150 >= 100), rate_limit should not (500 < 1000)
      expect(results.length).toBe(1);
      expect(results[0]!.ruleId).toBe(1);
    });
  });

  // ─── Default rule deletion protection ─────────────────────

  describe('Default rule deletion protection (via API)', () => {
    let worker: { fetch: (request: Request, env: unknown) => Promise<Response> };
    let superAdminToken: string;

    beforeEach(async () => {
      const mod = await import('../../src/index.js');
      worker = mod.default;

      const header = { alg: 'HS256', typ: 'JWT' };
      const now = Math.floor(Date.now() / 1000);
      const payload = { sub: 'user-1', username: 'superadmin', role: 'super-admin', iat: now, exp: now + 900 };

      function base64UrlEncode(str: string): string {
        return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      }

      const encodedHeader = base64UrlEncode(JSON.stringify(header));
      const encodedPayload = base64UrlEncode(JSON.stringify(payload));
      const signatureInput = `${encodedHeader}.${encodedPayload}`;

      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode('test-secret'),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signatureInput));
      const encodedSig = base64UrlEncode(String.fromCharCode(...new Uint8Array(sig)));
      superAdminToken = `${signatureInput}.${encodedSig}`;
    });

    it('DELETE returns 403 for default rules', async () => {
      const defaultRule: MockRow = {
        id: 1,
        name: 'Default Rule',
        condition_type: 'error_rate',
        threshold_value: 100,
        threshold_unit: 'per_hour',
        severity: 'warning',
        channels: '["dashboard"]',
        enabled: 1,
        cooldown_minutes: 60,
        is_default: 1,
        created_by: 'system',
        created_at: Date.now(),
        last_triggered_at: null,
      };

      const db = createMockD1({
        'SELECT * FROM alert_rules WHERE id': [defaultRule],
      });

      const env = {
        ADMIN_USERS: {} as unknown,
        ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
        DIAGNOSTICS_DB: db as unknown as D1Database,
      };

      const req = new Request('http://localhost/admin/api/alerts/rules/1', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(403);
      const body = await res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Cannot delete default alert rules. Disable instead.');
    });

    it('DELETE succeeds for non-default rules', async () => {
      const nonDefaultRule: MockRow = {
        id: 2,
        name: 'Custom Rule',
        condition_type: 'error_rate',
        threshold_value: 200,
        threshold_unit: 'per_hour',
        severity: 'warning',
        channels: '["dashboard"]',
        enabled: 1,
        cooldown_minutes: 60,
        is_default: 0,
        created_by: 'admin',
        created_at: Date.now(),
        last_triggered_at: null,
      };

      const db = createMockD1({
        'SELECT * FROM alert_rules WHERE id': [nonDefaultRule],
        'DELETE FROM alert_rules': [nonDefaultRule],
      });

      const env = {
        ADMIN_USERS: {} as unknown,
        ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
        DIAGNOSTICS_DB: db as unknown as D1Database,
      };

      const req = new Request('http://localhost/admin/api/alerts/rules/2', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean };
      expect(body.success).toBe(true);
    });
  });

  // ─── Disk usage evaluator ─────────────────────────────────

  describe('disk_usage_high evaluator', () => {
    it('fires when disk warnings exceed threshold', async () => {
      const rule = makeRule({
        id: 8,
        condition_type: 'disk_usage_high',
        threshold_value: 3,
        threshold_unit: 'per_hour',
      });

      const db = createMockD1({
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [
          { condition_type: 'error_rate' },
          { condition_type: 'error_rate_spike' },
          { condition_type: 'server_offline' },
          { condition_type: 'new_critical_crash' },
          { condition_type: 'rate_limit_violations' },
          { condition_type: 'ai_issue' },
        ],
        'SELECT * FROM alert_rules WHERE enabled = 1': [rule],
        'COUNT(*)': [{ count: 5 }],
      });

      const kv = createMockKV();
      const env = createMockEnv({
        DIAGNOSTICS_DB: db as unknown as D1Database,
        ADMIN_KV: kv as unknown as KVNamespace,
      });

      const results = await evaluateAlertRules(env);
      expect(results.length).toBe(1);
      expect(results[0]!.message).toContain('Disk usage warnings');
    });

    it('does not fire when disk warnings below threshold', async () => {
      const rule = makeRule({
        id: 8,
        condition_type: 'disk_usage_high',
        threshold_value: 5,
        threshold_unit: 'per_hour',
      });

      const db = createMockD1({
        'SELECT condition_type FROM alert_rules WHERE is_default = 1': [
          { condition_type: 'error_rate' },
          { condition_type: 'error_rate_spike' },
          { condition_type: 'server_offline' },
          { condition_type: 'new_critical_crash' },
          { condition_type: 'rate_limit_violations' },
          { condition_type: 'ai_issue' },
        ],
        'SELECT * FROM alert_rules WHERE enabled = 1': [rule],
        'COUNT(*)': [{ count: 0 }],
      });

      const env = createMockEnv({
        DIAGNOSTICS_DB: db as unknown as D1Database,
      });

      const results = await evaluateAlertRules(env);
      expect(results.length).toBe(0);
    });
  });
});
