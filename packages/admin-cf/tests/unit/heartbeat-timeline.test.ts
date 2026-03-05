/**
 * Unit tests for heartbeat timeline handler (US-5.4)
 *
 * Tests the handleHeartbeatTimeline route handler which queries
 * server_metrics from D1 and computes timeline segments per server.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../src/types.js';

// ─────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────

const mockVerifyJwt = vi.fn();

/** Mock JWT verification so requireAuth passes */
vi.mock('../../src/crypto.js', () => ({
  verifyJwt: (...args: unknown[]) => mockVerifyJwt(...args),
}));

// Import handler AFTER setting up mock
import {
  handleHeartbeatTimeline,
  computeSegments,
  computeSummary,
} from '../../src/routes/heartbeat-timeline.js';

/** Helper to build a mock request with auth */
function makeRequest(params: Record<string, string> = {}): Request {
  const url = new URL('https://admin.test/admin/api/servers/heartbeat-timeline');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new Request(url.toString(), {
    headers: { Authorization: 'Bearer test-token' },
  });
}

/** Helper to build a mock request without auth */
function makeUnauthRequest(params: Record<string, string> = {}): Request {
  const url = new URL('https://admin.test/admin/api/servers/heartbeat-timeline');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new Request(url.toString());
}

/** Helper timestamps: minutes from a base time */
const BASE = 1709500000000; // fixed base time

function ts(minutesFromBase: number): number {
  return BASE + minutesFromBase * 60 * 1000;
}

/**
 * Build a mock D1 database that returns the given rows.
 */
function mockD1(rows: Array<{ server_id: string; region: string; timestamp: number }>) {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({ results: rows }),
      }),
    }),
  } as unknown as D1Database;
}

/**
 * Build a mock D1 that throws an error when queried.
 */
function mockD1Error(errorMessage: string) {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockRejectedValue(new Error(errorMessage)),
      }),
    }),
  } as unknown as D1Database;
}

/** Minimal Env for most tests */
function makeEnv(db?: D1Database): Env {
  return {
    ADMIN_USERS: {} as DurableObjectNamespace,
    ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    DIAGNOSTICS_DB: db,
  };
}

/** Default valid JWT payload */
function validJwtPayload() {
  return {
    sub: 'user-1',
    username: 'admin',
    role: 'super-admin',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

// ─────────────────────────────────────────────
// Pure function tests: computeSegments
// ─────────────────────────────────────────────

describe('computeSegments', () => {
  it('returns empty for fewer than 2 timestamps', () => {
    expect(computeSegments([])).toEqual([]);
    expect(computeSegments([ts(0)])).toEqual([]);
  });

  it('returns ok segments for continuous heartbeats within 5 min', () => {
    const timestamps = [ts(0), ts(1), ts(2), ts(3), ts(4)];
    const segments = computeSegments(timestamps);

    expect(segments).toHaveLength(4);
    for (const seg of segments) {
      expect(seg.status).toBe('ok');
    }
    expect(segments[0]!.startTime).toBe(ts(0));
    expect(segments[0]!.endTime).toBe(ts(1));
    expect(segments[3]!.startTime).toBe(ts(3));
    expect(segments[3]!.endTime).toBe(ts(4));
  });

  it('detects gaps (>5 min between heartbeats)', () => {
    // 0, 1, 2, then 10-minute gap, then 11, 12
    const timestamps = [ts(0), ts(1), ts(2), ts(12), ts(13)];
    const segments = computeSegments(timestamps);

    expect(segments).toHaveLength(4);
    expect(segments[0]!.status).toBe('ok');  // 0->1 (1 min)
    expect(segments[1]!.status).toBe('ok');  // 1->2 (1 min)
    expect(segments[2]!.status).toBe('gap'); // 2->12 (10 min)
    expect(segments[3]!.status).toBe('ok');  // 12->13 (1 min)
  });

  it('detects offline periods (>30 min gaps)', () => {
    // 0, 1, then 60-minute gap, then 61
    const timestamps = [ts(0), ts(1), ts(61), ts(62)];
    const segments = computeSegments(timestamps);

    expect(segments).toHaveLength(3);
    expect(segments[0]!.status).toBe('ok');      // 0->1 (1 min)
    expect(segments[1]!.status).toBe('offline');  // 1->61 (60 min)
    expect(segments[2]!.status).toBe('ok');       // 61->62 (1 min)
  });

  it('handles mixed timeline (ok, gap, ok, offline, ok)', () => {
    const timestamps = [ts(0), ts(1), ts(10), ts(11), ts(50), ts(51)];
    const segments = computeSegments(timestamps);

    expect(segments).toHaveLength(5);
    expect(segments[0]!.status).toBe('ok');      // 0->1 (1 min)
    expect(segments[1]!.status).toBe('gap');     // 1->10 (9 min)
    expect(segments[2]!.status).toBe('ok');      // 10->11 (1 min)
    expect(segments[3]!.status).toBe('offline'); // 11->50 (39 min)
    expect(segments[4]!.status).toBe('ok');      // 50->51 (1 min)
  });

  it('treats exactly 5 min gap as ok (<=5 min)', () => {
    const timestamps = [ts(0), ts(5)];
    const segments = computeSegments(timestamps);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.status).toBe('ok');
  });

  it('treats 5 min + 1 ms as gap', () => {
    const timestamps = [BASE, BASE + 5 * 60 * 1000 + 1];
    const segments = computeSegments(timestamps);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.status).toBe('gap');
  });

  it('treats exactly 30 min gap as gap (<=30 min)', () => {
    const timestamps = [ts(0), ts(30)];
    const segments = computeSegments(timestamps);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.status).toBe('gap');
  });

  it('treats 30 min + 1 ms as offline', () => {
    const timestamps = [BASE, BASE + 30 * 60 * 1000 + 1];
    const segments = computeSegments(timestamps);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.status).toBe('offline');
  });
});

