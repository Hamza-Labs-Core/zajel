/**
 * Unit tests for regression detection (US-2.4)
 *
 * Tests:
 *   - compareSemver utility
 *   - handleErrorRegressions handler with mock D1 data
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { compareSemver, handleErrorRegressions } from '../../src/routes/errors.js';
import type { Env } from '../../src/types.js';

// ─────────────────────────────────────────────
// Mock auth module — bypass JWT verification.
// With isolate: false, vi.mock must be declared in every file that imports
// from the handler module (errors.ts), because vi.mock is hoisted and must
// run before the handler's import of auth.js.
// ─────────────────────────────────────────────

vi.mock('../../src/routes/auth.js', () => ({
  requireAuth: vi.fn().mockResolvedValue({
    sub: 'user-1',
    username: 'admin',
    role: 'admin',
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

/**
 * Create a mock D1Database that returns different results based on query content.
 */
function createMockD1ForRegressions(opts: {
  versions?: string[];
  aggregates?: Array<{
    error_signature: string;
    category: string;
    app_version: string;
    total_count: number;
    first_bucket: string;
    sample_message: string;
  }>;
}): D1Database {
  const prepareFn = vi.fn().mockImplementation((query: string) => {
    if (query.includes('SELECT DISTINCT app_version')) {
      const results = (opts.versions || []).map(v => ({ app_version: v }));
      return createMockStatement(results);
    }
    if (query.includes('GROUP BY error_signature, category, app_version')) {
      return createMockStatement(opts.aggregates || []);
    }
    return createMockStatement([]);
  });

  return { prepare: prepareFn } as unknown as D1Database;
}

// ─────────────────────────────────────────────
// compareSemver Tests
// ─────────────────────────────────────────────

describe('compareSemver', () => {
  it('compares equal versions', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
  });

  it('compares major version difference', () => {
    expect(compareSemver('2.0.0', '1.0.0')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '2.0.0')).toBeLessThan(0);
  });

  it('compares minor version difference', () => {
    expect(compareSemver('1.2.0', '1.1.0')).toBeGreaterThan(0);
    expect(compareSemver('1.1.0', '1.2.0')).toBeLessThan(0);
  });

  it('compares patch version difference', () => {
    expect(compareSemver('1.0.2', '1.0.1')).toBeGreaterThan(0);
    expect(compareSemver('1.0.1', '1.0.2')).toBeLessThan(0);
  });

  it('orders 1.10.0 after 1.3.0 (numeric, not lexicographic)', () => {
    expect(compareSemver('1.10.0', '1.3.0')).toBeGreaterThan(0);
    expect(compareSemver('1.3.0', '1.10.0')).toBeLessThan(0);
  });

  it('correctly sorts ["1.2.0", "1.10.0", "1.3.0"]', () => {
    const versions = ['1.2.0', '1.10.0', '1.3.0'];
    versions.sort(compareSemver);
    expect(versions).toEqual(['1.2.0', '1.3.0', '1.10.0']);
  });

  it('handles versions with different segment counts', () => {
    expect(compareSemver('1.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.0.1', '1.0')).toBeGreaterThan(0);
  });

  it('falls back to lexicographic for non-numeric segments', () => {
    expect(compareSemver('1.3.0-beta', '1.3.0-alpha')).toBeGreaterThan(0);
    expect(compareSemver('1.3.0-alpha', '1.3.0-beta')).toBeLessThan(0);
  });

  it('handles single-segment versions', () => {
    expect(compareSemver('2', '1')).toBeGreaterThan(0);
    expect(compareSemver('1', '2')).toBeLessThan(0);
    expect(compareSemver('1', '1')).toBe(0);
  });
});

// ─────────────────────────────────────────────
// handleErrorRegressions Tests
// ─────────────────────────────────────────────

