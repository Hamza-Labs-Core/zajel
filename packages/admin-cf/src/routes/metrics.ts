/**
 * Metrics route handlers for Epic 3: Metrics Dashboard
 *
 * Provides endpoints for:
 * - Server metrics overview and detail (/admin/api/metrics/server, /admin/api/metrics/server/:id)
 * - App performance metrics (/admin/api/metrics/app)
 * - Network metrics (/admin/api/metrics/network)
 * - Federation health metrics (/admin/api/metrics/federation)
 */

import type { Env, ApiResponse } from '../types.js';
import { requireAuth } from './auth.js';

// ── Health thresholds ──────────────────────────────────────────────

/** CPU usage percentage that triggers "degraded" status */
export const CPU_WARNING = 80;
/** CPU usage percentage that triggers "critical" status */
export const CPU_CRITICAL = 95;
/** Memory usage in MB that triggers "degraded" status */
export const MEMORY_WARNING = 512;
/** Memory usage in MB that triggers "critical" status */
export const MEMORY_CRITICAL = 1024;

// ── Time range helpers ─────────────────────────────────────────────

/** Valid time ranges for metric queries */
const VALID_RANGES = ['1h', '6h', '24h', '7d'] as const;
type TimeRange = typeof VALID_RANGES[number];

/**
 * Parse a range string to milliseconds offset from now.
 * Returns null for invalid ranges.
 */
function rangeToMs(range: string): number | null {
  switch (range) {
    case '1h': return 60 * 60 * 1000;
    case '6h': return 6 * 60 * 60 * 1000;
    case '24h': return 24 * 60 * 60 * 1000;
    case '7d': return 7 * 24 * 60 * 60 * 1000;
    default: return null;
  }
}

/**
 * Get range from query string, defaulting to '24h'.
 */
function getRangeParam(url: URL): TimeRange {
  const range = url.searchParams.get('range') || '24h';
  if (VALID_RANGES.includes(range as TimeRange)) {
    return range as TimeRange;
  }
  return '24h';
}

// ── Health determination ───────────────────────────────────────────

/**
 * Determine health status of a server based on CPU and memory metrics.
 *
 * C-1 fix: checks both CPU and memory thresholds.
 * If either metric exceeds the critical threshold, returns 'critical'.
 * If either exceeds the warning threshold, returns 'degraded'.
 * Otherwise returns 'healthy'.
 */
export function determineHealthStatus(
  cpuPercent: number,
  memoryMb: number
): 'healthy' | 'degraded' | 'critical' {
  if (cpuPercent >= CPU_CRITICAL || memoryMb >= MEMORY_CRITICAL) {
    return 'critical';
  }
  if (cpuPercent >= CPU_WARNING || memoryMb >= MEMORY_WARNING) {
    return 'degraded';
  }
  return 'healthy';
}

// ── JSON response helper ───────────────────────────────────────────

function jsonResponse<T>(data: ApiResponse<T>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

// ── Handler: Server Metrics Overview ───────────────────────────────

/**
 * GET /admin/api/metrics/server
 *
 * Returns the latest metric snapshot for each server.
 *
 * H-2 fix: returns 200 with empty data when DIAGNOSTICS_DB is not bound.
 * C-2 fix: query includes LIMIT 500.
 * H-1 fix: error responses use generic message; details logged to console.
 */
export async function handleServerMetrics(
  request: Request,
  env: Env
): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;

  // H-2: Graceful degradation when DB not bound
  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse({ success: true, data: { servers: [] } });
  }

  try {
    const result = await env.DIAGNOSTICS_DB.prepare(`
      SELECT
        server_id,
        region,
        cpu_percent,
        memory_mb,
        connections_total,
        connections_relay,
        connections_signaling,
        active_codes,
        message_rate_per_sec,
        uptime_seconds,
        timestamp
      FROM server_metric_snapshots
      WHERE id IN (
        SELECT MAX(id) FROM server_metric_snapshots GROUP BY server_id
      )
      LIMIT 500
    `).all<{
      server_id: string;
      region: string;
      cpu_percent: number;
      memory_mb: number;
      connections_total: number;
      connections_relay: number;
      connections_signaling: number;
      active_codes: number;
      message_rate_per_sec: number;
      uptime_seconds: number;
      timestamp: number;
    }>();

    const servers = (result.results || []).map((row) => ({
      serverId: row.server_id,
      region: row.region,
      health: determineHealthStatus(row.cpu_percent, row.memory_mb),
      cpu: row.cpu_percent,
      memoryMb: row.memory_mb,
      connections: {
        total: row.connections_total,
        relay: row.connections_relay,
        signaling: row.connections_signaling,
      },
      activeCodes: row.active_codes,
      messageRatePerSec: row.message_rate_per_sec,
      uptimeSeconds: row.uptime_seconds,
      timestamp: row.timestamp,
    }));

    return jsonResponse({ success: true, data: { servers } });
  } catch (error) {
    // H-1: Log detailed error, return generic message
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('Failed to query server metrics:', errMsg);
    return jsonResponse(
      { success: false, error: 'Failed to retrieve server metrics' },
      500
    );
  }
}