// ─────────────────────────────────────────────
// Pure function tests: computeSummary
// ─────────────────────────────────────────────

describe('computeSummary', () => {
  it('returns 100% uptime for empty segments', () => {
    const summary = computeSummary([]);
    expect(summary.uptimePercent).toBe(100);
    expect(summary.gapCount).toBe(0);
    expect(summary.longestGapMs).toBe(0);
  });

  it('computes 100% uptime for all-ok segments', () => {
    const segments = computeSegments([ts(0), ts(1), ts(2), ts(3)]);
    const summary = computeSummary(segments);

    expect(summary.uptimePercent).toBe(100);
    expect(summary.gapCount).toBe(0);
    expect(summary.longestGapMs).toBe(0);
  });

  it('computes uptimePercent correctly for mixed segments', () => {
    // ok: 0->1 (1 min), gap: 1->10 (9 min), ok: 10->11 (1 min)
    // total = 11 min, ok = 2 min, uptime = 2/11 = 18.18%
    const segments = computeSegments([ts(0), ts(1), ts(10), ts(11)]);
    const summary = computeSummary(segments);

    expect(summary.uptimePercent).toBeCloseTo(18.18, 1);
    expect(summary.gapCount).toBe(1);
    expect(summary.longestGapMs).toBe(9 * 60 * 1000);
  });

  it('computes gapCount including both gap and offline segments', () => {
    // ok, gap, ok, offline, ok
    const segments = computeSegments([ts(0), ts(1), ts(10), ts(11), ts(50), ts(51)]);
    const summary = computeSummary(segments);

    expect(summary.gapCount).toBe(2); // gap + offline
  });

  it('computes longestGapMs as the longest non-ok segment', () => {
    // gap: 1->10 (9 min), offline: 11->50 (39 min)
    const segments = computeSegments([ts(0), ts(1), ts(10), ts(11), ts(50), ts(51)]);
    const summary = computeSummary(segments);

    expect(summary.longestGapMs).toBe(39 * 60 * 1000);
  });

  it('handles 0% uptime (only 2 heartbeats far apart)', () => {
    // Only one segment: offline (0->60)
    const segments = computeSegments([ts(0), ts(60)]);
    const summary = computeSummary(segments);

    expect(summary.uptimePercent).toBe(0);
    expect(summary.gapCount).toBe(1);
    expect(summary.longestGapMs).toBe(60 * 60 * 1000);
  });
});

