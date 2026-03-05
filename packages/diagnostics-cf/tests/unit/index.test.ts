/**
 * Unit tests for the diagnostics worker entry point (index.ts).
 *
 * Tests request routing, CORS headers, and error handling by
 * calling the worker's fetch handler directly with mock bindings.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../../src/index.js';
import type { Env } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Mock helpers (reusable, minimal)
// ---------------------------------------------------------------------------

function createMockD1() {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              return null;
            },
            async run() {
              return { success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
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

function createMockRateLimiter() {
  return {
    async limit() {
      return { success: true };
    },
  };
}

function makeEnv(): Env {
  return {
    DB: createMockD1(),
    RATE_LIMIT_KV: createMockKV(),
    REPORTS_BUCKET: {} as R2Bucket,
    GLOBAL_RATE_LIMITER: createMockRateLimiter() as unknown as Env['GLOBAL_RATE_LIMITER'],
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Worker routing', () => {
  let env: Env;
  let ctx: ExecutionContext;

  beforeEach(() => {
    env = makeEnv();
    ctx = makeCtx();
  });

  it('GET /diagnostics/health returns 200 with correct shape', async () => {
    const req = new Request(
      'https://diagnostics.example.com/diagnostics/health',
    );
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty('status', 'ok');
    expect(body).toHaveProperty('service', 'zajel-diagnostics');
    expect(body).toHaveProperty('timestamp');
  });

  it('POST /diagnostics/heartbeat routes to heartbeat handler', async () => {
    const req = new Request(
      'https://diagnostics.example.com/diagnostics/heartbeat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionHash: VALID_HASH,
          platform: 'android',
          appVersion: '1.0.0',
        }),
      },
    );
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.nextHeartbeatMs).toBe(300000);
  });

  it('unknown path returns 404', async () => {
    const req = new Request(
      'https://diagnostics.example.com/diagnostics/unknown',
    );
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Not found');
  });

  it('GET /diagnostics/heartbeat (wrong method) returns 404', async () => {
    const req = new Request(
      'https://diagnostics.example.com/diagnostics/heartbeat',
      { method: 'GET' },
    );
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(404);
  });

  it('POST /diagnostics/health (wrong method) returns 404', async () => {
    const req = new Request(
      'https://diagnostics.example.com/diagnostics/health',
      { method: 'POST' },
    );
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(404);
  });

  // ─── Server metrics push route (US-3.3) ───

  it('POST /diagnostics/server-metrics routes to server-push handler', async () => {
    const envWithSecret = {
      ...env,
      SERVER_METRICS_SECRET: 'test-push-secret',
    };
    const payload = {
      serverId: 'srv-01',
      region: 'us-east',
      timestamp: Date.now(),
      metrics: {
        connections: { total: 42, relay: 30, signaling: 12 },
        entropy: { activeCodes: 50, collisionRisk: 'low' },
        federation: { aliveMembers: 3, totalMembers: 4 },
        messageRate: { perSecond: 5, perMinute: 300 },
        system: { cpuPercent: 25.5, memoryMb: 128.5, uptimeSeconds: 3600 },
      },
    };
    const req = new Request(
      'https://diagnostics.example.com/diagnostics/server-metrics',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-push-secret',
        },
        body: JSON.stringify(payload),
      },
    );
    const res = await worker.fetch(req, envWithSecret, ctx);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('POST /diagnostics/server-metrics returns 401 without auth', async () => {
    const envWithSecret = {
      ...env,
      SERVER_METRICS_SECRET: 'test-push-secret',
    };
    const req = new Request(
      'https://diagnostics.example.com/diagnostics/server-metrics',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: 'srv-01' }),
      },
    );
    const res = await worker.fetch(req, envWithSecret, ctx);
    expect(res.status).toBe(401);
  });

  it('POST /diagnostics/server-metrics returns 503 without secret configured', async () => {
    const req = new Request(
      'https://diagnostics.example.com/diagnostics/server-metrics',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer some-secret',
        },
        body: JSON.stringify({ serverId: 'srv-01' }),
      },
    );
    // env does not have SERVER_METRICS_SECRET
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(503);
  });

  it('GET /diagnostics/server-metrics (wrong method) returns 404', async () => {
    const req = new Request(
      'https://diagnostics.example.com/diagnostics/server-metrics',
      { method: 'GET' },
    );
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(404);
  });
});

describe('CORS', () => {
  let env: Env;
  let ctx: ExecutionContext;

  beforeEach(() => {
    env = makeEnv();
    ctx = makeCtx();
  });

  it('OPTIONS preflight returns 204 with CORS headers', async () => {
    const req = new Request(
      'https://diagnostics.example.com/diagnostics/heartbeat',
      { method: 'OPTIONS' },
    );
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-max-age')).toBe('86400');
  });

  it('200 responses include CORS headers', async () => {
    const req = new Request(
      'https://diagnostics.example.com/diagnostics/health',
    );
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('404 responses include CORS headers', async () => {
    const req = new Request(
      'https://diagnostics.example.com/diagnostics/unknown',
    );
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(404);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('400 responses include CORS headers', async () => {
    const req = new Request(
      'https://diagnostics.example.com/diagnostics/heartbeat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(400);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
