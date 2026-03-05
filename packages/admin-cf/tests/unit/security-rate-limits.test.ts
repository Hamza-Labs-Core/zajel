/**
 * Unit tests for GET /admin/api/security/rate-limits (US-7.1)
 *
 * Pattern follows the project convention:
 * - Auth enforcement (401 without token)
 * - Empty data when no DIAGNOSTICS_DB binding
 * - Valid response with mock D1 data
 * - Range parameter validation
 * - Top endpoints and regional breakdown
 * - Error handling (generic message, no D1 error leakage)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateJwt } from '../../src/crypto.js';

const JWT_SECRET = 'test-secret-key-for-unit-tests';

// ── Helpers ────────────────────────────────────────────────────────────

async function makeAuthToken(): Promise<string> {
  return generateJwt(
    { sub: 'user-1', username: 'admin', role: 'admin' },
    JWT_SECRET,
    60 // 60 minutes
  );
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    ZAJEL_ADMIN_JWT_SECRET: JWT_SECRET,
    ADMIN_USERS: {} as unknown,
    ...overrides,
  };
}

/**
 * Create a mock D1Database that returns canned results for batch queries.
 */
function mockD1(batchResults: Array<{ results?: unknown[]; success: boolean }>) {
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

async function callEndpoint(
  queryString = '',
  env: Record<string, unknown> = {},
  token?: string
): Promise<Response> {
  const mod = await import('../../src/index.js');
  const worker = mod.default;
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const request = new Request(
    `https://admin.test/admin/api/security/rate-limits${queryString}`,
    { method: 'GET', headers }
  );
  return worker.fetch(request, makeEnv(env) as any);
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('GET /admin/api/security/rate-limits', () => {
  // Auth enforcement
  describe('auth enforcement', () => {
    it('returns 401 without a token', async () => {
      const res = await callEndpoint();
      expect(res.status).toBe(401);
      const body = await res.json();
      expect((body as any).success).toBe(false);
    });

    it('returns 401 with an invalid token', async () => {
      const res = await callEndpoint('', {}, 'invalid-token');
      expect(res.status).toBe(401);
    });
  });

  // Empty data fallback
  describe('no DIAGNOSTICS_DB binding', () => {
    it('returns empty data with success: true', async () => {
      const token = await makeAuthToken();
      const res = await callEndpoint('', {}, token);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
      expect(body.data.range).toBe('7d'); // default range
      expect(body.data.summary.totalViolations).toBe(0);
      expect(body.data.summary.uniqueEndpoints).toBe(0);
      expect(body.data.summary.uniqueRegions).toBe(0);
      expect(body.data.summary.peakHourlyRate).toBe(0);
      expect(body.data.timeline).toEqual([]);
      expect(body.data.topEndpoints).toEqual([]);
      expect(body.data.regionalBreakdown).toEqual([]);
      expect(body.data.lastUpdated).toBeGreaterThan(0);
    });
  });

  // Range parameter validation
  describe('range parameter', () => {
    it('defaults to 7d when range is not specified', async () => {
      const token = await makeAuthToken();
      const res = await callEndpoint('', {}, token);
      const body = (await res.json()) as any;
      expect(body.data.range).toBe('7d');
    });

    it('accepts 24h range', async () => {
      const token = await makeAuthToken();
      const res = await callEndpoint('?range=24h', {}, token);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
      expect(body.data.range).toBe('24h');
    });

    it('accepts 30d range', async () => {
      const token = await makeAuthToken();
      const res = await callEndpoint('?range=30d', {}, token);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
      expect(body.data.range).toBe('30d');
    });

    it('rejects invalid range with 400', async () => {
      const token = await makeAuthToken();
      const res = await callEndpoint('?range=1y', {}, token);
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.success).toBe(false);
      expect(body.error).toContain('Invalid range');
    });
  });

  // Valid response with mock D1 data
  describe('with mock D1 data', () => {
    it('returns aggregated violations data', async () => {
      const token = await makeAuthToken();
      const db = mockD1([
        // Summary query
        {
          results: [{
            totalViolations: 150,
            uniqueEndpoints: 5,
            uniqueRegions: 3,
          }],
          success: true,
        },
        // Timeline query
        {
          results: [
            { bucket: 1709200000000, count: 30 },
            { bucket: 1709203600000, count: 50 },
            { bucket: 1709207200000, count: 70 },
          ],
          success: true,
        },
        // Top endpoints query
        {
          results: [
            { endpoint: '/pair', count: 80 },
            { endpoint: '/diagnostics/report', count: 50 },
            { endpoint: '/servers', count: 20 },
          ],
          success: true,
        },
        // Regional breakdown query
        {
          results: [
            { region: 'us-east-1', count: 90 },
            { region: 'eu-west-1', count: 40 },
            { region: 'ap-south-1', count: 20 },
          ],
          success: true,
        },
      ]);

      const res = await callEndpoint('?range=7d', { DIAGNOSTICS_DB: db }, token);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.success).toBe(true);

      // Summary
      expect(body.data.summary.totalViolations).toBe(150);
      expect(body.data.summary.uniqueEndpoints).toBe(5);
      expect(body.data.summary.uniqueRegions).toBe(3);
      expect(body.data.summary.peakHourlyRate).toBe(70);

      // Timeline
      expect(body.data.timeline).toHaveLength(3);
      expect(body.data.timeline[0].timestamp).toBe(1709200000000);
      expect(body.data.timeline[0].count).toBe(30);

      // Top endpoints
      expect(body.data.topEndpoints).toHaveLength(3);
      expect(body.data.topEndpoints[0].endpoint).toBe('/pair');
      expect(body.data.topEndpoints[0].count).toBe(80);
      // Percentage: 80/150 = 53.33%
      expect(body.data.topEndpoints[0].percentage).toBeCloseTo(53.33, 1);

      // Regional breakdown
      expect(body.data.regionalBreakdown).toHaveLength(3);
      expect(body.data.regionalBreakdown[0].region).toBe('us-east-1');
      expect(body.data.regionalBreakdown[0].count).toBe(90);
      // Percentage: 90/150 = 60%
      expect(body.data.regionalBreakdown[0].percentage).toBe(60);

      // Verify D1 was called with parameterized queries
      expect(db.batch).toHaveBeenCalledTimes(1);
      expect(db.prepare).toHaveBeenCalled();
    });

    it('handles empty D1 results gracefully', async () => {
      const token = await makeAuthToken();
      const db = mockD1([
        { results: [{ totalViolations: 0, uniqueEndpoints: 0, uniqueRegions: 0 }], success: true },
        { results: [], success: true },
        { results: [], success: true },
        { results: [], success: true },
      ]);

      const res = await callEndpoint('', { DIAGNOSTICS_DB: db }, token);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
      expect(body.data.summary.totalViolations).toBe(0);
      expect(body.data.timeline).toEqual([]);
      expect(body.data.topEndpoints).toEqual([]);
      expect(body.data.regionalBreakdown).toEqual([]);
    });
  });

  // Error handling
  describe('error handling', () => {
    it('returns generic error message when D1 query fails', async () => {
      const token = await makeAuthToken();
      const db = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnThis(),
        }),
        batch: vi.fn().mockRejectedValue(new Error('D1_ERROR: table not found: security_events')),
      };

      const res = await callEndpoint('', { DIAGNOSTICS_DB: db }, token);
      expect(res.status).toBe(500);

      const body = (await res.json()) as any;
      expect(body.success).toBe(false);
      // Must NOT leak D1 error details
      expect(body.error).toBe('Failed to retrieve rate limit data');
      expect(body.error).not.toContain('D1_ERROR');
      expect(body.error).not.toContain('table not found');
    });
  });
});
