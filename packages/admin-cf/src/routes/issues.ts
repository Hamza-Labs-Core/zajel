/**
 * Issue lifecycle route handlers (US-6.3)
 *
 * Reads from the issue_tracking table in the shared DIAGNOSTICS_DB (D1)
 * to provide an admin dashboard for tracking AI-created issues from
 * detection to resolution.
 */

import type {
  Env,
  ApiResponse,
  IssueListEntry,
  IssueDetail,
  IssuesListData,
  IssueDetailData,
  IssueMetrics,
  AiAnalysisResult,
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

/**
 * Map a D1 row to an IssueListEntry.
 * D1 returns snake_case column names; we map to camelCase.
 */
function rowToIssueListEntry(row: Record<string, unknown>): IssueListEntry {
  return {
    id: row['id'] as number,
    errorSignature: row['error_signature'] as string,
    githubIssueNumber: (row['github_issue_number'] as number | null) ?? null,
    githubIssueUrl: (row['github_issue_url'] as string | null) ?? null,
    severity: row['severity'] as string,
    component: row['component'] as string,
    status: row['status'] as string,
    firstDetected: row['first_detected'] as number,
    lastDetected: row['last_detected'] as number,
    totalOccurrences: row['total_occurrences'] as number,
    createdAt: row['created_at'] as number,
    updatedAt: row['updated_at'] as number,
  };
}

/**
 * Map a D1 row to an IssueDetail (includes parsed ai_analysis JSON).
 */
function rowToIssueDetail(row: Record<string, unknown>): IssueDetail {
  const entry = rowToIssueListEntry(row);
  let aiAnalysis: AiAnalysisResult | null = null;

  const raw = row['ai_analysis'];
  if (raw && typeof raw === 'string') {
    try {
      aiAnalysis = JSON.parse(raw) as AiAnalysisResult;
    } catch {
      // Malformed JSON — leave as null
    }
  }

  return { ...entry, aiAnalysis };
}

// Valid status values for filtering
const VALID_STATUSES = new Set(['open', 'closed', 'acknowledged', 'pending', 'all']);
const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);

// ─── Handlers ───────────────────────────────────

/**
 * GET /admin/api/issues
 *
 * List issues with optional filtering by status and severity.
 * Returns paginated results plus aggregate metrics.
 */
