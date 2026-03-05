/**
 * D1 aggregation logic for diagnostic metrics.
 *
 * Uses INSERT ... ON CONFLICT (UPSERT) to atomically update
 * time-bucketed counters and percentile approximations.
 */

import type { DiagnosticReport } from './types.js';

/**
 * Truncate a Unix ms timestamp to the hour bucket.
 * Returns an ISO datetime string like "2026-03-03T14:00:00Z".
 */
export function getTimeBucket(timestampMs: number): string {
  const date = new Date(timestampMs);
  date.setMinutes(0, 0, 0);
  return date.toISOString().replace('.000Z', 'Z');
}

/**
 * Aggregate error data from a diagnostic report into D1.
 *
 * For each error in the report, upserts into error_aggregates
 * with count increment and timestamp updates.
 */
export async function aggregateErrors(
  db: D1Database,
  report: DiagnosticReport,
): Promise<void> {
  if (!report.errors || report.errors.length === 0) {
    return;
  }

  const timeBucket = getTimeBucket(report.timestamp);
  const statements: D1PreparedStatement[] = [];

  for (const error of report.errors) {
    statements.push(
      db
        .prepare(
          `INSERT INTO error_aggregates (time_bucket, error_signature, category, app_version, platform, count, first_seen, last_seen, sample_message, sample_stack_trace)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
           ON CONFLICT(time_bucket, error_signature, app_version, platform) DO UPDATE SET
             count = count + excluded.count,
             first_seen = MIN(first_seen, excluded.first_seen),
             last_seen = MAX(last_seen, excluded.last_seen),
             sample_message = excluded.sample_message,
             sample_stack_trace = COALESCE(excluded.sample_stack_trace, sample_stack_trace)`,
        )
        .bind(
          timeBucket,
          error.signature,
          error.category,
          report.appVersion,
          report.platform,
          error.count,
          error.firstOccurrence,
          error.lastOccurrence,
          error.message,
          error.stackTrace ?? null,
        ),
    );
  }

  await db.batch(statements);
}

/**
 * Aggregate performance metrics from a diagnostic report into D1.
 *
 * Uses a weighted average approximation for percentile tracking.
 * Each metric is stored as its own row, with p50/p95/p99 updated
 * using an exponential moving average approach.
 */
export async function aggregatePerformance(
  db: D1Database,
  report: DiagnosticReport,
): Promise<void> {
  if (!report.performance) {
    return;
  }

  const timeBucket = getTimeBucket(report.timestamp);
  const statements: D1PreparedStatement[] = [];

  const metrics: Array<{ name: string; value: number | undefined }> = [
    { name: 'startupTimeMs', value: report.performance.startupTimeMs },
    { name: 'frameRateAvg', value: report.performance.frameRateAvg },
    { name: 'frameRateP95', value: report.performance.frameRateP95 },
    { name: 'memoryUsageMb', value: report.performance.memoryUsageMb },
    { name: 'memoryPeakMb', value: report.performance.memoryPeakMb },
  ];

  for (const metric of metrics) {
    if (metric.value === undefined || metric.value === null) {
      continue;
    }

    // For a single sample, p50/p95/p99 are all the same value.
    // On conflict, we merge using weighted average:
    //   new_p = (old_p * old_count + new_value) / (old_count + 1)
    // This is an approximation but works well for streaming percentiles.
    statements.push(
      db
        .prepare(
          `INSERT INTO performance_aggregates (time_bucket, platform, app_version, metric_name, p50, p95, p99, sample_count)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)
           ON CONFLICT(time_bucket, platform, app_version, metric_name) DO UPDATE SET
             p50 = (p50 * sample_count + excluded.p50) / (sample_count + 1),
             p95 = MAX(p95, (p95 * sample_count + excluded.p95) / (sample_count + 1)),
             p99 = MAX(p99, (p99 * sample_count + excluded.p99) / (sample_count + 1)),
             sample_count = sample_count + 1`,
        )
        .bind(
          timeBucket,
          report.platform,
          report.appVersion,
          metric.name,
          metric.value,
          metric.value,
          metric.value,
        ),
    );
  }

  if (statements.length > 0) {
    await db.batch(statements);
  }
}

/**
 * Aggregate network metrics from a diagnostic report into D1.
 *
 * Converts success rates + attempt counts into absolute success/failure counts
 * for accurate aggregation.
 */
