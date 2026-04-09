/**
 * Deduplication logic for error signature tracking.
 *
 * Checks the D1 issue_tracking table to determine if an error signature
 * has already been reported as a GitHub issue, and whether it should be
 * updated, reopened, or treated as new.
 */

import type { Env, ErrorCluster, DedupResult } from './types.js';
import { REOPEN_THRESHOLD, MAX_RETRY_COUNT } from './types.js';

/**
 * Check whether an error cluster is a duplicate of an existing tracked issue.
 *
 * Logic:
 * - If found in D1 with status 'open': it's a duplicate (update existing).
 * - If found in D1 with status 'closed' and cluster has significant new
 *   occurrences (>= REOPEN_THRESHOLD): not a duplicate (will reopen or create new).
 * - If found in D1 with status 'closed' and below threshold: treat as duplicate
 *   (skip — already handled).
 * - If not found: not a duplicate (create new).
 */
export async function checkDuplicate(
  env: Env,
  cluster: ErrorCluster,
): Promise<DedupResult> {
  try {
    const row = await env.DB.prepare(
      'SELECT github_issue_number, status, total_occurrences FROM issue_tracking WHERE error_signature = ?',
    )
      .bind(cluster.errorSignature)
      .first<{
        github_issue_number: number | null;
        status: string;
        total_occurrences: number;
      }>();

    if (!row) {
      // Brand new signature — not a duplicate
      return { isDuplicate: false };
    }

    if (row.status === 'open') {
      // Already tracked and open — it's a duplicate
      return {
        isDuplicate: true,
        existingIssueNumber: row.github_issue_number ?? undefined,
        existingStatus: row.status,
      };
    }

    // Status is 'closed' — check if new occurrences warrant reopening
    const newOccurrences = cluster.totalCount - row.total_occurrences;

    if (newOccurrences >= REOPEN_THRESHOLD) {
      // Significant new activity — treat as not duplicate so it gets reopened
      return {
        isDuplicate: false,
        existingIssueNumber: row.github_issue_number ?? undefined,
        existingStatus: row.status,
      };
    }

    // Closed and not enough new activity — treat as duplicate (skip)
    return {
      isDuplicate: true,
      existingIssueNumber: row.github_issue_number ?? undefined,
      existingStatus: row.status,
    };
  } catch (error) {
    console.error('Deduplication check failed:', error);
    // On error, assume not a duplicate (fail open — better to create than miss)
    return { isDuplicate: false };
  }
}

/**
 * Record or update a tracked issue in the issue_tracking table.
 */
export async function recordIssue(
  env: Env,
  cluster: ErrorCluster,
  issueNumber: number | null,
  issueUrl: string | null,
  severity: string,
  component: string,
  aiAnalysisJson: string | null,
  status: string,
): Promise<void> {
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO issue_tracking
       (error_signature, github_issue_number, github_issue_url, severity, component,
        status, ai_analysis, first_detected, last_detected, total_occurrences,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(error_signature) DO UPDATE SET
       github_issue_number = COALESCE(excluded.github_issue_number, issue_tracking.github_issue_number),
       github_issue_url = COALESCE(excluded.github_issue_url, issue_tracking.github_issue_url),
       severity = excluded.severity,
       component = excluded.component,
       status = excluded.status,
       ai_analysis = COALESCE(excluded.ai_analysis, issue_tracking.ai_analysis),
       last_detected = excluded.last_detected,
       total_occurrences = excluded.total_occurrences,
       updated_at = excluded.updated_at`,
  )
    .bind(
      cluster.errorSignature,
      issueNumber,
      issueUrl,
      severity,
      component,
      status,
      aiAnalysisJson,
      cluster.firstSeen,
      cluster.lastSeen,
      cluster.totalCount,
      now,
      now,
    )
    .run();
}

/**
 * Update the status of an existing tracked issue (e.g., when reopened).
 */
export async function updateIssueStatus(
  env: Env,
  errorSignature: string,
  status: string,
  totalOccurrences: number,
  lastDetected: number,
): Promise<void> {
  const now = Date.now();

  await env.DB.prepare(
    `UPDATE issue_tracking
     SET status = ?, total_occurrences = ?, last_detected = ?, updated_at = ?
     WHERE error_signature = ?`,
  )
    .bind(status, totalOccurrences, lastDetected, now, errorSignature)
    .run();
}

/**
 * Pending issue row returned from the retry queue query.
 */
export interface PendingIssueRow {
  error_signature: string;
  severity: string;
  component: string;
  ai_analysis: string | null;
  retry_count: number;
  total_occurrences: number;
  first_detected: number;
  last_detected: number;
}

/**
 * Query pending issues that failed to create on GitHub in previous runs.
 * Returns rows with status = 'pending' and retry_count < MAX_RETRY_COUNT.
 */
export async function getPendingIssues(env: Env): Promise<PendingIssueRow[]> {
  try {
    const result = await env.DB.prepare(
      `SELECT error_signature, severity, component, ai_analysis,
              COALESCE(retry_count, 0) as retry_count,
              total_occurrences, first_detected, last_detected
       FROM issue_tracking
       WHERE status = 'pending'
         AND COALESCE(retry_count, 0) < ?
       ORDER BY last_detected DESC
       LIMIT 10`,
    )
      .bind(MAX_RETRY_COUNT)
      .all<PendingIssueRow>();

    return result.success ? (result.results ?? []) : [];
  } catch (error) {
    console.error('Failed to query pending issues:', error);
    return [];
  }
}

/**
 * Increment the retry count for a pending issue.
 */
export async function incrementRetryCount(
  env: Env,
  errorSignature: string,
): Promise<void> {
  const now = Date.now();

  await env.DB.prepare(
    `UPDATE issue_tracking
     SET retry_count = COALESCE(retry_count, 0) + 1, updated_at = ?
     WHERE error_signature = ?`,
  )
    .bind(now, errorSignature)
    .run();
}

/**
 * Mark a pending issue as failed (exceeded max retries).
 */
export async function markIssueFailed(
  env: Env,
  errorSignature: string,
): Promise<void> {
  const now = Date.now();

  await env.DB.prepare(
    `UPDATE issue_tracking
     SET status = 'failed', updated_at = ?
     WHERE error_signature = ?`,
  )
    .bind(now, errorSignature)
    .run();
}

/**
 * Update a pending issue to open after successful GitHub creation.
 */
export async function updatePendingToOpen(
  env: Env,
  errorSignature: string,
  issueNumber: number,
  issueUrl: string,
): Promise<void> {
  const now = Date.now();

  await env.DB.prepare(
    `UPDATE issue_tracking
     SET status = 'open',
         github_issue_number = ?,
         github_issue_url = ?,
         retry_count = COALESCE(retry_count, 0),
         updated_at = ?
     WHERE error_signature = ?`,
  )
    .bind(issueNumber, issueUrl, now, errorSignature)
    .run();
}