// ─────────────────────────────────────────────
// Handler integration tests
// ─────────────────────────────────────────────

describe('handleHeartbeatTimeline', () => {
  beforeEach(() => {
    mockVerifyJwt.mockReset();
    mockVerifyJwt.mockResolvedValue(validJwtPayload());
  });

  it('returns empty servers when DIAGNOSTICS_DB is not bound', async () => {
    const env = makeEnv(); // no DB
    const req = makeRequest();
    const res = await handleHeartbeatTimeline(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { servers: unknown[]; range: string } };
    expect(body.success).toBe(true);
    expect(body.data.servers).toEqual([]);
    expect(body.data.range).toBe('24h');
  });

  it('returns 401 when not authenticated', async () => {
    mockVerifyJwt.mockResolvedValueOnce(null);

    const env = makeEnv(mockD1([]));
    const req = makeUnauthRequest();
    const res = await handleHeartbeatTimeline(req, env);

    expect(res.status).toBe(401);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
  });

  it('validates range parameter', async () => {
    const env = makeEnv(mockD1([]));
    const req = makeRequest({ range: 'invalid' });
    const res = await handleHeartbeatTimeline(req, env);

    expect(res.status).toBe(400);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('Invalid range');
    expect(body.error).toContain('1h');
    expect(body.error).toContain('6h');
    expect(body.error).toContain('24h');
    expect(body.error).toContain('7d');
  });

  it('returns timeline with ok segments for continuous heartbeats', async () => {
    const now = Date.now();
    const rows = [
      { server_id: 'srv-01', region: 'us-east', timestamp: now - 4 * 60000 },
      { server_id: 'srv-01', region: 'us-east', timestamp: now - 3 * 60000 },
      { server_id: 'srv-01', region: 'us-east', timestamp: now - 2 * 60000 },
      { server_id: 'srv-01', region: 'us-east', timestamp: now - 1 * 60000 },
    ];

    const env = makeEnv(mockD1(rows));
    const req = makeRequest();
    const res = await handleHeartbeatTimeline(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { servers: Array<{ serverId: string; segments: Array<{ status: string }>; uptimePercent: number; gapCount: number }> } };
    expect(body.success).toBe(true);
    expect(body.data.servers).toHaveLength(1);

    const server = body.data.servers[0]!;
    expect(server.serverId).toBe('srv-01');
    expect(server.segments).toHaveLength(3);
    for (const seg of server.segments) {
      expect(seg.status).toBe('ok');
    }
    expect(server.uptimePercent).toBe(100);
    expect(server.gapCount).toBe(0);
  });

  it('detects gaps in heartbeats', async () => {
    const now = Date.now();
    const rows = [
      { server_id: 'srv-01', region: 'us-east', timestamp: now - 20 * 60000 },
      { server_id: 'srv-01', region: 'us-east', timestamp: now - 19 * 60000 },
      // 10-minute gap
      { server_id: 'srv-01', region: 'us-east', timestamp: now - 9 * 60000 },
      { server_id: 'srv-01', region: 'us-east', timestamp: now - 8 * 60000 },
    ];

    const env = makeEnv(mockD1(rows));
    const req = makeRequest();
    const res = await handleHeartbeatTimeline(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { servers: Array<{ segments: Array<{ status: string }> }> } };
    const server = body.data.servers[0]!;

    expect(server.segments).toHaveLength(3);
    expect(server.segments[0]!.status).toBe('ok');     // 20->19 (1 min)
    expect(server.segments[1]!.status).toBe('gap');    // 19->9 (10 min)
    expect(server.segments[2]!.status).toBe('ok');     // 9->8 (1 min)
  });

  it('detects offline periods', async () => {
    const now = Date.now();
    const rows = [
      { server_id: 'srv-01', region: 'eu-west', timestamp: now - 120 * 60000 },
      { server_id: 'srv-01', region: 'eu-west', timestamp: now - 119 * 60000 },
      // 60-minute gap (offline)
      { server_id: 'srv-01', region: 'eu-west', timestamp: now - 59 * 60000 },
      { server_id: 'srv-01', region: 'eu-west', timestamp: now - 58 * 60000 },
    ];

    const env = makeEnv(mockD1(rows));
    const req = makeRequest();
    const res = await handleHeartbeatTimeline(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { servers: Array<{ segments: Array<{ status: string }>; longestGapMs: number }> } };
    const server = body.data.servers[0]!;

    expect(server.segments).toHaveLength(3);
    expect(server.segments[0]!.status).toBe('ok');
    expect(server.segments[1]!.status).toBe('offline');
    expect(server.segments[2]!.status).toBe('ok');
    expect(server.longestGapMs).toBe(60 * 60000);
  });

  it('handles mixed timeline across multiple servers', async () => {
    const now = Date.now();
    const rows = [
      // Server A: continuous (ok)
      { server_id: 'srv-a', region: 'us-east', timestamp: now - 3 * 60000 },
      { server_id: 'srv-a', region: 'us-east', timestamp: now - 2 * 60000 },
      { server_id: 'srv-a', region: 'us-east', timestamp: now - 1 * 60000 },
      // Server B: with a gap
      { server_id: 'srv-b', region: 'eu-west', timestamp: now - 20 * 60000 },
      { server_id: 'srv-b', region: 'eu-west', timestamp: now - 5 * 60000 },
    ];

    const env = makeEnv(mockD1(rows));
    const req = makeRequest();
    const res = await handleHeartbeatTimeline(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { servers: Array<{ serverId: string; uptimePercent: number; gapCount: number }> } };
    expect(body.data.servers).toHaveLength(2);

    const srvA = body.data.servers.find(s => s.serverId === 'srv-a')!;
    const srvB = body.data.servers.find(s => s.serverId === 'srv-b')!;

    expect(srvA.uptimePercent).toBe(100);
    expect(srvA.gapCount).toBe(0);

    expect(srvB.uptimePercent).toBe(0); // 15-min gap, no ok segments
    expect(srvB.gapCount).toBe(1);
  });

  it('filters by serverId', async () => {
    const now = Date.now();
    const rows = [
      { server_id: 'srv-01', region: 'us-east', timestamp: now - 2 * 60000 },
      { server_id: 'srv-01', region: 'us-east', timestamp: now - 1 * 60000 },
    ];

    const db = mockD1(rows);
    const env = makeEnv(db);
    const req = makeRequest({ serverId: 'srv-01' });
    const res = await handleHeartbeatTimeline(req, env);

    expect(res.status).toBe(200);

    // Verify the query was constructed with serverId filter
    const prepareCall = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(prepareCall).toContain('server_id = ?');
  });

  it('filters by time range', async () => {
    const now = Date.now();
    const rows = [
      { server_id: 'srv-01', region: 'us-east', timestamp: now - 30 * 60000 },
      { server_id: 'srv-01', region: 'us-east', timestamp: now - 29 * 60000 },
    ];

    const db = mockD1(rows);
    const env = makeEnv(db);
    const req = makeRequest({ range: '1h' });
    const res = await handleHeartbeatTimeline(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { range: string } };
    expect(body.data.range).toBe('1h');

    // Verify the range start timestamp was passed to the query
    const bindCall = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0]!.value.bind as ReturnType<typeof vi.fn>;
    const boundArgs = bindCall.mock.calls[0] as number[];
    const rangeStart = boundArgs[0]!;
    // Should be approximately now - 1 hour
    const expectedStart = now - 1 * 60 * 60 * 1000;
    expect(Math.abs(rangeStart - expectedStart)).toBeLessThan(1000);
  });

  it('handles server with no gaps (100% uptime)', async () => {
    const now = Date.now();
    const rows: Array<{ server_id: string; region: string; timestamp: number }> = [];
    // 60 heartbeats at 1-minute intervals
    for (let i = 59; i >= 0; i--) {
      rows.push({ server_id: 'srv-01', region: 'us-east', timestamp: now - i * 60000 });
    }

    const env = makeEnv(mockD1(rows));
    const req = makeRequest();
    const res = await handleHeartbeatTimeline(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { servers: Array<{ uptimePercent: number; gapCount: number; longestGapMs: number }> } };
    const server = body.data.servers[0]!;

    expect(server.uptimePercent).toBe(100);
    expect(server.gapCount).toBe(0);
    expect(server.longestGapMs).toBe(0);
  });

  it('handles server with all gaps (0% uptime)', async () => {
    const now = Date.now();
    // Two heartbeats 2 hours apart — one offline segment
    const rows = [
      { server_id: 'srv-01', region: 'us-east', timestamp: now - 120 * 60000 },
      { server_id: 'srv-01', region: 'us-east', timestamp: now - 1 * 60000 },
    ];

    const env = makeEnv(mockD1(rows));
    const req = makeRequest();
    const res = await handleHeartbeatTimeline(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { servers: Array<{ uptimePercent: number; gapCount: number; longestGapMs: number }> } };
    const server = body.data.servers[0]!;

    expect(server.uptimePercent).toBe(0);
    expect(server.gapCount).toBe(1);
    expect(server.longestGapMs).toBe(119 * 60000);
  });

  it('returns 500 on D1 error', async () => {
    const db = mockD1Error('D1_ERROR: database unavailable');
    const env = makeEnv(db);
    const req = makeRequest();
    const res = await handleHeartbeatTimeline(req, env);

    expect(res.status).toBe(500);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('Failed to query heartbeat data');
  });

  it('accepts all valid range values', async () => {
    const env = makeEnv(mockD1([]));

    for (const range of ['1h', '6h', '24h', '7d']) {
      const req = makeRequest({ range });
      const res = await handleHeartbeatTimeline(req, env);
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; data: { range: string } };
      expect(body.data.range).toBe(range);
    }
  });

  it('defaults to 24h range when not specified', async () => {
    const env = makeEnv(mockD1([]));
    const req = makeRequest(); // no range param
    const res = await handleHeartbeatTimeline(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { range: string } };
    expect(body.data.range).toBe('24h');
  });

  it('includes lastUpdated timestamp in response', async () => {
    const before = Date.now();
    const env = makeEnv(mockD1([]));
    const req = makeRequest();
    const res = await handleHeartbeatTimeline(req, env);

    const body = await res.json() as { success: boolean; data: { lastUpdated: number } };
    const after = Date.now();

    expect(body.data.lastUpdated).toBeGreaterThanOrEqual(before);
    expect(body.data.lastUpdated).toBeLessThanOrEqual(after);
  });

  it('sorts servers by serverId for stable output', async () => {
    const now = Date.now();
    const rows = [
      { server_id: 'srv-c', region: 'ap-south', timestamp: now - 2 * 60000 },
      { server_id: 'srv-c', region: 'ap-south', timestamp: now - 1 * 60000 },
      { server_id: 'srv-a', region: 'us-east', timestamp: now - 2 * 60000 },
      { server_id: 'srv-a', region: 'us-east', timestamp: now - 1 * 60000 },
      { server_id: 'srv-b', region: 'eu-west', timestamp: now - 2 * 60000 },
      { server_id: 'srv-b', region: 'eu-west', timestamp: now - 1 * 60000 },
    ];

    const env = makeEnv(mockD1(rows));
    const req = makeRequest();
    const res = await handleHeartbeatTimeline(req, env);

    const body = await res.json() as { success: boolean; data: { servers: Array<{ serverId: string }> } };
    const ids = body.data.servers.map(s => s.serverId);
    expect(ids).toEqual(['srv-a', 'srv-b', 'srv-c']);
  });

  it('includes region in server timeline', async () => {
    const now = Date.now();
    const rows = [
      { server_id: 'srv-01', region: 'eu-west', timestamp: now - 2 * 60000 },
      { server_id: 'srv-01', region: 'eu-west', timestamp: now - 1 * 60000 },
    ];

    const env = makeEnv(mockD1(rows));
    const req = makeRequest();
    const res = await handleHeartbeatTimeline(req, env);

    const body = await res.json() as { success: boolean; data: { servers: Array<{ serverId: string; region: string }> } };
    expect(body.data.servers[0]!.region).toBe('eu-west');
  });

  it('returns empty servers array when no data matches range', async () => {
    const env = makeEnv(mockD1([])); // empty results
    const req = makeRequest({ range: '1h' });
    const res = await handleHeartbeatTimeline(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { servers: unknown[] } };
    expect(body.data.servers).toEqual([]);
  });
});
