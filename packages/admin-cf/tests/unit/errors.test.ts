/**
 * Unit tests for error route handler
 *
 * Tests handleListErrors with mock D1 bindings and mock auth.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleListErrors, handleErrorTrends, handleErrorRegressions, transformTrendsData } from '../../src/routes/errors.js';
import { handleServerMetrics, handleServerMetricsDetail, handleAppMetrics, handleNetworkMetrics, handleFederationMetrics } from '../../src/routes/metrics.js';
import { handleActiveClients, handlePlatformBreakdown, handleVersionAdoption, handleConnectionTypes } from '../../src/routes/clients.js';
import { handleServersHealth } from '../../src/routes/servers-health.js';
import { handleServerLogs } from '../../src/routes/logs.js';
import { handleFederationTopology } from '../../src/routes/federation-topology.js';
import { handleHeartbeatTimeline } from '../../src/routes/heartbeat-timeline.js';
import { handleListIssues, handleIssueDetail, handleAcknowledgeIssue } from '../../src/routes/issues.js';
import { handleAiCosts } from '../../src/routes/ai-costs.js';
import { handleRateLimitViolations } from '../../src/routes/security-rate-limits.js';
import { handleDdosIndicators } from '../../src/routes/security-attacks.js';
import { handleBadClients, handlePairingBruteForce } from '../../src/routes/security-clients.js';
import {
  handleListAlertRules,
  handleGetAlertRule,
  handleCreateAlertRule,
  handleUpdateAlertRule,
  handleDeleteAlertRule,
} from '../../src/routes/alert-rules.js';
import {
  handleListAlertHistory,
  handleAcknowledgeAlert,
} from '../../src/routes/alert-history.js';
import {
  handleListNotifications,
  handleUnreadCount,
  handleMarkRead,
  handleMarkAllRead,
} from '../../src/routes/notifications.js';
import {
  handleGetNotificationConfig,
  handleUpdateNotificationConfig,
  handleTestNotification,
} from '../../src/routes/notification-config.js';
import type { Env } from '../../src/types.js';

// ─────────────────────────────────────────────
// Mock auth module — bypass JWT verification
// ─────────────────────────────────────────────

vi.mock('../../src/routes/auth.js', () => ({
  requireAuth: vi.fn().mockResolvedValue({
    sub: 'user-1',
    username: 'admin',
    role: 'admin',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
  requireSuperAdmin: vi.fn().mockResolvedValue({
    sub: 'user-1',
    username: 'admin',
    role: 'super-admin',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
}));

// ─────────────────────────────────────────────
// Mock D1 helpers
// ─────────────────────────────────────────────

interface MockD1Statement {
  bind: (...args: unknown[]) => MockD1Statement;
  all: <T = unknown>() => Promise<{ results: T[]; success: boolean }>;
  first: <T = unknown>() => Promise<T | null>;
}

function createMockStatement(
  allResults: unknown[] = [],
  firstResult: unknown = null
): MockD1Statement {
  const stmt: MockD1Statement = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue({ results: allResults, success: true }),
    first: vi.fn().mockResolvedValue(firstResult),
  };
  return stmt;
}

interface PrepareCall {
  query: string;
  allResults?: unknown[];
  firstResult?: unknown;
}

/**
 * Create a mock D1Database that returns different results depending on
 * which query is prepared. Matches are by substring inclusion.
 */
function createMockD1(prepareCalls: PrepareCall[]): D1Database {
  const prepareFn = vi.fn().mockImplementation((query: string) => {
    // Find the first matching config
    for (const call of prepareCalls) {
      if (query.includes(call.query)) {
        return createMockStatement(call.allResults || [], call.firstResult || null);
      }
    }
    // Default: empty results
    return createMockStatement([], null);
  });

  return { prepare: prepareFn } as unknown as D1Database;
}

