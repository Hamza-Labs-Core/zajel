/**
 * Deduplication logic for error signatures.
 *
 * Before creating a new GitHub issue, checks D1 issue_tracking to determine
 * whether the error signature has already been reported. Handles three cases:
 *   - New signature: create a new issue
 *   - Open issue exists: update with new occurrence data
 *   - Closed issue with spike: reopen the issue
 */

import type {
  DedupResult,
  ErrorCluster,
  IssueTrackingRow,
} from './types.js';
import { REOPEN_THRESHOLD } from './types.js';

/**
 * Check whether an error signature already has a tracked issue.
 *
 * @returns A DedupResult indicating what action to take.
 */
export async function checkDuplicate(
  db: D1Database,
  cluster: ErrorCluster,
): Promise<DedupResult> {
  try {
    const row = await db
      .prepare('SELECT * FROM issue_tracking WHERE error_signature = ?')
      .bind(cluster.errorSignature)
      .first<IssueTrackingRow>();

    if (!row) {
      return {
        isDuplicate: false,
        existingIssueNumber: null,
        existingIssueUrl: null,
        action: 'create',
        existingId: null,
      };
    }

    // Open issue exists — update with latest counts
    if (row.status === 'open') {
      return {
        isDuplicate: true,
        existingIssueNumber: row.github_issue_number,
        existingIssueUrl: row.github_issue_url,
        action: 'update',
        existingId: row.id,
      };
    }

    // Closed issue — check if we should reopen
    if (cluster.totalCount >= REOPEN_THRESHOLD) {
      return {
        isDuplicate: true,
        existingIssueNumber: row.github_issue_number,
        existingIssueUrl: row.github_issue_url,
        action: 'reopen',
        existingId: row.id,
      };
    }

    // Closed and below reopen threshold — skip
    return {
      isDuplicate: true,
      existingIssueNumber: row.github_issue_number,
      existingIssueUrl: row.github_issue_url,
      action: 'skip',
      existingId: row.id,
    };
  } catch {
    // On DB failure, default to create (will be caught by GitHub dedup search)
    return {
      isDuplicate: false,
      existingIssueNumber: null,
      existingIssueUrl: null,
      action: 'create',
      existingId: null,
    };
  }
}

/**
 * Record a new entry in the issue_tracking table.
 */
export async function recordIssueTracking(
  db: D1Database,
  errorSignature: string,
  issueNumber: number,
  issueUrl: string,
  severity: string,
  component: string,
  aiAnalysis: string | null,
  totalOccurrences: number,
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO issue_tracking
        (error_signature, github_issue_number, github_issue_url,
         severity, component, status, ai_analysis,
         first_detected, last_detected, total_occurrences,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      errorSignature,
      issueNumber,
      issueUrl,
      severity,
      component,
      aiAnalysis,
      now,
      now,
      totalOccurrences,
      now,
      now,
    )
    .run();
}

/**
 * Update an existing issue_tracking row with new occurrence data.
 */
export async function updateIssueTracking(
  db: D1Database,
  existingId: number,
  totalOccurrences: number,
  status: string,
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `UPDATE issue_tracking
       SET last_detected = ?, total_occurrences = ?, status = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(now, totalOccurrences, status, now, existingId)
    .run();
}
