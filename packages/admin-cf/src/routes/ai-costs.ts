/**
 * AI Cost Monitoring route handler (US-6.5)
 *
 * Reads processing_runs from the shared DIAGNOSTICS_DB (D1)
 * and returns summary totals, daily breakdown, and recent runs.
 */

import type {
  Env,
  ApiResponse,
  AiCostsData,
  AiCostSummary,
  AiCostDailyBreakdown,
  AiCostRecentRun,
} from '../types.js';
import { requireAuth } from './auth.js';

/** Cost per token in USD (Workers AI Llama 3.1 8B blend estimate) */
const COST_PER_1K_TOKENS = 0.011;

/** Valid range values */
const VALID_RANGES = ['24h', '7d', '30d'] as const;
type Range = (typeof VALID_RANGES)[number];

/** Map range strings to millisecond offsets */
const RANGE_MS: Record<Range, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/**
 * GET /admin/api/ai/costs
 *
 * Query params:
 *   range — '24h' | '7d' | '30d' (default '7d')
 */
export async function handleAiCosts(
  request: Request,
  env: Env
): Promise<Response> {
  // 1. Auth check
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  // 2. Validate range param
  const url = new URL(request.url);
  const rangeParam = url.searchParams.get('range') || '7d';
  if (!VALID_RANGES.includes(rangeParam as Range)) {
    return jsonResponse(
      { success: false, error: `Invalid range. Must be one of: ${VALID_RANGES.join(', ')}` },
      400
    );
  }
  const range = rangeParam as Range;

  // 3. If no DIAGNOSTICS_DB, return 200 with empty data
  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse({
      success: true,
      data: emptyResponse(range),
    });
  }

  try {
    const cutoff = Date.now() - RANGE_MS[range];

    // 4. Run all three queries in parallel
    const [summaryResult, dailyResult, recentResult] = await Promise.all([
      env.DIAGNOSTICS_DB.prepare(`
        SELECT
          COUNT(*) as total_runs,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_runs,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_runs,
          SUM(errors_processed) as total_errors_processed,
          SUM(issues_created) as total_issues_created,
          SUM(issues_updated) as total_issues_updated,
          SUM(ai_calls_made) as total_ai_calls,
          SUM(ai_tokens_used) as total_tokens_used
        FROM processing_runs
        WHERE run_start > ?1
      `).bind(cutoff).all(),

      env.DIAGNOSTICS_DB.prepare(`
        SELECT
          (run_start / 86400000) * 86400000 as day_bucket,
          COUNT(*) as runs,
          SUM(errors_processed) as errors_processed,
          SUM(issues_created) as issues_created,
          SUM(ai_calls_made) as ai_calls,
          SUM(ai_tokens_used) as tokens_used
        FROM processing_runs
        WHERE run_start > ?1
        GROUP BY day_bucket
        ORDER BY day_bucket ASC
      `).bind(cutoff).all(),

      env.DIAGNOSTICS_DB.prepare(`
        SELECT id, run_start, run_end, errors_processed, issues_created,
               issues_updated, ai_calls_made, ai_tokens_used, status
        FROM processing_runs
        WHERE run_start > ?1
        ORDER BY run_start DESC
        LIMIT 20
      `).bind(cutoff).all(),
    ]);

    // 5. Build summary
    const row = summaryResult.results[0] as Record<string, number | null> | undefined;
    const totalTokensUsed = Number(row?.total_tokens_used ?? 0);
    const summary: AiCostSummary = {
      totalRuns: Number(row?.total_runs ?? 0),
      successfulRuns: Number(row?.successful_runs ?? 0),
      failedRuns: Number(row?.failed_runs ?? 0),
      totalErrorsProcessed: Number(row?.total_errors_processed ?? 0),
      totalIssuesCreated: Number(row?.total_issues_created ?? 0),
      totalIssuesUpdated: Number(row?.total_issues_updated ?? 0),
      totalAiCalls: Number(row?.total_ai_calls ?? 0),
      totalTokensUsed,
      estimatedCostUsd: roundCost(totalTokensUsed * COST_PER_1K_TOKENS / 1000),
    };

    // 6. Build daily breakdown
    const dailyBreakdown: AiCostDailyBreakdown[] = dailyResult.results.map(
      (r: Record<string, unknown>) => {
        const tokens = Number(r.tokens_used ?? 0);
        return {
          date: new Date(Number(r.day_bucket)).toISOString().split('T')[0],
          runs: Number(r.runs ?? 0),
          errorsProcessed: Number(r.errors_processed ?? 0),
          issuesCreated: Number(r.issues_created ?? 0),
          aiCalls: Number(r.ai_calls ?? 0),
          tokensUsed: tokens,
          estimatedCostUsd: roundCost(tokens * COST_PER_1K_TOKENS / 1000),
        };
      }
    );

    // 7. Build recent runs
    const recentRuns: AiCostRecentRun[] = recentResult.results.map(
      (r: Record<string, unknown>) => {
        const runStart = Number(r.run_start);
        const runEnd = Number(r.run_end);
        return {
          id: Number(r.id),
          runStart,
          runEnd,
          durationMs: runEnd - runStart,
          errorsProcessed: Number(r.errors_processed ?? 0),
          issuesCreated: Number(r.issues_created ?? 0),
          issuesUpdated: Number(r.issues_updated ?? 0),
          aiCalls: Number(r.ai_calls_made ?? 0),
          tokensUsed: Number(r.ai_tokens_used ?? 0),
          status: String(r.status ?? 'unknown'),
        };
      }
    );

    const data: AiCostsData = {
      range,
      summary,
      dailyBreakdown,
      recentRuns,
      lastUpdated: Date.now(),
    };

    return jsonResponse({ success: true, data });
  } catch (error) {
    console.error('Failed to fetch AI costs:', error);
    return jsonResponse(
      { success: false, error: 'Failed to fetch AI cost data' },
      500
    );
  }
}

// ─── Helpers ───────────────────────────────────

function emptyResponse(range: string): AiCostsData {
  return {
    range,
    summary: {
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      totalErrorsProcessed: 0,
      totalIssuesCreated: 0,
      totalIssuesUpdated: 0,
      totalAiCalls: 0,
      totalTokensUsed: 0,
      estimatedCostUsd: 0,
    },
    dailyBreakdown: [],
    recentRuns: [],
    lastUpdated: Date.now(),
  };
}

/** Round cost to 6 decimal places to avoid floating-point noise */
function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function jsonResponse<T>(data: ApiResponse<T>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
