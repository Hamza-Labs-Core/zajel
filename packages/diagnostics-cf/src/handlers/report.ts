/**
 * Diagnostic report submission handler.
 *
 * POST /diagnostics/report
 * Validates the report, applies rate limiting, stores raw report in R2,
 * and aggregates metrics into D1.
 */

import type { Env, DiagnosticReport } from '../types.js';
import { MAX_BODY_SIZE } from '../types.js';
import { getCorsHeaders } from '../cors.js';
import { validateReport } from '../validation.js';
import { checkSessionRateLimit } from '../rate-limit.js';
import { storeReport } from '../storage.js';
import {
  aggregateErrors,
  aggregatePerformance,
  aggregateNetwork,
  updateHeartbeat,
} from '../aggregation.js';

/**
 * JSON response helper.
 */
function jsonResponse(
  body: Record<string, unknown>,
  status: number,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(),
    },
  });
}

/**
 * Handle POST /diagnostics/report request.
 */
export async function handleReport(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Check Content-Type
  const contentType = request.headers.get('Content-Type');
  if (!contentType || !contentType.includes('application/json')) {
    return jsonResponse(
      { success: false, error: 'Content-Type must be application/json' },
      400,
    );
  }

  // Check body size via Content-Length header
  const contentLength = request.headers.get('Content-Length');
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    return jsonResponse(
      { success: false, error: `Request body exceeds maximum size of ${MAX_BODY_SIZE} bytes` },
      413,
    );
  }

  // Read and parse body with size limit
  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return jsonResponse(
      { success: false, error: 'Failed to read request body' },
      400,
    );
  }

  // Double-check actual body size
  if (new TextEncoder().encode(bodyText).length > MAX_BODY_SIZE) {
    return jsonResponse(
      { success: false, error: `Request body exceeds maximum size of ${MAX_BODY_SIZE} bytes` },
      413,
    );
  }

  // Parse JSON
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return jsonResponse(
      { success: false, error: 'Invalid JSON in request body' },
      400,
    );
  }

  // Validate schema
  const validation = validateReport(body);
  if (!validation.valid || !validation.report) {
    return jsonResponse(
      { success: false, error: validation.error ?? 'Invalid report schema' },
      400,
    );
  }

  const report: DiagnosticReport = validation.report;

  // Per-session rate limit (uses sessionHash from parsed body)
  const sessionLimit = await checkSessionRateLimit(env, report.sessionHash);
  if (!sessionLimit.allowed) {
    return jsonResponse(
      { success: false, error: sessionLimit.error ?? 'Rate limit exceeded' },
      429,
    );
  }

  // Store raw report in R2 and aggregate in D1.
  // Use waitUntil so we can return the response quickly.
  let reportKey: string;
  try {
    reportKey = await storeReport(env.REPORTS_BUCKET, report);
  } catch (err) {
    // R2 write failure is non-fatal -- still aggregate in D1
    console.error('R2 storage error:', err);
    reportKey = `diagnostics/error/${report.sessionHash}_${report.timestamp}.json`;
  }

  // Aggregate to D1 in the background (after response is sent)
  ctx.waitUntil(
    aggregateAll(env.DB, report).catch((err) => {
      console.error('D1 aggregation error:', err);
    }),
  );

  return jsonResponse(
    {
      success: true,
      data: { reportId: reportKey },
    },
    200,
  );
}

/**
 * Run all D1 aggregation operations.
 */
async function aggregateAll(
  db: D1Database,
  report: DiagnosticReport,
): Promise<void> {
  await Promise.all([
    aggregateErrors(db, report),
    aggregatePerformance(db, report),
    aggregateNetwork(db, report),
    updateHeartbeat(db, report),
  ]);
}
