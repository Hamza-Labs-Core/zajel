/**
 * Security Rate Limits route handler (US-7.1)
 *
 * Provides rate limit violation dashboard data:
 * - Timeline of violations over time (hourly buckets)
 * - Top violated endpoints
 * - Regional breakdown
 */

import type { Env, ApiResponse, RateLimitViolationsData } from '../types.js';
import { requireAuth } from './auth.js';

/** Supported range parameters */
const VALID_RANGES = ['24h', '7d', '30d'] as const;
type Range = typeof VALID_RANGES[number];

/** Map range string to milliseconds */
const RANGE_MS: Record<Range, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/**
 * GET /admin/api/security/rate-limits
 *
 * Returns rate limit violation data aggregated over the requested time range.
 */
export async function handleRateLimitViolations(
  request: Request,
  env: Env
): Promise<Response> {
  // Auth check
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  const url = new URL(request.url);
  const rangeParam = url.searchParams.get('range') || '7d';

  // Validate range
  if (!VALID_RANGES.includes(rangeParam as Range)) {
    return jsonResponse(
      { success: false, error: `Invalid range. Must be one of: ${VALID_RANGES.join(', ')}` },
      400
    );
  }
  const range = rangeParam as Range;

  // If no DIAGNOSTICS_DB binding, return empty data
  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse({
      success: true,
      data: emptyRateLimitData(range),
    });
  }

  try {
    const now = Date.now();
    const cutoff = now - RANGE_MS[range];

    // Run all queries in parallel
    const [summaryResult, timelineResult, endpointsResult, regionsResult] = await env.DIAGNOSTICS_DB.batch([
      // Summary: total violations, unique endpoints, unique regions
      env.DIAGNOSTICS_DB.prepare(
        `SELECT
          COALESCE(SUM(count), 0) as totalViolations,
          COUNT(DISTINCT endpoint) as uniqueEndpoints,
          COUNT(DISTINCT region) as uniqueRegions
        FROM security_events
        WHERE event_type = ?
          AND timestamp > ?
        LIMIT 1`
      ).bind('rate_limit_violation', cutoff),

      // Timeline: hourly buckets
      env.DIAGNOSTICS_DB.prepare(
        `SELECT
          (timestamp / 3600000) * 3600000 as bucket,
          SUM(count) as count
        FROM security_events
        WHERE event_type = ?
          AND timestamp > ?
        GROUP BY bucket
        ORDER BY bucket ASC
        LIMIT 720`
      ).bind('rate_limit_violation', cutoff),

      // Top endpoints
      env.DIAGNOSTICS_DB.prepare(
        `SELECT
          endpoint,
          SUM(count) as count
        FROM security_events
        WHERE event_type = ?
          AND timestamp > ?
        GROUP BY endpoint
        ORDER BY count DESC
        LIMIT 20`
      ).bind('rate_limit_violation', cutoff),

      // Regional breakdown
      env.DIAGNOSTICS_DB.prepare(
        `SELECT
          region,
          SUM(count) as count
        FROM security_events
        WHERE event_type = ?
          AND timestamp > ?
        GROUP BY region
        ORDER BY count DESC
        LIMIT 50`
      ).bind('rate_limit_violation', cutoff),
    ]);

    // Parse summary
    const summaryRow = summaryResult.results?.[0] as {
      totalViolations: number;
      uniqueEndpoints: number;
      uniqueRegions: number;
    } | undefined;

    const totalViolations = summaryRow?.totalViolations ?? 0;
    const uniqueEndpoints = summaryRow?.uniqueEndpoints ?? 0;
    const uniqueRegions = summaryRow?.uniqueRegions ?? 0;

    // Parse timeline
    const timelineRows = (timelineResult.results ?? []) as Array<{
      bucket: number;
      count: number;
    }>;
    const timeline = timelineRows.map(row => ({
      timestamp: row.bucket,
      count: row.count,
    }));

    // Calculate peak hourly rate
    const peakHourlyRate = timeline.reduce(
      (max, entry) => Math.max(max, entry.count),
      0
    );

    // Parse top endpoints
    const endpointRows = (endpointsResult.results ?? []) as Array<{
      endpoint: string;
      count: number;
    }>;
    const topEndpoints = endpointRows.map(row => ({
      endpoint: row.endpoint ?? 'unknown',
      count: row.count,
      percentage: totalViolations > 0
        ? Math.round((row.count / totalViolations) * 10000) / 100
        : 0,
    }));

    // Parse regional breakdown
    const regionRows = (regionsResult.results ?? []) as Array<{
      region: string;
      count: number;
    }>;
    const regionalBreakdown = regionRows.map(row => ({
      region: row.region ?? 'unknown',
      count: row.count,
      percentage: totalViolations > 0
        ? Math.round((row.count / totalViolations) * 10000) / 100
        : 0,
    }));

    const data: RateLimitViolationsData = {
      range,
      summary: {
        totalViolations,
        uniqueEndpoints,
        uniqueRegions,
        peakHourlyRate,
      },
      timeline,
      topEndpoints,
      regionalBreakdown,
      lastUpdated: now,
    };

    return jsonResponse({ success: true, data });
  } catch (error) {
    console.error('Failed to query rate limit violations:', error);
    return jsonResponse(
      { success: false, error: 'Failed to retrieve rate limit data' },
      500
    );
  }
}

/**
 * Returns an empty rate limit response for when no DB is available
 */
function emptyRateLimitData(range: string): RateLimitViolationsData {
  return {
    range,
    summary: {
      totalViolations: 0,
      uniqueEndpoints: 0,
      uniqueRegions: 0,
      peakHourlyRate: 0,
    },
    timeline: [],
    topEndpoints: [],
    regionalBreakdown: [],
    lastUpdated: Date.now(),
  };
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
