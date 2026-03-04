/**
 * Unit tests for GET /admin/api/security/attacks (US-7.3)
 *
 * Pattern follows the project convention:
 * - Auth enforcement (401 without token)
 * - Empty data when no DIAGNOSTICS_DB binding
 * - Valid response with mock D1 data
 * - Anomaly detection logic (5x threshold)
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
    `https://admin.test/admin/api/security/attacks${queryString}`,
    { method: 'GET', headers }
  );
  return worker.fetch(request, makeEnv(env) as any);
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('GET /admin/api/security/attacks', () => {
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
      expect(body.data.range).toBe('24h'); // default range for attacks
      expect(body.data.summary.totalSpikes).toBe(0);
      expect(body.data.summary.activeAlerts).toBe(0);
      expect(body.data.summary.highestMultiplier).toBe(0);
      expect(body.data.summary.currentConnectionRate).toBe(0);
      expect(body.data.connectionRateTimeline).toEqual([]);
      expect(body.data.activeAlerts).toEqual([]);
      expect(body.data.lastUpdated).toBeGreaterThan(0);
    });
  });

  // Range parameter validation
  describe('range parameter', () => {
    it('defaults to 24h when range is not specified', async () => {
      const token = await makeAuthToken();
      const res = await callEndpoint('', {}, token);
      const body = (await res.json()) as any;
      expect(body.data.range).toBe('24h');
    });

    it('accepts 7d range', async () => {
      const token = await makeAuthToken();
      const res = await callEndpoint('?range=7d', {}, token);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
      expect(body.data.range).toBe('7d');
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
    it('returns DDoS indicators data with alerts', async () => {
      const token = await makeAuthToken();
      const now = Date.now();
      const oneHourAgo = now - 3600000;

      const db = mockD1([
        // Spikes summary
        {
          results: [{
            totalSpikes: 3,
            highestMultiplier: 8.5,
          }],
          success: true,
        },
        // Connection rate timeline
        {
          results: [
            { bucket: now - 7200000, rate: 100 },
            { bucket: now - 3600000, rate: 500 },
            { bucket: now, rate: 120 },
          ],
          success: true,
        },
        // Active alerts
        {
          results: [
            {
              id: 1,
              timestamp: oneHourAgo,
              server_id: 'srv-01',
              region: 'us-east-1',
              details: JSON.stringify({
                multiplier: 8.5,
                currentRate: 850,
                normalRate: 100,
              }),
              severity: 'critical',
              count: 850,
            },
          ],
          success: true,
        },
        // Normal rate (avgRate only)
        {
          results: [{
            avgRate: 100,
          }],
          success: true,
        },
        // Current rate (most recent hour)
        {
          results: [{
            currentRate: 120,
          }],
          success: true,
        },
      ]);

      const res = await callEndpoint('?range=24h', { DIAGNOSTICS_DB: db }, token);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.success).toBe(true);

      // Summary
      expect(body.data.summary.totalSpikes).toBe(3);
      expect(body.data.summary.highestMultiplier).toBe(8.5);
      expect(body.data.summary.activeAlerts).toBe(1);
      expect(body.data.summary.currentConnectionRate).toBe(120);

      // Timeline
      expect(body.data.connectionRateTimeline).toHaveLength(3);
      expect(body.data.connectionRateTimeline[0].rate).toBe(100);
      expect(body.data.connectionRateTimeline[0].normalRate).toBe(100);

      // Anomaly detection: rate 500 should be flagged (500 >= 100 * 5)
      expect(body.data.connectionRateTimeline[1].rate).toBe(500);
      expect(body.data.connectionRateTimeline[1].isAnomaly).toBe(true);

      // Rate 120 should NOT be anomaly (120 < 100 * 5 = 500)
      expect(body.data.connectionRateTimeline[2].rate).toBe(120);
      expect(body.data.connectionRateTimeline[2].isAnomaly).toBe(false);

      // Active alerts
      expect(body.data.activeAlerts).toHaveLength(1);
      expect(body.data.activeAlerts[0].serverId).toBe('srv-01');
      expect(body.data.activeAlerts[0].region).toBe('us-east-1');
      expect(body.data.activeAlerts[0].multiplier).toBe(8.5);
      expect(body.data.activeAlerts[0].currentRate).toBe(850);
      expect(body.data.activeAlerts[0].normalRate).toBe(100);
      expect(body.data.activeAlerts[0].severity).toBe('critical');

      // Verify D1 was called with parameterized queries
      expect(db.batch).toHaveBeenCalledTimes(1);
      expect(db.prepare).toHaveBeenCalled();
    });

    it('marks anomaly correctly at exactly 5x threshold', async () => {
      const token = await makeAuthToken();
      const db = mockD1([
        // Spikes summary
        { results: [{ totalSpikes: 1, highestMultiplier: 5.0 }], success: true },
        // Timeline: one entry at exactly 5x
        {
          results: [
            { bucket: 1709200000000, rate: 500 },
          ],
          success: true,
        },
        // No active alerts
        { results: [], success: true },
        // Normal rate = 100
        { results: [{ avgRate: 100 }], success: true },
        // Current rate
        { results: [{ currentRate: 500 }], success: true },
      ]);

      const res = await callEndpoint('', { DIAGNOSTICS_DB: db }, token);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);

      // Exactly 5x should trigger anomaly (>= 5x)
      expect(body.data.connectionRateTimeline[0].isAnomaly).toBe(true);
    });

    it('does not flag anomaly below 5x threshold', async () => {
      const token = await makeAuthToken();
      const db = mockD1([
        { results: [{ totalSpikes: 0, highestMultiplier: 0 }], success: true },
        {
          results: [
            { bucket: 1709200000000, rate: 499 },
          ],
          success: true,
        },
        { results: [], success: true },
        { results: [{ avgRate: 100 }], success: true },
        { results: [{ currentRate: 499 }], success: true },
      ]);

      const res = await callEndpoint('', { DIAGNOSTICS_DB: db }, token);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);

      // 499 < 100 * 5 = 500, should NOT be anomaly
      expect(body.data.connectionRateTimeline[0].isAnomaly).toBe(false);
    });

    it('handles zero normal rate without false anomalies', async () => {
      const token = await makeAuthToken();
      const db = mockD1([
        { results: [{ totalSpikes: 0, highestMultiplier: 0 }], success: true },
        {
          results: [
            { bucket: 1709200000000, rate: 10 },
          ],
          success: true,
        },
        { results: [], success: true },
        // Normal rate is 0 (no historical data)
        { results: [{ avgRate: 0 }], success: true },
        { results: [{ currentRate: 10 }], success: true },
      ]);

      const res = await callEndpoint('', { DIAGNOSTICS_DB: db }, token);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);

      // When normalRate is 0, nothing should be flagged as anomaly
      expect(body.data.connectionRateTimeline[0].isAnomaly).toBe(false);
    });

    it('handles empty D1 results gracefully', async () => {
      const token = await makeAuthToken();
      const db = mockD1([
        { results: [{ totalSpikes: 0, highestMultiplier: null }], success: true },
        { results: [], success: true },
        { results: [], success: true },
        { results: [{ avgRate: null }], success: true },
        { results: [{ currentRate: null }], success: true },
      ]);

      const res = await callEndpoint('', { DIAGNOSTICS_DB: db }, token);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
      expect(body.data.summary.totalSpikes).toBe(0);
      expect(body.data.summary.highestMultiplier).toBe(0);
      expect(body.data.summary.currentConnectionRate).toBe(0);
      expect(body.data.connectionRateTimeline).toEqual([]);
      expect(body.data.activeAlerts).toEqual([]);
    });

    it('parses alert details from JSON blob', async () => {
      const token = await makeAuthToken();
      const db = mockD1([
        { results: [{ totalSpikes: 1, highestMultiplier: 6 }], success: true },
        { results: [], success: true },
        {
          results: [{
            id: 42,
            timestamp: Date.now(),
            server_id: 'srv-02',
            region: 'eu-west-1',
            details: JSON.stringify({
              multiplier: 6.2,
              currentRate: 620,
              normalRate: 100,
            }),
            severity: 'high',
            count: 620,
          }],
          success: true,
        },
        { results: [{ avgRate: 100 }], success: true },
        { results: [{ currentRate: 100 }], success: true },
      ]);

      const res = await callEndpoint('', { DIAGNOSTICS_DB: db }, token);
      const body = (await res.json()) as any;
      expect(body.data.activeAlerts[0].multiplier).toBe(6.2);
      expect(body.data.activeAlerts[0].currentRate).toBe(620);
      expect(body.data.activeAlerts[0].normalRate).toBe(100);
    });

    it('handles malformed details JSON gracefully', async () => {
      const token = await makeAuthToken();
      const db = mockD1([
        { results: [{ totalSpikes: 1, highestMultiplier: 5 }], success: true },
        { results: [], success: true },
        {
          results: [{
            id: 99,
            timestamp: Date.now(),
            server_id: null,
            region: null,
            details: 'not-valid-json',
            severity: 'medium',
            count: 500,
          }],
          success: true,
        },
        { results: [{ avgRate: 100 }], success: true },
        { results: [{ currentRate: 100 }], success: true },
      ]);

      const res = await callEndpoint('', { DIAGNOSTICS_DB: db }, token);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);

      // Should still produce an alert with fallback values
      expect(body.data.activeAlerts).toHaveLength(1);
      expect(body.data.activeAlerts[0].serverId).toBe('unknown');
      expect(body.data.activeAlerts[0].region).toBe('unknown');
      expect(body.data.activeAlerts[0].currentRate).toBe(500); // falls back to count
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
        batch: vi.fn().mockRejectedValue(new Error('D1_ERROR: database locked')),
      };

      const res = await callEndpoint('', { DIAGNOSTICS_DB: db }, token);
      expect(res.status).toBe(500);

      const body = (await res.json()) as any;
      expect(body.success).toBe(false);
      // Must NOT leak D1 error details
      expect(body.error).toBe('Failed to retrieve DDoS indicator data');
      expect(body.error).not.toContain('D1_ERROR');
      expect(body.error).not.toContain('database locked');
    });
  });
});
