/**
 * Unit tests for the regression detection module.
 *
 * Tests detection of error rate regressions and version-specific
 * error patterns using hourly rolling averages.
 */

import { describe, it, expect, vi } from 'vitest';
import { detectRegressions } from '../../src/regression.js';
import type { RegressionInfo } from '../../src/regression.js';
import type { Env, ErrorCluster } from '../../src/types.js';

// ─────────────────────────────────────────────
// Test Fixtures
// ─────────────────────────────────────────────

function makeCluster(overrides: Partial<ErrorCluster> = {}): ErrorCluster {
  return {
    errorSignature: 'crypto:handshake_failed',
    category: 'crypto',
    totalCount: 30,
    versions: ['1.0.0', '1.1.0'],
    platforms: ['android'],
    sampleMessages: ['Handshake failed'],
    sampleStackTraces: [],
    firstSeen: Date.now() - 3600000,
    lastSeen: Date.now() - 60000,
    ...overrides,
  };
}

function makeEnv(options: {
  hourlyRows?: Array<{ hour_bucket: number; hourly_count: number }>;
  versionRows?: Array<{ app_version: string; version_count: number }>;
} = {}): Env {
  const { hourlyRows = [], versionRows = [] } = options;

  const prepare = vi.fn().mockImplementation((sql: string) => {
    return {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockImplementation(async () => {
        if (sql.includes('hour_bucket')) {
          return { success: true, results: hourlyRows };
        }
        if (sql.includes('app_version')) {
          return { success: true, results: versionRows };
        }
        return { success: true, results: [] };
      }),
    };
  });

  return {
    DB: { prepare } as unknown as D1Database,
    REPORTS_BUCKET: {} as R2Bucket,
    AI: {} as Ai,
    GITHUB_TOKEN: 'ghp_test',
    GITHUB_REPO: 'owner/repo',
  };
}

// ─────────────────────────────────────────────
// detectRegressions tests
// ─────────────────────────────────────────────

