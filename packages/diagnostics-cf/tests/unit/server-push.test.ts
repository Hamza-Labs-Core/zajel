/**
 * Unit tests for server metrics push handler.
 *
 * Tests validation, authentication, D1 insert, and cleanup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleServerMetricsPush } from '../../src/handlers/server-push.js';
import { validateServerMetricsPush } from '../../src/handlers/server-push.js';
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
    _runFn: runFn,
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: createMockD1() as unknown as D1Database,
    RATE_LIMIT_KV: {} as KVNamespace,
    REPORTS_BUCKET: {} as R2Bucket,
    GLOBAL_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) } as unknown as Env['GLOBAL_RATE_LIMITER'],
    SERVER_METRICS_SECRET: 'test-secret-123',
    ...overrides,
  };
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil(_p: Promise<unknown>) {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}

function makeValidPayload() {
  return {
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
}

function makeRequest(body: unknown, secret = 'test-secret-123'): Request {
  return new Request('https://diagnostics.example.com/diagnostics/server-metrics', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

describe('validateServerMetricsPush', () => {
  it('accepts a valid payload', () => {
    const result = validateServerMetricsPush(makeValidPayload());
    expect(result.valid).toBe(true);
  });

  it('rejects null body', () => {
    const result = validateServerMetricsPush(null);
    expect(result.valid).toBe(false);
  });

  it('rejects missing serverId', () => {
    const payload = makeValidPayload();
    delete (payload as Record<string, unknown>)['serverId'];
    const result = validateServerMetricsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('serverId');
    }
  });

  it('rejects missing metrics', () => {
    const payload = makeValidPayload();
    delete (payload as Record<string, unknown>)['metrics'];
    const result = validateServerMetricsPush(payload);
    expect(result.valid).toBe(false);
  });

  it('rejects missing metrics.connections', () => {
    const payload = makeValidPayload();
    delete (payload.metrics as Record<string, unknown>)['connections'];
    const result = validateServerMetricsPush(payload);
    expect(result.valid).toBe(false);
  });

  it('rejects non-numeric timestamp', () => {
    const payload = makeValidPayload();
    (payload as Record<string, unknown>)['timestamp'] = 'not-a-number';
    const result = validateServerMetricsPush(payload);
    expect(result.valid).toBe(false);
  });

  it('rejects missing system metrics', () => {
    const payload = makeValidPayload();
    delete (payload.metrics as Record<string, unknown>)['system'];
    const result = validateServerMetricsPush(payload);
    expect(result.valid).toBe(false);
  });

  it('accepts payload with gossipLatency', () => {
    const payload = makeValidPayload();
    (payload.metrics as Record<string, unknown>)['gossipLatency'] = {
      p50Ms: 10, p95Ms: 50, p99Ms: 100, pingCount: 200,
    };
    const result = validateServerMetricsPush(payload);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.metrics.gossipLatency).toEqual({
        p50Ms: 10, p95Ms: 50, p99Ms: 100, pingCount: 200,
      });
    }
  });

  it('accepts payload without gossipLatency (backward compat)', () => {
    const payload = makeValidPayload();
    // No gossipLatency field
    const result = validateServerMetricsPush(payload);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.metrics.gossipLatency).toBeUndefined();
    }
  });

  it('rejects invalid gossipLatency (missing fields)', () => {
    const payload = makeValidPayload();
    (payload.metrics as Record<string, unknown>)['gossipLatency'] = {
      p50Ms: 10, p95Ms: 'not-a-number',
    };
    const result = validateServerMetricsPush(payload);
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

describe('handleServerMetricsPush', () => {
  let env: Env;
  let ctx: ExecutionContext;

  beforeEach(() => {
    env = makeEnv();
    ctx = makeCtx();
  });

  it('returns 503 when SERVER_METRICS_SECRET not configured', async () => {
    const localEnv = makeEnv({ SERVER_METRICS_SECRET: undefined });
    const req = makeRequest(makeValidPayload());
    const res = await handleServerMetricsPush(req, localEnv, ctx);
    expect(res.status).toBe(503);
  });

  it('returns 401 for missing auth header', async () => {
    const req = new Request('https://diagnostics.example.com/diagnostics/server-metrics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeValidPayload()),
    });
    const res = await handleServerMetricsPush(req, env, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 401 for wrong secret', async () => {
    const req = makeRequest(makeValidPayload(), 'wrong-secret');
    const res = await handleServerMetricsPush(req, env, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid JSON', async () => {
    const req = new Request('https://diagnostics.example.com/diagnostics/server-metrics', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-secret-123',
      },
      body: 'not json',
    });
    const res = await handleServerMetricsPush(req, env, ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid payload', async () => {
    const req = makeRequest({ invalid: true });
    const res = await handleServerMetricsPush(req, env, ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('returns 200 and inserts into D1 for valid payload', async () => {
    const req = makeRequest(makeValidPayload());
    const res = await handleServerMetricsPush(req, env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // Verify D1 prepare was called (at least for insert + cleanup)
    expect((env.DB as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare).toHaveBeenCalled();
  });
});
