/**
 * Regression detection for error clusters.
 *
 * Detects regressions by comparing current error rates against
 * a 24-hour rolling average, and by checking if errors appear
 * only in the latest app version.
 */

import type { Env, ErrorCluster } from './types.js';

/**
 * Information about a detected regression.
 */
export interface RegressionInfo {
  errorSignature: string;
  currentRate: number;
  baselineRate: number;
  multiplier: number;
  isNewInVersion: boolean;
  latestVersion: string;
}

/** Regression multiplier threshold: flag if current > 3x baseline */
const REGRESSION_MULTIPLIER_THRESHOLD = 3;

/** Hours of history to consider for baseline calculation */
const BASELINE_HOURS = 24;

/**
 * Raw row from the hourly error_aggregates query.
 */
interface HourlyAggregateRow {
  hour_bucket: number;
  hourly_count: number;
}

/**
 * Raw row from the version-specific query.
 */
interface VersionCountRow {
  app_version: string;
  version_count: number;
}

/**
 * Detect regressions among the given error clusters by comparing
 * current-hour error rates against a 24-hour rolling average.
 *
 * A cluster is flagged as a regression if:
 * - Current hour count > 3x the 24h rolling hourly average, OR
 * - The error signature appears ONLY in the latest app_version
 */
export async function detectRegressions(
  env: Env,
  clusters: ErrorCluster[],
): Promise<RegressionInfo[]> {
  const regressions: RegressionInfo[] = [];
  const now = Date.now();
  const twentyFourHoursAgo = now - BASELINE_HOURS * 60 * 60 * 1000;
  const oneHourAgo = now - 60 * 60 * 1000;

  for (const cluster of clusters) {
    try {
      const regressionInfo = await checkClusterRegression(
        env,
        cluster,
        twentyFourHoursAgo,
        oneHourAgo,
        now,
      );
      if (regressionInfo) {
        regressions.push(regressionInfo);
      }
    } catch (error) {
      console.error(
        `Regression detection failed for ${cluster.errorSignature}:`,
        error,
      );
      // Continue checking other clusters
    }
  }

  return regressions;
}

/**
 * Check a single cluster for regression signals.
 */
async function checkClusterRegression(
  env: Env,
  cluster: ErrorCluster,
  twentyFourHoursAgo: number,
  oneHourAgo: number,
  now: number,
): Promise<RegressionInfo | null> {
  // Query hourly counts over the last 24 hours
  const hourlyResult = await env.DB.prepare(
    `SELECT
       CAST((last_seen / 3600000) AS INTEGER) as hour_bucket,
       SUM(count) as hourly_count
     FROM error_aggregates
     WHERE error_signature = ?
       AND last_seen > ?
     GROUP BY hour_bucket
     ORDER BY hour_bucket`,
  )
    .bind(cluster.errorSignature, twentyFourHoursAgo)
    .all<HourlyAggregateRow>();

  const hourlyRows = hourlyResult.success ? (hourlyResult.results ?? []) : [];

  // Calculate current hour count and baseline average
  const currentHourBucket = Math.floor(now / 3600000);
  let currentRate = 0;
  let baselineTotal = 0;
  let baselineHours = 0;

  for (const row of hourlyRows) {
    if (row.hour_bucket === currentHourBucket) {
      currentRate = row.hourly_count;
    } else {
      baselineTotal += row.hourly_count;
      baselineHours++;
    }
  }

  const baselineRate = baselineHours > 0 ? baselineTotal / baselineHours : 0;
  const multiplier = baselineRate > 0 ? currentRate / baselineRate : 0;

  // Check if error is new in the latest version
  const versionResult = await env.DB.prepare(
    `SELECT
       app_version,
       SUM(count) as version_count
     FROM error_aggregates
     WHERE error_signature = ?
       AND last_seen > ?
     GROUP BY app_version`,
  )
    .bind(cluster.errorSignature, twentyFourHoursAgo)
    .all<VersionCountRow>();

  const versionRows = versionResult.success ? (versionResult.results ?? []) : [];

  // Determine the latest version (lexicographic sort; versions like 1.2.3)
  const latestVersion = cluster.versions.length > 0
    ? cluster.versions.sort().reverse()[0]!
    : 'unknown';

  // Flag as new-in-version if only one version has errors
  const isNewInVersion = versionRows.length === 1
    && versionRows[0]!.app_version === latestVersion;

  // Flag as regression if rate spike or new-in-version
  const isRateRegression = baselineRate > 0
    && multiplier >= REGRESSION_MULTIPLIER_THRESHOLD;

  if (isRateRegression || isNewInVersion) {
    return {
      errorSignature: cluster.errorSignature,
      currentRate,
      baselineRate,
      multiplier: Math.round(multiplier * 100) / 100,
      isNewInVersion,
      latestVersion,
    };
  }

  return null;
}
