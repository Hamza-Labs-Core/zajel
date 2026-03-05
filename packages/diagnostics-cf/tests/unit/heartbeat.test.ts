/**
 * Unit tests for POST /diagnostics/heartbeat handler.
 *
 * Uses mock D1 and KV to test validation, rate limiting, UPSERT logic,
 * and response shapes without hitting real Cloudflare bindings.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleHeartbeat, validateHeartbeatRequest } from '../../src/handlers/heartbeat.js';
import type { Env } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** A minimal D1 result row returned by `.first()`. */
interface MockD1Row {
  [key: string]: unknown;
}

/**
 * Creates a mock D1Database that supports `prepare().bind().first()` and
 * `prepare().bind().run()` chains.
 */
function createMockD1(rows: Map<string, MockD1Row> = new Map()) {
  return {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              // SELECT query — look up by session_hash (first param)
              const sessionHash = params[0] as string;
              const row = rows.get(sessionHash);
              return (row as T) ?? null;
            },
            async run(): Promise<{ success: boolean }> {
              // UPSERT — store the row
              const sessionHash = params[0] as string;
              rows.set(sessionHash, {
                session_hash: sessionHash,
                platform: params[1],
                app_version: params[2],
                connection_type: params[3],
                region: params[4],
                last_seen: params[5],
                session_start: params[6],
              });
              return { success: true };
            },
          };
        },
        _query: query,
      };
    },
  } as unknown as D1Database;
}

/**
 * Creates a mock KVNamespace that records `put` and `get` calls.
 */
function createMockKV(): KVNamespace & {
  _store: Map<string, { value: string; opts?: unknown }>;
} {
  const store = new Map<string, { value: string; opts?: unknown }>();
  return {
    _store: store,
    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      return entry?.value ?? null;
    },
    async put(
      key: string,
      value: string,
      opts?: unknown,
    ): Promise<void> {
      store.set(key, { value, opts });
    },
    async delete(_key: string): Promise<void> {
      // no-op for tests
    },
    async list(): Promise<{ keys: { name: string }[] }> {
      return { keys: [] };
    },
    async getWithMetadata(): Promise<{ value: null; metadata: null }> {
      return { value: null, metadata: null };
    },
  } as unknown as KVNamespace & {
    _store: Map<string, { value: string; opts?: unknown }>;
  };
}

/**
 * Creates a mock ExecutionContext with a working `waitUntil`.
 */
function createMockCtx(): ExecutionContext & { _promises: Promise<unknown>[] } {
  const promises: Promise<unknown>[] = [];
  return {
    _promises: promises,
    waitUntil(promise: Promise<unknown>) {
      promises.push(promise);
    },
    passThroughOnException() {
      // no-op
    },
  } as unknown as ExecutionContext & { _promises: Promise<unknown>[] };
}

/**
 * Build a valid heartbeat request.
 */
