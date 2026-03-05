/**
 * KV counter logic for fast dashboard reads.
 *
 * Counters are best-effort / eventually consistent. For exact counts,
 * the admin dashboard should fall back to D1 queries.
 *
 * KV TTL of 15 minutes (900 seconds) ensures stale counters auto-expire
 * if the Worker stops receiving heartbeats.
 */

const KV_TTL_SECONDS = 900; // 15 minutes

/**
 * Increment a KV counter by 1 (or by a custom delta).
 * Reads the current value, increments it, and writes back with TTL.
 *
 * NOTE: This is NOT atomic. Concurrent writes may cause under-counting.
 * This is acceptable for approximate dashboard counters.
 */
export async function incrementCounter(
  kv: KVNamespace,
  key: string,
  delta = 1,
): Promise<void> {
  const current = await getCounter(kv, key);
  const next = current + delta;
  await kv.put(key, String(next), { expirationTtl: KV_TTL_SECONDS });
}

/**
 * Read a counter value from KV. Returns 0 if the key does not exist.
 */
export async function getCounter(
  kv: KVNamespace,
  key: string,
): Promise<number> {
  const raw = await kv.get(key);
  if (raw === null) {
    return 0;
  }
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Update all heartbeat-related KV counters for a single heartbeat event.
 */
export async function updateHeartbeatCounters(
  kv: KVNamespace,
  platform: string,
  appVersion: string,
  connectionType?: string,
): Promise<void> {
  const promises: Promise<void>[] = [
    incrementCounter(kv, 'active_clients:total'),
    incrementCounter(kv, `active_clients:platform:${platform}`),
    incrementCounter(kv, `active_clients:version:${appVersion}`),
  ];

  if (connectionType) {
    promises.push(
      incrementCounter(kv, `active_clients:connection:${connectionType}`),
    );
  }

  await Promise.all(promises);
}