export async function aggregateNetwork(
  db: D1Database,
  report: DiagnosticReport,
): Promise<void> {
  if (!report.network) {
    return;
  }

  const timeBucket = getTimeBucket(report.timestamp);
  const net = report.network;

  // Convert rates to counts
  const signalingAttempts = net.signalingConnectAttempts ?? 0;
  const signalingSuccessRate = net.signalingConnectSuccessRate ?? 0;
  const signalingSuccess = Math.round(signalingAttempts * signalingSuccessRate);
  const signalingFailure = signalingAttempts - signalingSuccess;

  const webrtcAttempts = net.webrtcEstablishAttempts ?? 0;
  const webrtcSuccessRate = net.webrtcEstablishSuccessRate ?? 0;
  const webrtcSuccess = Math.round(webrtcAttempts * webrtcSuccessRate);
  const webrtcFailure = webrtcAttempts - webrtcSuccess;

  // Connection type counts
  const relayUsage = (net.relayUsageRate ?? 0) > 0 ? 1 : 0;
  const directP2p = report.connectionType === 'direct_p2p' ? 1 : 0;

  await db
    .prepare(
      `INSERT INTO network_aggregates (time_bucket, platform, app_version, signaling_success_count, signaling_failure_count, webrtc_success_count, webrtc_failure_count, relay_usage_count, direct_p2p_count, avg_latency_ms, sample_count)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1)
       ON CONFLICT(time_bucket, platform, app_version) DO UPDATE SET
         signaling_success_count = signaling_success_count + excluded.signaling_success_count,
         signaling_failure_count = signaling_failure_count + excluded.signaling_failure_count,
         webrtc_success_count = webrtc_success_count + excluded.webrtc_success_count,
         webrtc_failure_count = webrtc_failure_count + excluded.webrtc_failure_count,
         relay_usage_count = relay_usage_count + excluded.relay_usage_count,
         direct_p2p_count = direct_p2p_count + excluded.direct_p2p_count,
         avg_latency_ms = CASE
           WHEN excluded.avg_latency_ms IS NOT NULL
           THEN (COALESCE(avg_latency_ms, 0) * sample_count + excluded.avg_latency_ms) / (sample_count + 1)
           ELSE avg_latency_ms
         END,
         sample_count = sample_count + 1`,
    )
    .bind(
      timeBucket,
      report.platform,
      report.appVersion,
      signalingSuccess,
      signalingFailure,
      webrtcSuccess,
      webrtcFailure,
      relayUsage,
      directP2p,
      net.avgLatencyMs ?? null,
    )
    .run();
}

/**
 * Aggregate current connection type distribution into
 * the connection_type_history table.
 *
 * - Groups active clients (last_seen within 10 min) by connection_type
 * - Uses COALESCE to map NULL connection_type to 'none'
 * - Inserts into 5-minute time buckets (INSERT OR REPLACE on unique constraint)
 * - Cleans up data older than 30 days
 */
export async function aggregateConnectionTypes(db: D1Database): Promise<void> {
  const now = Date.now();
  const timeBucket = Math.floor(now / 300_000) * 300_000;
  const cutoff = now - 600_000;
  const retentionCutoff = now - 30 * 24 * 60 * 60 * 1000;

  await db
    .prepare(
      `INSERT OR REPLACE INTO connection_type_history (time_bucket, connection_type, active_count)
       SELECT ?, COALESCE(connection_type, 'none'), COUNT(*)
       FROM client_heartbeats
       WHERE last_seen > ?
       GROUP BY COALESCE(connection_type, 'none')`
    )
    .bind(timeBucket, cutoff)
    .run();

  await db
    .prepare('DELETE FROM connection_type_history WHERE time_bucket < ?')
    .bind(retentionCutoff)
    .run();
}

/**
 * Update the client heartbeat record (upsert by session_hash).
 */
export async function updateHeartbeat(
  db: D1Database,
  report: DiagnosticReport,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO client_heartbeats (session_hash, platform, app_version, connection_type, last_seen, session_start)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT(session_hash) DO UPDATE SET
         platform = excluded.platform,
         app_version = excluded.app_version,
         connection_type = excluded.connection_type,
         last_seen = excluded.last_seen`,
    )
    .bind(
      report.sessionHash,
      report.platform,
      report.appVersion,
      report.connectionType ?? null,
      report.timestamp,
    )
    .run();
}