describe('handleErrorRegressions', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-establish the default mock after clearing
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
    it('returns 200 with empty regressions', async () => {
      const req = createRequest('/admin/api/errors/regressions');
      const env = createEnv(undefined);

      const res = await handleErrorRegressions(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as { success: boolean; data: { regressions: unknown[]; window: string; threshold: number } };
      expect(body.success).toBe(true);
      expect(body.data.regressions).toEqual([]);
      expect(body.data.window).toBe('24h');
      expect(body.data.threshold).toBe(3.0);
    });
  });

  // ─── Query param validation ───

  describe('query parameter validation', () => {
    it('rejects invalid window', async () => {
      const db = createMockD1ForRegressions({ versions: [] });
      const req = createRequest('/admin/api/errors/regressions?window=12h');
      const env = createEnv(db);

      const res = await handleErrorRegressions(req, env);
      expect(res.status).toBe(400);

      const body = await res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('Invalid window');
    });

    it('rejects threshold below 1.0', async () => {
      const db = createMockD1ForRegressions({ versions: [] });
      const req = createRequest('/admin/api/errors/regressions?threshold=0.5');
      const env = createEnv(db);

      const res = await handleErrorRegressions(req, env);
      expect(res.status).toBe(400);

      const body = await res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('Invalid threshold');
    });

    it('rejects non-numeric threshold', async () => {
      const db = createMockD1ForRegressions({ versions: [] });
      const req = createRequest('/admin/api/errors/regressions?threshold=abc');
      const env = createEnv(db);

      const res = await handleErrorRegressions(req, env);
      expect(res.status).toBe(400);

      const body = await res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('Invalid threshold');
    });

    it('accepts valid window and threshold params', async () => {
      const db = createMockD1ForRegressions({ versions: ['1.0.0'] });
      const req = createRequest('/admin/api/errors/regressions?window=6h&threshold=2.0');
      const env = createEnv(db);

      const res = await handleErrorRegressions(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as { data: { window: string; threshold: number } };
      expect(body.data.window).toBe('6h');
      expect(body.data.threshold).toBe(2.0);
    });
  });

  // ─── Only one version: empty regressions ───

  describe('when only one version exists', () => {
    it('returns empty regressions', async () => {
      const db = createMockD1ForRegressions({ versions: ['1.0.0'] });
      const req = createRequest('/admin/api/errors/regressions');
      const env = createEnv(db);

      const res = await handleErrorRegressions(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as { data: { regressions: unknown[]; currentVersion: string; previousVersion: string } };
      expect(body.data.regressions).toEqual([]);
      expect(body.data.currentVersion).toBe('1.0.0');
      expect(body.data.previousVersion).toBe('');
    });
  });

  // ─── Regression detection scenarios ───

  describe('regression detection', () => {
    it('flags a 4x rate increase as regression', async () => {
      const now = new Date().toISOString();
      const db = createMockD1ForRegressions({
        versions: ['1.2.0', '1.3.0'],
        aggregates: [
          {
            error_signature: 'abc123',
            category: 'crypto',
            app_version: '1.3.0',
            total_count: 240,  // 240 / 24h = 10/hr
            first_bucket: now,
            sample_message: 'Decrypt failed',
          },
          {
            error_signature: 'abc123',
            category: 'crypto',
            app_version: '1.2.0',
            total_count: 60,  // 60 / 24h = 2.5/hr  => multiplier = 4.0
            first_bucket: now,
            sample_message: 'Decrypt failed',
          },
        ],
      });

      const req = createRequest('/admin/api/errors/regressions?window=24h&threshold=3.0');
      const env = createEnv(db);

      const res = await handleErrorRegressions(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as { data: { regressions: Array<{ errorSignature: string; multiplier: number; category: string }> } };
      expect(body.data.regressions).toHaveLength(1);
      expect(body.data.regressions[0]!.errorSignature).toBe('abc123');
      expect(body.data.regressions[0]!.multiplier).toBe(4);
      expect(body.data.regressions[0]!.category).toBe('crypto');
    });

    it('does NOT flag a 2x rate increase (below 3.0 threshold)', async () => {
      const now = new Date().toISOString();
      const db = createMockD1ForRegressions({
        versions: ['1.2.0', '1.3.0'],
        aggregates: [
          {
            error_signature: 'abc123',
            category: 'crypto',
            app_version: '1.3.0',
            total_count: 120,  // 120 / 24h = 5/hr
            first_bucket: now,
            sample_message: 'Decrypt failed',
          },
          {
            error_signature: 'abc123',
            category: 'crypto',
            app_version: '1.2.0',
            total_count: 60,  // 60 / 24h = 2.5/hr  => multiplier = 2.0
            first_bucket: now,
            sample_message: 'Decrypt failed',
          },
        ],
      });

      const req = createRequest('/admin/api/errors/regressions?window=24h&threshold=3.0');
      const env = createEnv(db);

      const res = await handleErrorRegressions(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as { data: { regressions: unknown[] } };
      expect(body.data.regressions).toHaveLength(0);
    });

    it('flags new signature in current version with count >= 10', async () => {
      const now = new Date().toISOString();
      const db = createMockD1ForRegressions({
        versions: ['1.2.0', '1.3.0'],
        aggregates: [
          {
            error_signature: 'new_sig_123',
            category: 'network',
            app_version: '1.3.0',
            total_count: 15,  // Only in current version, count >= 10
            first_bucket: now,
            sample_message: 'Connection timeout',
          },
        ],
      });

      const req = createRequest('/admin/api/errors/regressions?window=24h');
      const env = createEnv(db);

      const res = await handleErrorRegressions(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as { data: { regressions: Array<{ errorSignature: string; multiplier: number; previousTotal: number }> } };
      expect(body.data.regressions).toHaveLength(1);
      expect(body.data.regressions[0]!.errorSignature).toBe('new_sig_123');
      expect(body.data.regressions[0]!.multiplier).toBe(999.9); // Infinity capped
      expect(body.data.regressions[0]!.previousTotal).toBe(0);
    });

    it('does NOT flag new signature with count < 10', async () => {
      const now = new Date().toISOString();
      const db = createMockD1ForRegressions({
        versions: ['1.2.0', '1.3.0'],
        aggregates: [
          {
            error_signature: 'rare_sig',
            category: 'network',
            app_version: '1.3.0',
            total_count: 3,  // Only in current version, but below threshold of 10
            first_bucket: now,
            sample_message: 'Rare error',
          },
        ],
      });

      const req = createRequest('/admin/api/errors/regressions?window=24h');
      const env = createEnv(db);

      const res = await handleErrorRegressions(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as { data: { regressions: unknown[] } };
      expect(body.data.regressions).toHaveLength(0);
    });

    it('sorts regressions by multiplier descending', async () => {
      const now = new Date().toISOString();
      const db = createMockD1ForRegressions({
        versions: ['1.2.0', '1.3.0'],
        aggregates: [
          // Signature A: 4x regression
          {
            error_signature: 'sig_a',
            category: 'crypto',
            app_version: '1.3.0',
            total_count: 240,
            first_bucket: now,
            sample_message: 'Error A',
          },
          {
            error_signature: 'sig_a',
            category: 'crypto',
            app_version: '1.2.0',
            total_count: 60,
            first_bucket: now,
            sample_message: 'Error A',
          },
          // Signature B: 6x regression
          {
            error_signature: 'sig_b',
            category: 'network',
            app_version: '1.3.0',
            total_count: 360,
            first_bucket: now,
            sample_message: 'Error B',
          },
          {
            error_signature: 'sig_b',
            category: 'network',
            app_version: '1.2.0',
            total_count: 60,
            first_bucket: now,
            sample_message: 'Error B',
          },
        ],
      });

      const req = createRequest('/admin/api/errors/regressions?window=24h');
      const env = createEnv(db);

      const res = await handleErrorRegressions(req, env);
      const body = await res.json() as { data: { regressions: Array<{ errorSignature: string; multiplier: number }> } };

      expect(body.data.regressions).toHaveLength(2);
      expect(body.data.regressions[0]!.errorSignature).toBe('sig_b');
      expect(body.data.regressions[0]!.multiplier).toBe(6);
      expect(body.data.regressions[1]!.errorSignature).toBe('sig_a');
      expect(body.data.regressions[1]!.multiplier).toBe(4);
    });

    it('uses custom threshold (e.g., 2.0)', async () => {
      const now = new Date().toISOString();
      const db = createMockD1ForRegressions({
        versions: ['1.2.0', '1.3.0'],
        aggregates: [
          {
            error_signature: 'abc123',
            category: 'crypto',
            app_version: '1.3.0',
            total_count: 120,  // 120 / 24h = 5/hr
            first_bucket: now,
            sample_message: 'Decrypt failed',
          },
          {
            error_signature: 'abc123',
            category: 'crypto',
            app_version: '1.2.0',
            total_count: 48,  // 48 / 24h = 2/hr  => multiplier = 2.5
            first_bucket: now,
            sample_message: 'Decrypt failed',
          },
        ],
      });

      // With threshold=2.0, a 2.5x increase should be flagged
      const req = createRequest('/admin/api/errors/regressions?window=24h&threshold=2.0');
      const env = createEnv(db);

      const res = await handleErrorRegressions(req, env);
      const body = await res.json() as { data: { regressions: Array<{ multiplier: number }>; threshold: number } };

      expect(body.data.threshold).toBe(2.0);
      expect(body.data.regressions).toHaveLength(1);
      expect(body.data.regressions[0]!.multiplier).toBe(2.5);
    });

    it('does not flag resolved errors (only in previous version)', async () => {
      const now = new Date().toISOString();
      const db = createMockD1ForRegressions({
        versions: ['1.2.0', '1.3.0'],
        aggregates: [
          // Only in previous version -- resolved, not a regression
          {
            error_signature: 'resolved_sig',
            category: 'crash',
            app_version: '1.2.0',
            total_count: 100,
            first_bucket: now,
            sample_message: 'Old crash',
          },
        ],
      });

      const req = createRequest('/admin/api/errors/regressions?window=24h');
      const env = createEnv(db);

      const res = await handleErrorRegressions(req, env);
      const body = await res.json() as { data: { regressions: unknown[] } };

      expect(body.data.regressions).toHaveLength(0);
    });
  });

  // ─── Version ordering ───

  describe('version ordering', () => {
    it('identifies 1.10.0 as current and 1.3.0 as previous from ["1.2.0", "1.10.0", "1.3.0"]', async () => {
      const db = createMockD1ForRegressions({
        versions: ['1.2.0', '1.10.0', '1.3.0'],
        aggregates: [],
      });

      const req = createRequest('/admin/api/errors/regressions');
      const env = createEnv(db);

      const res = await handleErrorRegressions(req, env);
      const body = await res.json() as { data: { currentVersion: string; previousVersion: string } };

      expect(body.data.currentVersion).toBe('1.10.0');
      expect(body.data.previousVersion).toBe('1.3.0');
    });
  });

  // ─── Response structure ───

  describe('response structure', () => {
    it('returns all expected fields', async () => {
      const db = createMockD1ForRegressions({ versions: ['1.0.0', '1.1.0'], aggregates: [] });
      const req = createRequest('/admin/api/errors/regressions');
      const env = createEnv(db);

      const res = await handleErrorRegressions(req, env);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/json');
      expect(res.headers.get('Cache-Control')).toBe('no-store');

      const body = await res.json() as {
        success: boolean;
        data: {
          regressions: unknown[];
          currentVersion: string;
          previousVersion: string;
          window: string;
          threshold: number;
          computedAt: number;
        };
      };

      expect(body.success).toBe(true);
      expect(Array.isArray(body.data.regressions)).toBe(true);
      expect(typeof body.data.currentVersion).toBe('string');
      expect(typeof body.data.previousVersion).toBe('string');
      expect(typeof body.data.window).toBe('string');
      expect(typeof body.data.threshold).toBe('number');
      expect(typeof body.data.computedAt).toBe('number');
    });

    it('regression objects contain all expected fields', async () => {
      const now = new Date().toISOString();
      const db = createMockD1ForRegressions({
        versions: ['1.2.0', '1.3.0'],
        aggregates: [
          {
            error_signature: 'abc123',
            category: 'crypto',
            app_version: '1.3.0',
            total_count: 240,
            first_bucket: now,
            sample_message: 'Decrypt failed',
          },
          {
            error_signature: 'abc123',
            category: 'crypto',
            app_version: '1.2.0',
            total_count: 60,
            first_bucket: now,
            sample_message: 'Decrypt failed',
          },
        ],
      });

      const req = createRequest('/admin/api/errors/regressions');
      const env = createEnv(db);

      const res = await handleErrorRegressions(req, env);
      const body = await res.json() as {
        data: {
          regressions: Array<{
            errorSignature: string;
            category: string;
            currentVersion: string;
            previousVersion: string;
            currentRate: number;
            previousRate: number;
            multiplier: number;
            currentTotal: number;
            previousTotal: number;
            firstDetected: number;
            sampleMessage: string;
          }>;
        };
      };

      const reg = body.data.regressions[0]!;
      expect(typeof reg.errorSignature).toBe('string');
      expect(typeof reg.category).toBe('string');
      expect(typeof reg.currentVersion).toBe('string');
      expect(typeof reg.previousVersion).toBe('string');
      expect(typeof reg.currentRate).toBe('number');
      expect(typeof reg.previousRate).toBe('number');
      expect(typeof reg.multiplier).toBe('number');
      expect(typeof reg.currentTotal).toBe('number');
      expect(typeof reg.previousTotal).toBe('number');
      expect(typeof reg.firstDetected).toBe('number');
      expect(typeof reg.sampleMessage).toBe('string');
    });
  });

  // ─── Auth enforcement for handleErrorRegressions is in errors.test.ts ───
  // (see comment at top: vi.mock identity issue with isolate: false)

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

      const req = createRequest('/admin/api/errors/regressions');
      const env = createEnv(db);

      const res = await handleErrorRegressions(req, env);
      expect(res.status).toBe(500);

      const body = await res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('Failed to compute regressions');
    });
  });

  // ─── Window parameter ───

  describe('window parameter', () => {
    it('accepts 6h window', async () => {
      const db = createMockD1ForRegressions({ versions: ['1.0.0'] });
      const req = createRequest('/admin/api/errors/regressions?window=6h');
      const env = createEnv(db);

      const res = await handleErrorRegressions(req, env);
      const body = await res.json() as { data: { window: string } };
      expect(body.data.window).toBe('6h');
    });

    it('accepts 48h window', async () => {
      const db = createMockD1ForRegressions({ versions: ['1.0.0'] });
      const req = createRequest('/admin/api/errors/regressions?window=48h');
      const env = createEnv(db);

      const res = await handleErrorRegressions(req, env);
      const body = await res.json() as { data: { window: string } };
      expect(body.data.window).toBe('48h');
    });

    it('defaults to 24h window', async () => {
      const db = createMockD1ForRegressions({ versions: ['1.0.0'] });
      const req = createRequest('/admin/api/errors/regressions');
      const env = createEnv(db);

      const res = await handleErrorRegressions(req, env);
      const body = await res.json() as { data: { window: string } };
      expect(body.data.window).toBe('24h');
    });
  });

  // ─── Division by zero edge case ───

  describe('division by zero edge case', () => {
    it('handles signature in current version with zero in previous version', async () => {
      const now = new Date().toISOString();
      const db = createMockD1ForRegressions({
        versions: ['1.2.0', '1.3.0'],
        aggregates: [
          {
            error_signature: 'zero_prev',
            category: 'crash',
            app_version: '1.3.0',
            total_count: 50,
            first_bucket: now,
            sample_message: 'New crash',
          },
          // Previous version has this signature but 0 count
          {
            error_signature: 'zero_prev',
            category: 'crash',
            app_version: '1.2.0',
            total_count: 0,
            first_bucket: now,
            sample_message: 'New crash',
          },
        ],
      });

      const req = createRequest('/admin/api/errors/regressions');
      const env = createEnv(db);

      const res = await handleErrorRegressions(req, env);
      const body = await res.json() as { data: { regressions: Array<{ multiplier: number }> } };

      // count >= 10, so it should be flagged with capped multiplier
      expect(body.data.regressions).toHaveLength(1);
      expect(body.data.regressions[0]!.multiplier).toBe(999.9);
    });
  });

  // ─── Hysteresis threshold (1.5x to clear) ───

  describe('hysteresis threshold', () => {
    it('1.3x rate would be cleared (below 1.5 hysteresis) -- not flagged with 3.0 threshold', async () => {
      const now = new Date().toISOString();
      const db = createMockD1ForRegressions({
        versions: ['1.2.0', '1.3.0'],
        aggregates: [
          {
            error_signature: 'clearing_sig',
            category: 'network',
            app_version: '1.3.0',
            total_count: 130,
            first_bucket: now,
            sample_message: 'Minor increase',
          },
          {
            error_signature: 'clearing_sig',
            category: 'network',
            app_version: '1.2.0',
            total_count: 100,  // 1.3x multiplier -- below both 3.0 flag and 1.5 clear threshold
            first_bucket: now,
            sample_message: 'Minor increase',
          },
        ],
      });

      const req = createRequest('/admin/api/errors/regressions');
      const env = createEnv(db);

      const res = await handleErrorRegressions(req, env);
      const body = await res.json() as { data: { regressions: unknown[] } };

      // 1.3x is below 3.0 threshold, so not flagged
      expect(body.data.regressions).toHaveLength(0);
    });
  });
});
