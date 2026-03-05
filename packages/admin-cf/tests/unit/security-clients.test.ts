/**
 * Unit tests for security-clients route handlers
 *
 * US-7.2: Bad Client Detection (handleBadClients)
 * US-7.4: Pairing Code Brute Force Detection (handlePairingBruteForce)
 *
 * Tests cover:
 * - Auth enforcement (401 without token)
 * - Empty data when no DIAGNOSTICS_DB
 * - Valid responses with mock D1 data
 * - Pagination (limit/offset)
 * - Range validation
 * - Timeline aggregation
 * - Top offenders
 * - Threshold alerts
 * - Severity ranking (numeric CASE instead of lexicographic MAX)
 * - Global summary calculations (not page-scoped)
 * - Error handling (generic messages, no D1 details leaked)
 */

import { describe, it, expect, vi } from 'vitest';
import { handleBadClients, handlePairingBruteForce } from '../../src/routes/security-clients.js';
import type { Env } from '../../src/types.js';

// ── Mock JWT / Auth ──────────────────────────────────────

vi.mock('../../src/crypto.js', () => ({
  verifyJwt: vi.fn(),
}));

import { verifyJwt } from '../../src/crypto.js';
const mockVerifyJwt = vi.mocked(verifyJwt);

// ── Helpers ──────────────────────────────────────────────

function makeRequest(path: string, token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return new Request(`https://admin.example.com${path}`, { headers });
}

function makeBaseEnv(overrides: Partial<Env> = {}): Env {
  return {
    ADMIN_USERS: {} as unknown as DurableObjectNamespace,
    ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    ...overrides,
  };
}

function authPayload() {
  return {
    sub: 'user1',
    username: 'admin',
    role: 'admin',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

/**
 * Creates a mock D1Database that returns canned results for batch() calls.
 * Each element in batchResults corresponds to one statement in the batch.
 */
function createMockD1(batchResults: Array<{ results?: unknown[]; success: boolean }>) {
  const mockPrepared = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
  };

  return {
    prepare: vi.fn().mockReturnValue(mockPrepared),
    batch: vi.fn().mockResolvedValue(batchResults),
  };
}

/**
 * Creates a mock D1Database that throws an error (simulating D1 failure).
 */
function createFailingD1() {
  const mockPrepared = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
  };

  return {
    prepare: vi.fn().mockReturnValue(mockPrepared),
    batch: vi.fn().mockRejectedValue(
      new Error('D1_INTERNAL: connection pool exhausted (simulated)')
    ),
  };
}

// ══════════════════════════════════════════════════════════
// US-7.2: handleBadClients
// ══════════════════════════════════════════════════════════

