/**
 * Server logs route handler
 * Queries the diagnostics D1 database for server log entries
 * with filtering by severity, time range, keyword search, and server ID.
 */

import type { Env, ApiResponse, ServerLogEntry, ServerLogsData } from '../types.js';
import { requireAuth } from './auth.js';

/** Valid severity levels */
const VALID_SEVERITIES = ['error', 'warn', 'info', 'debug'] as const;
type Severity = typeof VALID_SEVERITIES[number];

/** Valid time range options and their durations in milliseconds */
const VALID_RANGES: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

/** Maximum number of results per request */
const MAX_LIMIT = 500;

/** Default number of results per request */
const DEFAULT_LIMIT = 100;

/**
 * Handle GET /admin/api/logs
 * Returns paginated, filtered server log entries from the diagnostics D1 database.
 */
export async function handleServerLogs(
  request: Request,
  env: Env
): Promise<Response> {
  // Verify authentication
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  // Check if DIAGNOSTICS_DB is bound
  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse({
      success: true,
      data: {
        logs: [],
        total: 0,
        limit: DEFAULT_LIMIT,
        offset: 0,
        lastUpdated: Date.now(),
      },
    });
  }

  // Parse and validate query parameters
  const url = new URL(request.url);

  // Validate severity
  const severityParam = url.searchParams.get('severity');
  if (severityParam && !VALID_SEVERITIES.includes(severityParam as Severity)) {
    return jsonResponse({
      success: false,
      error: `Invalid severity: ${severityParam}. Must be one of: ${VALID_SEVERITIES.join(', ')}`,
    }, 400);
  }
  const severity = severityParam as Severity | null;

  // Validate range
  const rangeParam = url.searchParams.get('range') || '24h';
  if (!(rangeParam in VALID_RANGES)) {
    return jsonResponse({
      success: false,
      error: `Invalid range: ${rangeParam}. Must be one of: ${Object.keys(VALID_RANGES).join(', ')}`,
    }, 400);
  }
  const rangeMs = VALID_RANGES[rangeParam]!;

  // Validate limit
  const limitParam = url.searchParams.get('limit');
  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    limit = parseInt(limitParam, 10);
    if (isNaN(limit) || limit < 1) {
      return jsonResponse({
        success: false,
        error: 'Invalid limit: must be a positive integer',
      }, 400);
    }
    if (limit > MAX_LIMIT) {
      limit = MAX_LIMIT;
    }
  }

  // Validate offset
  const offsetParam = url.searchParams.get('offset');
  let offset = 0;
  if (offsetParam !== null) {
    offset = parseInt(offsetParam, 10);
    if (isNaN(offset) || offset < 0) {
      return jsonResponse({
        success: false,
        error: 'Invalid offset: must be a non-negative integer',
      }, 400);
    }
  }

  const search = url.searchParams.get('search');
  const serverId = url.searchParams.get('serverId');

  try {
    // Build the query dynamically
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    // Time range filter (always applied)
    const sinceTimestamp = Date.now() - rangeMs;
    conditions.push('timestamp >= ?');
    params.push(sinceTimestamp);

    // Severity filter
    if (severity) {
      conditions.push('severity = ?');
      params.push(severity);
    }

    // Server ID filter
    if (serverId) {
      conditions.push('server_id = ?');
      params.push(serverId);
    }

    // Keyword search (uses LIKE with bound parameter — SQL injection safe)
    if (search) {
      conditions.push('message LIKE ?');
      params.push(`%${search}%`);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM server_logs ${whereClause}`;
    const countResult = await env.DIAGNOSTICS_DB.prepare(countQuery)
      .bind(...params)
      .first<{ total: number }>();
    const total = countResult?.total ?? 0;

    // Get paginated results
    const dataQuery = `SELECT id, server_id, timestamp, severity, category, message, metadata FROM server_logs ${whereClause} ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
    const dataParams = [...params, limit, offset];
    const dataResult = await env.DIAGNOSTICS_DB.prepare(dataQuery)
      .bind(...dataParams)
      .all();

    // Map D1 rows to ServerLogEntry objects
    const logs: ServerLogEntry[] = (dataResult.results || []).map((row) => ({
      id: row['id'] as number,
      serverId: row['server_id'] as string,
      timestamp: row['timestamp'] as number,
      severity: row['severity'] as ServerLogEntry['severity'],
      category: row['category'] as string,
      message: row['message'] as string,
      metadata: row['metadata'] ? JSON.parse(row['metadata'] as string) : null,
    }));

    return jsonResponse({
      success: true,
      data: {
        logs,
        total,
        limit,
        offset,
        lastUpdated: Date.now(),
      },
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('Failed to query server logs:', errMsg);
    return jsonResponse({
      success: false,
      error: 'Failed to query server logs',
    }, 500);
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
