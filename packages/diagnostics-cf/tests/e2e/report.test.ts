/**
 * E2E tests for the diagnostic report submission endpoint.
 *
 * Full request-response cycle using mock D1/R2/KV bindings,
 * following the MockStorage/MockState pattern from
 * packages/server/tests/e2e/bootstrap.test.js.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../../src/index.js';
import type { Env, RateLimit } from '../../src/types.js';

/**
 * Mock KV namespace for rate limiting.
 */
class MockKV {
  private store = new Map<string, { value: string; expiration?: number }>();

  async get(key: string, type?: string): Promise<string | Record<string, unknown> | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiration && Date.now() > entry.expiration) {
      this.store.delete(key);
      return null;
    }
    if (type === 'json') {
      return JSON.parse(entry.value) as Record<string, unknown>;
    }
    return entry.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    const expiration = opts?.expirationTtl
      ? Date.now() + opts.expirationTtl * 1000
      : undefined;
    this.store.set(key, { value, expiration });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

/**
 * Mock R2 bucket.
 */
class MockR2Bucket {
  objects = new Map<string, { body: string; httpMetadata?: Record<string, string> }>();

  async put(
    key: string,
    body: string,
    opts?: { httpMetadata?: { contentType?: string } },
  ): Promise<void> {
    this.objects.set(key, {
      body,
      httpMetadata: opts?.httpMetadata as Record<string, string> | undefined,
    });
  }

  async get(key: string): Promise<{ body: string } | null> {
    return this.objects.get(key) ?? null;
  }

  clear(): void {
    this.objects.clear();
  }
}

/**
 * Mock D1Database with in-memory SQLite-like storage.
 * Tracks statements for verification without actual SQL execution.
 */
class MockD1Database {
  statements: Array<{ sql: string; values: unknown[] }> = [];

  prepare(sql: string): MockD1PreparedStatement {
    return new MockD1PreparedStatement(sql, this);
  }

  async batch(stmts: MockD1PreparedStatement[]): Promise<D1Result[]> {
    return stmts.map((stmt) => {
      this.statements.push({ sql: stmt.sql, values: stmt.boundValues });
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
    });
  }

  clear(): void {
    this.statements = [];
  }
}

class MockD1PreparedStatement {
  sql: string;
  boundValues: unknown[] = [];
  private db: MockD1Database;

  constructor(sql: string, db: MockD1Database) {
    this.sql = sql;
    this.db = db;
  }

  bind(...values: unknown[]): MockD1PreparedStatement {
    this.boundValues = values;
    return this;
  }

  async run(): Promise<D1Result> {
    this.db.statements.push({ sql: this.sql, values: this.boundValues });
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
      meta: { duration: 0, rows_read: 0, rows_written: 0, last_row_id: 0, changed_db: false, changes: 0, size_after: 0 },
    };
  }

  async raw(): Promise<unknown[][]> {
    return [];
  }
}

/**
 * Mock rate limiter (global).
 */
class MockGlobalRateLimiter implements RateLimit {
  private shouldSucceed = true;

  async limit(_config: { key: string }): Promise<{ success: boolean }> {
    return { success: this.shouldSucceed };
  }

  setBlocked(blocked: boolean): void {
    this.shouldSucceed = !blocked;
  }
}

/**
 * Create a mock ExecutionContext.
 */
function createMockContext(): ExecutionContext {
  const waitUntilPromises: Promise<unknown>[] = [];
  return {
    waitUntil(promise: Promise<unknown>): void {
      waitUntilPromises.push(promise);
    },
    passThroughOnException(): void {
      // no-op
    },
    // Non-standard: expose promises for test assertions
    _waitUntilPromises: waitUntilPromises,
  } as unknown as ExecutionContext;
}

/**
 * Create mock environment bindings.
 */
