/**
 * Unit tests for GET /admin/api/clients/platforms (US-4.2)
 *
 * Auth enforcement test lives in errors.test.ts (isolate: true)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handlePlatformBreakdown } from '../../src/routes/clients.js';
import type { Env } from '../../src/types.js';

// Mock auth to always succeed
vi.mock('../../src/routes/auth.js', () => ({
  requireAuth: vi.fn().mockResolvedValue({
    sub: 'user-1',
    username: 'admin',
    role: 'admin',
    iat: Date.now(),
    exp: Date.now() + 3600000,
  }),
}));

function makeRequest(): Request {
  return new Request('https://admin.example.com/admin/api/clients/platforms', {
    method: 'GET',
    headers: { Authorization: 'Bearer mock-token' },
  });
}

function makeMockD1(results: Array<{ platform: string; count: number }>) {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({ results }),
      }),
    }),
  };
}

function makeMockD1Error(errorMessage: string) {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockRejectedValue(new Error(errorMessage)),
      }),
    }),
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ADMIN_USERS: {} as Env['ADMIN_USERS'],
    ZAJEL_ADMIN_JWT_SECRET: 'test-secret',
    ...overrides,
  } as Env;
}

describe('handlePlatformBreakdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 with platform breakdown from D1', async () => {
    const env = makeEnv({
      DIAGNOSTICS_DB: makeMockD1([
        { platform: 'android', count: 50 },
        { platform: 'ios', count: 30 },
      ]) as unknown as D1Database,
    });

    const res = await handlePlatformBreakdown(makeRequest(), env);
    expect(res.status).toBe(200);

    const body = await res.json() as { success: boolean; data: { platforms: Array<{ platform: string; count: number; percentage: number }>; totalActive: number; lastUpdated: number } };
    expect(body.success).toBe(true);
    expect(body.data.platforms).toHaveLength(2);
    expect(body.data.totalActive).toBe(80);
    expect(body.data.lastUpdated).toBeGreaterThan(0);

    // Verify first platform
    expect(body.data.platforms[0]!.platform).toBe('android');
    expect(body.data.platforms[0]!.count).toBe(50);
    expect(body.data.platforms[0]!.percentage).toBe(62.5);

    // Verify second platform
    expect(body.data.platforms[1]!.platform).toBe('ios');
    expect(body.data.platforms[1]!.count).toBe(30);
    expect(body.data.platforms[1]!.percentage).toBe(37.5);
  });

  it('handles multiple platforms sorted by count DESC', async () => {
    const env = makeEnv({
      DIAGNOSTICS_DB: makeMockD1([
        { platform: 'android', count: 100 },
        { platform: 'ios', count: 80 },
        { platform: 'web', count: 50 },
        { platform: 'windows', count: 30 },
        { platform: 'macos', count: 20 },
        { platform: 'linux', count: 10 },
      ]) as unknown as D1Database,
    });

    const res = await handlePlatformBreakdown(makeRequest(), env);
    expect(res.status).toBe(200);

    const body = await res.json() as { success: boolean; data: { platforms: Array<{ platform: string; count: number; percentage: number }>; totalActive: number } };
    expect(body.success).toBe(true);
    expect(body.data.platforms).toHaveLength(6);
    expect(body.data.totalActive).toBe(290);

    // Verify sort order (should be count DESC as returned by SQL ORDER BY)
    expect(body.data.platforms[0]!.platform).toBe('android');
    expect(body.data.platforms[1]!.platform).toBe('ios');
    expect(body.data.platforms[2]!.platform).toBe('web');
    expect(body.data.platforms[3]!.platform).toBe('windows');
    expect(body.data.platforms[4]!.platform).toBe('macos');
    expect(body.data.platforms[5]!.platform).toBe('linux');
  });

  it('handles single platform (full circle)', async () => {
    const env = makeEnv({
      DIAGNOSTICS_DB: makeMockD1([
        { platform: 'android', count: 42 },
      ]) as unknown as D1Database,
    });

    const res = await handlePlatformBreakdown(makeRequest(), env);
    expect(res.status).toBe(200);

    const body = await res.json() as { success: boolean; data: { platforms: Array<{ platform: string; count: number; percentage: number }>; totalActive: number } };
    expect(body.success).toBe(true);
    expect(body.data.platforms).toHaveLength(1);
    expect(body.data.platforms[0]!.platform).toBe('android');
    expect(body.data.platforms[0]!.count).toBe(42);
    expect(body.data.platforms[0]!.percentage).toBe(100);
    expect(body.data.totalActive).toBe(42);
  });

  it('handles empty data (no active clients)', async () => {
    const env = makeEnv({
      DIAGNOSTICS_DB: makeMockD1([]) as unknown as D1Database,
    });

    const res = await handlePlatformBreakdown(makeRequest(), env);
    expect(res.status).toBe(200);

    const body = await res.json() as { success: boolean; data: { platforms: Array<{ platform: string; count: number; percentage: number }>; totalActive: number } };
    expect(body.success).toBe(true);
    expect(body.data.platforms).toHaveLength(0);
    expect(body.data.totalActive).toBe(0);
  });

  it('percentage calculation is correct and sums to ~100%', async () => {
    const env = makeEnv({
      DIAGNOSTICS_DB: makeMockD1([
        { platform: 'android', count: 33 },
        { platform: 'ios', count: 33 },
        { platform: 'web', count: 34 },
      ]) as unknown as D1Database,
    });

    const res = await handlePlatformBreakdown(makeRequest(), env);
    expect(res.status).toBe(200);

    const body = await res.json() as { success: boolean; data: { platforms: Array<{ platform: string; count: number; percentage: number }>; totalActive: number } };
    expect(body.success).toBe(true);

    const totalPercentage = body.data.platforms.reduce(
      (sum: number, p: { percentage: number }) => sum + p.percentage,
      0
    );
    // Rounding to 1 decimal place means total may not be exactly 100
    expect(totalPercentage).toBeGreaterThanOrEqual(99);
    expect(totalPercentage).toBeLessThanOrEqual(101);

    // Verify individual percentage precision (1 decimal place)
    for (const p of body.data.platforms) {
      const decimalPlaces = (p.percentage.toString().split('.')[1] || '').length;
      expect(decimalPlaces).toBeLessThanOrEqual(1);
    }
  });

  it('platforms with 0 count excluded', async () => {
    // D1 GROUP BY won't normally return 0-count rows,
    // but test the filter logic in case of edge cases
    const env = makeEnv({
      DIAGNOSTICS_DB: makeMockD1([
        { platform: 'android', count: 10 },
        { platform: 'ios', count: 0 },
      ]) as unknown as D1Database,
    });

    const res = await handlePlatformBreakdown(makeRequest(), env);
    expect(res.status).toBe(200);

    const body = await res.json() as { success: boolean; data: { platforms: Array<{ platform: string; count: number; percentage: number }>; totalActive: number } };
    expect(body.success).toBe(true);
    // ios with count 0 should be excluded
    expect(body.data.platforms).toHaveLength(1);
    expect(body.data.platforms[0]!.platform).toBe('android');
    expect(body.data.platforms[0]!.percentage).toBe(100);
    // totalActive sums all rows, including 0-count rows
    expect(body.data.totalActive).toBe(10);
  });

  it('returns 200 with empty data when DIAGNOSTICS_DB not bound', async () => {
    const env = makeEnv({
      // No DIAGNOSTICS_DB
    });

    const res = await handlePlatformBreakdown(makeRequest(), env);
    expect(res.status).toBe(200);

    const body = await res.json() as { success: boolean; data: { platforms: Array<{ platform: string; count: number; percentage: number }>; totalActive: number; lastUpdated: number } };
    expect(body.success).toBe(true);
    expect(body.data.platforms).toHaveLength(0);
    expect(body.data.totalActive).toBe(0);
    expect(body.data.lastUpdated).toBeGreaterThan(0);
  });

  it('returns 500 when D1 query fails', async () => {
    const env = makeEnv({
      DIAGNOSTICS_DB: makeMockD1Error('D1_ERROR: table not found') as unknown as D1Database,
    });

    const res = await handlePlatformBreakdown(makeRequest(), env);
    expect(res.status).toBe(500);

    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('Failed to query platform breakdown');
  });

  it('handles unknown platform values gracefully', async () => {
    const env = makeEnv({
      DIAGNOSTICS_DB: makeMockD1([
        { platform: 'android', count: 50 },
        { platform: 'unknown_device', count: 5 },
        { platform: 'chromeos', count: 3 },
      ]) as unknown as D1Database,
    });

    const res = await handlePlatformBreakdown(makeRequest(), env);
    expect(res.status).toBe(200);

    const body = await res.json() as { success: boolean; data: { platforms: Array<{ platform: string; count: number; percentage: number }>; totalActive: number } };
    expect(body.success).toBe(true);
    expect(body.data.platforms).toHaveLength(3);
    expect(body.data.totalActive).toBe(58);

    // All platforms should have valid percentage
    for (const p of body.data.platforms) {
      expect(p.percentage).toBeGreaterThan(0);
      expect(p.percentage).toBeLessThanOrEqual(100);
    }

    // Unknown platform values should still be included
    const unknownPlatform = body.data.platforms.find(
      (p: { platform: string }) => p.platform === 'unknown_device'
    );
    expect(unknownPlatform).toBeDefined();
    expect(unknownPlatform!.count).toBe(5);
  });
});
