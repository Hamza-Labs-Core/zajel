/**
 * Error dashboard route handlers
 * Queries the D1 error_aggregates table for error rate overview
 */

import type { Env, ApiResponse, ErrorAggregate, ErrorSummary, ErrorsResponse, Regression, RegressionResponse, ErrorTrendsResponse, DeploymentMarker, ErrorDetailResponse, DistributionEntry, TimelinePoint } from '../types.js';
import { requireAuth } from './auth.js';

/** Valid time range options */
const VALID_RANGES = ['1h', '24h', '7d'] as const;
type TimeRange = typeof VALID_RANGES[number];

/** Valid error categories */
const VALID_CATEGORIES = ['crash', 'network', 'crypto', 'storage', 'ui', 'protocol', 'other'] as const;

/** Default and max limits for query results */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Compute the ISO datetime threshold for a given time range
 */
function computeThreshold(range: TimeRange, now: Date): string {
  const ms = now.getTime();
  let offset: number;
  switch (range) {
    case '1h':
      offset = 60 * 60 * 1000;
      break;
    case '24h':
      offset = 24 * 60 * 60 * 1000;
      break;
    case '7d':
      offset = 7 * 24 * 60 * 60 * 1000;
      break;
  }
  return new Date(ms - offset).toISOString();
}

/**
 * Determine the highest severity from error categories and counts
 *
 * Simple heuristic: crash => critical, network/crypto => high,
 * storage/protocol => medium, ui/other => low
 */
function determineSeverity(
  errors: ErrorAggregate[]
): 'critical' | 'high' | 'medium' | 'low' | 'none' {
  if (errors.length === 0) return 'none';

  const categories = new Set(errors.map((e) => e.category));

  if (categories.has('crash')) return 'critical';
  if (categories.has('network') || categories.has('crypto')) return 'high';
  if (categories.has('storage') || categories.has('protocol')) return 'medium';
  return 'low';
}

/**
 * List errors with aggregation from D1 error_aggregates table
 *
 * GET /admin/api/errors?range=1h|24h|7d&category=...&limit=50
 */
