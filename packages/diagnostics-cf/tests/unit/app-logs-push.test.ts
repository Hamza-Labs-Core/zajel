/**
 * Unit tests for app logs push handler.
 *
 * Tests validation, rate limiting, D1 insert with dedup, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAppLogsPush, validateAppLogsPush } from '../../src/handlers/app-logs-push.js';
import type { Env } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockD1() {
  const runFn = vi.fn().mockResolvedValue({ success: true });
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        run: runFn,
      }),
    }),
    batch: vi.fn().mockResolvedValue([]),
    _runFn: runFn,
  };
}

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string, format?: string) {
      const val = store.get(key) ?? null;
      if (val !== null && format === 'json') {
        return JSON.parse(val);
      }
      return val;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete() {},
    async list() {
      return { keys: [] };
    },
    async getWithMetadata() {
      return { value: null, metadata: null };
    },
  } as unknown as KVNamespace;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: createMockD1() as unknown as D1Database,
    RATE_LIMIT_KV: createMockKV(),
    REPORTS_BUCKET: {} as R2Bucket,
    GLOBAL_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) } as unknown as Env['GLOBAL_RATE_LIMITER'],
    ...overrides,
  };
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil(_p: Promise<unknown>) {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}

const VALID_HASH =
  'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

function makeValidPayload() {
  return {
    sessionHash: VALID_HASH,
    appVersion: '1.6.0',
    platform: 'android',
    environment: 'production',
    entries: [
      {
        timestamp: Date.now(),
        severity: 'info',
        category: 'Network',
        message: 'WebSocket connected',
        count: 1,
      },
    ],
  };
}

function makeRequest(body: unknown): Request {
  return new Request('https://diagnostics.example.com/diagnostics/app-logs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

describe('validateAppLogsPush', () => {
  it('accepts a valid payload', () => {
    const result = validateAppLogsPush(makeValidPayload());
    expect(result.valid).toBe(true);
  });

  it('rejects null body', () => {
    const result = validateAppLogsPush(null);
    expect(result.valid).toBe(false);
  });

  it('rejects array body', () => {
    const result = validateAppLogsPush([]);
    expect(result.valid).toBe(false);
  });

  it('rejects missing sessionHash', () => {
    const payload = makeValidPayload();
    delete (payload as Record<string, unknown>)['sessionHash'];
    const result = validateAppLogsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('sessionHash');
  });

  it('rejects invalid sessionHash (not hex)', () => {
    const payload = makeValidPayload();
    payload.sessionHash = 'not-a-valid-hash';
    const result = validateAppLogsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('sessionHash');
  });

  it('rejects missing appVersion', () => {
    const payload = makeValidPayload();
    delete (payload as Record<string, unknown>)['appVersion'];
    const result = validateAppLogsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('appVersion');
  });

  it('rejects missing platform', () => {
    const payload = makeValidPayload();
    delete (payload as Record<string, unknown>)['platform'];
    const result = validateAppLogsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('platform');
  });

  it('rejects invalid platform', () => {
    const payload = makeValidPayload();
    (payload as Record<string, unknown>)['platform'] = 'blackberry';
    const result = validateAppLogsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('platform');
  });

  it('rejects invalid environment', () => {
    const payload = makeValidPayload();
    (payload as Record<string, unknown>)['environment'] = 'staging';
    const result = validateAppLogsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('environment');
  });

  it('defaults environment to production when omitted', () => {
    const payload = makeValidPayload();
    delete (payload as Record<string, unknown>)['environment'];
    const result = validateAppLogsPush(payload);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.data.environment).toBe('production');
  });

  it('accepts qa environment', () => {
    const payload = makeValidPayload();
    payload.environment = 'qa';
    const result = validateAppLogsPush(payload);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.data.environment).toBe('qa');
  });

  it('rejects missing entries', () => {
    const payload = { sessionHash: VALID_HASH, appVersion: '1.0.0', platform: 'android' };
    const result = validateAppLogsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('entries');
  });

  it('rejects empty entries array', () => {
    const payload = { ...makeValidPayload(), entries: [] };
    const result = validateAppLogsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('empty');
  });

  it('rejects too many entries', () => {
    const entries = Array.from({ length: 501 }, (_, i) => ({
      timestamp: Date.now(),
      severity: 'info',
      category: 'test',
      message: `message ${i}`,
    }));
    const payload = { ...makeValidPayload(), entries };
    const result = validateAppLogsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('500');
  });

  it('rejects entry with missing timestamp', () => {
    const payload = {
      ...makeValidPayload(),
      entries: [{ severity: 'info', category: 'test', message: 'hello' }],
    };
    const result = validateAppLogsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('timestamp');
  });

  it('rejects entry with invalid severity', () => {
    const payload = {
      ...makeValidPayload(),
      entries: [{
        timestamp: Date.now(),
        severity: 'ultra',
        category: 'test',
        message: 'hello',
      }],
    };
    const result = validateAppLogsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('severity');
  });

  it('rejects entry with missing message', () => {
    const payload = {
      ...makeValidPayload(),
      entries: [{
        timestamp: Date.now(),
        severity: 'info',
        category: 'test',
      }],
    };
    const result = validateAppLogsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('message');
  });

  it('rejects entry with missing category', () => {
    const payload = {
      ...makeValidPayload(),
      entries: [{
        timestamp: Date.now(),
        severity: 'info',
        message: 'hello',
      }],
    };
    const result = validateAppLogsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('category');
  });

  it('defaults count to 1 when omitted', () => {
    const payload = {
      ...makeValidPayload(),
      entries: [{
        timestamp: Date.now(),
        severity: 'info',
        category: 'test',
        message: 'hello',
      }],
    };
    const result = validateAppLogsPush(payload);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.data.entries[0]!.count).toBe(1);
  });

  it('accepts all valid severity levels', () => {
    for (const severity of ['debug', 'info', 'warn', 'error', 'critical']) {
      const payload = {
        ...makeValidPayload(),
        entries: [{
          timestamp: Date.now(),
          severity,
          category: 'test',
          message: 'hello',
        }],
      };
      const result = validateAppLogsPush(payload);
      expect(result.valid).toBe(true);
    }
  });

  it('accepts all valid platforms', () => {
    for (const platform of ['android', 'ios', 'windows', 'macos', 'linux', 'web']) {
      const payload = { ...makeValidPayload(), platform };
      const result = validateAppLogsPush(payload);
      expect(result.valid).toBe(true);
    }
  });

  it('accepts multiple entries', () => {
    const payload = {
      ...makeValidPayload(),
      entries: [
        { timestamp: Date.now(), severity: 'info', category: 'Network', message: 'Connected' },
        { timestamp: Date.now(), severity: 'warn', category: 'Crypto', message: 'Key rotation' },
        { timestamp: Date.now(), severity: 'error', category: 'Storage', message: 'Write failed' },
      ],
    };
    const result = validateAppLogsPush(payload);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.data.entries).toHaveLength(3);
  });

  it('rejects entry with invalid count (zero)', () => {
    const payload = {
      ...makeValidPayload(),
      entries: [{
        timestamp: Date.now(),
        severity: 'info',
        category: 'test',
        message: 'hello',
        count: 0,
      }],
    };
    const result = validateAppLogsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('count');
  });

  it('rejects entry with negative count', () => {
    const payload = {
      ...makeValidPayload(),
      entries: [{
        timestamp: Date.now(),
        severity: 'info',
        category: 'test',
        message: 'hello',
        count: -1,
      }],
    };
    const result = validateAppLogsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('count');
  });
});

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

describe('handleAppLogsPush', () => {
  let env: Env;
  let ctx: ExecutionContext;

  beforeEach(() => {
    env = makeEnv();
    ctx = makeCtx();
  });

  it('returns 400 for wrong Content-Type', async () => {
    const req = new Request('https://diagnostics.example.com/diagnostics/app-logs', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(makeValidPayload()),
    });
    const res = await handleAppLogsPush(req, env, ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Content-Type');
  });

  it('returns 413 for oversized Content-Length', async () => {
    const req = new Request('https://diagnostics.example.com/diagnostics/app-logs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '100000',
      },
      body: JSON.stringify(makeValidPayload()),
    });
    const res = await handleAppLogsPush(req, env, ctx);
    expect(res.status).toBe(413);
  });

  it('returns 400 for invalid JSON', async () => {
    const req = new Request('https://diagnostics.example.com/diagnostics/app-logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    const res = await handleAppLogsPush(req, env, ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid JSON');
  });

  it('returns 400 for invalid payload', async () => {
    const req = makeRequest({ invalid: true });
    const res = await handleAppLogsPush(req, env, ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('returns 200 and batch inserts for valid payload', async () => {
    const req = makeRequest(makeValidPayload());
    const res = await handleAppLogsPush(req, env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.received).toBe(1);

    // Verify D1 batch was called
    expect((env.DB as unknown as { batch: ReturnType<typeof vi.fn> }).batch).toHaveBeenCalled();
  });

  it('returns 200 with correct count for multiple entries', async () => {
    const payload = {
      ...makeValidPayload(),
      entries: [
        { timestamp: Date.now(), severity: 'info', category: 'Network', message: 'Connected' },
        { timestamp: Date.now(), severity: 'warn', category: 'Crypto', message: 'Key rotation' },
      ],
    };
    const req = makeRequest(payload);
    const res = await handleAppLogsPush(req, env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.received).toBe(2);
  });

  it('returns 500 when D1 batch fails', async () => {
    const failingDb = createMockD1();
    failingDb.batch.mockRejectedValue(new Error('D1 error'));
    const localEnv = makeEnv({ DB: failingDb as unknown as D1Database });

    const req = makeRequest(makeValidPayload());
    const res = await handleAppLogsPush(req, localEnv, ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('Failed to store');
  });
});
