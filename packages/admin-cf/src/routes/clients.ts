/**
 * Client analytics route handlers (Epic 4)
 *
 * US-4.1: Active client count + sparkline
 * US-4.2: Platform breakdown (donut chart data)
 * US-4.3: Version adoption curves (stacked area chart)
 * US-4.4: Connection type distribution + trend
 */

import type { Env, SparklineEntry, PlatformCount, VersionAdoptionData, VersionTimeBucket, ConnectionTypeCount, ConnectionTypeTrend, ConnectionTypeData } from '../types.js';
import { requireAuth } from './auth.js';

// ─── US-4.1 Constants ──────────────────────────

/** Maximum hours allowed for sparkline window */
const MAX_HOURS = 168;
/** Default hours for sparkline window */
const DEFAULT_HOURS = 24;
/** Client considered active if heartbeat within this window (ms) */
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
/** Sparkline bucket size (5 minutes in ms) */
const BUCKET_SIZE_MS = 5 * 60 * 1000;

// ─── US-4.3 Constants ──────────────────────────

/** Valid time range options for version adoption */
const VALID_RANGES = ['24h', '7d', '30d'] as const;
type VersionRange = typeof VALID_RANGES[number];

/** Map range to milliseconds */
const RANGE_MS: Record<VersionRange, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/** Maximum number of distinct versions before grouping into "other" */
const MAX_VERSIONS = 8;

// ─── US-4.4 Constants ──────────────────────────

/** Maximum trend window: 7 days */
const MAX_TREND_HOURS = 168;
/** Default trend window: 24 hours */
const DEFAULT_TREND_HOURS = 24;
/** Heartbeat freshness window: 10 minutes */
const HEARTBEAT_WINDOW_MS = 600_000;

// ─── US-4.1: Active Clients ────────────────────

/**
 * Handle GET /admin/api/clients/active
 * Returns active client count and sparkline data
 */
