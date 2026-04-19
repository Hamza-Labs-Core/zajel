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

import type { Env, ErrorCluster, ProcessingRunResult, LogEntry, RelatedLogs } from './types.js';
import {
  ERROR_THRESHOLD,
  MAX_CLUSTERS_PER_RUN,
  MAX_NEW_ISSUES_PER_RUN,
  DEFAULT_LOOKBACK_MS,
  LOG_CLUSTER_THRESHOLD,
} from './types.js';
import { analyzeWithAi } from './ai-analyzer.js';
import {
  createGitHubIssue,
  updateExistingIssue,
  rateLimitHit,
  resetRateLimitFlag,
} from './github-client.js';
import {
  checkDuplicate,
  recordIssue,
  updateIssueStatus,
  getPendingIssues,
  incrementRetryCount,
  markIssueFailed,
  updatePendingToOpen,
} from './dedup.js';
import { detectRegressions } from './regression.js';
import type { RegressionInfo } from './regression.js';
import { MAX_RETRY_COUNT } from './types.js';

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
 * Raw row returned from server_logs / app_logs queries.
 */
interface LogRow {
  timestamp: number;
  severity: string;
  category: string;
  message: string;
}

/**
 * Raw row returned from log cluster aggregation query.
 */
interface LogClusterRow {
  message_prefix: string;
  category: string;
  occurrence_count: number;
  min_timestamp: number;
  max_timestamp: number;
  sample_message: string;
}

/**
 * Query server_logs and app_logs for entries related to an error cluster's time window.
 *
 * Time window: [cluster.firstSeen - 300000, cluster.lastSeen + 60000]
 * (5 minutes before first seen to 1 minute after last seen)
 */
export async function queryRelatedLogs(
  env: Env,
  cluster: ErrorCluster,
): Promise<RelatedLogs> {
  const windowStart = cluster.firstSeen - 300000; // 5 min before
  const windowEnd = cluster.lastSeen + 60000; // 1 min after

  // Query server_logs
  let serverLogs: LogEntry[] = [];
  try {
    const serverResult = await env.DB.prepare(
      `SELECT timestamp, severity, category, message
       FROM server_logs
       WHERE timestamp >= ? AND timestamp <= ?
         AND severity IN ('warn', 'error', 'critical')
       ORDER BY timestamp ASC
       LIMIT 20`,
    )
      .bind(windowStart, windowEnd)
      .all<LogRow>();

    if (serverResult.success && serverResult.results) {
      serverLogs = serverResult.results.map((row) => ({
        timestamp: row.timestamp,
        severity: row.severity,
        category: row.category,
        message: row.message,
      }));
    }
  } catch (error) {
    console.error('Failed to query server_logs:', error);
  }

  // Query app_logs (may not exist yet)
  let appLogs: LogEntry[] = [];
  try {
    const appResult = await env.DB.prepare(
      `SELECT timestamp, severity, category, message
       FROM app_logs
       WHERE timestamp >= ? AND timestamp <= ?
         AND severity IN ('warn', 'error', 'critical')
       ORDER BY timestamp ASC
       LIMIT 20`,
    )
      .bind(windowStart, windowEnd)
      .all<LogRow>();

    if (appResult.success && appResult.results) {
      appLogs = appResult.results.map((row) => ({
        timestamp: row.timestamp,
        severity: row.severity,
        category: row.category,
        message: row.message,
      }));
    }
  } catch {
    // app_logs table may not exist yet — handle gracefully
  }

  return { serverLogs, appLogs };
}

/**
 * Query server_logs for clusters of warn/error/critical log messages
 * that appear >= LOG_CLUSTER_THRESHOLD times in the processing window.
 *
 * Groups by the first 100 characters of the message to find patterns.
 * Returns additional ErrorCluster objects to process alongside error_aggregates.
 */
