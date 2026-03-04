/**
 * Security Attacks / DDoS Indicators route handler (US-7.3)
 *
 * Provides DDoS indicator data:
 * - Connection rate timeline with anomaly highlighting
 * - Active alerts when spikes exceed 5x normal rate
 * - Summary of spike events
 */

import type { Env, ApiResponse, DdosIndicatorsData } from '../types.js';
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

/** Anomaly threshold: 5x the rolling average triggers an alert */
const ANOMALY_MULTIPLIER = 5;

/** Lookback window for computing the "normal" rate (24 hours in ms) */
const NORMAL_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How recent an alert must be to be considered "active" (1 hour) */
const ACTIVE_ALERT_WINDOW_MS = 60 * 60 * 1000;

/**
 * GET /admin/api/security/attacks
 *
 * Returns DDoS indicator data for the requested time range.
 */
export async function handleDdosIndicators(
  request: Request,
  env: Env
): Promise<Response> {
  // Auth check
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  const url = new URL(request.url);
  const rangeParam = url.searchParams.get('range') || '24h';

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
      data: emptyDdosData(range),
    });
  }

  try {
    const now = Date.now();
    const cutoff = now - RANGE_MS[range];
    const normalRateCutoff = now - NORMAL_RATE_WINDOW_MS;
    const activeAlertCutoff = now - ACTIVE_ALERT_WINDOW_MS;

    // Run queries in parallel
    const [spikesResult, timelineResult, activeAlertsResult, normalRateResult, currentRateResult] = await env.DIAGNOSTICS_DB.batch([
      // Total spike events in range
      env.DIAGNOSTICS_DB.prepare(
        `SELECT
          COUNT(*) as totalSpikes,
          MAX(CAST(json_extract(details, '$.multiplier') AS REAL)) as highestMultiplier
        FROM security_events
        WHERE event_type = ?
          AND timestamp > ?
        LIMIT 1`
      ).bind('connection_spike', cutoff),

      // Connection rate timeline (hourly buckets) from all connection events
      env.DIAGNOSTICS_DB.prepare(
        `SELECT
          (timestamp / 3600000) * 3600000 as bucket,
          SUM(count) as rate
        FROM security_events
        WHERE event_type IN (?, ?)
          AND timestamp > ?
        GROUP BY bucket
        ORDER BY bucket ASC
        LIMIT 720`
      ).bind('connection_spike', 'rate_limit_violation', cutoff),

      // Active alerts (recent connection spikes with high severity)
      env.DIAGNOSTICS_DB.prepare(
        `SELECT
          id,
          timestamp,
          server_id,
          region,
          details,
          severity,
          count
        FROM security_events
        WHERE event_type = ?
          AND timestamp > ?
        ORDER BY timestamp DESC
        LIMIT 50`
      ).bind('connection_spike', activeAlertCutoff),

      // Normal rate: average hourly rate over the last 24h
      env.DIAGNOSTICS_DB.prepare(
        `SELECT AVG(hourly_count) as avgRate
        FROM (
          SELECT
            (timestamp / 3600000) * 3600000 as bucket,
            SUM(count) as hourly_count
          FROM security_events
          WHERE event_type IN (?, ?)
            AND timestamp > ?
          GROUP BY bucket
          LIMIT 24
        )
        LIMIT 1`
      ).bind('connection_spike', 'rate_limit_violation', normalRateCutoff),

      // Current rate: most recent hour's connection count
      env.DIAGNOSTICS_DB.prepare(
        `SELECT COALESCE(SUM(count), 0) as currentRate
        FROM security_events
        WHERE event_type IN (?, ?)
          AND timestamp > ?
        LIMIT 1`
      ).bind('connection_spike', 'rate_limit_violation', now - 3600000),
    ]);

    // Parse spike summary
    const spikeSummary = spikesResult.results?.[0] as {
      totalSpikes: number;
      highestMultiplier: number | null;
    } | undefined;

    const totalSpikes = spikeSummary?.totalSpikes ?? 0;
    const highestMultiplier = spikeSummary?.highestMultiplier ?? 0;

    // Parse normal rate (average hourly) and current rate (latest hour)
    const normalRateRow = normalRateResult.results?.[0] as {
      avgRate: number | null;
    } | undefined;
    const normalRate = normalRateRow?.avgRate ?? 0;

    const currentRateRow = currentRateResult.results?.[0] as {
      currentRate: number | null;
    } | undefined;
    const currentConnectionRate = currentRateRow?.currentRate ?? 0;

    // Parse timeline and flag anomalies
    const timelineRows = (timelineResult.results ?? []) as Array<{
      bucket: number;
      rate: number;
    }>;
    const connectionRateTimeline = timelineRows.map(row => ({
      timestamp: row.bucket,
      rate: row.rate,
      isAnomaly: normalRate > 0 && row.rate >= normalRate * ANOMALY_MULTIPLIER,
      normalRate: Math.round(normalRate * 100) / 100,
    }));

    // Parse active alerts
    const alertRows = (activeAlertsResult.results ?? []) as Array<{
      id: number;
      timestamp: number;
      server_id: string | null;
      region: string | null;
      details: string | null;
      severity: string;
      count: number;
    }>;

    const activeAlerts = alertRows.map(row => {
      let parsedDetails: { multiplier?: number; currentRate?: number; normalRate?: number } = {};
      try {
        if (row.details) {
          parsedDetails = JSON.parse(row.details);
        }
      } catch {
        // details is not valid JSON, ignore
      }

      return {
        id: row.id,
        timestamp: row.timestamp,
        serverId: row.server_id ?? 'unknown',
        region: row.region ?? 'unknown',
        currentRate: parsedDetails.currentRate ?? row.count,
        normalRate: parsedDetails.normalRate ?? normalRate,
        multiplier: parsedDetails.multiplier ?? (normalRate > 0 ? row.count / normalRate : 0),
        severity: row.severity,
      };
    });

    const data: DdosIndicatorsData = {
      range,
      summary: {
        totalSpikes,
        activeAlerts: activeAlerts.length,
        highestMultiplier: Math.round(highestMultiplier * 100) / 100,
        currentConnectionRate: Math.round(currentConnectionRate),
      },
      connectionRateTimeline,
      activeAlerts,
      lastUpdated: now,
    };

    return jsonResponse({ success: true, data });
  } catch (error) {
    console.error('Failed to query DDoS indicators:', error);
    return jsonResponse(
      { success: false, error: 'Failed to retrieve DDoS indicator data' },
      500
    );
  }
}

/**
 * Returns an empty DDoS indicators response for when no DB is available
 */
function emptyDdosData(range: string): DdosIndicatorsData {
  return {
    range,
    summary: {
      totalSpikes: 0,
      activeAlerts: 0,
      highestMultiplier: 0,
      currentConnectionRate: 0,
    },
    connectionRateTimeline: [],
    activeAlerts: [],
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