describe('detectRegressions', () => {
  it('returns empty array when no clusters provided', async () => {
    const env = makeEnv();
    const result = await detectRegressions(env, []);
    expect(result).toEqual([]);
  });

  it('returns empty array when no regressions detected', async () => {
    const currentHourBucket = Math.floor(Date.now() / 3600000);

    const env = makeEnv({
      hourlyRows: [
        { hour_bucket: currentHourBucket - 2, hourly_count: 10 },
        { hour_bucket: currentHourBucket - 1, hourly_count: 10 },
        { hour_bucket: currentHourBucket, hourly_count: 10 },
      ],
      versionRows: [
        { app_version: '1.0.0', version_count: 15 },
        { app_version: '1.1.0', version_count: 15 },
      ],
    });

    const clusters = [makeCluster()];
    const result = await detectRegressions(env, clusters);
    expect(result).toEqual([]);
  });

  it('detects rate spike regression (>3x baseline)', async () => {
    const currentHourBucket = Math.floor(Date.now() / 3600000);

    const env = makeEnv({
      hourlyRows: [
        { hour_bucket: currentHourBucket - 3, hourly_count: 5 },
        { hour_bucket: currentHourBucket - 2, hourly_count: 5 },
        { hour_bucket: currentHourBucket - 1, hourly_count: 5 },
        // Current hour: 20, baseline avg: 5 -> 4x
        { hour_bucket: currentHourBucket, hourly_count: 20 },
      ],
      versionRows: [
        { app_version: '1.0.0', version_count: 15 },
        { app_version: '1.1.0', version_count: 20 },
      ],
    });

    const clusters = [makeCluster()];
    const result = await detectRegressions(env, clusters);

    expect(result).toHaveLength(1);
    expect(result[0]!.errorSignature).toBe('crypto:handshake_failed');
    expect(result[0]!.currentRate).toBe(20);
    expect(result[0]!.baselineRate).toBe(5);
    expect(result[0]!.multiplier).toBe(4);
    expect(result[0]!.isNewInVersion).toBe(false);
  });

  it('detects new-in-version regression', async () => {
    const currentHourBucket = Math.floor(Date.now() / 3600000);

    const env = makeEnv({
      hourlyRows: [
        { hour_bucket: currentHourBucket, hourly_count: 10 },
      ],
      versionRows: [
        // Only one version has errors
        { app_version: '1.1.0', version_count: 10 },
      ],
    });

    const clusters = [makeCluster({ versions: ['1.1.0'] })];
    const result = await detectRegressions(env, clusters);

    expect(result).toHaveLength(1);
    expect(result[0]!.isNewInVersion).toBe(true);
    expect(result[0]!.latestVersion).toBe('1.1.0');
  });

  it('does not flag as new-in-version when multiple versions have errors', async () => {
    const currentHourBucket = Math.floor(Date.now() / 3600000);

    const env = makeEnv({
      hourlyRows: [
        { hour_bucket: currentHourBucket, hourly_count: 5 },
      ],
      versionRows: [
        { app_version: '1.0.0', version_count: 3 },
        { app_version: '1.1.0', version_count: 2 },
      ],
    });

    const clusters = [makeCluster()];
    const result = await detectRegressions(env, clusters);
    expect(result).toEqual([]);
  });

  it('handles D1 query failures gracefully', async () => {
    const env: Env = {
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnThis(),
          all: vi.fn().mockRejectedValue(new Error('D1 unavailable')),
        }),
      } as unknown as D1Database,
      REPORTS_BUCKET: {} as R2Bucket,
      AI: {} as Ai,
      GITHUB_TOKEN: 'ghp_test',
      GITHUB_REPO: 'owner/repo',
    };

    const clusters = [makeCluster()];
    // Should not throw
    const result = await detectRegressions(env, clusters);
    expect(result).toEqual([]);
  });

  it('processes multiple clusters independently', async () => {
    const currentHourBucket = Math.floor(Date.now() / 3600000);

    // Create env that returns different results for different queries
    let callCount = 0;
    const prepare = vi.fn().mockImplementation((sql: string) => {
      return {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockImplementation(async () => {
          callCount++;
          if (sql.includes('hour_bucket')) {
            // Alternate: first cluster has spike, second doesn't
            if (callCount <= 1) {
              return {
                success: true,
                results: [
                  { hour_bucket: currentHourBucket - 1, hourly_count: 2 },
                  { hour_bucket: currentHourBucket, hourly_count: 10 },
                ],
              };
            }
            return {
              success: true,
              results: [
                { hour_bucket: currentHourBucket - 1, hourly_count: 10 },
                { hour_bucket: currentHourBucket, hourly_count: 10 },
              ],
            };
          }
          if (sql.includes('app_version')) {
            return {
              success: true,
              results: [
                { app_version: '1.0.0', version_count: 5 },
                { app_version: '1.1.0', version_count: 5 },
              ],
            };
          }
          return { success: true, results: [] };
        }),
      };
    });

    const env: Env = {
      DB: { prepare } as unknown as D1Database,
      REPORTS_BUCKET: {} as R2Bucket,
      AI: {} as Ai,
      GITHUB_TOKEN: 'ghp_test',
      GITHUB_REPO: 'owner/repo',
    };

    const clusters = [
      makeCluster({ errorSignature: 'sig:spike' }),
      makeCluster({ errorSignature: 'sig:normal' }),
    ];

    const result = await detectRegressions(env, clusters);
    // At least the first cluster should be flagged as a regression (5x baseline)
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some(r => r.errorSignature === 'sig:spike')).toBe(true);
  });

  it('uses latest version from cluster versions array', async () => {
    const currentHourBucket = Math.floor(Date.now() / 3600000);

    const env = makeEnv({
      hourlyRows: [
        { hour_bucket: currentHourBucket, hourly_count: 10 },
      ],
      versionRows: [
        { app_version: '1.2.0', version_count: 10 },
      ],
    });

    const clusters = [makeCluster({ versions: ['1.0.0', '1.1.0', '1.2.0'] })];
    const result = await detectRegressions(env, clusters);

    // Only one version in error_aggregates but cluster has multiple versions,
    // so isNewInVersion should be true (only 1.2.0 appears in DB results)
    expect(result).toHaveLength(1);
    expect(result[0]!.latestVersion).toBe('1.2.0');
    expect(result[0]!.isNewInVersion).toBe(true);
  });

  it('handles zero baseline rate correctly', async () => {
    const currentHourBucket = Math.floor(Date.now() / 3600000);

    const env = makeEnv({
      hourlyRows: [
        // Only current hour, no baseline
        { hour_bucket: currentHourBucket, hourly_count: 10 },
      ],
      versionRows: [
        { app_version: '1.0.0', version_count: 5 },
        { app_version: '1.1.0', version_count: 5 },
      ],
    });

    const clusters = [makeCluster()];
    const result = await detectRegressions(env, clusters);

    // No baseline, so multiplier is 0, not a rate regression.
    // Two versions, so not new-in-version either.
    expect(result).toEqual([]);
  });
});
