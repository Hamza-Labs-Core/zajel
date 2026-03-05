/**
 * Main processing pipeline for error pattern analysis.
 *
 * Orchestrates the full flow:
 * 1. Query D1 for error clusters above threshold
 * 2. Check deduplication for each cluster
 * 3. Run AI analysis for new clusters
 * 4. Create/update GitHub issues
 * 5. Record results
 */

import type { Env, ErrorCluster, ProcessingRunResult } from './types.js';
import {
  ERROR_THRESHOLD,
  MAX_CLUSTERS_PER_RUN,
  MAX_NEW_ISSUES_PER_RUN,
  DEFAULT_LOOKBACK_MS,
} from './types.js';
import { analyzeWithAi } from './ai-analyzer.js';
import { createGitHubIssue, updateExistingIssue } from './github-client.js';
import { checkDuplicate, recordIssue, updateIssueStatus } from './dedup.js';

/**
 * Raw row returned from the error_aggregates query.
 */
interface ErrorAggregateRow {
  error_signature: string;
  category: string;
  total_count: number;
  versions: string;
  platforms: string;
  sample_messages: string;
  sample_stack_traces: string;
  first_seen: number;
  last_seen: number;
}

/**
 * Get the timestamp of the last successful processing run.
 * Falls back to DEFAULT_LOOKBACK_MS ago if no prior run exists.
 */
export async function getLastRunTimestamp(env: Env): Promise<number> {
  try {
    const row = await env.DB.prepare(
      `SELECT run_end FROM processing_runs
       WHERE status IN ('success', 'partial')
       ORDER BY run_end DESC
       LIMIT 1`,
    ).first<{ run_end: number }>();

    return row?.run_end ?? Date.now() - DEFAULT_LOOKBACK_MS;
  } catch {
    return Date.now() - DEFAULT_LOOKBACK_MS;
  }
}

/**
 * Query D1 for error clusters that exceed the occurrence threshold
 * since the last processing run.
 */
export async function queryErrorClusters(
  env: Env,
  sinceTimestamp: number,
): Promise<ErrorCluster[]> {
  const result = await env.DB.prepare(
    `SELECT
       error_signature,
       category,
       SUM(count) as total_count,
       GROUP_CONCAT(DISTINCT app_version) as versions,
       GROUP_CONCAT(DISTINCT platform) as platforms,
       GROUP_CONCAT(DISTINCT sample_message, '|||') as sample_messages,
       GROUP_CONCAT(DISTINCT sample_stack_trace, '|||') as sample_stack_traces,
       MIN(first_seen) as first_seen,
       MAX(last_seen) as last_seen
     FROM error_aggregates
     WHERE last_seen > ?
     GROUP BY error_signature
     HAVING SUM(count) >= ?
     ORDER BY total_count DESC
     LIMIT ?`,
  )
    .bind(sinceTimestamp, ERROR_THRESHOLD, MAX_CLUSTERS_PER_RUN)
    .all<ErrorAggregateRow>();

  if (!result.success || !result.results) {
    return [];
  }

  return result.results.map((row) => ({
    errorSignature: row.error_signature,
    category: row.category,
    totalCount: row.total_count,
    versions: row.versions ? row.versions.split(',').filter(Boolean) : [],
    platforms: row.platforms ? row.platforms.split(',').filter(Boolean) : [],
    sampleMessages: row.sample_messages
      ? row.sample_messages.split('|||').slice(0, 5).filter(Boolean)
      : [],
    sampleStackTraces: row.sample_stack_traces
      ? row.sample_stack_traces.split('|||').slice(0, 3).filter(Boolean)
      : [],
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  }));
}

/**
 * Compute a human-readable time window string.
 */
function formatTimeWindow(sinceTimestamp: number): string {
  const diffMs = Date.now() - sinceTimestamp;
  const diffMinutes = Math.round(diffMs / 60000);

  if (diffMinutes < 60) {
    return `${diffMinutes} minutes`;
  }
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} hours`;
  }
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays} days`;
}

/**
 * Record a processing run in the processing_runs table.
 */
