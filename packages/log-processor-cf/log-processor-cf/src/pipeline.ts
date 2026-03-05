/**
 * Main processing pipeline for the log processor.
 *
 * Orchestrates the full flow:
 *   1. Query D1 for error clusters above threshold since last run
 *   2. For each cluster: check dedup -> analyze with AI -> create/update GitHub issue
 *   3. Record results in issue_tracking and processing_runs tables
 */

import type { Env, ErrorCluster, ProcessingRunResult } from './types.js';
import {
  ERROR_THRESHOLD,
  MAX_CLUSTERS_PER_RUN,
  MAX_NEW_ISSUES_PER_RUN,
} from './types.js';
import { analyzeErrorCluster } from './ai-analyzer.js';
import { checkDuplicate, recordIssueTracking, updateIssueTracking } from './dedup.js';
import {
  createGitHubIssue,
  updateExistingIssue,
  reopenGitHubIssue,
} from './github-client.js';

/**
 * Get the timestamp of the last successful processing run.
 * Returns 0 if no previous run exists (processes all data).
 */
async function getLastRunTime(db: D1Database): Promise<number> {
  try {
    const row = await db
      .prepare(
        `SELECT run_end FROM processing_runs
         WHERE status IN ('success', 'partial')
         ORDER BY run_end DESC LIMIT 1`,
      )
      .first<{ run_end: number }>();

    return row?.run_end ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Query D1 for error clusters that exceed the occurrence threshold
 * since the last processing run.
 */
async function queryErrorClusters(
  db: D1Database,
  lastRunTime: number,
): Promise<ErrorCluster[]> {
  const result = await db
    .prepare(
      `SELECT
         error_signature,
         category,
         SUM(count) as total_count,
         GROUP_CONCAT(DISTINCT app_version) as app_versions,
         GROUP_CONCAT(DISTINCT platform) as platforms,
         MAX(sample_message) as sample_message,
         MAX(sample_stack_trace) as sample_stack_trace,
         MIN(first_seen) as first_seen,
         MAX(last_seen) as last_seen
       FROM error_aggregates
       WHERE last_seen > ?
       GROUP BY error_signature, category
       HAVING SUM(count) >= ?
       ORDER BY total_count DESC
       LIMIT ?`,
    )
    .bind(lastRunTime, ERROR_THRESHOLD, MAX_CLUSTERS_PER_RUN)
    .all();

  return (result.results ?? []).map((row: Record<string, unknown>) => ({
    errorSignature: row['error_signature'] as string,
    category: row['category'] as string,
    totalCount: row['total_count'] as number,
    appVersions: (row['app_versions'] as string) ?? '',
    platforms: (row['platforms'] as string) ?? '',
    sampleMessage: (row['sample_message'] as string) ?? '',
    sampleStackTrace: (row['sample_stack_trace'] as string) ?? '',
    firstSeen: row['first_seen'] as number,
    lastSeen: row['last_seen'] as number,
  }));
}

/**
 * Record a processing run in the processing_runs table.
 */
export async function recordProcessingRun(
  db: D1Database,
  result: ProcessingRunResult,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO processing_runs
        (run_start, run_end, errors_processed, issues_created,
         issues_updated, ai_calls_made, ai_tokens_used, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      result.runStart,
      result.runEnd,
      result.errorsProcessed,
      result.issuesCreated,
      result.issuesUpdated,
      result.aiCallsMade,
      result.aiTokensUsed,
      result.status,
    )
    .run();
}

/**
 * Run the full processing pipeline.
 *
 * @returns ProcessingRunResult with statistics about the run.
 */
export async function runProcessingPipeline(
  env: Env,
): Promise<ProcessingRunResult> {
  const runStart = Date.now();
  let errorsProcessed = 0;
  let issuesCreated = 0;
  let issuesUpdated = 0;
  let aiCallsMade = 0;
  let aiTokensUsed = 0;
  let status: ProcessingRunResult['status'] = 'success';

  try {
    const lastRunTime = await getLastRunTime(env.DB);
    const clusters = await queryErrorClusters(env.DB, lastRunTime);

    if (clusters.length === 0) {
      return {
        runStart,
        runEnd: Date.now(),
        errorsProcessed: 0,
        issuesCreated: 0,
        issuesUpdated: 0,
        aiCallsMade: 0,
        aiTokensUsed: 0,
        status: 'success',
      };
    }

    let newIssueCount = 0;

    for (const cluster of clusters) {
      try {
        errorsProcessed++;

        // Step 1: Check deduplication
        const dedupResult = await checkDuplicate(env.DB, cluster);

        if (dedupResult.action === 'skip') {
          continue;
        }

        // Step 2: Analyze with AI
        const { analysis, tokensUsed } = await analyzeErrorCluster(env, cluster);
        aiCallsMade++;
        aiTokensUsed += tokensUsed;

        // Determine severity and component (from AI or defaults)
        const severity = analysis?.severity ?? 'medium';
        const component = analysis?.component ?? cluster.category;
        const aiAnalysisJson = analysis ? JSON.stringify(analysis) : null;

        // Step 3: Create, update, or reopen GitHub issue
        if (dedupResult.action === 'create') {
          // Enforce max new issues per run
          if (newIssueCount >= MAX_NEW_ISSUES_PER_RUN) {
            continue;
          }

          if (analysis) {
            const issueResult = await createGitHubIssue(
              env.GITHUB_TOKEN,
              env.GITHUB_REPO,
              cluster,
              analysis,
            );

            if (issueResult) {
              await recordIssueTracking(
                env.DB,
                cluster.errorSignature,
                issueResult.issueNumber,
                issueResult.issueUrl,
                severity,
                component,
                aiAnalysisJson,
                cluster.totalCount,
              );
              issuesCreated++;
              newIssueCount++;
            }
          } else {
            // AI failed — record without GitHub issue for retry next run
            await recordIssueTracking(
              env.DB,
              cluster.errorSignature,
              0,
              '',
              severity,
              component,
              null,
              cluster.totalCount,
            );
          }
        } else if (dedupResult.action === 'update' && dedupResult.existingIssueNumber) {
          const updateResult = await updateExistingIssue(
            env.GITHUB_TOKEN,
            env.GITHUB_REPO,
            dedupResult.existingIssueNumber,
            cluster,
          );

          if (updateResult && dedupResult.existingId !== null) {
            await updateIssueTracking(
              env.DB,
              dedupResult.existingId,
              cluster.totalCount,
              'open',
            );
            issuesUpdated++;
          }
        } else if (dedupResult.action === 'reopen' && dedupResult.existingIssueNumber) {
          const reopenResult = await reopenGitHubIssue(
            env.GITHUB_TOKEN,
            env.GITHUB_REPO,
            dedupResult.existingIssueNumber,
            cluster,
          );

          if (reopenResult && dedupResult.existingId !== null) {
            await updateIssueTracking(
              env.DB,
              dedupResult.existingId,
              cluster.totalCount,
              'open',
            );
            issuesUpdated++;
          }
        }
      } catch {
        // Individual cluster processing failure — continue with others
        status = 'partial';
      }
    }
  } catch {
    status = 'failed';
  }

  return {
    runStart,
    runEnd: Date.now(),
    errorsProcessed,
    issuesCreated,
    issuesUpdated,
    aiCallsMade,
    aiTokensUsed,
    status,
  };
}
