/**
 * Heartbeat Timeline route handler (US-5.4)
 *
 * Queries server_metrics D1 table for heartbeat timestamps,
 * computes timeline segments per server, and highlights gaps.
 *
 * Thresholds:
 *   - 'ok':      consecutive heartbeats within 5 minutes
 *   - 'gap':     missing heartbeats >5 min but <30 min
 *   - 'offline': server completely gone >30 min
 */

import type {
  Env,
  ApiResponse,
  HeartbeatSegment,
  ServerHeartbeatTimeline,
  HeartbeatTimelineData,
} from '../types.js';
import { requireAuth } from './auth.js';

/** Gap thresholds in milliseconds */
const GAP_THRESHOLD_MS = 5 * 60 * 1000;     // 5 minutes
const OFFLINE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/** Valid time range values and their durations in milliseconds */
const VALID_RANGES: Record<string, number> = {
  '1h': 1 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

/**
 * Row returned from the server_metrics D1 query
 */
interface MetricsRow {
  server_id: string;
  region: string;
  timestamp: number;
}

/**
 * Compute timeline segments from a sorted list of heartbeat timestamps.
 *
 * Each pair of consecutive heartbeats forms a segment whose status
 * depends on the time gap between them.
 */
export function computeSegments(timestamps: number[]): HeartbeatSegment[] {
  if (timestamps.length < 2) {
    return [];
  }

  const segments: HeartbeatSegment[] = [];

  for (let i = 0; i < timestamps.length - 1; i++) {
    const start = timestamps[i]!;
    const end = timestamps[i + 1]!;
    const delta = end - start;

    let status: HeartbeatSegment['status'];
    if (delta <= GAP_THRESHOLD_MS) {
      status = 'ok';
    } else if (delta <= OFFLINE_THRESHOLD_MS) {
      status = 'gap';
    } else {
      status = 'offline';
    }

    segments.push({ startTime: start, endTime: end, status });
  }

  return segments;
}

/**
 * Compute per-server summary statistics from segments.
 */
export function computeSummary(segments: HeartbeatSegment[]): {
  uptimePercent: number;
  gapCount: number;
  longestGapMs: number;
} {
  if (segments.length === 0) {
    return { uptimePercent: 100, gapCount: 0, longestGapMs: 0 };
  }

  let totalMs = 0;
  let okMs = 0;
  let gapCount = 0;
  let longestGapMs = 0;

  for (const seg of segments) {
    const duration = seg.endTime - seg.startTime;
    totalMs += duration;

    if (seg.status === 'ok') {
      okMs += duration;
    } else {
      gapCount++;
      if (duration > longestGapMs) {
        longestGapMs = duration;
      }
    }
  }

  const uptimePercent = totalMs > 0
    ? Math.round((okMs / totalMs) * 10000) / 100
    : 100;

  return { uptimePercent, gapCount, longestGapMs };
}

/**
 * GET /admin/api/servers/heartbeat-timeline
 *
 * Query parameters:
 *   range    — '1h' | '6h' | '24h' | '7d' (default: '24h')
 *   serverId — optional filter for a single server
 */
export async function handleHeartbeatTimeline(
  request: Request,
  env: Env
): Promise<Response> {
  // Verify authentication
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  // Check for DIAGNOSTICS_DB binding
  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse({
      success: true,
      data: {
        servers: [],
        range: '24h',
        lastUpdated: Date.now(),
      },
    });
  }

  // Parse and validate query parameters
  const url = new URL(request.url);
  const range = url.searchParams.get('range') || '24h';
  const serverId = url.searchParams.get('serverId') || null;

  if (!VALID_RANGES[range]) {
    return jsonResponse(
      { success: false, error: `Invalid range: ${range}. Must be one of: ${Object.keys(VALID_RANGES).join(', ')}` },
      400
    );
  }

  const rangeDuration = VALID_RANGES[range]!;
  const now = Date.now();
  const rangeStart = now - rangeDuration;

  try {
    // Build query
    let query: string;
    let params: unknown[];

    if (serverId) {
      query = `SELECT server_id, region, timestamp FROM server_metrics WHERE timestamp >= ? AND server_id = ? ORDER BY server_id, timestamp ASC LIMIT 50000`;
      params = [rangeStart, serverId];
    } else {
      query = `SELECT server_id, region, timestamp FROM server_metrics WHERE timestamp >= ? ORDER BY server_id, timestamp ASC LIMIT 50000`;
      params = [rangeStart];
    }

    const result = await env.DIAGNOSTICS_DB.prepare(query)
      .bind(...params)
      .all<MetricsRow>();

    // Group rows by server_id
    const serverMap = new Map<string, { region: string; timestamps: number[] }>();

    for (const row of result.results) {
      let entry = serverMap.get(row.server_id);
      if (!entry) {
        entry = { region: row.region, timestamps: [] };
        serverMap.set(row.server_id, entry);
      }
      entry.timestamps.push(row.timestamp);
    }

    // Build timelines
    const servers: ServerHeartbeatTimeline[] = [];

    for (const [id, data] of serverMap) {
      const segments = computeSegments(data.timestamps);
      const summary = computeSummary(segments);

      servers.push({
        serverId: id,
        region: data.region,
        segments,
        ...summary,
      });
    }

    // Sort by serverId for stable output
    servers.sort((a, b) => a.serverId.localeCompare(b.serverId));

    const responseData: HeartbeatTimelineData = {
      servers,
      range,
      lastUpdated: Date.now(),
    };

    return jsonResponse({ success: true, data: responseData });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('Heartbeat timeline query failed:', errMsg);
    return jsonResponse(
      { success: false, error: 'Failed to query heartbeat data' },
      500
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
