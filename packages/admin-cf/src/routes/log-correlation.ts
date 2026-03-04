/**
 * Log-Diagnostic Correlation route handler
 *
 * Provides a correlation view of server logs and client error aggregates
 * within the same time window, enabling side-by-side analysis.
 */

import type { Env, ApiResponse, LogCorrelationData, ClientErrorEntry, ServerLogEntry } from '../types.js';
import { requireAuth } from './auth.js';

/** Maximum allowed limit for query results */
const MAX_LIMIT = 500;
/** Default limit when not specified */
const DEFAULT_LIMIT = 100;
/** Maximum allowed time window in milliseconds (7 days) */
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Handle GET /admin/api/logs/correlation
 *
 * Query params:
 *   - startTime (required): Unix timestamp in milliseconds
 *   - endTime (required): Unix timestamp in milliseconds
 *   - serverId (optional): Filter to a specific server
 *   - limit (optional): 1-500, default 100
 */
export async function handleLogDiagnosticCorrelation(
  request: Request,
  env: Env
): Promise<Response> {
  // Verify authentication
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  // Parse query parameters
  const url = new URL(request.url);
  const startTimeParam = url.searchParams.get('startTime');
  const endTimeParam = url.searchParams.get('endTime');
  const serverId = url.searchParams.get('serverId');
  const limitParam = url.searchParams.get('limit');

  // Validate required params
  if (!startTimeParam || !endTimeParam) {
    return jsonResponse(
      { success: false, error: 'startTime and endTime query parameters are required' },
      400
    );
  }

  const startTime = Number(startTimeParam);
  const endTime = Number(endTimeParam);

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    return jsonResponse(
      { success: false, error: 'startTime and endTime must be valid numbers' },
      400
    );
  }

  if (startTime < 0 || endTime < 0) {
    return jsonResponse(
      { success: false, error: 'startTime and endTime must be non-negative' },
      400
    );
  }

  if (endTime <= startTime) {
    return jsonResponse(
      { success: false, error: 'endTime must be greater than startTime' },
      400
    );
  }

  if (endTime - startTime > MAX_WINDOW_MS) {
    return jsonResponse(
      { success: false, error: 'Time window must not exceed 7 days' },
      400
    );
  }

  // Validate limit
  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    limit = Number(limitParam);
    if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return jsonResponse(
        { success: false, error: `limit must be an integer between 1 and ${MAX_LIMIT}` },
        400
      );
    }
  }

  // If DIAGNOSTICS_DB is not bound, return empty data gracefully
  if (!env.DIAGNOSTICS_DB) {
    const emptyData: LogCorrelationData = {
      timeRange: { startTime, endTime },
      serverLogs: [],
      clientErrors: [],
      summary: {
        serverLogCount: 0,
        clientErrorCount: 0,
        overlappingCategories: [],
      },
      lastUpdated: Date.now(),
    };
    return jsonResponse({ success: true, data: emptyData });
  }

  try {
    // Build server logs query
    let serverLogsQuery: string;
    const serverLogsBindings: (string | number)[] = [startTime, endTime];

    if (serverId) {
      serverLogsQuery =
        'SELECT id, server_id, timestamp, severity, category, message FROM server_logs WHERE timestamp >= ? AND timestamp <= ? AND server_id = ? ORDER BY timestamp DESC LIMIT ?';
      serverLogsBindings.push(serverId, limit);
    } else {
      serverLogsQuery =
        'SELECT id, server_id, timestamp, severity, category, message FROM server_logs WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT ?';
      serverLogsBindings.push(limit);
    }

    // Build client errors query
    const clientErrorsQuery =
      'SELECT time_bucket, error_signature, category, count, app_version, platform, sample_message FROM error_aggregates WHERE time_bucket >= ? AND time_bucket <= ? ORDER BY time_bucket DESC LIMIT ?';

    // Convert unix ms timestamps to ISO strings for time_bucket comparison
    const startTimeIso = new Date(startTime).toISOString();
    const endTimeIso = new Date(endTime).toISOString();
    const clientErrorsBindings: (string | number)[] = [startTimeIso, endTimeIso, limit];

    // Execute both queries in a single batch for efficiency
    const [serverLogsResult, clientErrorsResult] = await env.DIAGNOSTICS_DB.batch([
      env.DIAGNOSTICS_DB.prepare(serverLogsQuery).bind(...serverLogsBindings),
      env.DIAGNOSTICS_DB.prepare(clientErrorsQuery).bind(...clientErrorsBindings),
    ]);

    // Map server logs results
    const serverLogs: LogCorrelationData['serverLogs'] = (serverLogsResult?.results ?? []).map((row) => ({
      id: row['id'] as number,
      serverId: row['server_id'] as string,
      timestamp: row['timestamp'] as number,
      severity: row['severity'] as ServerLogEntry['severity'],
      category: row['category'] as string,
      message: row['message'] as string,
    }));

    // Map client error results
    const clientErrors: ClientErrorEntry[] = (clientErrorsResult?.results ?? []).map((row) => ({
      timeBucket: row['time_bucket'] as string,
      errorSignature: row['error_signature'] as string,
      category: row['category'] as string,
      count: row['count'] as number,
      appVersion: row['app_version'] as string,
      platform: row['platform'] as string,
      sampleMessage: (row['sample_message'] as string | null) ?? null,
    }));

    // Compute overlapping categories
    const serverCategories = new Set(serverLogs.map((log) => log.category));
    const clientCategories = new Set(clientErrors.map((err) => err.category));
    const overlappingCategories = [...serverCategories].filter((cat) => clientCategories.has(cat));

    const data: LogCorrelationData = {
      timeRange: { startTime, endTime },
      serverLogs,
      clientErrors,
      summary: {
        serverLogCount: serverLogs.length,
        clientErrorCount: clientErrors.length,
        overlappingCategories,
      },
      lastUpdated: Date.now(),
    };

    return jsonResponse({ success: true, data });
  } catch (error) {
    console.error('Log correlation query failed:', error);
    return jsonResponse(
      { success: false, error: 'Failed to query diagnostic data' },
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
