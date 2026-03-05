/**
 * Notification route handlers (US-8.1)
 *
 * Reads from the notifications table in the shared DIAGNOSTICS_DB (D1)
 * to provide real-time dashboard notification management.
 */

import type {
  Env,
  ApiResponse,
  NotificationEntry,
  NotificationsListData,
} from '../types.js';
import { requireAuth } from './auth.js';

// ─── Helpers ────────────────────────────────────

function jsonResponse<T>(data: ApiResponse<T>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

const VALID_SEVERITIES = new Set(['info', 'warning', 'critical']);

/**
 * Map a D1 row to a NotificationEntry.
 * D1 returns snake_case column names; we map to camelCase.
 */
function rowToNotificationEntry(row: Record<string, unknown>): NotificationEntry {
  let channelsNotified: string[] | null = null;
  const rawChannels = row['channels_notified'];
  if (rawChannels && typeof rawChannels === 'string') {
    try {
      channelsNotified = JSON.parse(rawChannels) as string[];
    } catch {
      // Malformed JSON -- leave as null
    }
  }

  return {
    id: row['id'] as number,
    ruleId: (row['rule_id'] as number | null) ?? null,
    severity: row['severity'] as 'info' | 'warning' | 'critical',
    title: row['title'] as string,
    message: row['message'] as string,
    source: row['source'] as string,
    channelsNotified,
    createdAt: row['created_at'] as number,
    readAt: (row['read_at'] as number | null) ?? null,
    readBy: (row['read_by'] as string | null) ?? null,
    acknowledgedAt: (row['acknowledged_at'] as number | null) ?? null,
    acknowledgedBy: (row['acknowledged_by'] as string | null) ?? null,
  };
}

// ─── Handlers ───────────────────────────────────

/**
 * GET /admin/api/notifications
 *
 * List notifications with optional filtering by severity and read status.
 * Returns paginated results ordered by created_at DESC.
 */
export async function handleListNotifications(
  request: Request,
  env: Env
): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  if (!env.DIAGNOSTICS_DB) {
    const emptyData: NotificationsListData = {
      notifications: [],
      total: 0,
      limit: 50,
      offset: 0,
      lastUpdated: Date.now(),
    };
    return jsonResponse({ success: true, data: emptyData });
  }

  try {
    const url = new URL(request.url);
    const severityParam = url.searchParams.get('severity');
    const unreadOnlyParam = url.searchParams.get('unreadOnly');
    const limitParam = url.searchParams.get('limit');
    const offsetParam = url.searchParams.get('offset');

    // Validate severity
    if (severityParam && !VALID_SEVERITIES.has(severityParam)) {
      return jsonResponse(
        { success: false, error: 'Invalid severity filter. Must be one of: info, warning, critical' },
        400
      );
    }

    // Parse and validate limit
    let limit = 50;
    if (limitParam !== null) {
      limit = parseInt(limitParam, 10);
      if (isNaN(limit) || limit < 1 || limit > 200) {
        return jsonResponse(
          { success: false, error: 'Invalid limit. Must be between 1 and 200' },
          400
        );
      }
    }

    // Parse and validate offset
    let offset = 0;
    if (offsetParam !== null) {
      offset = parseInt(offsetParam, 10);
      if (isNaN(offset) || offset < 0) {
        return jsonResponse(
          { success: false, error: 'Invalid offset. Must be a non-negative integer' },
          400
        );
      }
    }

    // Build parameterized query
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (severityParam) {
      conditions.push('severity = ?');
      params.push(severityParam);
    }

    if (unreadOnlyParam === 'true') {
      conditions.push('read_at IS NULL');
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    // Count + paginated data in a single batch roundtrip
    const [countBatchResult, dataBatchResult] = await env.DIAGNOSTICS_DB.batch([
      env.DIAGNOSTICS_DB.prepare(
        `SELECT COUNT(*) as total FROM notifications ${whereClause}`
      ).bind(...params),
      env.DIAGNOSTICS_DB.prepare(
        `SELECT id, rule_id, severity, title, message, source, channels_notified,
                created_at, read_at, read_by, acknowledged_at, acknowledged_by
         FROM notifications ${whereClause}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      ).bind(...params, limit, offset),
    ]);

    const total = ((countBatchResult as D1Result<{ total: number }>).results?.[0] as { total: number } | undefined)?.total ?? 0;
    const notifications: NotificationEntry[] = ((dataBatchResult as D1Result).results || []).map(
      (row) => rowToNotificationEntry(row as Record<string, unknown>)
    );

    const data: NotificationsListData = {
      notifications,
      total,
      limit,
      offset,
      lastUpdated: Date.now(),
    };

    return jsonResponse({ success: true, data });
  } catch (error) {
    console.error('Failed to list notifications:', error);
    return jsonResponse(
      { success: false, error: 'Failed to retrieve notifications' },
      500
    );
  }
}

/**
 * GET /admin/api/notifications/unread-count
 *
 * Returns the count of unread notifications.
 */
export async function handleUnreadCount(
  request: Request,
  env: Env
): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse({ success: true, data: { count: 0 } });
  }

  try {
    const result = await env.DIAGNOSTICS_DB.prepare(
      `SELECT COUNT(*) as count FROM notifications WHERE read_at IS NULL`
    ).first<{ count: number }>();

    return jsonResponse({ success: true, data: { count: result?.count ?? 0 } });
  } catch (error) {
    console.error('Failed to get unread count:', error);
    return jsonResponse(
      { success: false, error: 'Failed to retrieve unread count' },
      500
    );
  }
}

/**
 * POST /admin/api/notifications/:id/read
 *
 * Mark a single notification as read.
 */
export async function handleMarkRead(
  request: Request,
  env: Env,
  notificationId: string
): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse(
      { success: true, data: { notification: null, lastUpdated: Date.now() } }
    );
  }

  try {
    const id = parseInt(notificationId, 10);
    if (isNaN(id)) {
      return jsonResponse(
        { success: false, error: 'Invalid notification ID' },
        400
      );
    }

    // Check if the notification exists
    const existing = await env.DIAGNOSTICS_DB.prepare(
      `SELECT id, rule_id, severity, title, message, source, channels_notified,
              created_at, read_at, read_by, acknowledged_at, acknowledged_by
       FROM notifications WHERE id = ?`
    ).bind(id).first();

    if (!existing) {
      return jsonResponse(
        { success: false, error: 'Notification not found' },
        404
      );
    }

    // Already read — return as-is
    const existingEntry = rowToNotificationEntry(existing as Record<string, unknown>);
    if (existingEntry.readAt !== null) {
      return jsonResponse({
        success: true,
        data: { notification: existingEntry, lastUpdated: Date.now() },
      });
    }

    const now = Date.now();
    const username = authResult.username;

    // Batch update + re-fetch in single roundtrip
    const [, selectResult] = await env.DIAGNOSTICS_DB.batch([
      env.DIAGNOSTICS_DB.prepare(
        `UPDATE notifications SET read_at = ?, read_by = ? WHERE id = ? AND read_at IS NULL`
      ).bind(now, username, id),
      env.DIAGNOSTICS_DB.prepare(
        `SELECT id, rule_id, severity, title, message, source, channels_notified,
                created_at, read_at, read_by, acknowledged_at, acknowledged_by
         FROM notifications WHERE id = ?`
      ).bind(id),
    ]);

    const updatedRow = (selectResult as D1Result).results?.[0] ?? null;
    const notification = rowToNotificationEntry(
      (updatedRow ?? existing) as Record<string, unknown>
    );

    return jsonResponse({
      success: true,
      data: { notification, lastUpdated: now },
    });
  } catch (error) {
    console.error('Failed to mark notification as read:', error);
    return jsonResponse(
      { success: false, error: 'Failed to mark notification as read' },
      500
    );
  }
}

/**
 * POST /admin/api/notifications/read-all
 *
 * Mark all unread notifications as read.
 */
export async function handleMarkAllRead(
  request: Request,
  env: Env
): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse({ success: true, data: { updated: 0, lastUpdated: Date.now() } });
  }

  try {
    const now = Date.now();
    const username = authResult.username;

    const result = await env.DIAGNOSTICS_DB.prepare(
      `UPDATE notifications SET read_at = ?, read_by = ? WHERE read_at IS NULL`
    ).bind(now, username).run();

    return jsonResponse({
      success: true,
      data: {
        updated: result.meta?.changes ?? 0,
        lastUpdated: now,
      },
    });
  } catch (error) {
    console.error('Failed to mark all notifications as read:', error);
    return jsonResponse(
      { success: false, error: 'Failed to mark all notifications as read' },
      500
    );
  }
}