export async function recordProcessingRun(
  env: Env,
  runStart: number,
  result: ProcessingRunResult,
): Promise<void> {
  const runEnd = Date.now();

  await env.DB.prepare(
    `INSERT INTO processing_runs
       (run_start, run_end, errors_processed, issues_created, issues_updated,
        ai_calls_made, ai_tokens_used, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      runStart,
      runEnd,
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
 * Main processing pipeline entry point.
 *
 * Called by the cron handler every 15 minutes to:
 * 1. Find significant error clusters
 * 2. Check deduplication
 * 3. Analyze with AI
 * 4. Create/update GitHub issues
 * 5. Record run results
 */
export async function runProcessingPipeline(
  env: Env,
): Promise<ProcessingRunResult> {
  const result: ProcessingRunResult = {
    errorsProcessed: 0,
    issuesCreated: 0,
    issuesUpdated: 0,
    aiCallsMade: 0,
    aiTokensUsed: 0,
    status: 'success',
  };

  // 1. Get last run timestamp
  const sinceTimestamp = await getLastRunTimestamp(env);
  const timeWindow = formatTimeWindow(sinceTimestamp);

  // 2. Query for error clusters above threshold
  const clusters = await queryErrorClusters(env, sinceTimestamp);
  result.errorsProcessed = clusters.length;

  if (clusters.length === 0) {
    return result;
  }

  let newIssuesCreated = 0;

  // 3. Process each cluster
  for (const cluster of clusters) {
    try {
      // 3a. Check deduplication
      const dedupResult = await checkDuplicate(env, cluster);

      if (dedupResult.isDuplicate && dedupResult.existingIssueNumber) {
        // Update existing open issue with a comment
        await updateExistingIssue(
          env,
          dedupResult.existingIssueNumber,
          cluster,
          false,
        );
        await updateIssueStatus(
          env,
          cluster.errorSignature,
          'open',
          cluster.totalCount,
          cluster.lastSeen,
        );
        result.issuesUpdated++;
        continue;
      }

      if (dedupResult.isDuplicate) {
        // Closed issue below reopen threshold — skip
        continue;
      }

      // Check if we've hit the new issue cap
      if (newIssuesCreated >= MAX_NEW_ISSUES_PER_RUN) {
        console.log(`Skipping cluster ${cluster.errorSignature}: new issue cap (${MAX_NEW_ISSUES_PER_RUN}) reached`);
        continue;
      }

      // 3b. Run AI analysis (if available)
      result.aiCallsMade++;
      const aiResult = await analyzeWithAi(env, cluster, timeWindow);
      result.aiTokensUsed += aiResult.tokensUsed;
      const analysis = aiResult.analysis;

      // 3c. Handle reopening of closed issues
      const shouldReopen =
        dedupResult.existingStatus === 'closed' &&
        dedupResult.existingIssueNumber !== undefined;

      if (shouldReopen && dedupResult.existingIssueNumber !== undefined) {
        await updateExistingIssue(
          env,
          dedupResult.existingIssueNumber,
          cluster,
          true,
        );
        await updateIssueStatus(
          env,
          cluster.errorSignature,
          'open',
          cluster.totalCount,
          cluster.lastSeen,
        );
        result.issuesUpdated++;
        continue;
      }

      // 3d. Create new GitHub issue
      const issueResult = await createGitHubIssue(
        env,
        cluster,
        analysis,
        timeWindow,
      );

      // 3e. Record in issue_tracking
      const severity = analysis?.severity ?? 'medium';
      const component = analysis?.component ?? cluster.category;
      const aiJson = analysis ? JSON.stringify(analysis) : null;
      const status = issueResult ? 'open' : 'pending';

      await recordIssue(
        env,
        cluster,
        issueResult?.issueNumber ?? null,
        issueResult?.issueUrl ?? null,
        severity,
        component,
        aiJson,
        status,
      );

      if (issueResult) {
        result.issuesCreated++;
        newIssuesCreated++;
      }
    } catch (error) {
      console.error(
        `Error processing cluster ${cluster.errorSignature}:`,
        error,
      );
      result.status = 'partial';
    }
  }

  return result;
}