function createRequest(urlPath: string): Request {
  return new Request(`https://admin.example.com${urlPath}`, {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

function createEnv(db?: D1Database): Env {
  return {
    ADMIN_USERS: {} as DurableObjectNamespace,
    ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    DIAGNOSTICS_DB: db,
  };
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('handleListErrors', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-establish default mock after clearing (required with isolate: false)
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  // ─── Graceful degradation ───

  describe('when DIAGNOSTICS_DB is not bound', () => {
    it('returns 200 with empty data', async () => {
      const req = createRequest('/admin/api/errors');
      const env = createEnv(undefined);

      const res = await handleListErrors(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as { success: boolean; data: { summary: { totalErrors: number }; errors: unknown[]; range: string } };
      expect(body.success).toBe(true);
      expect(body.data.summary.totalErrors).toBe(0);
      expect(body.data.summary.rateChangePercent).toBe(0);
      expect(body.data.summary.regressionAlerts).toBe(0);
      expect(body.data.summary.highestSeverity).toBe('none');
      expect(body.data.errors).toEqual([]);
      expect(body.data.range).toBe('24h');
    });

    it('respects range param even without DB', async () => {
      const req = createRequest('/admin/api/errors?range=1h');
      const env = createEnv(undefined);

      const res = await handleListErrors(req, env);
      const body = await res.json() as { data: { range: string } };
      expect(body.data.range).toBe('1h');
    });
  });

  // ─── Query param validation ───

  describe('query parameter validation', () => {
    it('rejects invalid category', async () => {
      const db = createMockD1([]);
      const req = createRequest('/admin/api/errors?category=badcat');
      const env = createEnv(db);

      const res = await handleListErrors(req, env);
      expect(res.status).toBe(400);

      const body = await res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('Invalid category');
    });

    it('rejects limit below 1', async () => {
      const db = createMockD1([]);
      const req = createRequest('/admin/api/errors?limit=0');
      const env = createEnv(db);

      const res = await handleListErrors(req, env);
      expect(res.status).toBe(400);

      const body = await res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('Invalid limit');
    });

    it('rejects limit above 200', async () => {
      const db = createMockD1([]);
      const req = createRequest('/admin/api/errors?limit=999');
      const env = createEnv(db);

      const res = await handleListErrors(req, env);
      expect(res.status).toBe(400);

      const body = await res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('Invalid limit');
    });

    it('rejects non-numeric limit', async () => {
      const db = createMockD1([]);
      const req = createRequest('/admin/api/errors?limit=abc');
      const env = createEnv(db);

      const res = await handleListErrors(req, env);
      expect(res.status).toBe(400);

      const body = await res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('Invalid limit');
    });

    it('defaults range to 24h when invalid range is given', async () => {
      const db = createMockD1([
        { query: 'GROUP BY error_signature', allResults: [] },
        { query: 'COALESCE(SUM(count), 0) as total', firstResult: { total: 0 } },
      ]);
      const req = createRequest('/admin/api/errors?range=invalid');
      const env = createEnv(db);

      const res = await handleListErrors(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as { data: { range: string } };
      expect(body.data.range).toBe('24h');
    });

    it('accepts valid category filter', async () => {
      const db = createMockD1([
        { query: 'GROUP BY error_signature', allResults: [] },
        { query: 'COALESCE(SUM(count), 0) as total', firstResult: { total: 0 } },
      ]);
      const req = createRequest('/admin/api/errors?category=crash');
      const env = createEnv(db);

      const res = await handleListErrors(req, env);
      expect(res.status).toBe(200);
    });
  });

  // ─── Time range computation ───

  describe('time range handling', () => {
    it('uses 1h range', async () => {
      const db = createMockD1([
        { query: 'GROUP BY error_signature', allResults: [] },
        { query: 'COALESCE(SUM(count), 0) as total', firstResult: { total: 0 } },
      ]);
      const req = createRequest('/admin/api/errors?range=1h');
      const env = createEnv(db);

      const res = await handleListErrors(req, env);
      const body = await res.json() as { data: { range: string } };
      expect(body.data.range).toBe('1h');
    });

    it('uses 7d range', async () => {
      const db = createMockD1([
        { query: 'GROUP BY error_signature', allResults: [] },
        { query: 'COALESCE(SUM(count), 0) as total', firstResult: { total: 0 } },
      ]);
      const req = createRequest('/admin/api/errors?range=7d');
      const env = createEnv(db);

      const res = await handleListErrors(req, env);
      const body = await res.json() as { data: { range: string } };
      expect(body.data.range).toBe('7d');
    });
  });

  // ─── D1 query results processing ───

  describe('D1 query results processing', () => {
    it('returns properly parsed error aggregates', async () => {
      const db = createMockD1([
        {
          query: 'GROUP BY error_signature',
          allResults: [
            {
              error_signature: 'abc123def456',
              category: 'network',
              total_count: 42,
              versions: '1.0.0,1.0.1',
              platforms: 'android,ios',
              first_seen: 1709380800000,
              last_seen: 1709384400000,
              sample_message: 'WebRTC connection timed out',
            },
            {
              error_signature: 'xyz789ghi012',
              category: 'crash',
              total_count: 10,
              versions: '1.0.0',
              platforms: 'android',
              first_seen: 1709380000000,
              last_seen: 1709383000000,
              sample_message: 'Null pointer in crypto handler',
            },
          ],
        },
        { query: 'COALESCE(SUM(count), 0) as total', firstResult: { total: 52 } },
      ]);
      const req = createRequest('/admin/api/errors?range=24h');
      const env = createEnv(db);

      const res = await handleListErrors(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as {
        success: boolean;
        data: {
          summary: { totalErrors: number; highestSeverity: string; rateChangePercent: number };
          errors: Array<{
            errorSignature: string;
            category: string;
            totalCount: number;
            versions: string[];
            platforms: string[];
            sampleMessage: string;
          }>;
          range: string;
        };
      };
      expect(body.success).toBe(true);
      expect(body.data.errors).toHaveLength(2);

      // First error
      expect(body.data.errors[0]!.errorSignature).toBe('abc123def456');
      expect(body.data.errors[0]!.category).toBe('network');
      expect(body.data.errors[0]!.totalCount).toBe(42);
      expect(body.data.errors[0]!.versions).toEqual(['1.0.0', '1.0.1']);
      expect(body.data.errors[0]!.platforms).toEqual(['android', 'ios']);
      expect(body.data.errors[0]!.sampleMessage).toBe('WebRTC connection timed out');

      // Second error
      expect(body.data.errors[1]!.errorSignature).toBe('xyz789ghi012');
      expect(body.data.errors[1]!.category).toBe('crash');
      expect(body.data.errors[1]!.totalCount).toBe(10);

      // Summary
      expect(body.data.summary.totalErrors).toBe(52);
      // Has crash category, so severity should be critical
      expect(body.data.summary.highestSeverity).toBe('critical');
    });

    it('handles empty results', async () => {
      const db = createMockD1([
        { query: 'GROUP BY error_signature', allResults: [] },
        { query: 'COALESCE(SUM(count), 0) as total', firstResult: { total: 0 } },
      ]);
      const req = createRequest('/admin/api/errors');
      const env = createEnv(db);

      const res = await handleListErrors(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as { data: { summary: { totalErrors: number; highestSeverity: string }; errors: unknown[] } };
      expect(body.data.summary.totalErrors).toBe(0);
      expect(body.data.summary.highestSeverity).toBe('none');
      expect(body.data.errors).toEqual([]);
    });

    it('handles null versions and platforms in results', async () => {
      const db = createMockD1([
        {
          query: 'GROUP BY error_signature',
          allResults: [
            {
              error_signature: 'sig123',
              category: 'ui',
              total_count: 5,
              versions: null,
              platforms: null,
              first_seen: 1709380800000,
              last_seen: 1709384400000,
              sample_message: null,
            },
          ],
        },
        { query: 'COALESCE(SUM(count), 0) as total', firstResult: { total: 5 } },
      ]);
      const req = createRequest('/admin/api/errors');
      const env = createEnv(db);

      const res = await handleListErrors(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as { data: { errors: Array<{ versions: string[]; platforms: string[]; sampleMessage: string }> } };
      expect(body.data.errors[0]!.versions).toEqual([]);
      expect(body.data.errors[0]!.platforms).toEqual([]);
      expect(body.data.errors[0]!.sampleMessage).toBe('');
    });
  });

  // ─── Rate change calculation ───

  describe('rate change calculation', () => {
    it('computes positive rate change when current > previous', async () => {
      // Current period: 150, Previous period: 100 => +50%
      let callIndex = 0;
      const db = createMockD1([
        { query: 'GROUP BY error_signature', allResults: [] },
      ]);
      // Override prepare to distinguish between the two "total" queries
      const prepareFn = vi.fn().mockImplementation((query: string) => {
        if (query.includes('GROUP BY error_signature')) {
          return createMockStatement([], null);
        }
        if (query.includes('COALESCE(SUM(count), 0) as total')) {
          callIndex++;
          if (callIndex === 1) {
            // Current period total
            return createMockStatement([], { total: 150 });
          }
          // Previous period total
          return createMockStatement([], { total: 100 });
        }
        return createMockStatement([], null);
      });
      (db as unknown as { prepare: typeof prepareFn }).prepare = prepareFn;

      const req = createRequest('/admin/api/errors');
      const env = createEnv(db);

      const res = await handleListErrors(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as { data: { summary: { rateChangePercent: number } } };
      expect(body.data.summary.rateChangePercent).toBe(50);
    });

    it('computes negative rate change when current < previous', async () => {
      let callIndex = 0;
      const db = createMockD1([]);
      const prepareFn = vi.fn().mockImplementation((query: string) => {
        if (query.includes('GROUP BY error_signature')) {
          return createMockStatement([], null);
        }
        if (query.includes('COALESCE(SUM(count), 0) as total')) {
          callIndex++;
          if (callIndex === 1) {
            return createMockStatement([], { total: 50 });
          }
          return createMockStatement([], { total: 100 });
        }
        return createMockStatement([], null);
      });
      (db as unknown as { prepare: typeof prepareFn }).prepare = prepareFn;

      const req = createRequest('/admin/api/errors');
      const env = createEnv(db);

      const res = await handleListErrors(req, env);
      const body = await res.json() as { data: { summary: { rateChangePercent: number } } };
      expect(body.data.summary.rateChangePercent).toBe(-50);
    });

    it('returns 100% when previous period has zero errors', async () => {
      let callIndex = 0;
      const db = createMockD1([]);
      const prepareFn = vi.fn().mockImplementation((query: string) => {
        if (query.includes('GROUP BY error_signature')) {
          return createMockStatement([], null);
        }
        if (query.includes('COALESCE(SUM(count), 0) as total')) {
          callIndex++;
          if (callIndex === 1) {
            return createMockStatement([], { total: 42 });
          }
          return createMockStatement([], { total: 0 });
        }
        return createMockStatement([], null);
      });
      (db as unknown as { prepare: typeof prepareFn }).prepare = prepareFn;

      const req = createRequest('/admin/api/errors');
      const env = createEnv(db);

      const res = await handleListErrors(req, env);
      const body = await res.json() as { data: { summary: { rateChangePercent: number } } };
      expect(body.data.summary.rateChangePercent).toBe(100);
    });

    it('returns 0% when both periods have zero errors', async () => {
      const db = createMockD1([
        { query: 'GROUP BY error_signature', allResults: [] },
        { query: 'COALESCE(SUM(count), 0) as total', firstResult: { total: 0 } },
      ]);

      const req = createRequest('/admin/api/errors');
      const env = createEnv(db);

      const res = await handleListErrors(req, env);
      const body = await res.json() as { data: { summary: { rateChangePercent: number } } };
      expect(body.data.summary.rateChangePercent).toBe(0);
    });
  });

  // ─── Severity determination ───

  describe('severity determination', () => {
    it('returns "critical" when crash category is present', async () => {
      const db = createMockD1([
        {
          query: 'GROUP BY error_signature',
          allResults: [{ error_signature: 'sig1', category: 'crash', total_count: 1, versions: '', platforms: '', first_seen: 0, last_seen: 0, sample_message: '' }],
        },
        { query: 'COALESCE(SUM(count), 0) as total', firstResult: { total: 1 } },
      ]);

      const req = createRequest('/admin/api/errors');
      const res = await handleListErrors(req, createEnv(db));
      const body = await res.json() as { data: { summary: { highestSeverity: string } } };
      expect(body.data.summary.highestSeverity).toBe('critical');
    });

    it('returns "high" for network errors (no crash)', async () => {
      const db = createMockD1([
        {
          query: 'GROUP BY error_signature',
          allResults: [{ error_signature: 'sig1', category: 'network', total_count: 1, versions: '', platforms: '', first_seen: 0, last_seen: 0, sample_message: '' }],
        },
        { query: 'COALESCE(SUM(count), 0) as total', firstResult: { total: 1 } },
      ]);

      const req = createRequest('/admin/api/errors');
      const res = await handleListErrors(req, createEnv(db));
      const body = await res.json() as { data: { summary: { highestSeverity: string } } };
      expect(body.data.summary.highestSeverity).toBe('high');
    });

    it('returns "high" for crypto errors', async () => {
      const db = createMockD1([
        {
          query: 'GROUP BY error_signature',
          allResults: [{ error_signature: 'sig1', category: 'crypto', total_count: 1, versions: '', platforms: '', first_seen: 0, last_seen: 0, sample_message: '' }],
        },
        { query: 'COALESCE(SUM(count), 0) as total', firstResult: { total: 1 } },
      ]);

      const req = createRequest('/admin/api/errors');
      const res = await handleListErrors(req, createEnv(db));
      const body = await res.json() as { data: { summary: { highestSeverity: string } } };
      expect(body.data.summary.highestSeverity).toBe('high');
    });

    it('returns "medium" for storage errors (no crash/network/crypto)', async () => {
      const db = createMockD1([
        {
          query: 'GROUP BY error_signature',
          allResults: [{ error_signature: 'sig1', category: 'storage', total_count: 1, versions: '', platforms: '', first_seen: 0, last_seen: 0, sample_message: '' }],
        },
        { query: 'COALESCE(SUM(count), 0) as total', firstResult: { total: 1 } },
      ]);

      const req = createRequest('/admin/api/errors');
      const res = await handleListErrors(req, createEnv(db));
      const body = await res.json() as { data: { summary: { highestSeverity: string } } };
      expect(body.data.summary.highestSeverity).toBe('medium');
    });

    it('returns "low" for ui-only errors', async () => {
      const db = createMockD1([
        {
          query: 'GROUP BY error_signature',
          allResults: [{ error_signature: 'sig1', category: 'ui', total_count: 1, versions: '', platforms: '', first_seen: 0, last_seen: 0, sample_message: '' }],
        },
        { query: 'COALESCE(SUM(count), 0) as total', firstResult: { total: 1 } },
      ]);

      const req = createRequest('/admin/api/errors');
      const res = await handleListErrors(req, createEnv(db));
      const body = await res.json() as { data: { summary: { highestSeverity: string } } };
      expect(body.data.summary.highestSeverity).toBe('low');
    });

    it('returns "none" with no errors', async () => {
      const db = createMockD1([
        { query: 'GROUP BY error_signature', allResults: [] },
        { query: 'COALESCE(SUM(count), 0) as total', firstResult: { total: 0 } },
      ]);

      const req = createRequest('/admin/api/errors');
      const res = await handleListErrors(req, createEnv(db));
      const body = await res.json() as { data: { summary: { highestSeverity: string } } };
      expect(body.data.summary.highestSeverity).toBe('none');
    });
  });

  // ─── D1 error handling ───

  describe('D1 error handling', () => {
    it('returns 500 when D1 query fails', async () => {
      const db = {
        prepare: vi.fn().mockImplementation(() => ({
          bind: vi.fn().mockReturnThis(),
          all: vi.fn().mockRejectedValue(new Error('D1 is unavailable')),
          first: vi.fn().mockRejectedValue(new Error('D1 is unavailable')),
        })),
      } as unknown as D1Database;

      const req = createRequest('/admin/api/errors');
      const env = createEnv(db);

      const res = await handleListErrors(req, env);
      expect(res.status).toBe(500);

      const body = await res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('Failed to query error data');
    });
  });

  // ─── Auth enforcement ───

  describe('auth enforcement', () => {
    it('returns 401 when requireAuth rejects', async () => {
      const { requireAuth } = await import('../../src/routes/auth.js');
      const mockRequireAuth = vi.mocked(requireAuth);

      // Override to return 401 response
      mockRequireAuth.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const req = createRequest('/admin/api/errors');
      const env = createEnv(undefined);

      const res = await handleListErrors(req, env);
      expect(res.status).toBe(401);
    });
  });

  // ─── Response structure ───

  describe('response structure', () => {
    it('returns correct JSON structure with all expected fields', async () => {
      const db = createMockD1([
        { query: 'GROUP BY error_signature', allResults: [] },
        { query: 'COALESCE(SUM(count), 0) as total', firstResult: { total: 0 } },
      ]);

      const req = createRequest('/admin/api/errors?range=24h');
      const env = createEnv(db);

      const res = await handleListErrors(req, env);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/json');
      expect(res.headers.get('Cache-Control')).toBe('no-store');

      const body = await res.json() as {
        success: boolean;
        data: {
          summary: {
            totalErrors: number;
            rateChangePercent: number;
            regressionAlerts: number;
            highestSeverity: string;
          };
          errors: unknown[];
          range: string;
        };
      };

      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
      expect(body.data.summary).toBeDefined();
      expect(typeof body.data.summary.totalErrors).toBe('number');
      expect(typeof body.data.summary.rateChangePercent).toBe('number');
      expect(typeof body.data.summary.regressionAlerts).toBe('number');
      expect(typeof body.data.summary.highestSeverity).toBe('string');
      expect(Array.isArray(body.data.errors)).toBe(true);
      expect(body.data.range).toBe('24h');
    });
  });
});

// ─────────────────────────────────────────────
// transformTrendsData (US-2.2)
// ─────────────────────────────────────────────

describe('transformTrendsData', () => {
  it('returns empty result for empty rows', () => {
    const result = transformTrendsData([], []);
    expect(result.timestamps).toEqual([]);
    expect(result.series).toEqual({});
    expect(result.deployments).toEqual([]);
  });

  it('transforms single-category single-timestamp data', () => {
    const rows = [
      { time_bucket: '2024-03-02T10:00:00Z', category: 'crash', total: 5 },
    ];
    const result = transformTrendsData(rows, []);

    expect(result.timestamps).toHaveLength(1);
    expect(result.timestamps[0]).toBe(Math.floor(new Date('2024-03-02T10:00:00Z').getTime() / 1000));
    expect(result.series['crash']).toEqual([5]);
    expect(result.deployments).toEqual([]);
  });

  it('transforms multi-category multi-timestamp data', () => {
    const rows = [
      { time_bucket: '2024-03-02T10:00:00Z', category: 'crash', total: 5 },
      { time_bucket: '2024-03-02T10:00:00Z', category: 'network', total: 3 },
      { time_bucket: '2024-03-02T11:00:00Z', category: 'crash', total: 12 },
      { time_bucket: '2024-03-02T11:00:00Z', category: 'network', total: 8 },
    ];
    const result = transformTrendsData(rows, []);

    expect(result.timestamps).toHaveLength(2);
    // Sorted ascending
    const ts1 = Math.floor(new Date('2024-03-02T10:00:00Z').getTime() / 1000);
    const ts2 = Math.floor(new Date('2024-03-02T11:00:00Z').getTime() / 1000);
    expect(result.timestamps).toEqual([ts1, ts2]);

    expect(result.series['crash']).toEqual([5, 12]);
    expect(result.series['network']).toEqual([3, 8]);
  });

  it('fills zeros for missing category-timestamp combinations', () => {
    const rows = [
      { time_bucket: '2024-03-02T10:00:00Z', category: 'crash', total: 5 },
      { time_bucket: '2024-03-02T11:00:00Z', category: 'network', total: 8 },
    ];
    const result = transformTrendsData(rows, []);

    expect(result.timestamps).toHaveLength(2);
    // crash exists at ts1 but not ts2 => [5, 0]
    expect(result.series['crash']).toEqual([5, 0]);
    // network exists at ts2 but not ts1 => [0, 8]
    expect(result.series['network']).toEqual([0, 8]);
  });

  it('produces correct deployment markers', () => {
    const deploymentRows = [
      { app_version: '1.2.0', deploy_time: '2024-03-02T08:00:00Z' },
      { app_version: '1.2.1', deploy_time: '2024-03-02T14:00:00Z' },
    ];
    const result = transformTrendsData(
      [{ time_bucket: '2024-03-02T10:00:00Z', category: 'crash', total: 1 }],
      deploymentRows,
    );

    expect(result.deployments).toHaveLength(2);
    expect(result.deployments[0]!.version).toBe('1.2.0');
    expect(result.deployments[0]!.timestamp).toBe(new Date('2024-03-02T08:00:00Z').getTime());
    expect(result.deployments[1]!.version).toBe('1.2.1');
    expect(result.deployments[1]!.timestamp).toBe(new Date('2024-03-02T14:00:00Z').getTime());
  });

  it('sorts timestamps in ascending order', () => {
    const rows = [
      { time_bucket: '2024-03-02T15:00:00Z', category: 'crash', total: 1 },
      { time_bucket: '2024-03-02T10:00:00Z', category: 'crash', total: 2 },
      { time_bucket: '2024-03-02T12:00:00Z', category: 'crash', total: 3 },
    ];
    const result = transformTrendsData(rows, []);

    const ts10 = Math.floor(new Date('2024-03-02T10:00:00Z').getTime() / 1000);
    const ts12 = Math.floor(new Date('2024-03-02T12:00:00Z').getTime() / 1000);
    const ts15 = Math.floor(new Date('2024-03-02T15:00:00Z').getTime() / 1000);
    expect(result.timestamps).toEqual([ts10, ts12, ts15]);
    expect(result.series['crash']).toEqual([2, 3, 1]);
  });

  it('handles many categories correctly', () => {
    const categories = ['crash', 'network', 'crypto', 'storage', 'ui', 'protocol', 'other'];
    const rows = categories.map((cat, i) => ({
      time_bucket: '2024-03-02T10:00:00Z',
      category: cat,
      total: i + 1,
    }));
    const result = transformTrendsData(rows, []);

    expect(result.timestamps).toHaveLength(1);
    expect(Object.keys(result.series)).toHaveLength(7);
    categories.forEach((cat, i) => {
      expect(result.series[cat]).toEqual([i + 1]);
    });
  });
});

// ─────────────────────────────────────────────
// handleErrorTrends (US-2.2)
// ─────────────────────────────────────────────

describe('handleErrorTrends', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-establish default mock after clearing (required with isolate: false)
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  // ─── Graceful degradation ───

  describe('when DIAGNOSTICS_DB is not bound', () => {
    it('returns 200 with empty trends data', async () => {
      const req = createRequest('/admin/api/errors/trends');
      const env = createEnv(undefined);

      const res = await handleErrorTrends(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as {
        success: boolean;
        data: {
          timestamps: number[];
          series: Record<string, number[]>;
          deployments: unknown[];
          range: string;
          bucketSize: string;
        };
      };
      expect(body.success).toBe(true);
      expect(body.data.timestamps).toEqual([]);
      expect(body.data.series).toEqual({});
      expect(body.data.deployments).toEqual([]);
      expect(body.data.range).toBe('24h');
      expect(body.data.bucketSize).toBe('1h');
    });

    it('respects range param even without DB', async () => {
      const req = createRequest('/admin/api/errors/trends?range=7d');
      const env = createEnv(undefined);

      const res = await handleErrorTrends(req, env);
      const body = await res.json() as { data: { range: string; bucketSize: string } };
      expect(body.data.range).toBe('7d');
      expect(body.data.bucketSize).toBe('6h');
    });

    it('returns 1min bucket size for 1h range', async () => {
      const req = createRequest('/admin/api/errors/trends?range=1h');
      const env = createEnv(undefined);

      const res = await handleErrorTrends(req, env);
      const body = await res.json() as { data: { range: string; bucketSize: string } };
      expect(body.data.range).toBe('1h');
      expect(body.data.bucketSize).toBe('1min');
    });
  });

  // ─── Query param validation ───

  describe('query parameter validation', () => {
    it('rejects invalid range', async () => {
      const db = createMockD1([]);
      const req = createRequest('/admin/api/errors/trends?range=2h');
      const env = createEnv(db);

      const res = await handleErrorTrends(req, env);
      expect(res.status).toBe(400);

      const body = await res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('Invalid range');
    });

    it('rejects invalid category', async () => {
      const db = createMockD1([]);
      const req = createRequest('/admin/api/errors/trends?category=badcat');
      const env = createEnv(db);

      const res = await handleErrorTrends(req, env);
      expect(res.status).toBe(400);

      const body = await res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('Invalid category');
    });

    it('defaults range to 24h', async () => {
      const db = createMockD1([
        { query: 'time_bucket', allResults: [] },
        { query: 'app_version', allResults: [] },
      ]);
      const req = createRequest('/admin/api/errors/trends');
      const env = createEnv(db);

      const res = await handleErrorTrends(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as { data: { range: string } };
      expect(body.data.range).toBe('24h');
    });
  });

  // ─── D1 query results ───

  describe('D1 query results processing', () => {
    it('returns chart-formatted data from D1 results', async () => {
      const db = createMockD1([
        {
          query: 'category',
          allResults: [
            { time_bucket: '2024-03-02T10:00:00Z', category: 'crash', total: 5 },
            { time_bucket: '2024-03-02T10:00:00Z', category: 'network', total: 3 },
            { time_bucket: '2024-03-02T11:00:00Z', category: 'crash', total: 12 },
          ],
        },
        {
          query: 'app_version',
          allResults: [
            { app_version: '1.2.0', deploy_time: '2024-03-02T08:00:00Z' },
          ],
        },
      ]);

      const req = createRequest('/admin/api/errors/trends?range=24h');
      const env = createEnv(db);

      const res = await handleErrorTrends(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as {
        success: boolean;
        data: {
          timestamps: number[];
          series: Record<string, number[]>;
          deployments: Array<{ version: string; timestamp: number }>;
          range: string;
          bucketSize: string;
        };
      };
      expect(body.success).toBe(true);
      expect(body.data.timestamps).toHaveLength(2);
      expect(body.data.series['crash']).toBeDefined();
      expect(body.data.series['network']).toBeDefined();
      expect(body.data.deployments).toHaveLength(1);
      expect(body.data.deployments[0]!.version).toBe('1.2.0');
      expect(body.data.range).toBe('24h');
      expect(body.data.bucketSize).toBe('1h');
    });

    it('returns empty data when no rows match', async () => {
      const db = createMockD1([
        { query: 'category', allResults: [] },
        { query: 'app_version', allResults: [] },
      ]);

      const req = createRequest('/admin/api/errors/trends?range=24h');
      const env = createEnv(db);

      const res = await handleErrorTrends(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as { data: { timestamps: number[]; series: Record<string, number[]>; deployments: unknown[] } };
      expect(body.data.timestamps).toEqual([]);
      expect(body.data.series).toEqual({});
      expect(body.data.deployments).toEqual([]);
    });
  });

  // ─── D1 error handling ───

  describe('D1 error handling', () => {
    it('returns 500 when D1 query fails', async () => {
      const db = {
        prepare: vi.fn().mockImplementation(() => ({
          bind: vi.fn().mockReturnThis(),
          all: vi.fn().mockRejectedValue(new Error('D1 is unavailable')),
          first: vi.fn().mockRejectedValue(new Error('D1 is unavailable')),
        })),
      } as unknown as D1Database;

      const req = createRequest('/admin/api/errors/trends');
      const env = createEnv(db);

      const res = await handleErrorTrends(req, env);
      expect(res.status).toBe(500);

      const body = await res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('Failed to fetch error trends');
    });
  });

  // ─── Auth enforcement ───

  describe('auth enforcement', () => {
    it('returns 401 when requireAuth rejects', async () => {
      const { requireAuth } = await import('../../src/routes/auth.js');
      const mockRequireAuth = vi.mocked(requireAuth);

      mockRequireAuth.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const req = createRequest('/admin/api/errors/trends');
      const env = createEnv(undefined);

      const res = await handleErrorTrends(req, env);
      expect(res.status).toBe(401);
    });
  });

  // ─── Response structure ───

  describe('response structure', () => {
    it('returns correct JSON structure with all expected fields', async () => {
      const db = createMockD1([
        { query: 'category', allResults: [] },
        { query: 'app_version', allResults: [] },
      ]);

      const req = createRequest('/admin/api/errors/trends?range=7d');
      const env = createEnv(db);

      const res = await handleErrorTrends(req, env);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/json');
      expect(res.headers.get('Cache-Control')).toBe('no-store');

      const body = await res.json() as {
        success: boolean;
        data: {
          timestamps: number[];
          series: Record<string, number[]>;
          deployments: unknown[];
          range: string;
          bucketSize: string;
        };
      };

      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
      expect(Array.isArray(body.data.timestamps)).toBe(true);
      expect(typeof body.data.series).toBe('object');
      expect(Array.isArray(body.data.deployments)).toBe(true);
      expect(body.data.range).toBe('7d');
      expect(body.data.bucketSize).toBe('6h');
    });
  });
});

// ─────────────────────────────────────────────
// handleErrorRegressions auth (US-2.4)
// Auth enforcement test lives here (not in regressions.test.ts) because
// vi.mock factories create separate mock function instances per file when
// isolate: false. Only the first-loaded file's mock is wired into the
// handler's import binding.
// ─────────────────────────────────────────────

describe('handleErrorRegressions auth enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('returns 401 when requireAuth rejects', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    const mockRequireAuth = vi.mocked(requireAuth);

    mockRequireAuth.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = new Request('https://admin.example.com/admin/api/errors/regressions', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
    const env: Env = {
      ADMIN_USERS: {} as DurableObjectNamespace,
      ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    };

    const res = await handleErrorRegressions(req, env);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handleServerMetrics / handleServerMetricsDetail auth (US-3.3)
// Auth enforcement tests live here (not in server-metrics.test.ts) because
// vi.mock factories create separate mock function instances per file when
// isolate: false. Only the first-loaded file's mock is wired into the
// handler's import binding.
// ─────────────────────────────────────────────

describe('handleServerMetrics auth enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('returns 401 when requireAuth rejects', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    const mockRequireAuth = vi.mocked(requireAuth);

    mockRequireAuth.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = new Request('https://admin.example.com/admin/api/metrics/server', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
    const env: Env = {
      ADMIN_USERS: {} as DurableObjectNamespace,
      ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    };

    const res = await handleServerMetrics(req, env);
    expect(res.status).toBe(401);
  });
});

describe('handleServerMetricsDetail auth enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('returns 401 when requireAuth rejects', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    const mockRequireAuth = vi.mocked(requireAuth);

    mockRequireAuth.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = new Request('https://admin.example.com/admin/api/metrics/server/srv-01', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
    const env: Env = {
      ADMIN_USERS: {} as DurableObjectNamespace,
      ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    };

    const res = await handleServerMetricsDetail(req, env, 'srv-01');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handleAppMetrics auth enforcement (US-3.1)
// ─────────────────────────────────────────────

describe('handleAppMetrics auth enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('returns 401 when requireAuth rejects', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = new Request('https://admin.example.com/admin/api/metrics/app', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
    const env: Env = {
      ADMIN_USERS: {} as DurableObjectNamespace,
      ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    };

    const res = await handleAppMetrics(req, env);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handleNetworkMetrics auth enforcement (US-3.2)
// ─────────────────────────────────────────────

describe('handleNetworkMetrics auth enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('returns 401 when requireAuth rejects', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = new Request('https://admin.example.com/admin/api/metrics/network', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
    const env: Env = {
      ADMIN_USERS: {} as DurableObjectNamespace,
      ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    };

    const res = await handleNetworkMetrics(req, env);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handleFederationMetrics auth enforcement (US-3.4)
// ─────────────────────────────────────────────

describe('handleFederationMetrics auth enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('returns 401 when requireAuth rejects', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = new Request('https://admin.example.com/admin/api/metrics/federation', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
    const env: Env = {
      ADMIN_USERS: {} as DurableObjectNamespace,
      ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    };

    const res = await handleFederationMetrics(req, env);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handleActiveClients auth enforcement (US-4.1)
// ─────────────────────────────────────────────

describe('handleActiveClients auth enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('returns 401 when requireAuth rejects', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = new Request('https://admin.example.com/admin/api/clients/active', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
    const env: Env = {
      ADMIN_USERS: {} as DurableObjectNamespace,
      ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    };

    const res = await handleActiveClients(req, env);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handlePlatformBreakdown auth enforcement (US-4.2)
// ─────────────────────────────────────────────

describe('handlePlatformBreakdown auth enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('returns 401 when requireAuth rejects', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = new Request('https://admin.example.com/admin/api/clients/platforms', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
    const env: Env = {
      ADMIN_USERS: {} as DurableObjectNamespace,
      ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    };

    const res = await handlePlatformBreakdown(req, env);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handleVersionAdoption auth enforcement (US-4.3)
// ─────────────────────────────────────────────

describe('handleVersionAdoption auth enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('returns 401 when requireAuth rejects', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = new Request('https://admin.example.com/admin/api/clients/versions', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
    const env: Env = {
      ADMIN_USERS: {} as DurableObjectNamespace,
      ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    };

    const res = await handleVersionAdoption(req, env);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handleConnectionTypes auth enforcement (US-4.4)
// ─────────────────────────────────────────────

describe('handleConnectionTypes auth enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('returns 401 when requireAuth rejects', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = new Request('https://admin.example.com/admin/api/clients/connections', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
    const env: Env = {
      ADMIN_USERS: {} as DurableObjectNamespace,
      ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    };

    const res = await handleConnectionTypes(req, env);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handleServersHealth auth enforcement (US-5.1)
// ─────────────────────────────────────────────

describe('handleServersHealth auth enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('returns 401 when requireAuth rejects', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = new Request('https://admin.example.com/admin/api/servers/health', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
    const env: Env = {
      ADMIN_USERS: {} as DurableObjectNamespace,
      ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    };

    const res = await handleServersHealth(req, env);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handleServerLogs auth enforcement (US-5.2)
// ─────────────────────────────────────────────

describe('handleServerLogs auth enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('returns 401 when requireAuth rejects', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = new Request('https://admin.example.com/admin/api/logs', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
    const env: Env = {
      ADMIN_USERS: {} as DurableObjectNamespace,
      ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    };

    const res = await handleServerLogs(req, env);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handleFederationTopology auth enforcement (US-5.3)
// ─────────────────────────────────────────────

describe('handleFederationTopology auth enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('returns 401 when requireAuth rejects', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = new Request('https://admin.example.com/admin/api/federation/topology', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
    const env: Env = {
      ADMIN_USERS: {} as DurableObjectNamespace,
      ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    };

    const res = await handleFederationTopology(req, env);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handleHeartbeatTimeline auth enforcement (US-5.4)
// ─────────────────────────────────────────────

describe('handleHeartbeatTimeline auth enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('returns 401 when requireAuth rejects', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = new Request('https://admin.example.com/admin/api/servers/heartbeat-timeline', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
    const env: Env = {
      ADMIN_USERS: {} as DurableObjectNamespace,
      ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    };

    const res = await handleHeartbeatTimeline(req, env);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handleListIssues auth enforcement (US-6.3)
// ─────────────────────────────────────────────

describe('handleListIssues auth enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('returns 401 when requireAuth rejects', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = new Request('https://admin.example.com/admin/api/issues', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
    const env: Env = {
      ADMIN_USERS: {} as DurableObjectNamespace,
      ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    };

    const res = await handleListIssues(req, env);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handleIssueDetail auth enforcement (US-6.3)
// ─────────────────────────────────────────────

describe('handleIssueDetail auth enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('returns 401 when requireAuth rejects', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = new Request('https://admin.example.com/admin/api/issues/1', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
    const env: Env = {
      ADMIN_USERS: {} as DurableObjectNamespace,
      ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    };

    const res = await handleIssueDetail(req, env, '1');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handleAcknowledgeIssue auth enforcement (US-6.3)
// ─────────────────────────────────────────────

describe('handleAcknowledgeIssue auth enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('returns 401 when requireAuth rejects', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = new Request('https://admin.example.com/admin/api/issues/1/acknowledge', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    });
    const env: Env = {
      ADMIN_USERS: {} as DurableObjectNamespace,
      ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    };

    const res = await handleAcknowledgeIssue(req, env, '1');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handleAiCosts auth enforcement (US-6.5)
// ─────────────────────────────────────────────

describe('handleAiCosts auth enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('returns 401 when requireAuth rejects', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = new Request('https://admin.example.com/admin/api/ai/costs', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
    const env: Env = {
      ADMIN_USERS: {} as DurableObjectNamespace,
      ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    };

    const res = await handleAiCosts(req, env);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handleRateLimitViolations auth enforcement (US-7.1)
// ─────────────────────────────────────────────

describe('handleRateLimitViolations auth enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('returns 401 when requireAuth rejects', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = new Request('https://admin.example.com/admin/api/security/rate-limits', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
    const env: Env = {
      ADMIN_USERS: {} as DurableObjectNamespace,
      ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    };

    const res = await handleRateLimitViolations(req, env);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handleDdosIndicators auth enforcement (US-7.3)
// ─────────────────────────────────────────────

describe('handleDdosIndicators auth enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('returns 401 when requireAuth rejects', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = new Request('https://admin.example.com/admin/api/security/attacks', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
    const env: Env = {
      ADMIN_USERS: {} as DurableObjectNamespace,
      ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    };

    const res = await handleDdosIndicators(req, env);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handleBadClients auth enforcement (US-7.2)
// ─────────────────────────────────────────────

describe('handleBadClients auth enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('returns 401 when requireAuth rejects', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = new Request('https://admin.example.com/admin/api/security/bad-clients', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
    const env: Env = {
      ADMIN_USERS: {} as DurableObjectNamespace,
      ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    };

    const res = await handleBadClients(req, env);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handlePairingBruteForce auth enforcement (US-7.4)
// ─────────────────────────────────────────────

describe('handlePairingBruteForce auth enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValue({
      sub: 'user-1',
      username: 'admin',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('returns 401 when requireAuth rejects', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = new Request('https://admin.example.com/admin/api/security/pairing-abuse', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
    const env: Env = {
      ADMIN_USERS: {} as DurableObjectNamespace,
      ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    };

    const res = await handlePairingBruteForce(req, env);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handleListAlertRules auth enforcement (US-8.4)
// ─────────────────────────────────────────────

describe('handleListAlertRules auth enforcement', () => {
  it('returns 401 without valid auth', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    );

    const req = new Request('https://admin.test/admin/api/alerts/rules');
    const env: Env = { ADMIN_USERS: {} as unknown as DurableObjectNamespace, ZAJEL_ADMIN_JWT_SECRET: 'test-secret' };
    const res = await handleListAlertRules(req, env);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handleCreateAlertRule super-admin enforcement (US-8.4)
// ─────────────────────────────────────────────

describe('handleCreateAlertRule super-admin enforcement', () => {
  it('returns 403 for non-super-admin', async () => {
    const { requireSuperAdmin } = await import('../../src/routes/auth.js');
    vi.mocked(requireSuperAdmin).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Forbidden' }), { status: 403 })
    );

    const req = new Request('https://admin.test/admin/api/alerts/rules', {
      method: 'POST',
      body: JSON.stringify({ name: 'test' }),
    });
    const env: Env = { ADMIN_USERS: {} as unknown as DurableObjectNamespace, ZAJEL_ADMIN_JWT_SECRET: 'test-secret' };
    const res = await handleCreateAlertRule(req, env);
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────
// handleListAlertHistory auth enforcement (US-8.4)
// ─────────────────────────────────────────────

describe('handleListAlertHistory auth enforcement', () => {
  it('returns 401 without valid auth', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    );

    const req = new Request('https://admin.test/admin/api/alerts/history');
    const env: Env = { ADMIN_USERS: {} as unknown as DurableObjectNamespace, ZAJEL_ADMIN_JWT_SECRET: 'test-secret' };
    const res = await handleListAlertHistory(req, env);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handleAcknowledgeAlert auth enforcement (US-8.4)
// ─────────────────────────────────────────────

describe('handleAcknowledgeAlert auth enforcement', () => {
  it('returns 401 without valid auth', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    );

    const req = new Request('https://admin.test/admin/api/alerts/history/1/acknowledge', { method: 'POST' });
    const env: Env = { ADMIN_USERS: {} as unknown as DurableObjectNamespace, ZAJEL_ADMIN_JWT_SECRET: 'test-secret' };
    const res = await handleAcknowledgeAlert(req, env, '1');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handleListNotifications auth enforcement (US-8.1)
// ─────────────────────────────────────────────

describe('handleListNotifications auth enforcement', () => {
  it('returns 401 without valid auth', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    );

    const req = new Request('https://admin.test/admin/api/notifications');
    const env: Env = { ADMIN_USERS: {} as unknown as DurableObjectNamespace, ZAJEL_ADMIN_JWT_SECRET: 'test-secret' };
    const res = await handleListNotifications(req, env);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handleUnreadCount auth enforcement (US-8.1)
// ─────────────────────────────────────────────

describe('handleUnreadCount auth enforcement', () => {
  it('returns 401 without valid auth', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    );

    const req = new Request('https://admin.test/admin/api/notifications/unread-count');
    const env: Env = { ADMIN_USERS: {} as unknown as DurableObjectNamespace, ZAJEL_ADMIN_JWT_SECRET: 'test-secret' };
    const res = await handleUnreadCount(req, env);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// handleGetNotificationConfig auth enforcement (US-8.2)
// ─────────────────────────────────────────────

describe('handleGetNotificationConfig auth enforcement', () => {
  it('returns 401 without valid auth', async () => {
    const { requireAuth } = await import('../../src/routes/auth.js');
    vi.mocked(requireAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    );

    const req = new Request('https://admin.test/admin/api/notifications/config');
    const env: Env = { ADMIN_USERS: {} as unknown as DurableObjectNamespace, ZAJEL_ADMIN_JWT_SECRET: 'test-secret' };
    const res = await handleGetNotificationConfig(req, env);
    expect(res.status).toBe(401);
  });
});