export async function handleListErrors(
  request: Request,
  env: Env
): Promise<Response> {
  // Verify authentication
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  // If DIAGNOSTICS_DB is not bound, return empty data gracefully
  if (!env.DIAGNOSTICS_DB) {
    const range = parseRange(request);
    return jsonResponse({
      success: true,
      data: {
        summary: {
          totalErrors: 0,
          rateChangePercent: 0,
          regressionAlerts: 0,
          highestSeverity: 'none',
        },
        errors: [],
        range,
      },
    });
  }

  try {
    // Parse and validate query params
    const url = new URL(request.url);
    const range = parseRange(request);
    const category = url.searchParams.get('category') || undefined;
    const limitParam = url.searchParams.get('limit');

    // Validate category if provided
    if (category && !VALID_CATEGORIES.includes(category as typeof VALID_CATEGORIES[number])) {
      return jsonResponse(
        { success: false, error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` },
        400
      );
    }

    // Validate limit
    let limit = DEFAULT_LIMIT;
    if (limitParam !== null) {
      limit = parseInt(limitParam, 10);
      if (isNaN(limit) || limit < 1 || limit > MAX_LIMIT) {
        return jsonResponse(
          { success: false, error: `Invalid limit. Must be between 1 and ${MAX_LIMIT}` },
          400
        );
      }
    }

    const now = new Date();
    const currentThreshold = computeThreshold(range, now);

    // Compute previous period threshold for rate change calculation
    const rangeMs = now.getTime() - new Date(currentThreshold).getTime();
    const previousThreshold = new Date(new Date(currentThreshold).getTime() - rangeMs).toISOString();

    // Build the main query with optional category filter
    let mainQuery = `
      SELECT error_signature, category,
             SUM(count) as total_count,
             GROUP_CONCAT(DISTINCT app_version) as versions,
             GROUP_CONCAT(DISTINCT platform) as platforms,
             MIN(first_seen) as first_seen,
             MAX(last_seen) as last_seen,
             MAX(sample_message) as sample_message
      FROM error_aggregates
      WHERE time_bucket >= ?
    `;
    const mainParams: (string | number)[] = [currentThreshold];

    if (category) {
      mainQuery += ` AND category = ?`;
      mainParams.push(category);
    }

    mainQuery += `
      GROUP BY error_signature, category
      ORDER BY total_count DESC
      LIMIT ?
    `;
    mainParams.push(limit);

    // Build total count query for current period
    let totalQuery = `SELECT COALESCE(SUM(count), 0) as total FROM error_aggregates WHERE time_bucket >= ?`;
    const totalParams: (string | number)[] = [currentThreshold];
    if (category) {
      totalQuery += ` AND category = ?`;
      totalParams.push(category);
    }

    // Build total count query for previous period
    let prevQuery = `SELECT COALESCE(SUM(count), 0) as total FROM error_aggregates WHERE time_bucket >= ? AND time_bucket < ?`;
    const prevParams: (string | number)[] = [previousThreshold, currentThreshold];
    if (category) {
      prevQuery += ` AND category = ?`;
      prevParams.push(category);
    }

    // Execute all queries in parallel
    const [mainResult, totalResult, prevResult] = await Promise.all([
      env.DIAGNOSTICS_DB.prepare(mainQuery).bind(...mainParams).all(),
      env.DIAGNOSTICS_DB.prepare(totalQuery).bind(...totalParams).first<{ total: number }>(),
      env.DIAGNOSTICS_DB.prepare(prevQuery).bind(...prevParams).first<{ total: number }>(),
    ]);

    // Parse main query results
    const errors: ErrorAggregate[] = (mainResult.results || []).map((row: Record<string, unknown>) => ({
      errorSignature: String(row['error_signature'] || ''),
      category: String(row['category'] || 'other') as ErrorAggregate['category'],
      totalCount: Number(row['total_count'] || 0),
      versions: row['versions'] ? String(row['versions']).split(',') : [],
      platforms: row['platforms'] ? String(row['platforms']).split(',') : [],
      firstSeen: Number(row['first_seen'] || 0),
      lastSeen: Number(row['last_seen'] || 0),
      sampleMessage: String(row['sample_message'] || ''),
    }));

    // Calculate rate change
    const currentTotal = totalResult?.total ?? 0;
    const previousTotal = prevResult?.total ?? 0;
    let rateChangePercent = 0;
    if (previousTotal > 0) {
      rateChangePercent = Math.round(((currentTotal - previousTotal) / previousTotal) * 100 * 10) / 10;
    } else if (currentTotal > 0) {
      // Previous period had zero errors, current has some => 100% increase
      rateChangePercent = 100;
    }

    const summary: ErrorSummary = {
      totalErrors: currentTotal,
      rateChangePercent,
      regressionAlerts: 0, // Placeholder until US-2.4 implements regression alerts
      highestSeverity: determineSeverity(errors),
    };

    const responseData: ErrorsResponse = {
      summary,
      errors,
      range,
    };

    return jsonResponse({ success: true, data: responseData });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('Failed to query error aggregates:', errMsg);
    return jsonResponse(
      { success: false, error: `Failed to query error data: ${errMsg}` },
      500
    );
  }
}

/**
 * Parse the range query parameter, defaulting to '24h'
 */
function parseRange(request: Request): TimeRange {
  const url = new URL(request.url);
  const rangeParam = url.searchParams.get('range') || '24h';
  if (VALID_RANGES.includes(rangeParam as TimeRange)) {
    return rangeParam as TimeRange;
  }
  return '24h';
}

// ─────────────────────────────────────────────
// Error Trends (US-2.2)
// ─────────────────────────────────────────────

/** Map range to bucket size label */
const BUCKET_SIZE_MAP: Record<TimeRange, ErrorTrendsResponse['bucketSize']> = {
  '1h': '1min',   // 1h range still uses hourly buckets (native granularity)
  '24h': '1h',
  '7d': '6h',
};

/** Map range to milliseconds */
const RANGE_MS: Record<TimeRange, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

interface TrendsAggregateRow {
  time_bucket: string;
  category: string;
  total: number;
}

interface DeploymentRow {
  app_version: string;
  deploy_time: string;
}

/**
 * Transform raw D1 query rows into the chart-optimized ErrorTrendsResponse format.
 *
 * Exported for unit testing.
 */
export function transformTrendsData(
  rows: TrendsAggregateRow[],
  deploymentRows: DeploymentRow[],
): Omit<ErrorTrendsResponse, 'range' | 'bucketSize'> {
  if (rows.length === 0) {
    return { timestamps: [], series: {}, deployments: [] };
  }

  // Collect all unique timestamps and categories
  const timestampSet = new Set<number>();
  const categorySet = new Set<string>();

  for (const row of rows) {
    const ts = Math.floor(new Date(row.time_bucket).getTime() / 1000);
    timestampSet.add(ts);
    categorySet.add(row.category);
  }

  // Sort timestamps ascending
  const timestamps = Array.from(timestampSet).sort((a, b) => a - b);
  const tsIndex = new Map<number, number>();
  timestamps.forEach((ts, i) => tsIndex.set(ts, i));

  // Build series: category -> array of counts aligned with timestamps
  const series: Record<string, number[]> = {};
  for (const cat of categorySet) {
    series[cat] = new Array(timestamps.length).fill(0);
  }

  for (const row of rows) {
    const ts = Math.floor(new Date(row.time_bucket).getTime() / 1000);
    const idx = tsIndex.get(ts);
    if (idx !== undefined && series[row.category]) {
      series[row.category]![idx] = row.total;
    }
  }

  // Build deployment markers
  const deployments: DeploymentMarker[] = deploymentRows.map((d) => ({
    version: d.app_version,
    timestamp: new Date(d.deploy_time).getTime(),
  }));

  return { timestamps, series, deployments };
}

/**
 * Handle GET /admin/api/errors/trends
 *
 * Returns time-bucketed error counts suitable for chart rendering.
 * Supports query params:
 *   - range: '1h' | '24h' | '7d' (default: '24h')
 *   - category: optional filter for a single category
 */
export async function handleErrorTrends(
  request: Request,
  env: Env,
): Promise<Response> {
  // Verify authentication
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  // If DIAGNOSTICS_DB is not bound, return empty data gracefully
  if (!env.DIAGNOSTICS_DB) {
    const range = parseRange(request);
    return jsonResponse({
      success: true,
      data: {
        timestamps: [],
        series: {},
        deployments: [],
        range,
        bucketSize: BUCKET_SIZE_MAP[range],
      },
    });
  }

  // Parse query params
  const url = new URL(request.url);
  const rangeParam = url.searchParams.get('range') || '24h';
  const categoryParam = url.searchParams.get('category') || null;

  // Validate range
  if (!VALID_RANGES.includes(rangeParam as TimeRange)) {
    return jsonResponse(
      { success: false, error: `Invalid range. Must be one of: ${VALID_RANGES.join(', ')}` },
      400,
    );
  }

  // Validate category if provided
  if (categoryParam && !VALID_CATEGORIES.includes(categoryParam as typeof VALID_CATEGORIES[number])) {
    return jsonResponse(
      { success: false, error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` },
      400,
    );
  }

  const range = rangeParam as TimeRange;
  const bucketSize = BUCKET_SIZE_MAP[range];
  const sinceMs = Date.now() - RANGE_MS[range];
  const sinceISO = new Date(sinceMs).toISOString();

  try {
    // Build trends query
    let trendsQuery: string;
    const trendsParams: string[] = [sinceISO];

    if (range === '7d') {
      // Aggregate hourly rows into 6-hour buckets using SQL
      trendsQuery = `
        SELECT
          strftime('%Y-%m-%dT', time_bucket) ||
          CASE
            WHEN CAST(strftime('%H', time_bucket) AS INTEGER) < 6 THEN '00'
            WHEN CAST(strftime('%H', time_bucket) AS INTEGER) < 12 THEN '06'
            WHEN CAST(strftime('%H', time_bucket) AS INTEGER) < 18 THEN '12'
            ELSE '18'
          END || ':00:00Z' as time_bucket,
          category,
          SUM(count) as total
        FROM error_aggregates
        WHERE time_bucket >= ?
      `;
      if (categoryParam) {
        trendsQuery += ' AND category = ?';
        trendsParams.push(categoryParam);
      }
      trendsQuery += ' GROUP BY 1, category ORDER BY 1 ASC';
    } else {
      // For 1h and 24h, use hourly buckets as-is
      trendsQuery = `
        SELECT time_bucket, category, SUM(count) as total
        FROM error_aggregates
        WHERE time_bucket >= ?
      `;
      if (categoryParam) {
        trendsQuery += ' AND category = ?';
        trendsParams.push(categoryParam);
      }
      trendsQuery += ' GROUP BY time_bucket, category ORDER BY time_bucket ASC';
    }

    // Build deployment markers query
    let deploymentsQuery = `
      SELECT app_version, MIN(first_seen) as deploy_time
      FROM error_aggregates
      WHERE time_bucket >= ?
    `;
    const deploymentsParams: string[] = [sinceISO];
    if (categoryParam) {
      deploymentsQuery += ' AND category = ?';
      deploymentsParams.push(categoryParam);
    }
    deploymentsQuery += ' GROUP BY app_version ORDER BY deploy_time ASC';

    // Execute queries in parallel
    const [trendsResult, deploymentsResult] = await Promise.all([
      env.DIAGNOSTICS_DB.prepare(trendsQuery).bind(...trendsParams).all<TrendsAggregateRow>(),
      env.DIAGNOSTICS_DB.prepare(deploymentsQuery).bind(...deploymentsParams).all<DeploymentRow>(),
    ]);

    const trendRows = trendsResult.results ?? [];
    const deploymentRows = deploymentsResult.results ?? [];

    // Transform into chart format
    const { timestamps, series, deployments } = transformTrendsData(
      trendRows,
      deploymentRows,
    );

    const responseData: ErrorTrendsResponse = {
      timestamps,
      series,
      deployments,
      range,
      bucketSize,
    };

    return jsonResponse({ success: true, data: responseData });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('Failed to fetch error trends:', errMsg);
    return jsonResponse(
      { success: false, error: `Failed to fetch error trends: ${errMsg}` },
      500,
    );
  }
}

// ─────────────────────────────────────────────
// Regression Detection (US-2.4)
// ─────────────────────────────────────────────

/** Valid regression window options */
const VALID_WINDOWS = ['6h', '24h', '48h'] as const;
type RegressionWindow = typeof VALID_WINDOWS[number];

/** Minimum occurrence threshold for new errors (no previous version data) */
const NEW_ERROR_MIN_THRESHOLD = 10;

/**
 * Compare two semver strings: returns negative if a < b, positive if a > b, 0 if equal.
 * Splits on '.', compares each segment as integers.
 * Falls back to lexicographic comparison for non-numeric segments.
 */
export function compareSemver(a: string, b: string): number {
  const partsA = a.split('.');
  const partsB = b.split('.');
  const len = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < len; i++) {
    const segA = partsA[i] || '0';
    const segB = partsB[i] || '0';
    const isNumA = /^\d+$/.test(segA);
    const isNumB = /^\d+$/.test(segB);

    if (isNumA && isNumB) {
      const diff = parseInt(segA, 10) - parseInt(segB, 10);
      if (diff !== 0) return diff;
    } else {
      const cmp = segA.localeCompare(segB);
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

/**
 * Detect regressions by comparing error rates across the two most recent app versions.
 *
 * GET /admin/api/errors/regressions?window=6h|24h|48h&threshold=3.0
 */
export async function handleErrorRegressions(
  request: Request,
  env: Env
): Promise<Response> {
  // Verify authentication
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  // If DIAGNOSTICS_DB is not bound, return empty regressions
  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse({
      success: true,
      data: {
        regressions: [],
        currentVersion: '',
        previousVersion: '',
        window: '24h',
        threshold: 3.0,
        computedAt: Date.now(),
      } as RegressionResponse,
    });
  }

  try {
    // Parse query params
    const url = new URL(request.url);
    const windowParam = url.searchParams.get('window') || '24h';
    const thresholdParam = url.searchParams.get('threshold') || '3.0';

    // Validate window
    if (!VALID_WINDOWS.includes(windowParam as RegressionWindow)) {
      return jsonResponse(
        { success: false, error: `Invalid window. Must be one of: ${VALID_WINDOWS.join(', ')}` },
        400
      );
    }
    const window = windowParam as RegressionWindow;

    // Validate threshold
    const threshold = parseFloat(thresholdParam);
    if (isNaN(threshold) || threshold < 1.0) {
      return jsonResponse(
        { success: false, error: 'Invalid threshold. Must be a number >= 1.0' },
        400
      );
    }

    // Compute time threshold
    const now = new Date();
    const windowMs = parseWindowMs(window);
    const timeThreshold = new Date(now.getTime() - windowMs).toISOString();
    const hoursInWindow = windowMs / (60 * 60 * 1000);

    // Step 1: Get the two most recent app versions (semver ordered)
    const versionsResult = await env.DIAGNOSTICS_DB.prepare(`
      SELECT DISTINCT app_version
      FROM error_aggregates
      WHERE time_bucket >= ?
    `).bind(timeThreshold).all();

    const versions = (versionsResult.results || [])
      .map((row: Record<string, unknown>) => String(row['app_version'] || ''))
      .filter((v: string) => v.length > 0)
      .sort(compareSemver);

    // If fewer than 2 versions, return empty regressions
    if (versions.length < 2) {
      return jsonResponse({
        success: true,
        data: {
          regressions: [],
          currentVersion: versions[versions.length - 1] || '',
          previousVersion: versions.length > 1 ? versions[versions.length - 2] : '',
          window,
          threshold,
          computedAt: Date.now(),
        } as RegressionResponse,
      });
    }

    // After the guard above, we know versions.length >= 2
    const currentVersion = versions[versions.length - 1]!;
    const previousVersion = versions[versions.length - 2]!;

    // Step 2: Get error counts grouped by signature, category, and version
    const aggregatesResult = await env.DIAGNOSTICS_DB.prepare(`
      SELECT
        error_signature,
        category,
        app_version,
        SUM(count) as total_count,
        MIN(time_bucket) as first_bucket,
        MAX(sample_message) as sample_message
      FROM error_aggregates
      WHERE time_bucket >= ?
        AND app_version IN (?, ?)
      GROUP BY error_signature, category, app_version
    `).bind(timeThreshold, currentVersion, previousVersion).all();

    // Step 3: Build maps of signature -> version data
    interface VersionData {
      totalCount: number;
      category: string;
      firstBucket: string;
      sampleMessage: string;
    }

    const currentMap = new Map<string, VersionData>();
    const previousMap = new Map<string, VersionData>();

    for (const row of (aggregatesResult.results || [])) {
      const sig = String(row['error_signature'] || '');
      const version = String(row['app_version'] || '');
      const data: VersionData = {
        totalCount: Number(row['total_count'] || 0),
        category: String(row['category'] || 'other'),
        firstBucket: String(row['first_bucket'] || ''),
        sampleMessage: String(row['sample_message'] || ''),
      };

      if (version === currentVersion) {
        currentMap.set(sig, data);
      } else if (version === previousVersion) {
        previousMap.set(sig, data);
      }
    }

    // Step 4: Compute regressions
    const regressions: Regression[] = [];

    for (const [sig, currentData] of currentMap) {
      const previousData = previousMap.get(sig);

      const currentRate = currentData.totalCount / hoursInWindow;
      let previousRate: number;
      let multiplier: number;
      let previousTotal: number;

      if (previousData) {
        previousRate = previousData.totalCount / hoursInWindow;
        previousTotal = previousData.totalCount;

        if (previousRate === 0) {
          // Previous version had this signature but zero count -- treat as new error path
          if (currentData.totalCount >= NEW_ERROR_MIN_THRESHOLD) {
            multiplier = Infinity;
          } else {
            continue; // Below minimum threshold
          }
        } else {
          multiplier = currentRate / previousRate;
        }
      } else {
        // New error: only in current version
        previousRate = 0;
        previousTotal = 0;
        if (currentData.totalCount >= NEW_ERROR_MIN_THRESHOLD) {
          multiplier = Infinity;
        } else {
          continue; // Below minimum threshold for new errors
        }
      }

      // Flag as regression if multiplier >= threshold
      if (multiplier >= threshold) {
        const firstDetected = currentData.firstBucket
          ? new Date(currentData.firstBucket).getTime()
          : Date.now();

        regressions.push({
          errorSignature: sig,
          category: currentData.category,
          currentVersion,
          previousVersion,
          currentRate: Math.round(currentRate * 100) / 100,
          previousRate: Math.round(previousRate * 100) / 100,
          multiplier: multiplier === Infinity
            ? 999.9  // Cap for JSON serialization
            : Math.round(multiplier * 10) / 10,
          currentTotal: currentData.totalCount,
          previousTotal,
          firstDetected,
          sampleMessage: currentData.sampleMessage,
        });
      }
    }

    // Sort by multiplier descending (worst first)
    regressions.sort((a, b) => b.multiplier - a.multiplier);

    return jsonResponse({
      success: true,
      data: {
        regressions,
        currentVersion,
        previousVersion,
        window,
        threshold,
        computedAt: Date.now(),
      } as RegressionResponse,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('Failed to compute regressions:', errMsg);
    return jsonResponse(
      { success: false, error: `Failed to compute regressions: ${errMsg}` },
      500
    );
  }
}

/**
 * Parse a window string into milliseconds
 */
function parseWindowMs(window: RegressionWindow): number {
  switch (window) {
    case '6h': return 6 * 60 * 60 * 1000;
    case '24h': return 24 * 60 * 60 * 1000;
    case '48h': return 48 * 60 * 60 * 1000;
  }
}

/**
 * Error detail drill-down for a specific error signature
 * GET /admin/api/errors/:signature
 */
export async function handleErrorDetail(
  request: Request,
  env: Env,
  signature: string
): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  if (!signature) {
    return jsonResponse({ success: false, error: 'Signature parameter required' }, 400);
  }

  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse({ success: false, error: 'Error signature not found' }, 404);
  }

  try {
    const stmt = env.DIAGNOSTICS_DB.prepare(`
      SELECT time_bucket, app_version, platform, count, first_seen, last_seen,
             sample_message, sample_stack_trace, category
      FROM error_aggregates
      WHERE error_signature = ?
      ORDER BY time_bucket DESC
      LIMIT 500
    `).bind(signature);

    const results = await stmt.all();

    if (!results.results || results.results.length === 0) {
      return jsonResponse({ success: false, error: 'Error signature not found' }, 404);
    }

    const rows = results.results;

    let totalCount = 0;
    let firstSeen = Infinity;
    let lastSeen = -Infinity;
    let sampleMessage = '';
    let sampleStackTrace: string | null = null;
    let category = 'other';

    const versionCounts: Record<string, number> = {};
    const platformCounts: Record<string, number> = {};
    const timelineBuckets: Record<string, number> = {};

    for (const row of rows) {
      const count = Number(row['count'] ?? 0);
      const rowFirstSeen = Number(row['first_seen'] ?? 0);
      const rowLastSeen = Number(row['last_seen'] ?? 0);
      const version = String(row['app_version'] ?? 'unknown');
      const platform = String(row['platform'] ?? 'unknown');
      const timeBucket = String(row['time_bucket'] ?? '');

      totalCount += count;
      if (rowFirstSeen < firstSeen) firstSeen = rowFirstSeen;
      if (rowLastSeen > lastSeen) lastSeen = rowLastSeen;

      versionCounts[version] = (versionCounts[version] ?? 0) + count;
      platformCounts[platform] = (platformCounts[platform] ?? 0) + count;
      timelineBuckets[timeBucket] = (timelineBuckets[timeBucket] ?? 0) + count;
    }

    const firstRow = rows[0];
    if (firstRow) {
      sampleMessage = String(firstRow['sample_message'] ?? '');
      category = String(firstRow['category'] ?? 'other');
    }

    for (const row of rows) {
      if (row['sample_stack_trace']) {
        sampleStackTrace = String(row['sample_stack_trace']);
        break;
      }
    }

    const versionDistribution = buildDistribution(versionCounts, totalCount);
    const platformDistribution = buildDistribution(platformCounts, totalCount);

    const occurrenceTimeline: TimelinePoint[] = Object.entries(timelineBuckets)
      .map(([bucket, count]) => ({
        timestamp: Math.floor(new Date(bucket).getTime() / 1000),
        count,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

    if (firstSeen === Infinity) firstSeen = 0;
    if (lastSeen === -Infinity) lastSeen = 0;

    const data: ErrorDetailResponse = {
      errorSignature: signature,
      category,
      totalCount,
      firstSeen,
      lastSeen,
      sampleMessage,
      sampleStackTrace,
      versionDistribution,
      platformDistribution,
      occurrenceTimeline,
    };

    return jsonResponse({ success: true, data });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('Failed to query error detail:', errMsg);
    return jsonResponse({ success: false, error: `Failed to query error detail: ${errMsg}` }, 500);
  }
}

/**
 * Build a sorted distribution array from counts with percentages
 */
function buildDistribution(
  counts: Record<string, number>,
  total: number
): DistributionEntry[] {
  return Object.entries(counts)
    .map(([name, count]) => ({
      name,
      count,
      percentage: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * JSON response helper
 */
function jsonResponse<T>(data: ApiResponse<T>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