export async function queryLogClusters(
  env: Env,
  sinceTimestamp: number,
): Promise<ErrorCluster[]> {
  try {
    const result = await env.DB.prepare(
      `SELECT
         SUBSTR(message, 1, 100) as message_prefix,
         category,
         COUNT(*) as occurrence_count,
         MIN(timestamp) as min_timestamp,
         MAX(timestamp) as max_timestamp,
         message as sample_message
       FROM server_logs
       WHERE timestamp > ?
         AND severity IN ('warn', 'error', 'critical')
       GROUP BY SUBSTR(message, 1, 100)
       HAVING COUNT(*) >= ?
       ORDER BY occurrence_count DESC
       LIMIT ?`,
    )
      .bind(sinceTimestamp, LOG_CLUSTER_THRESHOLD, MAX_CLUSTERS_PER_RUN)
      .all<LogClusterRow>();

    if (!result.success || !result.results) {
      return [];
    }

    return result.results.map((row) => ({
      errorSignature: `log:${row.message_prefix.substring(0, 60).replace(/[^a-zA-Z0-9_:-]/g, '_')}`,
      category: row.category,
      totalCount: row.occurrence_count,
      versions: [],
      platforms: [],
      sampleMessages: [row.sample_message],
      sampleStackTraces: [],
      firstSeen: row.min_timestamp,
      lastSeen: row.max_timestamp,
    }));
  } catch (error) {
    console.error('Failed to query log clusters:', error);
    return [];
  }
}

/**
 * Fetch up to 3 raw stack traces from R2 diagnostic reports
 * matching the error cluster's time window.
 */
export async function fetchR2StackTraces(
  env: Env,
  cluster: ErrorCluster,
): Promise<string[]> {
  try {
    if (!env.REPORTS_BUCKET) {
      return [];
    }

    // List objects in the time window — use a prefix based on timestamp range
    const listResult = await env.REPORTS_BUCKET.list({
      limit: 10,
    });

    if (!listResult.objects || listResult.objects.length === 0) {
      return [];
    }

    const stackTraces: string[] = [];

    for (const obj of listResult.objects) {
      if (stackTraces.length >= 3) break;

      try {
        const r2Object = await env.REPORTS_BUCKET.get(obj.key);
        if (!r2Object) continue;

        const text = await r2Object.text();
        const parsed = JSON.parse(text) as Record<string, unknown>;

        // Extract stack trace from the report JSON
        const stackTrace =
          (parsed['stack_trace'] as string) ??
          (parsed['stackTrace'] as string) ??
          (parsed['error']  as string);

        if (typeof stackTrace === 'string' && stackTrace.length > 0) {
          // Only include if it matches the cluster's error signature
          const content = text.toLowerCase();
          const sigLower = cluster.errorSignature.toLowerCase();
          const categoryLower = cluster.category.toLowerCase();

          if (content.includes(sigLower) || content.includes(categoryLower)) {
            stackTraces.push(stackTrace);
          }
        }
      } catch {
        // Skip malformed reports
      }
    }

    return stackTraces;
  } catch (error) {
    console.error('Failed to fetch R2 stack traces:', error);
    return [];
  }
}

