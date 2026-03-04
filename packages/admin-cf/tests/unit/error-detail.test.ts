/**
 * Unit tests for the error detail drill-down endpoint
 * Tests handleErrorDetail with mock D1 bindings
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleErrorDetail } from '../../src/routes/errors.js';
import type { Env } from '../../src/types.js';

// --- Mock D1 helpers ---

interface MockD1Row {
  time_bucket: string;
  app_version: string;
  platform: string;
  count: number;
  first_seen: number;
  last_seen: number;
  sample_message: string;
  sample_stack_trace: string | null;
  category: string;
  error_signature?: string;
}

function createMockD1(rows: MockD1Row[]) {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({
          results: rows,
        }),
      }),
    }),
  } as unknown as D1Database;
}

function createMockD1Error(errorMessage: string) {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockRejectedValue(new Error(errorMessage)),
      }),
    }),
  } as unknown as D1Database;
}

// --- Mock auth (mock the JWT verification to always succeed) ---

// We mock requireAuth at the module level
vi.mock('../../src/routes/auth.js', () => ({
  requireAuth: vi.fn().mockResolvedValue({
    sub: 'test-user',
    username: 'admin',
    role: 'admin',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
}));

function createMockEnv(db?: D1Database): Env {
  return {
    ADMIN_USERS: {} as DurableObjectNamespace,
    ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    DIAGNOSTICS_DB: db,
  } as Env;
}

function createRequest(): Request {
  return new Request('https://admin.test/admin/api/errors/abc123', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  });
}

// --- Test data ---

const now = Date.now();
const oneHourAgo = now - 3600000;
const twoHoursAgo = now - 7200000;
const threeHoursAgo = now - 10800000;

const sampleRows: MockD1Row[] = [
  {
    time_bucket: new Date(now).toISOString(),
    app_version: '1.2.1',
    platform: 'android',
    count: 100,
    first_seen: oneHourAgo,
    last_seen: now,
    sample_message: 'WebRTC data channel failed: ICE connection timeout',
    sample_stack_trace: 'packages/app/lib/services/webrtc_service.dart:142\npackages/app/lib/services/connection_manager.dart:87',
    category: 'network',
  },
  {
    time_bucket: new Date(oneHourAgo).toISOString(),
    app_version: '1.2.1',
    platform: 'ios',
    count: 50,
    first_seen: twoHoursAgo,
    last_seen: oneHourAgo,
    sample_message: 'WebRTC data channel failed: ICE connection timeout',
    sample_stack_trace: null,
    category: 'network',
  },
  {
    time_bucket: new Date(twoHoursAgo).toISOString(),
    app_version: '1.2.0',
    platform: 'android',
    count: 50,
    first_seen: threeHoursAgo,
    last_seen: twoHoursAgo,
    sample_message: 'WebRTC connection timed out',
    sample_stack_trace: 'packages/app/lib/services/webrtc_service.dart:142',
    category: 'network',
  },
];

// --- Tests ---

describe('handleErrorDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 404 when D1 is not bound', async () => {
    const env = createMockEnv(undefined);
    const req = createRequest();
    const res = await handleErrorDetail(req, env, 'abc123');

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Error signature not found');
  });

  it('returns 404 when no rows match the signature', async () => {
    const db = createMockD1([]);
    const env = createMockEnv(db);
    const req = createRequest();
    const res = await handleErrorDetail(req, env, 'nonexistent_sig');

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Error signature not found');
  });

  it('returns 200 with correct detail structure for known signature', async () => {
    const db = createMockD1(sampleRows);
    const env = createMockEnv(db);
    const req = createRequest();
    const res = await handleErrorDetail(req, env, 'abc123');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();

    const data = body.data;
    expect(data.errorSignature).toBe('abc123');
    expect(data.category).toBe('network');
    expect(data.totalCount).toBe(200); // 100 + 50 + 50
    expect(data.sampleMessage).toBe('WebRTC data channel failed: ICE connection timeout');
    expect(data.sampleStackTrace).toContain('webrtc_service.dart:142');
    expect(data.versionDistribution).toBeDefined();
    expect(data.platformDistribution).toBeDefined();
    expect(data.occurrenceTimeline).toBeDefined();
  });

  it('calculates version distribution correctly', async () => {
    const db = createMockD1(sampleRows);
    const env = createMockEnv(db);
    const req = createRequest();
    const res = await handleErrorDetail(req, env, 'abc123');
    const body = await res.json();

    const vDist = body.data.versionDistribution;
    expect(vDist).toHaveLength(2);

    // 1.2.1: 100 + 50 = 150, 1.2.0: 50
    const v121 = vDist.find((v: { name: string }) => v.name === '1.2.1');
    const v120 = vDist.find((v: { name: string }) => v.name === '1.2.0');
    expect(v121).toBeDefined();
    expect(v120).toBeDefined();
    expect(v121.count).toBe(150);
    expect(v120.count).toBe(50);
  });

  it('calculates platform distribution correctly', async () => {
    const db = createMockD1(sampleRows);
    const env = createMockEnv(db);
    const req = createRequest();
    const res = await handleErrorDetail(req, env, 'abc123');
    const body = await res.json();

    const pDist = body.data.platformDistribution;
    expect(pDist).toHaveLength(2);

    // android: 100 + 50 = 150, ios: 50
    const android = pDist.find((p: { name: string }) => p.name === 'android');
    const ios = pDist.find((p: { name: string }) => p.name === 'ios');
    expect(android).toBeDefined();
    expect(ios).toBeDefined();
    expect(android.count).toBe(150);
    expect(ios.count).toBe(50);
  });

  it('calculates distribution percentages correctly for [100, 50, 50]', async () => {
    const db = createMockD1(sampleRows);
    const env = createMockEnv(db);
    const req = createRequest();
    const res = await handleErrorDetail(req, env, 'abc123');
    const body = await res.json();

    const vDist = body.data.versionDistribution;
    // 1.2.1: 150/200 = 75%, 1.2.0: 50/200 = 25%
    const v121 = vDist.find((v: { name: string }) => v.name === '1.2.1');
    const v120 = vDist.find((v: { name: string }) => v.name === '1.2.0');
    expect(v121.percentage).toBe(75);
    expect(v120.percentage).toBe(25);

    // Verify percentages sum to 100
    const totalPct = vDist.reduce((sum: number, v: { percentage: number }) => sum + v.percentage, 0);
    expect(totalPct).toBe(100);
  });

  it('handles percentage calculation for equal counts', async () => {
    const equalRows: MockD1Row[] = [
      {
        time_bucket: new Date(now).toISOString(),
        app_version: '1.0.0',
        platform: 'android',
        count: 100,
        first_seen: oneHourAgo,
        last_seen: now,
        sample_message: 'Test error',
        sample_stack_trace: null,
        category: 'crash',
      },
      {
        time_bucket: new Date(oneHourAgo).toISOString(),
        app_version: '1.1.0',
        platform: 'ios',
        count: 50,
        first_seen: twoHoursAgo,
        last_seen: oneHourAgo,
        sample_message: 'Test error',
        sample_stack_trace: null,
        category: 'crash',
      },
      {
        time_bucket: new Date(twoHoursAgo).toISOString(),
        app_version: '1.2.0',
        platform: 'web',
        count: 50,
        first_seen: threeHoursAgo,
        last_seen: twoHoursAgo,
        sample_message: 'Test error',
        sample_stack_trace: null,
        category: 'crash',
      },
    ];

    const db = createMockD1(equalRows);
    const env = createMockEnv(db);
    const req = createRequest();
    const res = await handleErrorDetail(req, env, 'sig123');
    const body = await res.json();

    const vDist = body.data.versionDistribution;
    expect(vDist).toHaveLength(3);
    // 100/200 = 50%, 50/200 = 25%, 50/200 = 25%
    const percentages = vDist.map((v: { percentage: number }) => v.percentage).sort();
    expect(percentages).toEqual([25, 25, 50]);
  });

  it('returns null sampleStackTrace when all rows have null traces', async () => {
    const noTraceRows: MockD1Row[] = [
      {
        time_bucket: new Date(now).toISOString(),
        app_version: '1.0.0',
        platform: 'android',
        count: 10,
        first_seen: oneHourAgo,
        last_seen: now,
        sample_message: 'Error with no trace',
        sample_stack_trace: null,
        category: 'other',
      },
      {
        time_bucket: new Date(oneHourAgo).toISOString(),
        app_version: '1.0.0',
        platform: 'ios',
        count: 5,
        first_seen: twoHoursAgo,
        last_seen: oneHourAgo,
        sample_message: 'Error with no trace',
        sample_stack_trace: null,
        category: 'other',
      },
    ];

    const db = createMockD1(noTraceRows);
    const env = createMockEnv(db);
    const req = createRequest();
    const res = await handleErrorDetail(req, env, 'notrace_sig');
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data.sampleStackTrace).toBeNull();
  });

  it('returns occurrence timeline sorted ascending by timestamp', async () => {
    const db = createMockD1(sampleRows);
    const env = createMockEnv(db);
    const req = createRequest();
    const res = await handleErrorDetail(req, env, 'abc123');
    const body = await res.json();

    const timeline = body.data.occurrenceTimeline;
    expect(timeline.length).toBeGreaterThanOrEqual(2);

    // Verify ascending order
    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i].timestamp).toBeGreaterThanOrEqual(timeline[i - 1].timestamp);
    }
  });

  it('uses sample message from the most recent row', async () => {
    const db = createMockD1(sampleRows);
    const env = createMockEnv(db);
    const req = createRequest();
    const res = await handleErrorDetail(req, env, 'abc123');
    const body = await res.json();

    // First row (most recent DESC) has the specific message
    expect(body.data.sampleMessage).toBe('WebRTC data channel failed: ICE connection timeout');
  });

  it('computes firstSeen as minimum and lastSeen as maximum across rows', async () => {
    const db = createMockD1(sampleRows);
    const env = createMockEnv(db);
    const req = createRequest();
    const res = await handleErrorDetail(req, env, 'abc123');
    const body = await res.json();

    expect(body.data.firstSeen).toBe(threeHoursAgo);
    expect(body.data.lastSeen).toBe(now);
  });

  it('returns 500 when D1 query fails', async () => {
    const db = createMockD1Error('D1 connection failed');
    const env = createMockEnv(db);
    const req = createRequest();
    const res = await handleErrorDetail(req, env, 'abc123');

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('Failed to query error detail');
  });

  it('returns correct JSON content type', async () => {
    const db = createMockD1(sampleRows);
    const env = createMockEnv(db);
    const req = createRequest();
    const res = await handleErrorDetail(req, env, 'abc123');

    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('handles single row correctly', async () => {
    const singleRow: MockD1Row[] = [
      {
        time_bucket: new Date(now).toISOString(),
        app_version: '2.0.0',
        platform: 'android',
        count: 1,
        first_seen: now,
        last_seen: now,
        sample_message: 'One-time error',
        sample_stack_trace: 'main.dart:1',
        category: 'crash',
      },
    ];

    const db = createMockD1(singleRow);
    const env = createMockEnv(db);
    const req = createRequest();
    const res = await handleErrorDetail(req, env, 'single_sig');
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data.totalCount).toBe(1);
    expect(body.data.versionDistribution).toHaveLength(1);
    expect(body.data.versionDistribution[0].percentage).toBe(100);
    expect(body.data.platformDistribution).toHaveLength(1);
    expect(body.data.platformDistribution[0].percentage).toBe(100);
  });

  it('version distribution is sorted descending by count', async () => {
    const db = createMockD1(sampleRows);
    const env = createMockEnv(db);
    const req = createRequest();
    const res = await handleErrorDetail(req, env, 'abc123');
    const body = await res.json();

    const vDist = body.data.versionDistribution;
    for (let i = 1; i < vDist.length; i++) {
      expect(vDist[i].count).toBeLessThanOrEqual(vDist[i - 1].count);
    }
  });
});
