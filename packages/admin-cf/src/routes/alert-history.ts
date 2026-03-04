/**
 * Alert History route handlers
 * Read and acknowledge alert history entries stored in D1 (DIAGNOSTICS_DB)
 */

import type {
  Env,
  ApiResponse,
  AlertHistoryRow,
  AlertHistoryEntry,
  AlertHistoryListData,
  AlertChannel,
} from '../types.js';
import { requireAuth } from './auth.js';

/**
 * Convert a D1 row to the API response format (camelCase)
 */
function toAlertHistoryEntry(row: AlertHistoryRow): AlertHistoryEntry {
  let channelsNotified: AlertChannel[] = [];
  try {
    channelsNotified = JSON.parse(row.channels_notified);
  } catch {
    channelsNotified = [];
  }
  return {
    id: row.id,
    ruleId: row.rule_id,
    triggeredAt: row.triggered_at,
    message: row.message,
    channelsNotified,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
  };
}

/**
 * List alert history entries
 * GET /admin/api/alerts/history
 */
export async function handleListAlertHistory(
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
      data: { entries: [], total: 0 } as AlertHistoryListData,
    });
  }

  try {
    const url = new URL(request.url);
    const ruleIdParam = url.searchParams.get('ruleId');
    const limitParam = url.searchParams.get('limit');
    const offsetParam = url.searchParams.get('offset');

    let limit = 50;
    if (limitParam) {
      const parsed = parseInt(limitParam, 10);
      if (!isNaN(parsed) && parsed >= 1 && parsed <= 200) {
        limit = parsed;
      }
    }

    let offset = 0;
    if (offsetParam) {
      const parsed = parseInt(offsetParam, 10);
      if (!isNaN(parsed) && parsed >= 0) {
        offset = parsed;
      }
    }

    let query: string;
    let countQuery: string;
    let params: unknown[];
    let countParams: unknown[];

    if (ruleIdParam) {
      const ruleId = parseInt(ruleIdParam, 10);
      if (isNaN(ruleId)) {
        return jsonResponse({ success: false, error: 'Invalid ruleId' }, 400);
      }
      query = 'SELECT * FROM alert_history WHERE rule_id = ? ORDER BY triggered_at DESC LIMIT ? OFFSET ?';
      params = [ruleId, limit, offset];
      countQuery = 'SELECT COUNT(*) as count FROM alert_history WHERE rule_id = ?';
      countParams = [ruleId];
    } else {
      query = 'SELECT * FROM alert_history ORDER BY triggered_at DESC LIMIT ? OFFSET ?';
      params = [limit, offset];
      countQuery = 'SELECT COUNT(*) as count FROM alert_history';
      countParams = [];
    }

    const [dataResult, countBatchResult] = await env.DIAGNOSTICS_DB.batch([
      env.DIAGNOSTICS_DB.prepare(query).bind(...params),
      env.DIAGNOSTICS_DB.prepare(countQuery).bind(...countParams),
    ]);
    const entries = ((dataResult as D1Result<AlertHistoryRow>).results || []).map(toAlertHistoryEntry);
    const total = ((countBatchResult as D1Result<{ count: number }>).results?.[0] as { count: number } | undefined)?.count ?? entries.length;

    return jsonResponse({
      success: true,
      data: { entries, total } as AlertHistoryListData,
    });
  } catch (error) {
    console.error('Failed to list alert history:', error);
    return jsonResponse(
      { success: false, error: 'Failed to list alert history' },
      500
    );
  }
}

/**
 * Acknowledge an alert history entry
 * POST /admin/api/alerts/history/:id/acknowledge
 */
export async function handleAcknowledgeAlert(
  request: Request,
  env: Env,
  historyId: string
): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse({ success: false, error: 'Alert history entry not found' }, 404);
  }

  const id = parseInt(historyId, 10);
  if (isNaN(id)) {
    return jsonResponse({ success: false, error: 'Invalid history entry ID' }, 400);
  }

  try {
    // Check if entry exists
    const existing = await env.DIAGNOSTICS_DB.prepare(
      'SELECT * FROM alert_history WHERE id = ? LIMIT 1'
    ).bind(id).first<AlertHistoryRow>();

    if (!existing) {
      return jsonResponse({ success: false, error: 'Alert history entry not found' }, 404);
    }

    // Check if already acknowledged
    if (existing.acknowledged_at) {
      return jsonResponse({ success: false, error: 'Alert already acknowledged' }, 409);
    }

    const now = Date.now();
    const [, selectResult] = await env.DIAGNOSTICS_DB.batch([
      env.DIAGNOSTICS_DB.prepare(
        'UPDATE alert_history SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ?'
      ).bind(now, authResult.username, id),
      env.DIAGNOSTICS_DB.prepare(
        'SELECT * FROM alert_history WHERE id = ? LIMIT 1'
      ).bind(id),
    ]);

    const updated = (selectResult as D1Result<AlertHistoryRow>).results?.[0] ?? null;
    if (!updated) {
      return jsonResponse(
        { success: false, error: 'Failed to acknowledge alert' },
        500
      );
    }

    return jsonResponse({
      success: true,
      data: toAlertHistoryEntry(updated),
    });
  } catch (error) {
    console.error('Failed to acknowledge alert:', error);
    return jsonResponse(
      { success: false, error: 'Failed to acknowledge alert' },
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