export async function handleActiveClients(
  request: Request,
  env: Env
): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse({
      success: true,
      data: {
        activeCount: 0,
        sparkline: [],
        lastUpdated: Date.now(),
      },
    });
  }

  const url = new URL(request.url);
  const hoursParam = url.searchParams.get('hours');
  let hours = DEFAULT_HOURS;

  if (hoursParam !== null) {
    const parsed = Number(hoursParam);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_HOURS) {
      return jsonResponse(
        { success: false, error: `hours must be between 1 and ${MAX_HOURS}` },
        400
      );
    }
    hours = parsed;
  }

  try {
    const now = Date.now();
    const activeThreshold = now - ACTIVE_WINDOW_MS;
    const sparklineThreshold = now - hours * 60 * 60 * 1000;

    const countResult = await env.DIAGNOSTICS_DB
      .prepare('SELECT COUNT(*) as active_count FROM client_heartbeats WHERE last_seen > ?')
      .bind(activeThreshold)
      .all();

    const activeCount = (countResult.results[0] as { active_count: number } | undefined)?.active_count ?? 0;

    const sparklineResult = await env.DIAGNOSTICS_DB
      .prepare(
        'SELECT (last_seen / ?) * ? AS bucket, COUNT(DISTINCT session_hash) AS count FROM client_heartbeats WHERE last_seen > ? GROUP BY bucket ORDER BY bucket ASC'
      )
      .bind(BUCKET_SIZE_MS, BUCKET_SIZE_MS, sparklineThreshold)
      .all();

    const sparkline: SparklineEntry[] = (sparklineResult.results as { bucket: number; count: number }[]).map(
      (row) => ({
        timestamp: row.bucket,
        count: row.count,
      })
    );

    return jsonResponse({
      success: true,
      data: {
        activeCount,
        sparkline,
        lastUpdated: now,
      },
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('Failed to query active clients:', errMsg);
    return jsonResponse(
      { success: false, error: 'Failed to query active clients' },
      500
    );
  }
}

// ─── US-4.2: Platform Breakdown ────────────────

/**
 * Handle GET /admin/api/clients/platforms
 * Returns platform breakdown of active clients (seen in last 10 minutes)
 */
export async function handlePlatformBreakdown(
  request: Request,
  env: Env
): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse({
      success: true,
      data: {
        platforms: [],
        totalActive: 0,
        lastUpdated: Date.now(),
      },
    });
  }

  try {
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;

    const result = await env.DIAGNOSTICS_DB
      .prepare(
        'SELECT platform, COUNT(*) as count FROM client_heartbeats WHERE last_seen > ? GROUP BY platform ORDER BY count DESC'
      )
      .bind(tenMinutesAgo)
      .all();

    const rows = (result.results || []) as Array<{ platform: string; count: number }>;

    const totalActive = rows.reduce((sum, row) => sum + row.count, 0);

    const platforms: PlatformCount[] = rows
      .filter((row) => row.count > 0)
      .map((row) => ({
        platform: row.platform,
        count: row.count,
        percentage: totalActive > 0
          ? Math.round((row.count / totalActive) * 1000) / 10
          : 0,
      }));

    return jsonResponse({
      success: true,
      data: {
        platforms,
        totalActive,
        lastUpdated: Date.now(),
      },
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('Failed to query platform breakdown:', errMsg);
    return jsonResponse(
      { success: false, error: 'Failed to query platform breakdown' },
      500
    );
  }
}

// ─── US-4.3: Version Adoption ──────────────────

/**
 * Compare two semver strings, newest first (descending).
 * Returns negative if a > b, positive if a < b, 0 if equal.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Handle GET /admin/api/clients/versions
 *
 * Returns version adoption data grouped into time buckets.
 * - 24h: 5-minute resolution (direct query)
 * - 7d: 1-hour buckets
 * - 30d: 6-hour buckets
 */
export async function handleVersionAdoption(
  request: Request,
  env: Env,
): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  const url = new URL(request.url);
  const rangeParam = url.searchParams.get('range') || '7d';

  if (!VALID_RANGES.includes(rangeParam as VersionRange)) {
    return jsonResponse(
      { success: false, error: `Invalid range: ${rangeParam}. Valid values: ${VALID_RANGES.join(', ')}` },
      400,
    );
  }

  const range = rangeParam as VersionRange;

  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse({
      success: true,
      data: {
        range,
        buckets: [],
        versions: [],
        lastUpdated: Date.now(),
      } satisfies VersionAdoptionData,
    }, 200);
  }

  try {
    const now = Date.now();
    const threshold = now - RANGE_MS[range];

    let query: string;

    if (range === '24h') {
      query = `SELECT time_bucket, app_version, active_count
               FROM version_history
               WHERE time_bucket >= ?1
               ORDER BY time_bucket ASC`;
    } else if (range === '7d') {
      query = `SELECT (time_bucket / 3600000) * 3600000 AS time_bucket,
                      app_version,
                      SUM(active_count) AS active_count
               FROM version_history
               WHERE time_bucket >= ?1
               GROUP BY (time_bucket / 3600000) * 3600000, app_version
               ORDER BY time_bucket ASC`;
    } else {
      query = `SELECT (time_bucket / 21600000) * 21600000 AS time_bucket,
                      app_version,
                      SUM(active_count) AS active_count
               FROM version_history
               WHERE time_bucket >= ?1
               GROUP BY (time_bucket / 21600000) * 21600000, app_version
               ORDER BY time_bucket ASC`;
    }

    const result = await env.DIAGNOSTICS_DB
      .prepare(query)
      .bind(threshold)
      .all<{ time_bucket: number; app_version: string; active_count: number }>();

    const rows = result.results || [];

    const versionSet = new Set<string>();
    for (const row of rows) {
      versionSet.add(row.app_version);
    }
    const allVersions = Array.from(versionSet).sort(compareSemver);

    let versions: string[];
    const groupedVersions = new Set<string>();
    if (allVersions.length > MAX_VERSIONS) {
      versions = allVersions.slice(0, MAX_VERSIONS);
      const otherVersions = allVersions.slice(MAX_VERSIONS);
      for (const v of otherVersions) {
        groupedVersions.add(v);
      }
      versions.push('other');
    } else {
      versions = allVersions;
    }

    const bucketMap = new Map<number, Record<string, number>>();

    for (const row of rows) {
      const ts = row.time_bucket;
      if (!bucketMap.has(ts)) {
        bucketMap.set(ts, {});
      }
      const counts = bucketMap.get(ts)!;
      const versionKey = groupedVersions.has(row.app_version) ? 'other' : row.app_version;
      counts[versionKey] = (counts[versionKey] || 0) + row.active_count;
    }

    const buckets: VersionTimeBucket[] = Array.from(bucketMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([timestamp, counts]) => ({ timestamp, counts }));

    const data: VersionAdoptionData = {
      range,
      buckets,
      versions,
      lastUpdated: now,
    };

    return jsonResponse({ success: true, data }, 200);
  } catch (error) {
    console.error('Failed to query version adoption:', error);
    return jsonResponse(
      { success: false, error: 'Failed to query version adoption data' },
      500,
    );
  }
}