describe('handleBadClients', () => {
  // ── Auth ──

  it('returns 401 without auth token', async () => {
    mockVerifyJwt.mockResolvedValue(null);
    const req = makeRequest('/admin/api/security/bad-clients');
    const env = makeBaseEnv();

    const res = await handleBadClients(req, env);
    expect(res.status).toBe(401);

    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 401 with invalid auth token', async () => {
    mockVerifyJwt.mockResolvedValue(null);
    const req = new Request('https://admin.example.com/admin/api/security/bad-clients', {
      headers: { 'Authorization': 'Bearer invalid-jwt-token' },
    });
    const env = makeBaseEnv();

    const res = await handleBadClients(req, env);
    expect(res.status).toBe(401);

    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('Unauthorized');
  });

  // ── Empty data when no DIAGNOSTICS_DB ──

  it('returns empty data when DIAGNOSTICS_DB is not bound', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const req = makeRequest('/admin/api/security/bad-clients', 'valid-token');
    const env = makeBaseEnv(); // no DIAGNOSTICS_DB

    const res = await handleBadClients(req, env);
    expect(res.status).toBe(200);

    const body = await res.json() as { success: boolean; data: Record<string, unknown> };
    expect(body.success).toBe(true);
    expect(body.data.range).toBe('7d');
    expect(body.data.summary).toEqual({
      totalBadClients: 0,
      totalViolations: 0,
      quarantinedCount: 0,
    });
    expect(body.data.clients).toEqual([]);
    expect(body.data.total).toBe(0);
    expect(body.data.limit).toBe(50);
    expect(body.data.offset).toBe(0);
    expect(typeof body.data.lastUpdated).toBe('number');
  });

  // ── Valid response with mock data ──

  it('returns aggregated bad-client data from D1', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const now = Date.now();
    // batch() returns 4 result sets: count, totalViolations, quarantinedCount, clientRows
    const mockD1 = createMockD1([
      { results: [{ total: 2 }], success: true },
      { results: [{ total_violations: 18 }], success: true },
      { results: [{ quarantined_count: 0 }], success: true },
      {
        results: [
          {
            source_ip: '192.168.1.100',
            violation_count: 15,
            last_seen: now - 1000,
            first_seen: now - 86400000,
            all_details: JSON.stringify({ violation_type: 'malformed_message', count: 10 })
              + '||' + JSON.stringify({ violation_type: 'signature_failure', count: 5 }),
            severity_rank: 3, // 'high'
          },
          {
            source_ip: '10.0.0.50',
            violation_count: 3,
            last_seen: now - 5000,
            first_seen: now - 43200000,
            all_details: JSON.stringify({ violation_type: 'protocol_violation', count: 3 }),
            severity_rank: 2, // 'medium'
          },
        ],
        success: true,
      },
    ]);

    const req = makeRequest('/admin/api/security/bad-clients?range=7d', 'valid-token');
    const env = makeBaseEnv({ DIAGNOSTICS_DB: mockD1 });

    const res = await handleBadClients(req, env);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      success: boolean;
      data: {
        range: string;
        summary: { totalBadClients: number; totalViolations: number; quarantinedCount: number };
        clients: Array<{
          sourceIp: string;
          violationCount: number;
          violations: { malformedMessages: number; signatureFailures: number; protocolViolations: number; other: number };
          severity: string;
        }>;
        total: number;
        limit: number;
        offset: number;
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.range).toBe('7d');
    expect(body.data.summary.totalBadClients).toBe(2);
    expect(body.data.summary.totalViolations).toBe(18);
    expect(body.data.summary.quarantinedCount).toBe(0);
    expect(body.data.clients).toHaveLength(2);

    // First client (highest violations)
    expect(body.data.clients[0]!.sourceIp).toBe('192.168.1.100');
    expect(body.data.clients[0]!.violationCount).toBe(15);
    expect(body.data.clients[0]!.violations.malformedMessages).toBe(10);
    expect(body.data.clients[0]!.violations.signatureFailures).toBe(5);
    expect(body.data.clients[0]!.severity).toBe('high');

    // Second client
    expect(body.data.clients[1]!.sourceIp).toBe('10.0.0.50');
    expect(body.data.clients[1]!.violations.protocolViolations).toBe(3);
    expect(body.data.clients[1]!.severity).toBe('medium');

    // Verify batch was used
    expect(mockD1.batch).toHaveBeenCalledTimes(1);
  });

  // ── Severity ranking ──

  it('resolves severity correctly using numeric rank (not lexicographic)', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const now = Date.now();
    const mockD1 = createMockD1([
      { results: [{ total: 2 }], success: true },
      { results: [{ total_violations: 60 }], success: true },
      { results: [{ quarantined_count: 1 }], success: true },
      {
        results: [
          {
            source_ip: '1.2.3.4',
            violation_count: 50,
            last_seen: now,
            first_seen: now - 1000,
            all_details: null,
            severity_rank: 4, // 'critical' — would be wrong with lexicographic MAX
          },
          {
            source_ip: '5.6.7.8',
            violation_count: 10,
            last_seen: now,
            first_seen: now - 1000,
            all_details: null,
            severity_rank: 1, // 'low'
          },
        ],
        success: true,
      },
    ]);

    const req = makeRequest('/admin/api/security/bad-clients', 'valid-token');
    const env = makeBaseEnv({ DIAGNOSTICS_DB: mockD1 });

    const res = await handleBadClients(req, env);
    const body = await res.json() as {
      data: {
        clients: Array<{ severity: string }>;
        summary: { quarantinedCount: number };
      };
    };

    // Critical severity must survive numeric ranking
    expect(body.data.clients[0]!.severity).toBe('critical');
    expect(body.data.clients[1]!.severity).toBe('low');
    expect(body.data.summary.quarantinedCount).toBe(1);
  });

  // ── Pagination ──

  it('respects limit and offset parameters', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const mockD1 = createMockD1([
      { results: [{ total: 100 }], success: true },
      { results: [{ total_violations: 500 }], success: true },
      { results: [{ quarantined_count: 3 }], success: true },
      { results: [], success: true },
    ]);

    const req = makeRequest(
      '/admin/api/security/bad-clients?limit=10&offset=20',
      'valid-token'
    );
    const env = makeBaseEnv({ DIAGNOSTICS_DB: mockD1 });

    const res = await handleBadClients(req, env);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      success: boolean;
      data: { total: number; limit: number; offset: number };
    };
    expect(body.data.total).toBe(100);
    expect(body.data.limit).toBe(10);
    expect(body.data.offset).toBe(20);
  });

  it('summary uses global counts not page-scoped', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    // Global: 200 violations, 5 quarantined; page: only 1 client with 10 violations
    const now = Date.now();
    const mockD1 = createMockD1([
      { results: [{ total: 50 }], success: true },
      { results: [{ total_violations: 200 }], success: true },
      { results: [{ quarantined_count: 5 }], success: true },
      {
        results: [{
          source_ip: '1.2.3.4',
          violation_count: 10,
          last_seen: now,
          first_seen: now - 1000,
          all_details: null,
          severity_rank: 2,
        }],
        success: true,
      },
    ]);

    const req = makeRequest(
      '/admin/api/security/bad-clients?limit=1&offset=0',
      'valid-token'
    );
    const env = makeBaseEnv({ DIAGNOSTICS_DB: mockD1 });

    const res = await handleBadClients(req, env);
    const body = await res.json() as {
      data: {
        summary: { totalBadClients: number; totalViolations: number; quarantinedCount: number };
        clients: unknown[];
      };
    };

    // Summary should reflect global counts, not the single page result
    expect(body.data.summary.totalBadClients).toBe(50);
    expect(body.data.summary.totalViolations).toBe(200);
    expect(body.data.summary.quarantinedCount).toBe(5);
    expect(body.data.clients).toHaveLength(1);
  });

  it('clamps limit to max 200 and min 1', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const mockD1 = createMockD1([
      { results: [{ total: 0 }], success: true },
      { results: [{ total_violations: 0 }], success: true },
      { results: [{ quarantined_count: 0 }], success: true },
      { results: [], success: true },
    ]);

    const req = makeRequest(
      '/admin/api/security/bad-clients?limit=999',
      'valid-token'
    );
    const env = makeBaseEnv({ DIAGNOSTICS_DB: mockD1 });

    const res = await handleBadClients(req, env);
    const body = await res.json() as { data: { limit: number } };
    expect(body.data.limit).toBe(200);
  });

  it('clamps negative offset to 0', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const mockD1 = createMockD1([
      { results: [{ total: 0 }], success: true },
      { results: [{ total_violations: 0 }], success: true },
      { results: [{ quarantined_count: 0 }], success: true },
      { results: [], success: true },
    ]);

    const req = makeRequest(
      '/admin/api/security/bad-clients?offset=-5',
      'valid-token'
    );
    const env = makeBaseEnv({ DIAGNOSTICS_DB: mockD1 });

    const res = await handleBadClients(req, env);
    const body = await res.json() as { data: { offset: number } };
    expect(body.data.offset).toBe(0);
  });

  // ── Range validation ──

  it('returns 400 for invalid range parameter', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const req = makeRequest(
      '/admin/api/security/bad-clients?range=invalid',
      'valid-token'
    );
    const env = makeBaseEnv();

    const res = await handleBadClients(req, env);
    expect(res.status).toBe(400);

    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('Invalid range');
  });

  it('accepts 24h range', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const req = makeRequest(
      '/admin/api/security/bad-clients?range=24h',
      'valid-token'
    );
    const env = makeBaseEnv();

    const res = await handleBadClients(req, env);
    expect(res.status).toBe(200);

    const body = await res.json() as { data: { range: string } };
    expect(body.data.range).toBe('24h');
  });

  it('accepts 30d range', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const req = makeRequest(
      '/admin/api/security/bad-clients?range=30d',
      'valid-token'
    );
    const env = makeBaseEnv();

    const res = await handleBadClients(req, env);
    expect(res.status).toBe(200);

    const body = await res.json() as { data: { range: string } };
    expect(body.data.range).toBe('30d');
  });

  it('defaults range to 7d when not specified', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const req = makeRequest('/admin/api/security/bad-clients', 'valid-token');
    const env = makeBaseEnv();

    const res = await handleBadClients(req, env);
    const body = await res.json() as { data: { range: string } };
    expect(body.data.range).toBe('7d');
  });

  // ── Error handling ──

  it('returns generic error message when D1 fails (no details leaked)', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const req = makeRequest('/admin/api/security/bad-clients', 'valid-token');
    const env = makeBaseEnv({ DIAGNOSTICS_DB: createFailingD1() });

    const res = await handleBadClients(req, env);
    expect(res.status).toBe(500);

    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('Failed to fetch bad client data');
    expect(body.error).not.toContain('D1_INTERNAL');
    expect(body.error).not.toContain('connection pool');
  });

  // ── Quarantined count ──

  it('counts quarantined clients (severity=critical) correctly', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const now = Date.now();
    const mockD1 = createMockD1([
      { results: [{ total: 2 }], success: true },
      { results: [{ total_violations: 55 }], success: true },
      { results: [{ quarantined_count: 1 }], success: true },
      {
        results: [
          {
            source_ip: '1.2.3.4',
            violation_count: 50,
            last_seen: now,
            first_seen: now - 1000,
            all_details: JSON.stringify({ violation_type: 'malformed_message', count: 50 }),
            severity_rank: 4, // critical
          },
          {
            source_ip: '5.6.7.8',
            violation_count: 5,
            last_seen: now,
            first_seen: now - 1000,
            all_details: null,
            severity_rank: 1, // low
          },
        ],
        success: true,
      },
    ]);

    const req = makeRequest('/admin/api/security/bad-clients', 'valid-token');
    const env = makeBaseEnv({ DIAGNOSTICS_DB: mockD1 });

    const res = await handleBadClients(req, env);
    const body = await res.json() as {
      data: { summary: { quarantinedCount: number } };
    };
    expect(body.data.summary.quarantinedCount).toBe(1);
  });

  // ── Malformed details parsing ──

  it('handles non-JSON detail blobs gracefully (counted as other)', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const now = Date.now();
    const mockD1 = createMockD1([
      { results: [{ total: 1 }], success: true },
      { results: [{ total_violations: 3 }], success: true },
      { results: [{ quarantined_count: 0 }], success: true },
      {
        results: [
          {
            source_ip: '1.2.3.4',
            violation_count: 3,
            last_seen: now,
            first_seen: now - 1000,
            all_details: 'not-json||also-not-json',
            severity_rank: 2,
          },
        ],
        success: true,
      },
    ]);

    const req = makeRequest('/admin/api/security/bad-clients', 'valid-token');
    const env = makeBaseEnv({ DIAGNOSTICS_DB: mockD1 });

    const res = await handleBadClients(req, env);
    const body = await res.json() as {
      data: {
        clients: Array<{
          violations: { malformedMessages: number; signatureFailures: number; protocolViolations: number; other: number };
        }>;
      };
    };
    expect(body.data.clients[0]!.violations.other).toBe(2);
    expect(body.data.clients[0]!.violations.malformedMessages).toBe(0);
  });

  // ── Response headers ──

  it('returns application/json content type and no-store cache', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const req = makeRequest('/admin/api/security/bad-clients', 'valid-token');
    const env = makeBaseEnv();

    const res = await handleBadClients(req, env);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

// ══════════════════════════════════════════════════════════
// US-7.4: handlePairingBruteForce
// ══════════════════════════════════════════════════════════

describe('handlePairingBruteForce', () => {
  // ── Auth ──

  it('returns 401 without auth token', async () => {
    mockVerifyJwt.mockResolvedValue(null);
    const req = makeRequest('/admin/api/security/pairing-abuse');
    const env = makeBaseEnv();

    const res = await handlePairingBruteForce(req, env);
    expect(res.status).toBe(401);

    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 401 with invalid auth token', async () => {
    mockVerifyJwt.mockResolvedValue(null);
    const req = new Request('https://admin.example.com/admin/api/security/pairing-abuse', {
      headers: { 'Authorization': 'Bearer invalid-jwt-token' },
    });
    const env = makeBaseEnv();

    const res = await handlePairingBruteForce(req, env);
    expect(res.status).toBe(401);

    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('Unauthorized');
  });

  // ── Empty data when no DIAGNOSTICS_DB ──

  it('returns empty data when DIAGNOSTICS_DB is not bound', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const req = makeRequest('/admin/api/security/pairing-abuse', 'valid-token');
    const env = makeBaseEnv();

    const res = await handlePairingBruteForce(req, env);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      success: boolean;
      data: {
        range: string;
        summary: { totalFailedAttempts: number; uniqueSessions: number; alertCount: number; threshold: number };
        timeline: unknown[];
        topOffenders: unknown[];
        lastUpdated: number;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.range).toBe('24h');
    expect(body.data.summary.totalFailedAttempts).toBe(0);
    expect(body.data.summary.uniqueSessions).toBe(0);
    expect(body.data.summary.alertCount).toBe(0);
    expect(body.data.summary.threshold).toBe(20);
    expect(body.data.timeline).toEqual([]);
    expect(body.data.topOffenders).toEqual([]);
    expect(typeof body.data.lastUpdated).toBe('number');
  });

  // ── Valid response with mock data ──

  it('returns brute force data from D1', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const now = Date.now();
    const hourBucket = Math.floor(now / 3600000) * 3600000;

    // batch() returns 4 result sets: summary, alertCount, timeline, offenders
    const mockD1 = createMockD1([
      { results: [{ total_failed: 150, unique_sessions: 5 }], success: true },
      { results: [{ alert_count: 2 }], success: true },
      {
        results: [
          { hour_bucket: hourBucket - 7200000, failed_attempts: 30, unique_sessions: 2 },
          { hour_bucket: hourBucket - 3600000, failed_attempts: 50, unique_sessions: 3 },
          { hour_bucket: hourBucket, failed_attempts: 70, unique_sessions: 4 },
        ],
        success: true,
      },
      {
        results: [
          { source_ip: '10.0.0.1', failed_attempts: 80, first_seen: now - 3600000, last_seen: now },
          { source_ip: '10.0.0.2', failed_attempts: 40, first_seen: now - 7200000, last_seen: now - 1000 },
          { source_ip: '10.0.0.3', failed_attempts: 30, first_seen: now - 86400000, last_seen: now - 5000 },
        ],
        success: true,
      },
    ]);

    const req = makeRequest('/admin/api/security/pairing-abuse?range=24h', 'valid-token');
    const env = makeBaseEnv({ DIAGNOSTICS_DB: mockD1 });

    const res = await handlePairingBruteForce(req, env);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      success: boolean;
      data: {
        range: string;
        summary: { totalFailedAttempts: number; uniqueSessions: number; alertCount: number; threshold: number };
        timeline: Array<{ timestamp: number; failedAttempts: number; uniqueSessions: number }>;
        topOffenders: Array<{ sourceIp: string; failedAttempts: number; firstSeen: number; lastSeen: number }>;
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.range).toBe('24h');

    // Summary
    expect(body.data.summary.totalFailedAttempts).toBe(150);
    expect(body.data.summary.uniqueSessions).toBe(5);
    expect(body.data.summary.alertCount).toBe(2);
    expect(body.data.summary.threshold).toBe(20);

    // Timeline
    expect(body.data.timeline).toHaveLength(3);
    expect(body.data.timeline[0]!.failedAttempts).toBe(30);
    expect(body.data.timeline[1]!.failedAttempts).toBe(50);
    expect(body.data.timeline[2]!.failedAttempts).toBe(70);

    // Top offenders
    expect(body.data.topOffenders).toHaveLength(3);
    expect(body.data.topOffenders[0]!.sourceIp).toBe('10.0.0.1');
    expect(body.data.topOffenders[0]!.failedAttempts).toBe(80);
    expect(body.data.topOffenders[1]!.sourceIp).toBe('10.0.0.2');
    expect(body.data.topOffenders[2]!.sourceIp).toBe('10.0.0.3');

    // Verify batch was used
    expect(mockD1.batch).toHaveBeenCalledTimes(1);
  });

  // ── Range validation ──

  it('returns 400 for invalid range parameter', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const req = makeRequest('/admin/api/security/pairing-abuse?range=1y', 'valid-token');
    const env = makeBaseEnv();

    const res = await handlePairingBruteForce(req, env);
    expect(res.status).toBe(400);

    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('Invalid range');
  });

  it('defaults range to 24h when not specified', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const req = makeRequest('/admin/api/security/pairing-abuse', 'valid-token');
    const env = makeBaseEnv();

    const res = await handlePairingBruteForce(req, env);
    const body = await res.json() as { data: { range: string } };
    expect(body.data.range).toBe('24h');
  });

  it('accepts 7d range', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const req = makeRequest('/admin/api/security/pairing-abuse?range=7d', 'valid-token');
    const env = makeBaseEnv();

    const res = await handlePairingBruteForce(req, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { range: string } };
    expect(body.data.range).toBe('7d');
  });

  it('accepts 30d range', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const req = makeRequest('/admin/api/security/pairing-abuse?range=30d', 'valid-token');
    const env = makeBaseEnv();

    const res = await handlePairingBruteForce(req, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { range: string } };
    expect(body.data.range).toBe('30d');
  });

  // ── Threshold alerts ──

  it('reports alert count for sessions exceeding threshold', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const mockD1 = createMockD1([
      { results: [{ total_failed: 500, unique_sessions: 10 }], success: true },
      { results: [{ alert_count: 5 }], success: true },
      { results: [], success: true },
      { results: [], success: true },
    ]);

    const req = makeRequest('/admin/api/security/pairing-abuse', 'valid-token');
    const env = makeBaseEnv({ DIAGNOSTICS_DB: mockD1 });

    const res = await handlePairingBruteForce(req, env);
    const body = await res.json() as {
      data: { summary: { alertCount: number; threshold: number } };
    };
    expect(body.data.summary.alertCount).toBe(5);
    expect(body.data.summary.threshold).toBe(20);
  });

  // ── Error handling ──

  it('returns generic error message when D1 fails (no details leaked)', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const req = makeRequest('/admin/api/security/pairing-abuse', 'valid-token');
    const env = makeBaseEnv({ DIAGNOSTICS_DB: createFailingD1() });

    const res = await handlePairingBruteForce(req, env);
    expect(res.status).toBe(500);

    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('Failed to fetch pairing abuse data');
    expect(body.error).not.toContain('D1_INTERNAL');
    expect(body.error).not.toContain('connection pool');
  });

  // ── Response headers ──

  it('returns application/json content type and no-store cache', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const req = makeRequest('/admin/api/security/pairing-abuse', 'valid-token');
    const env = makeBaseEnv();

    const res = await handlePairingBruteForce(req, env);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  // ── Zero results from D1 ──

  it('handles zero results from D1 gracefully', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const mockD1 = createMockD1([
      { results: [{ total_failed: 0, unique_sessions: 0 }], success: true },
      { results: [{ alert_count: 0 }], success: true },
      { results: [], success: true },
      { results: [], success: true },
    ]);

    const req = makeRequest('/admin/api/security/pairing-abuse', 'valid-token');
    const env = makeBaseEnv({ DIAGNOSTICS_DB: mockD1 });

    const res = await handlePairingBruteForce(req, env);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      data: {
        summary: { totalFailedAttempts: number; uniqueSessions: number; alertCount: number };
        timeline: unknown[];
        topOffenders: unknown[];
      };
    };
    expect(body.data.summary.totalFailedAttempts).toBe(0);
    expect(body.data.summary.uniqueSessions).toBe(0);
    expect(body.data.summary.alertCount).toBe(0);
    expect(body.data.timeline).toEqual([]);
    expect(body.data.topOffenders).toEqual([]);
  });

  // ── Null summary rows ──

  it('handles null summary row from D1', async () => {
    mockVerifyJwt.mockResolvedValue(authPayload());

    const mockD1 = createMockD1([
      { results: [], success: true },  // summary returns no rows
      { results: [], success: true },  // alert count returns no rows
      { results: [], success: true },
      { results: [], success: true },
    ]);

    const req = makeRequest('/admin/api/security/pairing-abuse', 'valid-token');
    const env = makeBaseEnv({ DIAGNOSTICS_DB: mockD1 });

    const res = await handlePairingBruteForce(req, env);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      data: {
        summary: { totalFailedAttempts: number; uniqueSessions: number; alertCount: number };
      };
    };
    expect(body.data.summary.totalFailedAttempts).toBe(0);
    expect(body.data.summary.uniqueSessions).toBe(0);
    expect(body.data.summary.alertCount).toBe(0);
  });
});
