/**
 * Per-server health status route handler (US-5.1)
 *
 * Queries the DIAGNOSTICS_DB (D1) for server_metrics rows and returns
 * per-server health cards with color-coded status and computed health scores.
 */

import type { Env, ServerHealthCard, ServersHealthData, ApiResponse } from '../types.js';
import { requireAuth } from './auth.js';

/**
 * Threshold in milliseconds for classifying server status.
 * - healthy:  lastSeen within the last 2 minutes
 * - degraded: lastSeen within the last 5 minutes
 * - offline:  lastSeen more than 5 minutes ago
 */
const HEALTHY_TTL = 2 * 60 * 1000;
const DEGRADED_TTL = 5 * 60 * 1000;

/**
 * Compute a health score (0-100) from CPU, memory, and connectivity.
 *
 * Weights:
 *  - CPU:          40 points (lower is better; 100% CPU = 0 points)
 *  - Memory:       30 points (lower is better; >= 2048 MB = 0 points)
 *  - Connectivity: 30 points (based on whether connections are present)
 */
export function computeHealthScore(
  cpuPercent: number,
  memoryMb: number,
  connectionsTotal: number,
): number {
  // CPU score: 0% -> 40 points, 100% -> 0 points
  const cpuScore = Math.max(0, 40 * (1 - Math.min(cpuPercent, 100) / 100));

  // Memory score: 0 MB -> 30 points, >= 2048 MB -> 0 points
  const memoryScore = Math.max(0, 30 * (1 - Math.min(memoryMb, 2048) / 2048));

  // Connectivity score: >0 connections = 30 points, 0 connections = 15 points
  // (a server with 0 connections isn't necessarily unhealthy — it may just be idle)
  const connectivityScore = connectionsTotal > 0 ? 30 : 15;

  return Math.round(cpuScore + memoryScore + connectivityScore);
}

/**
 * Classify server status based on when it was last seen.
 */
export function classifyStatus(
  lastSeen: number,
  now: number,
): 'healthy' | 'degraded' | 'offline' {
  const age = now - lastSeen;
  if (age <= HEALTHY_TTL) return 'healthy';
  if (age <= DEGRADED_TTL) return 'degraded';
  return 'offline';
}

/**
 * Row shape returned from the D1 server_metrics table.
 * Columns must match migrations/0002_server_metrics.sql.
 */
interface ServerMetricsRow {
  server_id: string;
  region: string;
  timestamp: number;
  cpu_percent: number;
  memory_mb: number;
  connections_total: number;
  uptime_seconds: number;
}

/**
 * GET /admin/api/servers/health
 *
 * Returns per-server health cards with status, key metrics, and health score.
 * Requires authentication.
 */
export async function handleServersHealth(
  request: Request,
  env: Env,
): Promise<Response> {
  // Verify authentication
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  // Handle missing DIAGNOSTICS_DB gracefully
  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse({
      success: true,
      data: {
        servers: [],
        lastUpdated: Date.now(),
      },
    });
  }

  try {
    const now = Date.now();

    const tenMinutesAgo = now - 10 * 60 * 1000;

    const result = await env.DIAGNOSTICS_DB.prepare(
      `SELECT sm.server_id, sm.region, sm.timestamp,
              sm.cpu_percent, sm.memory_mb, sm.connections_total, sm.uptime_seconds
       FROM server_metrics sm
       INNER JOIN (
         SELECT server_id, MAX(timestamp) as max_ts
         FROM server_metrics
         WHERE timestamp >= ?
         GROUP BY server_id
       ) latest ON sm.server_id = latest.server_id AND sm.timestamp = latest.max_ts
       ORDER BY sm.region, sm.server_id`,
    ).bind(tenMinutesAgo).all<ServerMetricsRow>();

    const rows = result.results ?? [];

    const servers: ServerHealthCard[] = rows.map((row) => {
      const lastSeen = row.timestamp;
      const cpuPercent = row.cpu_percent ?? 0;
      const memoryMb = row.memory_mb ?? 0;
      const connectionsTotal = row.connections_total ?? 0;
      const uptimeSeconds = row.uptime_seconds ?? 0;

      return {
        serverId: row.server_id,
        region: row.region ?? 'unknown',
        endpoint: '',
        status: classifyStatus(lastSeen, now),
        lastSeen,
        cpuPercent,
        memoryMb,
        connectionsTotal,
        uptimeSeconds,
        healthScore: computeHealthScore(cpuPercent, memoryMb, connectionsTotal),
      };
    });

    const data: ServersHealthData = {
      servers,
      lastUpdated: now,
    };

    return jsonResponse({ success: true, data });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('Failed to fetch server health data:', errMsg);
    return jsonResponse(
      { success: false, error: 'Failed to fetch server health data' },
      500,
    );
  }
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