// ── Handler: Server Metrics Detail ─────────────────────────────────

/**
 * GET /admin/api/metrics/server/:serverId
 *
 * Returns the latest snapshot plus 7-day history for a specific server.
 *
 * H-2 fix: returns 200 with empty data when DIAGNOSTICS_DB is not bound.
 * H-3 fix: history query is bounded to last 7 days.
 * H-1 fix: error responses use generic message.
 */
export async function handleServerMetricsDetail(
  request: Request,
  env: Env,
  serverId: string
): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;

  // H-2: Graceful degradation
  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse({
      success: true,
      data: { current: null, history: [] },
    });
  }

  try {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    // Latest snapshot
    const current = await env.DIAGNOSTICS_DB.prepare(`
      SELECT
        server_id, region, cpu_percent, memory_mb,
        connections_total, connections_relay, connections_signaling,
        active_codes, message_rate_per_sec, uptime_seconds, timestamp
      FROM server_metric_snapshots
      WHERE server_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).bind(serverId).first<{
      server_id: string;
      region: string;
      cpu_percent: number;
      memory_mb: number;
      connections_total: number;
      connections_relay: number;
      connections_signaling: number;
      active_codes: number;
      message_rate_per_sec: number;
      uptime_seconds: number;
      timestamp: number;
    }>();

    // H-3 fix: History bounded to last 7 days
    const historyResult = await env.DIAGNOSTICS_DB.prepare(`
      SELECT
        cpu_percent, memory_mb, connections_total,
        message_rate_per_sec, timestamp
      FROM server_metric_snapshots
      WHERE server_id = ? AND timestamp > ?
      ORDER BY timestamp ASC
      LIMIT 1000
    `).bind(serverId, sevenDaysAgo).all<{
      cpu_percent: number;
      memory_mb: number;
      connections_total: number;
      message_rate_per_sec: number;
      timestamp: number;
    }>();

    const currentData = current
      ? {
          serverId: current.server_id,
          region: current.region,
          health: determineHealthStatus(current.cpu_percent, current.memory_mb),
          cpu: current.cpu_percent,
          memoryMb: current.memory_mb,
          connections: {
            total: current.connections_total,
            relay: current.connections_relay,
            signaling: current.connections_signaling,
          },
          activeCodes: current.active_codes,
          messageRatePerSec: current.message_rate_per_sec,
          uptimeSeconds: current.uptime_seconds,
          timestamp: current.timestamp,
        }
      : null;

    return jsonResponse({
      success: true,
      data: {
        current: currentData,
        history: historyResult.results || [],
      },
    });
  } catch (error) {
    // H-1: Log detailed error, return generic message
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('Failed to query server metrics detail:', errMsg);
    return jsonResponse(
      { success: false, error: 'Failed to retrieve server metrics detail' },
      500
    );
  }
}

// ── Handler: App Performance Metrics ───────────────────────────────

/**
 * GET /admin/api/metrics/app
 *
 * Returns aggregated app performance metrics (startup time, frame rate, memory).
 *
 * H-2 fix: returns 200 with empty data when DIAGNOSTICS_DB is not bound.
 * H-1 fix: error responses use generic message.
 */
export async function handleAppMetrics(
  request: Request,
  env: Env
): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;

  // H-2: Graceful degradation
  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse({
      success: true,
      data: { metrics: [], range: '24h' },
    });
  }

  try {
    const url = new URL(request.url);
    const range = getRangeParam(url);
    const platform = url.searchParams.get('platform') || null;
    const rangeMs = rangeToMs(range)!;
    const since = Date.now() - rangeMs;

    let query = `
      SELECT
        time_bucket, platform, app_version, metric_name,
        p50, p95, p99, sample_count
      FROM performance_aggregates
      WHERE time_bucket > ?
    `;
    const params: unknown[] = [new Date(since).toISOString().slice(0, 13) + ':00:00'];

    if (platform) {
      query += ' AND platform = ?';
      params.push(platform);
    }

    query += ' ORDER BY time_bucket ASC LIMIT 1000';

    const stmt = env.DIAGNOSTICS_DB.prepare(query);
    const result = await stmt.bind(...params).all<{
      time_bucket: string;
      platform: string;
      app_version: string;
      metric_name: string;
      p50: number | null;
      p95: number | null;
      p99: number | null;
      sample_count: number;
    }>();

    return jsonResponse({
      success: true,
      data: {
        metrics: result.results || [],
        range,
      },
    });
  } catch (error) {
    // H-1: Log detailed error, return generic message
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('Failed to query app metrics:', errMsg);
    return jsonResponse(
      { success: false, error: 'Failed to retrieve app metrics' },
      500
    );
  }
}

// ── Handler: Network Metrics ───────────────────────────────────────

/**
 * GET /admin/api/metrics/network
 *
 * Returns aggregated network metrics (signaling, WebRTC, latency).
 *
 * H-2 fix: returns 200 with empty data when DIAGNOSTICS_DB is not bound.
 * H-1 fix: error responses use generic message.
 */
export async function handleNetworkMetrics(
  request: Request,
  env: Env
): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;

  // H-2: Graceful degradation
  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse({
      success: true,
      data: { metrics: [], range: '24h' },
    });
  }

  try {
    const url = new URL(request.url);
    const range = getRangeParam(url);
    const rangeMs = rangeToMs(range)!;
    const since = Date.now() - rangeMs;

    const result = await env.DIAGNOSTICS_DB.prepare(`
      SELECT
        time_bucket, platform, app_version,
        signaling_success_count, signaling_attempt_count,
        webrtc_success_count, webrtc_attempt_count,
        relay_usage_count, direct_usage_count,
        avg_latency_ms
      FROM network_aggregates
      WHERE time_bucket > ?
      ORDER BY time_bucket ASC
      LIMIT 1000
    `).bind(new Date(since).toISOString().slice(0, 13) + ':00:00').all<{
      time_bucket: string;
      platform: string;
      app_version: string;
      signaling_success_count: number;
      signaling_attempt_count: number;
      webrtc_success_count: number;
      webrtc_attempt_count: number;
      relay_usage_count: number;
      direct_usage_count: number;
      avg_latency_ms: number;
    }>();

    return jsonResponse({
      success: true,
      data: {
        metrics: result.results || [],
        range,
      },
    });
  } catch (error) {
    // H-1: Log detailed error, return generic message
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('Failed to query network metrics:', errMsg);
    return jsonResponse(
      { success: false, error: 'Failed to retrieve network metrics' },
      500
    );
  }
}

// ── Handler: Federation Health Metrics ─────────────────────────────

/**
 * GET /admin/api/metrics/federation
 *
 * Returns federation health data: latest per-server and historical trend.
 *
 * H-2 fix: returns 200 with empty data when DIAGNOSTICS_DB is not bound.
 * C-3 fix: both queries run in parallel via Promise.all().
 * H-4 fix: latest-per-server query includes time bound.
 * H-5 fix: '7d' is a valid range option.
 */
export async function handleFederationMetrics(
  request: Request,
  env: Env
): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;

  // H-2: Graceful degradation
  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse({
      success: true,
      data: { current: [], history: [], range: '24h' },
    });
  }

  try {
    const url = new URL(request.url);
    const range = getRangeParam(url);
    const rangeMs = rangeToMs(range)!;
    const since = Date.now() - rangeMs;

    // C-3 fix: Run both queries in parallel
    const [latestResult, historyResult] = await Promise.all([
      // H-4 fix: latest-per-server bounded by time window
      env.DIAGNOSTICS_DB.prepare(`
        SELECT
          server_id, alive_members, total_members,
          gossip_latency_ms, sync_completeness, timestamp
        FROM federation_metrics
        WHERE timestamp > ? AND id IN (
          SELECT MAX(id) FROM federation_metrics
          WHERE timestamp > ?
          GROUP BY server_id
        )
        LIMIT 500
      `).bind(since, since).all<{
        server_id: string;
        alive_members: number;
        total_members: number;
        gossip_latency_ms: number;
        sync_completeness: number;
        timestamp: number;
      }>(),

      env.DIAGNOSTICS_DB.prepare(`
        SELECT
          server_id, alive_members, total_members,
          gossip_latency_ms, sync_completeness, timestamp
        FROM federation_metrics
        WHERE timestamp > ?
        ORDER BY timestamp ASC
        LIMIT 1000
      `).bind(since).all<{
        server_id: string;
        alive_members: number;
        total_members: number;
        gossip_latency_ms: number;
        sync_completeness: number;
        timestamp: number;
      }>(),
    ]);

    return jsonResponse({
      success: true,
      data: {
        current: latestResult.results || [],
        history: historyResult.results || [],
        range,
      },
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('Failed to query federation metrics:', errMsg);
    return jsonResponse(
      { success: false, error: 'Failed to retrieve federation metrics' },
      500
    );
  }
}