function createMockEnv(overrides: Partial<{
  kv: MockKV;
  r2: MockR2Bucket;
  db: MockD1Database;
  rateLimiter: MockGlobalRateLimiter;
}> = {}): {
  env: Env;
  kv: MockKV;
  r2: MockR2Bucket;
  db: MockD1Database;
  rateLimiter: MockGlobalRateLimiter;
} {
  const kv = overrides.kv ?? new MockKV();
  const r2 = overrides.r2 ?? new MockR2Bucket();
  const db = overrides.db ?? new MockD1Database();
  const rateLimiter = overrides.rateLimiter ?? new MockGlobalRateLimiter();

  return {
    env: {
      DB: db as unknown as D1Database,
      REPORTS_BUCKET: r2 as unknown as R2Bucket,
      RATE_LIMIT_KV: kv as unknown as KVNamespace,
      GLOBAL_RATE_LIMITER: rateLimiter,
    },
    kv,
    r2,
    db,
    rateLimiter,
  };
}

/**
 * Helper to create a valid report body.
 */
function validReportBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionHash: 'a'.repeat(64),
    appVersion: '1.2.3',
    buildNumber: '42',
    platform: 'android',
    platformVersion: 'Android 14',
    locale: 'en-US',
    timestamp: 1709380800000,
    ...overrides,
  };
}

/**
 * Helper to create a JSON POST request.
 */