// ─── US-4.4: Connection Types ──────────────────

/**
 * Handle GET /admin/api/clients/connections
 *
 * Returns current connection type distribution and historical trend.
 * Accepts ?trendHours=24 (default: 24, max: 168).
 */
export async function handleConnectionTypes(
  request: Request,
  env: Env
): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse({
      success: true,
      data: {
        current: [],
        trend: [],
        totalActive: 0,
        lastUpdated: Date.now(),
      },
    });
  }

  const url = new URL(request.url);
  const trendHoursParam = url.searchParams.get('trendHours');
  let trendHours = DEFAULT_TREND_HOURS;

  if (trendHoursParam !== null) {
    const parsed = Number(trendHoursParam);
    if (isNaN(parsed) || parsed < 1 || parsed > MAX_TREND_HOURS) {
      return jsonResponse(
        { success: false, error: `trendHours must be between 1 and ${MAX_TREND_HOURS}` },
        400
      );
    }
    trendHours = parsed;
  }

  try {
    const now = Date.now();
    const activeCutoff = now - HEARTBEAT_WINDOW_MS;
    const trendCutoff = now - trendHours * 60 * 60 * 1000;

    const currentResult = await env.DIAGNOSTICS_DB
      .prepare(
        `SELECT COALESCE(connection_type, 'none') as connection_type, COUNT(*) as count
         FROM client_heartbeats
         WHERE last_seen > ?
         GROUP BY COALESCE(connection_type, 'none')
         ORDER BY count DESC`
      )
      .bind(activeCutoff)
      .all<{ connection_type: string; count: number }>();

    const trendResult = await env.DIAGNOSTICS_DB
      .prepare(
        `SELECT time_bucket, connection_type, active_count
         FROM connection_type_history
         WHERE time_bucket > ?
         ORDER BY time_bucket ASC`
      )
      .bind(trendCutoff)
      .all<{ time_bucket: number; connection_type: string; active_count: number }>();

    const currentRows = currentResult.results || [];
    const totalActive = currentRows.reduce((sum, row) => sum + row.count, 0);

    const current: ConnectionTypeCount[] = currentRows.map((row) => ({
      connectionType: row.connection_type,
      count: row.count,
      percentage: totalActive > 0 ? Math.round((row.count / totalActive) * 10000) / 100 : 0,
    }));

    const trendRows = trendResult.results || [];
    const trendMap = new Map<number, ConnectionTypeTrend>();

    for (const row of trendRows) {
      let entry = trendMap.get(row.time_bucket);
      if (!entry) {
        entry = {
          timestamp: row.time_bucket,
          direct_p2p: 0,
          relay: 0,
          none: 0,
        };
        trendMap.set(row.time_bucket, entry);
      }

      if (row.connection_type === 'direct_p2p') {
        entry.direct_p2p = row.active_count;
      } else if (row.connection_type === 'relay') {
        entry.relay = row.active_count;
      } else {
        entry.none = row.active_count;
      }
    }

    const trend = Array.from(trendMap.values()).sort((a, b) => a.timestamp - b.timestamp);

    const data: ConnectionTypeData = {
      current,
      trend,
      totalActive,
      lastUpdated: now,
    };

    return jsonResponse({ success: true, data });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('Failed to query connection types:', errMsg);
    return jsonResponse(
      { success: false, error: 'Failed to query connection type data' },
      500
    );
  }
}

// ─── Shared Helper ─────────────────────────────

/**
 * JSON response helper.
 */
function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