function makeRequest(
  body: unknown,
  headers?: Record<string, string>,
): Request {
  return new Request('https://diagnostics.example.com/diagnostics/heartbeat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** A valid 64-char hex hash for tests. */
const VALID_HASH =
  'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

/** A second valid hash for multi-session tests. */
const VALID_HASH_2 =
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    DB: createMockD1(),
    RATE_LIMIT_KV: createMockKV(),
    REPORTS_BUCKET: {} as R2Bucket,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Validation Tests
// ---------------------------------------------------------------------------

describe('validateHeartbeatRequest', () => {
  it('accepts a valid full request', () => {
    const result = validateHeartbeatRequest({
      sessionHash: VALID_HASH,
      platform: 'android',
      appVersion: '1.2.3',
      connectionType: 'direct_p2p',
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.sessionHash).toBe(VALID_HASH);
      expect(result.data.platform).toBe('android');
      expect(result.data.appVersion).toBe('1.2.3');
      expect(result.data.connectionType).toBe('direct_p2p');
    }
  });

  it('accepts a request without connectionType (optional)', () => {
    const result = validateHeartbeatRequest({
      sessionHash: VALID_HASH,
      platform: 'ios',
      appVersion: '2.0.0',
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.connectionType).toBeUndefined();
    }
  });

  it('rejects null body', () => {
    const result = validateHeartbeatRequest(null);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe('Request body must be a JSON object');
    }
  });

  it('rejects non-object body', () => {
    const result = validateHeartbeatRequest('not an object');
    expect(result.valid).toBe(false);
  });

  it('rejects missing sessionHash', () => {
    const result = validateHeartbeatRequest({
      platform: 'android',
      appVersion: '1.0.0',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe('Missing required field: sessionHash');
    }
  });

  it('rejects empty sessionHash', () => {
    const result = validateHeartbeatRequest({
      sessionHash: '',
      platform: 'android',
      appVersion: '1.0.0',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe('Missing required field: sessionHash');
    }
  });

  it('rejects non-64-char sessionHash', () => {
    const result = validateHeartbeatRequest({
      sessionHash: 'abc123',
      platform: 'android',
      appVersion: '1.0.0',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('64-character lowercase hex string');
    }
  });

  it('rejects uppercase hex sessionHash', () => {
    const result = validateHeartbeatRequest({
      sessionHash: VALID_HASH.toUpperCase(),
      platform: 'android',
      appVersion: '1.0.0',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('64-character lowercase hex string');
    }
  });

  it('rejects missing platform', () => {
    const result = validateHeartbeatRequest({
      sessionHash: VALID_HASH,
      appVersion: '1.0.0',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe('Missing required field: platform');
    }
  });

  it('rejects invalid platform value', () => {
    const result = validateHeartbeatRequest({
      sessionHash: VALID_HASH,
      platform: 'playstation',
      appVersion: '1.0.0',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('Invalid platform value');
      expect(result.error).toContain('playstation');
    }
  });

  it('rejects missing appVersion', () => {
    const result = validateHeartbeatRequest({
      sessionHash: VALID_HASH,
      platform: 'android',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe('Missing required field: appVersion');
    }
  });

  it('rejects non-semver appVersion', () => {
    const result = validateHeartbeatRequest({
      sessionHash: VALID_HASH,
      platform: 'android',
      appVersion: 'latest',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('valid semver');
    }
  });

  it('rejects invalid connectionType', () => {
    const result = validateHeartbeatRequest({
      sessionHash: VALID_HASH,
      platform: 'android',
      appVersion: '1.0.0',
      connectionType: 'bluetooth',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('Invalid connectionType');
    }
  });

  it('accepts all valid platform values', () => {
    for (const platform of [
      'android',
      'ios',
      'windows',
      'macos',
      'linux',
      'web',
    ]) {
      const result = validateHeartbeatRequest({
        sessionHash: VALID_HASH,
        platform,
        appVersion: '1.0.0',
      });
      expect(result.valid).toBe(true);
    }
  });

  it('accepts all valid connectionType values', () => {
    for (const connectionType of ['direct_p2p', 'relay', 'none']) {
      const result = validateHeartbeatRequest({
        sessionHash: VALID_HASH,
        platform: 'android',
        appVersion: '1.0.0',
        connectionType,
      });
      expect(result.valid).toBe(true);
    }
  });

  it('accepts semver with pre-release suffix', () => {
    const result = validateHeartbeatRequest({
      sessionHash: VALID_HASH,
      platform: 'android',
      appVersion: '1.0.0-beta.1',
    });
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Handler Tests
// ---------------------------------------------------------------------------

describe('handleHeartbeat', () => {
  let env: Env;
  let ctx: ExecutionContext & { _promises: Promise<unknown>[] };

  beforeEach(() => {
    env = makeEnv();
    ctx = createMockCtx();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-03T12:00:00.000Z'));
  });

  it('returns 200 for a valid heartbeat', async () => {
    const req = makeRequest({
      sessionHash: VALID_HASH,
      platform: 'android',
      appVersion: '1.2.3',
      connectionType: 'direct_p2p',
    });

    const res = await handleHeartbeat(req, env, ctx);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({
      success: true,
      data: { nextHeartbeatMs: 300000 },
    });
  });

  it('returns 400 for invalid JSON body', async () => {
    const req = new Request(
      'https://diagnostics.example.com/diagnostics/heartbeat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      },
    );

    const res = await handleHeartbeat(req, env, ctx);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Invalid JSON body');
  });

  it('returns 400 for missing sessionHash', async () => {
    const req = makeRequest({
      platform: 'android',
      appVersion: '1.0.0',
    });

    const res = await handleHeartbeat(req, env, ctx);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Missing required field: sessionHash');
  });

  it('returns 400 for missing platform', async () => {
    const req = makeRequest({
      sessionHash: VALID_HASH,
      appVersion: '1.0.0',
    });

    const res = await handleHeartbeat(req, env, ctx);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Missing required field: platform');
  });

  it('returns 400 for missing appVersion', async () => {
    const req = makeRequest({
      sessionHash: VALID_HASH,
      platform: 'android',
    });

    const res = await handleHeartbeat(req, env, ctx);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Missing required field: appVersion');
  });

  it('returns 400 for invalid platform (e.g., "playstation")', async () => {
    const req = makeRequest({
      sessionHash: VALID_HASH,
      platform: 'playstation',
      appVersion: '1.0.0',
    });

    const res = await handleHeartbeat(req, env, ctx);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('Invalid platform value');
  });

  it('returns 400 for non-64-char hex sessionHash', async () => {
    const req = makeRequest({
      sessionHash: 'tooshort',
      platform: 'android',
      appVersion: '1.0.0',
    });

    const res = await handleHeartbeat(req, env, ctx);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('64-character');
  });

  it('returns 429 when heartbeat is within 5 minutes of the last one', async () => {
    const now = Date.now();
    // Simulate an existing row with last_seen 2 minutes ago
    const twoMinutesAgo = now - 120_000;
    const d1Rows = new Map<string, MockD1Row>();
    d1Rows.set(VALID_HASH, { last_seen: twoMinutesAgo });

    env = makeEnv({ DB: createMockD1(d1Rows) });

    const req = makeRequest({
      sessionHash: VALID_HASH,
      platform: 'android',
      appVersion: '1.0.0',
    });

    const res = await handleHeartbeat(req, env, ctx);
    expect(res.status).toBe(429);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('Heartbeat too frequent');
    expect(body.error).toContain('seconds');
  });

  it('returns correct retry-after seconds in 429 response', async () => {
    const now = Date.now();
    // last_seen was 4 minutes ago → need to wait 1 more minute
    const fourMinutesAgo = now - 240_000;
    const d1Rows = new Map<string, MockD1Row>();
    d1Rows.set(VALID_HASH, { last_seen: fourMinutesAgo });

    env = makeEnv({ DB: createMockD1(d1Rows) });

    const req = makeRequest({
      sessionHash: VALID_HASH,
      platform: 'android',
      appVersion: '1.0.0',
    });

    const res = await handleHeartbeat(req, env, ctx);
    expect(res.status).toBe(429);

    const body = await res.json();
    // 300s - 240s = 60s → ceil(60) = 60
    expect(body.error).toContain('60 seconds');
  });

  it('returns 200 when heartbeat is exactly 5 minutes after the last one', async () => {
    const now = Date.now();
    const fiveMinutesAgo = now - 300_000;
    const d1Rows = new Map<string, MockD1Row>();
    d1Rows.set(VALID_HASH, { last_seen: fiveMinutesAgo });

    env = makeEnv({ DB: createMockD1(d1Rows) });

    const req = makeRequest({
      sessionHash: VALID_HASH,
      platform: 'android',
      appVersion: '1.0.0',
    });

    const res = await handleHeartbeat(req, env, ctx);
    expect(res.status).toBe(200);
  });

  it('returns 200 when heartbeat is more than 5 minutes after the last one', async () => {
    const now = Date.now();
    const sixMinutesAgo = now - 360_000;
    const d1Rows = new Map<string, MockD1Row>();
    d1Rows.set(VALID_HASH, { last_seen: sixMinutesAgo });

    env = makeEnv({ DB: createMockD1(d1Rows) });

    const req = makeRequest({
      sessionHash: VALID_HASH,
      platform: 'android',
      appVersion: '1.0.0',
    });

    const res = await handleHeartbeat(req, env, ctx);
    expect(res.status).toBe(200);
  });

  it('UPSERT writes correct data to D1 for a new session', async () => {
    const d1Rows = new Map<string, MockD1Row>();
    env = makeEnv({ DB: createMockD1(d1Rows) });

    const req = makeRequest({
      sessionHash: VALID_HASH,
      platform: 'ios',
      appVersion: '2.1.0',
      connectionType: 'relay',
    });

    const res = await handleHeartbeat(req, env, ctx);
    expect(res.status).toBe(200);

    // Wait for background writes
    await Promise.all(ctx._promises);

    const row = d1Rows.get(VALID_HASH);
    expect(row).toBeDefined();
    expect(row!['session_hash']).toBe(VALID_HASH);
    expect(row!['platform']).toBe('ios');
    expect(row!['app_version']).toBe('2.1.0');
    expect(row!['connection_type']).toBe('relay');
    expect(row!['last_seen']).toBe(Date.now());
    expect(row!['session_start']).toBe(Date.now());
  });

  it('UPSERT updates last_seen and connection_type for repeated session', async () => {
    const now = Date.now();
    const sixMinutesAgo = now - 360_000;
    const d1Rows = new Map<string, MockD1Row>();
    d1Rows.set(VALID_HASH, {
      session_hash: VALID_HASH,
      platform: 'android',
      app_version: '1.0.0',
      connection_type: 'direct_p2p',
      region: 'IAD',
      last_seen: sixMinutesAgo,
      session_start: sixMinutesAgo - 600_000,
    });

    env = makeEnv({ DB: createMockD1(d1Rows) });

    const req = makeRequest({
      sessionHash: VALID_HASH,
      platform: 'android',
      appVersion: '1.0.1',
      connectionType: 'relay',
    });

    const res = await handleHeartbeat(req, env, ctx);
    expect(res.status).toBe(200);

    // Wait for background writes
    await Promise.all(ctx._promises);

    const row = d1Rows.get(VALID_HASH);
    expect(row).toBeDefined();
    // The mock UPSERT stores the new row values; in real D1 the ON CONFLICT
    // clause preserves session_start from the existing row. Our mock
    // simulates the INSERT path (always stores the bound values).
    // This test verifies the handler passes the correct values to D1.
    expect(row!['app_version']).toBe('1.0.1');
    expect(row!['connection_type']).toBe('relay');
    expect(row!['last_seen']).toBe(now);
  });

  it('updates KV counters on successful heartbeat', async () => {
    const mockKV = createMockKV();
    env = makeEnv({ RATE_LIMIT_KV: mockKV });

    const req = makeRequest({
      sessionHash: VALID_HASH,
      platform: 'android',
      appVersion: '1.2.3',
      connectionType: 'direct_p2p',
    });

    const res = await handleHeartbeat(req, env, ctx);
    expect(res.status).toBe(200);

    // Wait for background writes
    await Promise.all(ctx._promises);

    // Verify counters were updated
    expect(mockKV._store.has('active_clients:total')).toBe(true);
    expect(mockKV._store.get('active_clients:total')?.value).toBe('1');

    expect(mockKV._store.has('active_clients:platform:android')).toBe(true);
    expect(mockKV._store.get('active_clients:platform:android')?.value).toBe(
      '1',
    );

    expect(mockKV._store.has('active_clients:version:1.2.3')).toBe(true);
    expect(mockKV._store.get('active_clients:version:1.2.3')?.value).toBe('1');

    expect(mockKV._store.has('active_clients:connection:direct_p2p')).toBe(
      true,
    );
    expect(
      mockKV._store.get('active_clients:connection:direct_p2p')?.value,
    ).toBe('1');
  });

  it('does not write connection counter when connectionType is absent', async () => {
    const mockKV = createMockKV();
    env = makeEnv({ RATE_LIMIT_KV: mockKV });

    const req = makeRequest({
      sessionHash: VALID_HASH,
      platform: 'web',
      appVersion: '1.0.0',
    });

    const res = await handleHeartbeat(req, env, ctx);
    expect(res.status).toBe(200);

    await Promise.all(ctx._promises);

    // total, platform, and version should exist — connection should not
    expect(mockKV._store.has('active_clients:total')).toBe(true);
    expect(mockKV._store.has('active_clients:platform:web')).toBe(true);
    expect(mockKV._store.has('active_clients:version:1.0.0')).toBe(true);

    // No connection-type counter
    const connectionKeys = [...mockKV._store.keys()].filter((k) =>
      k.startsWith('active_clients:connection:'),
    );
    expect(connectionKeys).toHaveLength(0);
  });

  it('KV counters are written with 15-minute TTL', async () => {
    const mockKV = createMockKV();
    env = makeEnv({ RATE_LIMIT_KV: mockKV });

    const req = makeRequest({
      sessionHash: VALID_HASH,
      platform: 'android',
      appVersion: '1.0.0',
    });

    await handleHeartbeat(req, env, ctx);
    await Promise.all(ctx._promises);

    const totalEntry = mockKV._store.get('active_clients:total');
    expect(totalEntry).toBeDefined();
    expect(
      (totalEntry!.opts as { expirationTtl?: number })?.expirationTtl,
    ).toBe(900);
  });

  it('uses waitUntil for D1 and KV writes', async () => {
    const req = makeRequest({
      sessionHash: VALID_HASH,
      platform: 'android',
      appVersion: '1.0.0',
    });

    await handleHeartbeat(req, env, ctx);

    // ctx.waitUntil should have been called at least once
    expect(ctx._promises.length).toBeGreaterThanOrEqual(1);
  });

  it('returns application/json content type', async () => {
    const req = makeRequest({
      sessionHash: VALID_HASH,
      platform: 'android',
      appVersion: '1.0.0',
    });

    const res = await handleHeartbeat(req, env, ctx);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('handles two different sessions independently', async () => {
    const d1Rows = new Map<string, MockD1Row>();
    env = makeEnv({ DB: createMockD1(d1Rows) });

    // First session
    const req1 = makeRequest({
      sessionHash: VALID_HASH,
      platform: 'android',
      appVersion: '1.0.0',
    });
    const res1 = await handleHeartbeat(req1, env, ctx);
    expect(res1.status).toBe(200);

    // Second session (different hash)
    const req2 = makeRequest({
      sessionHash: VALID_HASH_2,
      platform: 'ios',
      appVersion: '2.0.0',
    });
    const res2 = await handleHeartbeat(req2, env, ctx);
    expect(res2.status).toBe(200);

    await Promise.all(ctx._promises);

    expect(d1Rows.has(VALID_HASH)).toBe(true);
    expect(d1Rows.has(VALID_HASH_2)).toBe(true);
    expect(d1Rows.get(VALID_HASH)!['platform']).toBe('android');
    expect(d1Rows.get(VALID_HASH_2)!['platform']).toBe('ios');
  });

  it('defaults region to "unknown" when cf metadata is absent', async () => {
    const d1Rows = new Map<string, MockD1Row>();
    env = makeEnv({ DB: createMockD1(d1Rows) });

    const req = makeRequest({
      sessionHash: VALID_HASH,
      platform: 'android',
      appVersion: '1.0.0',
    });

    const res = await handleHeartbeat(req, env, ctx);
    expect(res.status).toBe(200);

    await Promise.all(ctx._promises);

    const row = d1Rows.get(VALID_HASH);
    expect(row!['region']).toBe('unknown');
  });

  it('null connectionType stores null in D1', async () => {
    const d1Rows = new Map<string, MockD1Row>();
    env = makeEnv({ DB: createMockD1(d1Rows) });

    const req = makeRequest({
      sessionHash: VALID_HASH,
      platform: 'android',
      appVersion: '1.0.0',
      // no connectionType
    });

    const res = await handleHeartbeat(req, env, ctx);
    expect(res.status).toBe(200);

    await Promise.all(ctx._promises);

    const row = d1Rows.get(VALID_HASH);
    expect(row!['connection_type']).toBeNull();
  });
});