function createPostRequest(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://test.workers.dev${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Helper to create a GET request.
 */
function createGetRequest(path: string): Request {
  return new Request(`https://test.workers.dev${path}`, {
    method: 'GET',
  });
}

/**
 * Drain waitUntil promises from the execution context.
 */
async function drainWaitUntil(ctx: ExecutionContext): Promise<void> {
  const promises = (ctx as unknown as { _waitUntilPromises: Promise<unknown>[] })._waitUntilPromises;
  await Promise.allSettled(promises);
}

describe('Diagnostics Worker E2E Tests', () => {
  let env: Env;
  let kv: MockKV;
  let r2: MockR2Bucket;
  let db: MockD1Database;
  let rateLimiter: MockGlobalRateLimiter;
  let ctx: ExecutionContext;

  beforeEach(() => {
    const mocks = createMockEnv();
    env = mocks.env;
    kv = mocks.kv;
    r2 = mocks.r2;
    db = mocks.db;
    rateLimiter = mocks.rateLimiter;
    ctx = createMockContext();
  });

  afterEach(() => {
    kv.clear();
    r2.clear();
    db.clear();
  });

  describe('GET /diagnostics/health', () => {
    it('should return 200 with service info', async () => {
      const request = createGetRequest('/diagnostics/health');
      const response = await worker.fetch(request, env, ctx);
      const data = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(data['status']).toBe('ok');
      expect(data['service']).toBe('zajel-diagnostics');
      expect(data['timestamp']).toBeDefined();
    });

    it('should include CORS headers', async () => {
      const request = createGetRequest('/diagnostics/health');
      const response = await worker.fetch(request, env, ctx);

      expect(response.headers.get('Access-Control-Allow-Origin')).toBeDefined();
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
      expect(response.headers.get('Content-Type')).toBe('application/json');
    });
  });

  describe('CORS preflight', () => {
    it('should return 204 for OPTIONS request', async () => {
      const request = new Request('https://test.workers.dev/diagnostics/report', {
        method: 'OPTIONS',
      });
      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
      expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
    });
  });

  describe('POST /diagnostics/report - Valid submissions', () => {
    it('should return 200 with reportId for a valid report', async () => {
      const request = createPostRequest('/diagnostics/report', validReportBody());
      const response = await worker.fetch(request, env, ctx);
      const data = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(data['success']).toBe(true);
      expect(data['data']).toBeDefined();
      const reportData = data['data'] as Record<string, unknown>;
      expect(reportData['reportId']).toContain('diagnostics/');
      expect(reportData['reportId']).toContain('a'.repeat(64));
    });

    it('should store the raw report in R2', async () => {
      const request = createPostRequest('/diagnostics/report', validReportBody());
      await worker.fetch(request, env, ctx);

      expect(r2.objects.size).toBe(1);
      const key = Array.from(r2.objects.keys())[0]!;
      expect(key).toMatch(/^diagnostics\/\d{4}\/\d{2}\/\d{2}\/\d{2}\//);

      const stored = r2.objects.get(key)!;
      const storedBody = JSON.parse(stored.body) as Record<string, unknown>;
      expect(storedBody['sessionHash']).toBe('a'.repeat(64));
    });

    it('should aggregate errors in D1', async () => {
      const body = validReportBody({
        errors: [
          {
            category: 'crypto',
            message: 'decrypt failed',
            signature: 'sig123',
            count: 3,
            firstOccurrence: 1709380700000,
            lastOccurrence: 1709380800000,
          },
        ],
      });

      const request = createPostRequest('/diagnostics/report', body);
      await worker.fetch(request, env, ctx);
      await drainWaitUntil(ctx);

      // D1 should have received error aggregate statements
      const errorStmts = db.statements.filter((s) => s.sql.includes('error_aggregates'));
      expect(errorStmts.length).toBeGreaterThan(0);
    });

    it('should aggregate performance metrics in D1', async () => {
      const body = validReportBody({
        performance: {
          startupTimeMs: 1200,
          frameRateAvg: 58.5,
        },
      });

      const request = createPostRequest('/diagnostics/report', body);
      await worker.fetch(request, env, ctx);
      await drainWaitUntil(ctx);

      const perfStmts = db.statements.filter((s) => s.sql.includes('performance_aggregates'));
      expect(perfStmts.length).toBeGreaterThan(0);
    });

    it('should aggregate network metrics in D1', async () => {
      const body = validReportBody({
        network: {
          signalingConnectSuccessRate: 0.95,
          signalingConnectAttempts: 20,
        },
      });

      const request = createPostRequest('/diagnostics/report', body);
      await worker.fetch(request, env, ctx);
      await drainWaitUntil(ctx);

      const netStmts = db.statements.filter((s) => s.sql.includes('network_aggregates'));
      expect(netStmts.length).toBeGreaterThan(0);
    });

    it('should update client heartbeat in D1', async () => {
      const request = createPostRequest('/diagnostics/report', validReportBody());
      await worker.fetch(request, env, ctx);
      await drainWaitUntil(ctx);

      const heartbeatStmts = db.statements.filter((s) => s.sql.includes('client_heartbeats'));
      expect(heartbeatStmts.length).toBeGreaterThan(0);
    });

    it('should include CORS headers on success response', async () => {
      const request = createPostRequest('/diagnostics/report', validReportBody());
      const response = await worker.fetch(request, env, ctx);

      expect(response.headers.get('Access-Control-Allow-Origin')).toBeDefined();
      expect(response.headers.get('Content-Type')).toBe('application/json');
    });

    it('should build correct R2 key path from timestamp', async () => {
      // timestamp 1709380800000 = 2024-03-02T12:00:00.000Z
      const body = validReportBody({ timestamp: 1709380800000 });
      const request = createPostRequest('/diagnostics/report', body);
      const response = await worker.fetch(request, env, ctx);
      const data = await response.json() as Record<string, unknown>;
      const reportData = data['data'] as Record<string, unknown>;

      expect(reportData['reportId']).toBe(
        `diagnostics/2024/03/02/12/${'a'.repeat(64)}_1709380800000.json`,
      );
    });
  });

  describe('POST /diagnostics/report - Schema validation errors', () => {
    it('should return 400 for missing required field', async () => {
      const body = validReportBody();
      delete body['sessionHash'];

      const request = createPostRequest('/diagnostics/report', body);
      const response = await worker.fetch(request, env, ctx);
      const data = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(400);
      expect(data['success']).toBe(false);
      expect(data['error']).toContain('sessionHash');
    });

    it('should return 400 for invalid platform', async () => {
      const body = validReportBody({ platform: 'chromeos' });

      const request = createPostRequest('/diagnostics/report', body);
      const response = await worker.fetch(request, env, ctx);
      const data = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(400);
      expect(data['success']).toBe(false);
      expect(data['error']).toContain('platform');
    });

    it('should return 400 for malformed sessionHash', async () => {
      const body = validReportBody({ sessionHash: 'not-a-hash' });

      const request = createPostRequest('/diagnostics/report', body);
      const response = await worker.fetch(request, env, ctx);
      const data = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(400);
      expect(data['success']).toBe(false);
      expect(data['error']).toContain('64-character hex');
    });

    it('should return 400 for invalid JSON body', async () => {
      const request = new Request('https://test.workers.dev/diagnostics/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });
      const response = await worker.fetch(request, env, ctx);
      const data = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(400);
      expect(data['success']).toBe(false);
      expect(data['error']).toContain('Invalid JSON');
    });

    it('should return 400 for wrong Content-Type', async () => {
      const request = new Request('https://test.workers.dev/diagnostics/report', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(validReportBody()),
      });
      const response = await worker.fetch(request, env, ctx);
      const data = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(400);
      expect(data['success']).toBe(false);
      expect(data['error']).toContain('Content-Type');
    });

    it('should return 400 for invalid error category in errors array', async () => {
      const body = validReportBody({
        errors: [
          {
            category: 'badcat',
            message: 'msg',
            signature: 'sig',
            count: 1,
            firstOccurrence: 1000,
            lastOccurrence: 2000,
          },
        ],
      });

      const request = createPostRequest('/diagnostics/report', body);
      const response = await worker.fetch(request, env, ctx);
      const data = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(400);
      expect(data['success']).toBe(false);
      expect(data['error']).toContain('category');
    });
  });

  describe('POST /diagnostics/report - Body size limit', () => {
    it('should return 413 for oversized request body', async () => {
      const largeBody = validReportBody({
        // Create a body larger than 64KB
        errors: Array.from({ length: 1000 }, (_, i) => ({
          category: 'other',
          message: 'x'.repeat(100),
          signature: `sig${i}`,
          count: 1,
          firstOccurrence: 1000,
          lastOccurrence: 2000,
          stackTrace: 'x'.repeat(200),
        })),
      });

      const bodyString = JSON.stringify(largeBody);
      // Verify the body is actually > 64KB
      expect(new TextEncoder().encode(bodyString).length).toBeGreaterThan(64 * 1024);

      const request = new Request('https://test.workers.dev/diagnostics/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(new TextEncoder().encode(bodyString).length),
        },
        body: bodyString,
      });

      const response = await worker.fetch(request, env, ctx);
      const data = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(413);
      expect(data['success']).toBe(false);
      expect(data['error']).toContain('maximum size');
    });
  });

  describe('POST /diagnostics/report - Rate limiting', () => {
    it('should return 429 when session rate limit is exceeded', async () => {
      const body = validReportBody();
      let lastResponse: Response | null = null;

      // Submit 10 reports (the limit)
      for (let i = 0; i < 10; i++) {
        const request = createPostRequest('/diagnostics/report', body);
        const response = await worker.fetch(request, env, createMockContext());
        expect(response.status).toBe(200);
      }

      // 11th should be rate limited
      const request = createPostRequest('/diagnostics/report', body);
      lastResponse = await worker.fetch(request, env, createMockContext());
      const data = await lastResponse.json() as Record<string, unknown>;

      expect(lastResponse.status).toBe(429);
      expect(data['success']).toBe(false);
      expect(data['error']).toContain('Rate limit exceeded');
      expect(data['error']).toContain('10');
    });

    it('should allow different sessions independently', async () => {
      // Fill up one session's rate limit
      for (let i = 0; i < 10; i++) {
        const body = validReportBody({ sessionHash: 'a'.repeat(64) });
        const request = createPostRequest('/diagnostics/report', body);
        const response = await worker.fetch(request, env, createMockContext());
        expect(response.status).toBe(200);
      }

      // A different session should still be allowed
      const body = validReportBody({ sessionHash: 'b'.repeat(64) });
      const request = createPostRequest('/diagnostics/report', body);
      const response = await worker.fetch(request, env, createMockContext());

      expect(response.status).toBe(200);
    });

    it('should return 429 when global rate limit is exceeded', async () => {
      rateLimiter.setBlocked(true);

      const request = createPostRequest('/diagnostics/report', validReportBody());
      const response = await worker.fetch(request, env, ctx);
      const data = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(429);
      expect(data['success']).toBe(false);
      expect(data['error']).toContain('high traffic');
    });
  });

  describe('Error handling', () => {
    it('should return 404 for unknown paths', async () => {
      const request = createGetRequest('/unknown/path');
      const response = await worker.fetch(request, env, ctx);
      const data = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(404);
      expect(data['success']).toBe(false);
      expect(data['error']).toContain('Not found');
    });

    it('should return 404 for GET /diagnostics/report', async () => {
      const request = createGetRequest('/diagnostics/report');
      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(404);
    });

    it('should still succeed if R2 write fails', async () => {
      // Make R2 throw
      const failingR2 = {
        put: async () => {
          throw new Error('R2 write failed');
        },
      } as unknown as R2Bucket;

      const testEnv: Env = {
        ...env,
        REPORTS_BUCKET: failingR2,
      };

      const request = createPostRequest('/diagnostics/report', validReportBody());
      const response = await worker.fetch(request, testEnv, createMockContext());
      const data = await response.json() as Record<string, unknown>;

      // Should still return 200 (D1 aggregation can still proceed)
      expect(response.status).toBe(200);
      expect(data['success']).toBe(true);
    });

    it('should include CORS headers on error responses', async () => {
      const request = createGetRequest('/unknown');
      const response = await worker.fetch(request, env, ctx);

      expect(response.headers.get('Access-Control-Allow-Origin')).toBeDefined();
    });
  });

  describe('R2 storage verification', () => {
    it('should store report with correct JSON content', async () => {
      const reportBody = validReportBody({
        errors: [
          {
            category: 'crypto',
            message: 'test error',
            signature: 'sig',
            count: 1,
            firstOccurrence: 1000,
            lastOccurrence: 2000,
          },
        ],
        performance: { startupTimeMs: 500 },
      });

      const request = createPostRequest('/diagnostics/report', reportBody);
      await worker.fetch(request, env, ctx);

      expect(r2.objects.size).toBe(1);
      const storedEntry = Array.from(r2.objects.values())[0]!;
      const parsed = JSON.parse(storedEntry.body) as Record<string, unknown>;

      expect(parsed['appVersion']).toBe('1.2.3');
      expect(parsed['platform']).toBe('android');
      expect((parsed['errors'] as unknown[]).length).toBe(1);
      expect((parsed['performance'] as Record<string, unknown>)['startupTimeMs']).toBe(500);
    });

    it('should use correct R2 key format', async () => {
      const request = createPostRequest('/diagnostics/report', validReportBody());
      const response = await worker.fetch(request, env, ctx);
      const data = await response.json() as Record<string, unknown>;
      const reportData = data['data'] as Record<string, unknown>;

      const key = reportData['reportId'] as string;
      // Format: diagnostics/{YYYY}/{MM}/{DD}/{HH}/{sessionHash}_{timestamp}.json
      expect(key).toMatch(
        /^diagnostics\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/[a-f0-9]{64}_\d+\.json$/,
      );
    });
  });

  describe('Multiple reports', () => {
    it('should handle multiple valid reports in sequence', async () => {
      for (let i = 0; i < 5; i++) {
        const body = validReportBody({
          sessionHash: `${'a'.repeat(62)}${String(i).padStart(2, '0')}`,
          timestamp: 1709380800000 + i * 1000,
        });

        const request = createPostRequest('/diagnostics/report', body);
        const response = await worker.fetch(request, env, createMockContext());

        expect(response.status).toBe(200);
      }

      // Each report should be stored in R2
      expect(r2.objects.size).toBe(5);
    });
  });
});