export async function handleListIssues(
  request: Request,
  env: Env
): Promise<Response> {
  // Verify authentication
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  // When DIAGNOSTICS_DB is not bound, return empty data
  if (!env.DIAGNOSTICS_DB) {
    const emptyData: IssuesListData = {
      issues: [],
      total: 0,
      limit: 50,
      offset: 0,
      metrics: {
        avgTimeToDetectionMs: null,
        avgTimeToFixMs: null,
        openCount: 0,
        closedCount: 0,
      },
      lastUpdated: Date.now(),
    };
    return jsonResponse({ success: true, data: emptyData });
  }

  try {
    const url = new URL(request.url);
    const statusParam = url.searchParams.get('status') || 'all';
    const severityParam = url.searchParams.get('severity');
    const limitParam = url.searchParams.get('limit');
    const offsetParam = url.searchParams.get('offset');

    // Validate status
    if (!VALID_STATUSES.has(statusParam)) {
      return jsonResponse(
        { success: false, error: 'Invalid status filter. Must be one of: open, closed, acknowledged, all' },
        400
      );
    }

    // Validate severity
    if (severityParam && !VALID_SEVERITIES.has(severityParam)) {
      return jsonResponse(
        { success: false, error: 'Invalid severity filter. Must be one of: critical, high, medium, low' },
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

    if (statusParam !== 'all') {
      conditions.push('status = ?');
      params.push(statusParam);
    }

    if (severityParam) {
      conditions.push('severity = ?');
      params.push(severityParam);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    // Count total matching issues
    const countResult = await env.DIAGNOSTICS_DB.prepare(
      `SELECT COUNT(*) as total FROM issue_tracking ${whereClause}`
    ).bind(...params).first<{ total: number }>();

    const total = countResult?.total ?? 0;

    // Fetch paginated issues
    const issuesResult = await env.DIAGNOSTICS_DB.prepare(
      `SELECT id, error_signature, github_issue_number, github_issue_url,
              severity, component, status, first_detected, last_detected,
              total_occurrences, created_at, updated_at
       FROM issue_tracking ${whereClause}
       ORDER BY updated_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all();

    const issues: IssueListEntry[] = (issuesResult.results || []).map(
      (row) => rowToIssueListEntry(row as Record<string, unknown>)
    );

    // Compute metrics (scoped to last 90 days for performance)
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const metricsResult = await env.DIAGNOSTICS_DB.prepare(
      `SELECT
         SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_count,
         SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_count,
         AVG(CASE WHEN first_detected > 0 THEN created_at - first_detected ELSE NULL END) as avg_detection_ms,
         AVG(CASE WHEN status = 'closed' AND updated_at > first_detected THEN updated_at - first_detected ELSE NULL END) as avg_fix_ms
       FROM issue_tracking
       WHERE created_at > ?`
    ).bind(ninetyDaysAgo).first<{
      open_count: number;
      closed_count: number;
      avg_detection_ms: number | null;
      avg_fix_ms: number | null;
    }>();

    const metrics: IssueMetrics = {
      avgTimeToDetectionMs: metricsResult?.avg_detection_ms ?? null,
      avgTimeToFixMs: metricsResult?.avg_fix_ms ?? null,
      openCount: metricsResult?.open_count ?? 0,
      closedCount: metricsResult?.closed_count ?? 0,
    };

    const data: IssuesListData = {
      issues,
      total,
      limit,
      offset,
      metrics,
      lastUpdated: Date.now(),
    };

    return jsonResponse({ success: true, data });
  } catch (error) {
    console.error('Failed to list issues:', error);
    return jsonResponse(
      { success: false, error: 'Failed to retrieve issues' },
      500
    );
  }
}

/**
 * GET /admin/api/issues/:id
 *
 * Fetch a single issue by ID with full AI analysis.
 */
export async function handleIssueDetail(
  request: Request,
  env: Env,
  issueId: string
): Promise<Response> {
  // Verify authentication
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  // When DIAGNOSTICS_DB is not bound, return empty data
  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse(
      { success: true, data: { issue: null, lastUpdated: Date.now() } }
    );
  }

  try {
    const id = parseInt(issueId, 10);
    if (isNaN(id)) {
      return jsonResponse(
        { success: false, error: 'Invalid issue ID' },
        400
      );
    }

    const row = await env.DIAGNOSTICS_DB.prepare(
      `SELECT id, error_signature, github_issue_number, github_issue_url,
              severity, component, status, ai_analysis, first_detected,
              last_detected, total_occurrences, created_at, updated_at
       FROM issue_tracking WHERE id = ?`
    ).bind(id).first();

    if (!row) {
      return jsonResponse(
        { success: false, error: 'Issue not found' },
        404
      );
    }

    const issue = rowToIssueDetail(row as Record<string, unknown>);
    const data: IssueDetailData = {
      issue,
      lastUpdated: Date.now(),
    };

    return jsonResponse({ success: true, data });
  } catch (error) {
    console.error('Failed to fetch issue detail:', error);
    return jsonResponse(
      { success: false, error: 'Failed to retrieve issue' },
      500
    );
  }
}

/**
 * POST /admin/api/issues/:id/acknowledge
 *
 * Mark an issue as 'acknowledged'. Only valid for issues currently in 'open' status.
 */
export async function handleAcknowledgeIssue(
  request: Request,
  env: Env,
  issueId: string
): Promise<Response> {
  // Verify authentication
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  // When DIAGNOSTICS_DB is not bound, return empty data
  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse(
      { success: true, data: { issue: null, lastUpdated: Date.now() } }
    );
  }

  try {
    const id = parseInt(issueId, 10);
    if (isNaN(id)) {
      return jsonResponse(
        { success: false, error: 'Invalid issue ID' },
        400
      );
    }

    // Fetch current issue state
    const row = await env.DIAGNOSTICS_DB.prepare(
      `SELECT id, error_signature, github_issue_number, github_issue_url,
              severity, component, status, ai_analysis, first_detected,
              last_detected, total_occurrences, created_at, updated_at
       FROM issue_tracking WHERE id = ?`
    ).bind(id).first();

    if (!row) {
      return jsonResponse(
        { success: false, error: 'Issue not found' },
        404
      );
    }

    const currentStatus = (row as Record<string, unknown>)['status'] as string;

    if (currentStatus === 'acknowledged' || currentStatus === 'closed') {
      return jsonResponse(
        { success: false, error: `Issue is already ${currentStatus}` },
        409
      );
    }

    const now = Date.now();

    // Update status to acknowledged
    await env.DIAGNOSTICS_DB.prepare(
      `UPDATE issue_tracking SET status = 'acknowledged', updated_at = ? WHERE id = ?`
    ).bind(now, id).run();

    // Fetch updated row
    const updatedRow = await env.DIAGNOSTICS_DB.prepare(
      `SELECT id, error_signature, github_issue_number, github_issue_url,
              severity, component, status, ai_analysis, first_detected,
              last_detected, total_occurrences, created_at, updated_at
       FROM issue_tracking WHERE id = ?`
    ).bind(id).first();

    const issue = rowToIssueDetail(
      (updatedRow ?? row) as Record<string, unknown>
    );

    const data: IssueDetailData = {
      issue,
      lastUpdated: now,
    };

    return jsonResponse({ success: true, data });
  } catch (error) {
    console.error('Failed to acknowledge issue:', error);
    return jsonResponse(
      { success: false, error: 'Failed to acknowledge issue' },
      500
    );
  }
}