/**
 * Main processing pipeline entry point.
 *
 * Called by the cron handler every 15 minutes to:
 * 1. Find significant error clusters (from error_aggregates AND server_logs)
 * 2. Check deduplication
 * 3. Analyze with AI
 * 4. Create/update GitHub issues (enriched with related logs and stack traces)
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

  // Reset rate limit flag at start of each run
  resetRateLimitFlag();

  // 0. Retry queue: process pending issues from previous failed runs
  await retryPendingIssues(env, result);

  // 1. Get last run timestamp
  const sinceTimestamp = await getLastRunTimestamp(env);
  const timeWindow = formatTimeWindow(sinceTimestamp);

  // 2. Query for error clusters above threshold from error_aggregates
  const errorAggregateClusters = await queryErrorClusters(env, sinceTimestamp);

  // 2b. Also query for log clusters from server_logs
  const logClusters = await queryLogClusters(env, sinceTimestamp);

  // Merge both sources, deduplicating by errorSignature
  const seenSignatures = new Set<string>();
  const clusters: ErrorCluster[] = [];
  for (const c of [...errorAggregateClusters, ...logClusters]) {
    if (!seenSignatures.has(c.errorSignature)) {
      seenSignatures.add(c.errorSignature);
      clusters.push(c);
    }
  }

  result.errorsProcessed = clusters.length;

  if (clusters.length === 0) {
    return result;
  }

  // 2c. Run regression detection
  let regressionMap: Map<string, RegressionInfo> = new Map();
  try {
    const regressions = await detectRegressions(env, clusters);
    for (const r of regressions) {
      regressionMap.set(r.errorSignature, r);
    }
  } catch (error) {
    console.error('Regression detection failed:', error);
    // Non-fatal: continue without regression info
  }

  let newIssuesCreated = 0;

  // 3. Process each cluster
  for (const cluster of clusters) {
    // Check rate limit before each GitHub operation
    if (rateLimitHit) {
      console.log('GitHub rate limit hit, stopping new issue creation');
      result.status = 'partial';
      break;
    }

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

      // 3b. Fetch related logs and stack traces for enrichment
      const relatedLogs = await queryRelatedLogs(env, cluster);
      const fullStackTraces = await fetchR2StackTraces(env, cluster);

      // 3c. Run AI analysis (if available)
      // Include regression info in the context
      const regression = regressionMap.get(cluster.errorSignature);
      result.aiCallsMade++;
      const aiResult = await analyzeWithAi(env, cluster, timeWindow, regression);
      result.aiTokensUsed += aiResult.tokensUsed;
      const analysis = aiResult.analysis;

      // 3d. Handle reopening of closed issues
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

      // 3e. Create new GitHub issue (enriched with related logs and stack traces)
      const issueResult = await createGitHubIssue(
        env,
        cluster,
        analysis,
        timeWindow,
        relatedLogs,
        fullStackTraces,
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

/**
 * Retry creating GitHub issues for pending entries from previous runs.
 * Caps at MAX_RETRY_COUNT retries before marking as failed.
 */
async function retryPendingIssues(
  env: Env,
  result: ProcessingRunResult,
): Promise<void> {
  try {
    const pendingIssues = await getPendingIssues(env);

    if (pendingIssues.length === 0) {
      return;
    }

    console.log(`Retrying ${pendingIssues.length} pending GitHub issues`);

    for (const pending of pendingIssues) {
      if (rateLimitHit) {
        console.log('GitHub rate limit hit, stopping retry queue');
        break;
      }

      try {
        // Parse stored AI analysis if available
        let analysis = null;
        if (pending.ai_analysis) {
          try {
            analysis = JSON.parse(pending.ai_analysis);
          } catch {
            // Ignore parse errors
          }
        }

        // Build a minimal cluster for issue creation
        const cluster: import('./types.js').ErrorCluster = {
          errorSignature: pending.error_signature,
          category: pending.component,
          totalCount: pending.total_occurrences,
          versions: [],
          platforms: [],
          sampleMessages: [],
          sampleStackTraces: [],
          firstSeen: pending.first_detected,
          lastSeen: pending.last_detected,
        };

        const issueResult = await createGitHubIssue(
          env,
          cluster,
          analysis,
          'previous run',
        );

        if (issueResult) {
          // Success — update to open
          await updatePendingToOpen(
            env,
            pending.error_signature,
            issueResult.issueNumber,
            issueResult.issueUrl,
          );
          result.issuesCreated++;
          console.log(
            `Retry succeeded for ${pending.error_signature}: #${issueResult.issueNumber}`,
          );
        } else {
          // Failed again — increment retry count
          await incrementRetryCount(env, pending.error_signature);

          if (pending.retry_count + 1 >= MAX_RETRY_COUNT) {
            // Exceeded max retries — mark as failed
            await markIssueFailed(env, pending.error_signature);
            console.warn(
              `Marking ${pending.error_signature} as failed after ${MAX_RETRY_COUNT} retries`,
            );
          }
        }
      } catch (error) {
        console.error(
          `Retry failed for ${pending.error_signature}:`,
          error,
        );
        await incrementRetryCount(env, pending.error_signature).catch(() => {});
      }
    }
  } catch (error) {
    console.error('Retry queue processing failed:', error);
    // Non-fatal: continue with normal pipeline
  }
}
