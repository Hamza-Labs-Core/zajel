/**
 * Unit tests for server logs push handler.
 *
 * Tests validation, authentication, D1 batch insert, and cleanup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleServerLogsPush, validateServerLogsPush } from '../../src/handlers/server-logs-push.js';
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
    entries: [
      {
        timestamp: Date.now(),
        severity: 'info',
        category: 'Federation',
        message: 'Peer joined: srv-02',
        metadata: { peerId: 'srv-02' },
      },
    ],
  };
}

function makeRequest(body: unknown, secret = 'test-secret-123'): Request {
  return new Request('https://diagnostics.example.com/diagnostics/server-logs', {
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

describe('validateServerLogsPush', () => {
  it('accepts a valid payload', () => {
    const result = validateServerLogsPush(makeValidPayload());
    expect(result.valid).toBe(true);
  });

  it('rejects null body', () => {
    const result = validateServerLogsPush(null);
    expect(result.valid).toBe(false);
  });

  it('rejects missing serverId', () => {
    const payload = makeValidPayload();
    delete (payload as Record<string, unknown>)['serverId'];
    const result = validateServerLogsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('serverId');
    }
  });

  it('rejects missing entries array', () => {
    const payload = { serverId: 'srv-01' };
    const result = validateServerLogsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('entries');
    }
  });

  it('rejects empty entries array', () => {
    const payload = { serverId: 'srv-01', entries: [] };
    const result = validateServerLogsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('empty');
    }
  });

  it('rejects entry with missing timestamp', () => {
    const payload = {
      serverId: 'srv-01',
      entries: [{ severity: 'info', category: 'test', message: 'hello' }],
    };
    const result = validateServerLogsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('timestamp');
    }
  });

  it('rejects entry with invalid severity', () => {
    const payload = {
      serverId: 'srv-01',
      entries: [{
        timestamp: Date.now(),
        severity: 'ultra',
        category: 'test',
        message: 'hello',
      }],
    };
    const result = validateServerLogsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('severity');
    }
  });

  it('rejects entry with missing message', () => {
    const payload = {
      serverId: 'srv-01',
      entries: [{
        timestamp: Date.now(),
        severity: 'info',
        category: 'test',
      }],
    };
    const result = validateServerLogsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('message');
    }
  });

  it('rejects entry with missing category', () => {
    const payload = {
      serverId: 'srv-01',
      entries: [{
        timestamp: Date.now(),
        severity: 'info',
        message: 'hello',
      }],
    };
    const result = validateServerLogsPush(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('category');
    }
  });

  it('accepts all valid severity levels', () => {
    for (const severity of ['debug', 'info', 'warn', 'error', 'critical']) {
      const payload = {
        serverId: 'srv-01',
        entries: [{
          timestamp: Date.now(),
          severity,
          category: 'test',
          message: 'hello',
        }],
      };
      const result = validateServerLogsPush(payload);
      expect(result.valid).toBe(true);
    }
  });

  it('stringifies object metadata', () => {
    const payload = {
      serverId: 'srv-01',
      entries: [{
        timestamp: Date.now(),
        severity: 'info',
        category: 'test',
        message: 'hello',
        metadata: { key: 'value' },
      }],
    };
    const result = validateServerLogsPush(payload);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.entries[0]!.metadata).toBe('{"key":"value"}');
    }
  });

  it('accepts multiple entries', () => {
    const payload = {
      serverId: 'srv-01',
      entries: [
        { timestamp: Date.now(), severity: 'info', category: 'Federation', message: 'Peer joined' },
        { timestamp: Date.now(), severity: 'warn', category: 'Client', message: 'Rate limited' },
        { timestamp: Date.now(), severity: 'error', category: 'Relay', message: 'Connection failed' },
      ],
    };
    const result = validateServerLogsPush(payload);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.entries).toHaveLength(3);
    }
  });
});

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

describe('handleServerLogsPush', () => {
  let env: Env;
  let ctx: ExecutionContext;

  beforeEach(() => {
    env = makeEnv();
    ctx = makeCtx();
  });

  it('returns 503 when SERVER_METRICS_SECRET not configured', async () => {
    const localEnv = makeEnv({ SERVER_METRICS_SECRET: undefined });
    const req = makeRequest(makeValidPayload());
    const res = await handleServerLogsPush(req, localEnv, ctx);
    expect(res.status).toBe(503);
  });

  it('returns 401 for missing auth header', async () => {
    const req = new Request('https://diagnostics.example.com/diagnostics/server-logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeValidPayload()),
    });
    const res = await handleServerLogsPush(req, env, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 401 for wrong secret', async () => {
    const req = makeRequest(makeValidPayload(), 'wrong-secret');
    const res = await handleServerLogsPush(req, env, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid JSON', async () => {
    const req = new Request('https://diagnostics.example.com/diagnostics/server-logs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-secret-123',
      },
      body: 'not json',
    });
    const res = await handleServerLogsPush(req, env, ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid payload', async () => {
    const req = makeRequest({ invalid: true });
    const res = await handleServerLogsPush(req, env, ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('returns 200 and batch inserts into D1 for valid payload', async () => {
    const req = makeRequest(makeValidPayload());
    const res = await handleServerLogsPush(req, env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.received).toBe(1);

    // Verify D1 batch was called
    expect((env.DB as unknown as { batch: ReturnType<typeof vi.fn> }).batch).toHaveBeenCalled();
  });

  it('returns 200 with correct count for multiple entries', async () => {
    const payload = {
      serverId: 'srv-01',
      entries: [
        { timestamp: Date.now(), severity: 'info', category: 'Federation', message: 'Peer joined' },
        { timestamp: Date.now(), severity: 'warn', category: 'Client', message: 'Rate limited' },
      ],
    };
    const req = makeRequest(payload);
    const res = await handleServerLogsPush(req, env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.received).toBe(2);
  });
});
