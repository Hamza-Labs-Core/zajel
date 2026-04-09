/**
 * Scheduled cleanup for diagnostics D1 tables.
 *
 * Applies retention policies per table, deleting rows older than
 * the configured thresholds. Logs how many rows were deleted per table.
 */

/** Retention periods in milliseconds. */
const RETENTION = {
  /** 7 days */
  SEVEN_DAYS: 7 * 24 * 60 * 60 * 1000,
  /** 14 days */
  FOURTEEN_DAYS: 14 * 24 * 60 * 60 * 1000,
  /** 24 hours */
  TWENTY_FOUR_HOURS: 24 * 60 * 60 * 1000,
  /** 30 days */
  THIRTY_DAYS: 30 * 24 * 60 * 60 * 1000,
  /** 90 days */
  NINETY_DAYS: 90 * 24 * 60 * 60 * 1000,
};

/**
 * Result of a cleanup run.
 */
export interface CleanupResult {
  table: string;
  condition: string;
  deleted: number;
}

/**
 * Run all cleanup tasks and return results.
 *
 * @param db - D1 database binding
 * @returns Array of cleanup results per table/condition
 */
export async function runCleanup(db: D1Database): Promise<CleanupResult[]> {
  const now = Date.now();
  const results: CleanupResult[] = [];

  // Define all cleanup tasks
  const tasks: Array<{
    table: string;
    condition: string;
    sql: string;
    params: unknown[];
  }> = [
    // server_logs: debug/info — 7 days
    {
      table: 'server_logs',
      condition: "severity IN ('debug','info') older than 7 days",
      sql: "DELETE FROM server_logs WHERE severity IN ('debug', 'info') AND timestamp < ?",
      params: [now - RETENTION.SEVEN_DAYS],
    },
    // server_logs: warn — 14 days
    {
      table: 'server_logs',
      condition: "severity = 'warn' older than 14 days",
      sql: "DELETE FROM server_logs WHERE severity = 'warn' AND timestamp < ?",
      params: [now - RETENTION.FOURTEEN_DAYS],
    },
    // server_logs: error/critical — 30 days
    {
      table: 'server_logs',
      condition: "severity IN ('error','critical') older than 30 days",
      sql: "DELETE FROM server_logs WHERE severity IN ('error', 'critical') AND timestamp < ?",
      params: [now - RETENTION.THIRTY_DAYS],
    },
    // app_logs: debug/info — 7 days
    {
      table: 'app_logs',
      condition: "severity IN ('debug','info') older than 7 days",
      sql: "DELETE FROM app_logs WHERE severity IN ('debug', 'info') AND timestamp < ?",
      params: [now - RETENTION.SEVEN_DAYS],
    },
    // app_logs: warn — 14 days
    {
      table: 'app_logs',
      condition: "severity = 'warn' older than 14 days",
      sql: "DELETE FROM app_logs WHERE severity = 'warn' AND timestamp < ?",
      params: [now - RETENTION.FOURTEEN_DAYS],
    },
    // app_logs: error/critical — 30 days
    {
      table: 'app_logs',
      condition: "severity IN ('error','critical') older than 30 days",
      sql: "DELETE FROM app_logs WHERE severity IN ('error', 'critical') AND timestamp < ?",
      params: [now - RETENTION.THIRTY_DAYS],
    },
    // error_aggregates — 90 days
    {
      table: 'error_aggregates',
      condition: 'older than 90 days',
      sql: 'DELETE FROM error_aggregates WHERE last_seen < ?',
      params: [now - RETENTION.NINETY_DAYS],
    },
    // client_heartbeats — 24 hours
    {
      table: 'client_heartbeats',
      condition: 'last_seen older than 24 hours',
      sql: 'DELETE FROM client_heartbeats WHERE last_seen < ?',
      params: [now - RETENTION.TWENTY_FOUR_HOURS],
    },
    // security_events — 30 days
    {
      table: 'security_events',
      condition: 'older than 30 days',
      sql: 'DELETE FROM security_events WHERE timestamp < ?',
      params: [now - RETENTION.THIRTY_DAYS],
    },
    // alert_history — 90 days
    {
      table: 'alert_history',
      condition: 'older than 90 days',
      sql: 'DELETE FROM alert_history WHERE triggered_at < ?',
      params: [now - RETENTION.NINETY_DAYS],
    },
    // notifications — 30 days
    {
      table: 'notifications',
      condition: 'older than 30 days',
      sql: 'DELETE FROM notifications WHERE created_at < ?',
      params: [now - RETENTION.THIRTY_DAYS],
    },
    // performance_aggregates — 90 days
    {
      table: 'performance_aggregates',
      condition: 'older than 90 days',
      sql: 'DELETE FROM performance_aggregates WHERE time_bucket < ?',
      params: [new Date(now - RETENTION.NINETY_DAYS).toISOString().replace('.000Z', 'Z')],
    },
    // network_aggregates — 90 days
    {
      table: 'network_aggregates',
      condition: 'older than 90 days',
      sql: 'DELETE FROM network_aggregates WHERE time_bucket < ?',
      params: [new Date(now - RETENTION.NINETY_DAYS).toISOString().replace('.000Z', 'Z')],
    },
  ];

  for (const task of tasks) {
    try {
      const stmt = db.prepare(task.sql);
      const bound = task.params.length === 1
        ? stmt.bind(task.params[0])
        : stmt.bind(...task.params);
      const result = await bound.run();
      const deleted = result.meta?.changes ?? 0;

      results.push({
        table: task.table,
        condition: task.condition,
        deleted,
      });

      if (deleted > 0) {
        console.log(`Cleanup: ${task.table} (${task.condition}): deleted ${deleted} rows`);
      }
    } catch (error) {
      // Log error but continue with other tables
      console.error(`Cleanup error for ${task.table} (${task.condition}):`, error);
      results.push({
        table: task.table,
        condition: task.condition,
        deleted: 0,
      });
    }
  }

  return results;
}
