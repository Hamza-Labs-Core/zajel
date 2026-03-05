/**
 * Unit tests for security events push handler.
 *
 * Tests validation, authentication, D1 batch insert, and cleanup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSecurityEventsPush, validateSecurityEventsPush } from '../../src/handlers/security-events-push.js';
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
    events: [
      {
        eventType: 'rate_limit_violation',
        timestamp: Date.now(),
        sourceIp: 'a1b2c3d4',
        endpoint: '/ws',
        severity: 'medium',
        count: 5,
        details: { violation_type: 'ws_message_rate' },
      },
    ],
  };
}

function makeRequest(body: unknown, secret = 'test-secret-123'): Request {
  return new Request('https://diagnostics.example.com/diagnostics/security-events', {
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

describe('validateSecurityEventsPush', () => {
  it('accepts a valid payload', () => {
    const result = validateSecurityEventsPush(makeValidPayload());
    expect(result.valid).toBe(true);
  });

  it('rejects null body', () => {
    const result = validateSecurityEventsPush(null);
    expect(result.valid).toBe(false);
  });

  it('rejects missing serverId', () => {
    const payload = makeValidPayload();
    delete (payload as Record<string, unknown>)['serverId'];
    const result = validateSecurityEventsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('serverId');
    }
  });

  it('rejects missing events array', () => {
    const payload = { serverId: 'srv-01' };
    const result = validateSecurityEventsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('events');
    }
  });

  it('rejects empty events array', () => {
    const payload = { serverId: 'srv-01', events: [] };
    const result = validateSecurityEventsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('empty');
    }
  });

  it('rejects invalid event type', () => {
    const payload = {
      serverId: 'srv-01',
      events: [{ eventType: 'invalid_type', timestamp: Date.now() }],
    };
    const result = validateSecurityEventsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('eventType');
    }
  });

  it('rejects event with missing timestamp', () => {
    const payload = {
      serverId: 'srv-01',
      events: [{ eventType: 'rate_limit_violation' }],
    };
    const result = validateSecurityEventsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('timestamp');
    }
  });

  it('rejects invalid severity', () => {
    const payload = {
      serverId: 'srv-01',
      events: [{
        eventType: 'rate_limit_violation',
        timestamp: Date.now(),
        severity: 'ultra',
      }],
    };
    const result = validateSecurityEventsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('severity');
    }
  });

  it('accepts multiple valid events', () => {
    const payload = {
      serverId: 'srv-01',
      events: [
        { eventType: 'rate_limit_violation', timestamp: Date.now(), severity: 'medium', count: 1 },
        { eventType: 'connection_spike', timestamp: Date.now(), severity: 'high', count: 1 },
        { eventType: 'bad_client', timestamp: Date.now(), severity: 'low', count: 3 },
        { eventType: 'brute_force_attempt', timestamp: Date.now(), severity: 'critical', count: 10 },
      ],
    };
    const result = validateSecurityEventsPush(payload);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.events).toHaveLength(4);
    }
  });

  it('stringifies object details', () => {
    const payload = {
      serverId: 'srv-01',
      events: [{
        eventType: 'rate_limit_violation',
        timestamp: Date.now(),
        details: { foo: 'bar' },
      }],
    };
    const result = validateSecurityEventsPush(payload);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.events[0]!.details).toBe('{"foo":"bar"}');
    }
  });

  it('uses serverId from top level when event lacks it', () => {
    const payload = {
      serverId: 'srv-top',
      events: [{
        eventType: 'rate_limit_violation',
        timestamp: Date.now(),
      }],
    };
    const result = validateSecurityEventsPush(payload);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.events[0]!.serverId).toBe('srv-top');
    }
  });
});

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

describe('handleSecurityEventsPush', () => {
  let env: Env;
  let ctx: ExecutionContext;

  beforeEach(() => {
    env = makeEnv();
    ctx = makeCtx();
  });

  it('returns 503 when SERVER_METRICS_SECRET not configured', async () => {
    const localEnv = makeEnv({ SERVER_METRICS_SECRET: undefined });
    const req = makeRequest(makeValidPayload());
    const res = await handleSecurityEventsPush(req, localEnv, ctx);
    expect(res.status).toBe(503);
  });

  it('returns 401 for missing auth header', async () => {
    const req = new Request('https://diagnostics.example.com/diagnostics/security-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeValidPayload()),
    });
    const res = await handleSecurityEventsPush(req, env, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 401 for wrong secret', async () => {
    const req = makeRequest(makeValidPayload(), 'wrong-secret');
    const res = await handleSecurityEventsPush(req, env, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid JSON', async () => {
    const req = new Request('https://diagnostics.example.com/diagnostics/security-events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-secret-123',
      },
      body: 'not json',
    });
    const res = await handleSecurityEventsPush(req, env, ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid payload', async () => {
    const req = makeRequest({ invalid: true });
    const res = await handleSecurityEventsPush(req, env, ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('returns 200 and batch inserts into D1 for valid payload', async () => {
    const req = makeRequest(makeValidPayload());
    const res = await handleSecurityEventsPush(req, env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.received).toBe(1);

    // Verify D1 batch was called
    expect((env.DB as unknown as { batch: ReturnType<typeof vi.fn> }).batch).toHaveBeenCalled();
  });

  it('returns 200 with correct count for multiple events', async () => {
    const payload = {
      serverId: 'srv-01',
      events: [
        { eventType: 'rate_limit_violation', timestamp: Date.now(), severity: 'medium' },
        { eventType: 'bad_client', timestamp: Date.now(), severity: 'high' },
        { eventType: 'brute_force_attempt', timestamp: Date.now(), severity: 'low' },
      ],
    };
    const req = makeRequest(payload);
    const res = await handleSecurityEventsPush(req, env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.received).toBe(3);
  });
});
