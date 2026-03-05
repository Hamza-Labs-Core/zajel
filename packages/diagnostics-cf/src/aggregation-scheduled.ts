/**
 * Scheduled aggregation for version adoption history.
 *
 * Runs on a cron schedule to snapshot the active version
 * distribution from client_heartbeats into version_history.
 */

/**
 * Aggregate version history from client_heartbeats into version_history.
 *
 * - Counts active clients per app_version (seen in last 10 minutes)
 * - Stores into 5-minute time buckets
 * - Cleans up data older than 30 days
 *
 * @returns Summary of inserted and cleaned rows
 */
export async function aggregateVersionHistory(
  db: D1Database,
): Promise<{ inserted: number; cleaned: number }> {
  const now = Date.now();
  const timeBucket = Math.floor(now / 300000) * 300000; // 5-minute bucket
  const activeThreshold = now - 600000; // 10 minutes ago
  const cleanupThreshold = now - 30 * 24 * 60 * 60 * 1000; // 30 days ago

  let inserted = 0;
  let cleaned = 0;

  try {
    // Insert version counts from active heartbeats
    const insertResult = await db
      .prepare(
        `INSERT OR REPLACE INTO version_history (time_bucket, app_version, active_count)
         SELECT ?1, app_version, COUNT(*)
         FROM client_heartbeats
         WHERE last_seen > ?2
         GROUP BY app_version`,
      )
      .bind(timeBucket, activeThreshold)
      .run();

    inserted = insertResult.meta?.changes ?? 0;

    // Cleanup old data beyond 30 days
    const cleanupResult = await db
      .prepare('DELETE FROM version_history WHERE time_bucket < ?1')
      .bind(cleanupThreshold)
      .run();

    cleaned = cleanupResult.meta?.changes ?? 0;
  } catch (error) {
    console.error('Version history aggregation failed:', error);
    throw error;
  }

  return { inserted, cleaned };
}
