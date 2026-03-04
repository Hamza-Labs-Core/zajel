/**
 * Version Policy Read-Through Cache
 *
 * Worker-level cache for version policy data. Avoids per-request DO fetch
 * for GET /attest/versions. Uses a simple TTL-based cache in Worker memory.
 *
 * Since Workers are stateless across requests in different isolates, this
 * cache is per-isolate and will be rebuilt on cold starts. This is acceptable
 * because the cache is a performance optimization, not a correctness requirement.
 */

// Cache TTL in milliseconds (5 minutes)
const VERSION_POLICY_CACHE_TTL = 5 * 60 * 1000;

// In-memory cache (per Worker isolate)
let cachedVersionPolicy = null;
let cacheTimestamp = 0;

/**
 * Get version policy, using read-through cache to avoid per-request DO fetch.
 *
 * @param {object} env - Cloudflare Worker environment
 * @param {function} fetchFromAdmin - Function that fetches version policy from admin shard
 * @returns {Promise<object>} The version policy data
 */
export async function getVersionPolicy(env, fetchFromAdmin) {
  const now = Date.now();

  // Return cached value if still fresh
  if (cachedVersionPolicy && (now - cacheTimestamp) < VERSION_POLICY_CACHE_TTL) {
    return cachedVersionPolicy;
  }

  // Cache miss or expired - fetch from admin shard
  const policy = await fetchFromAdmin();
  cachedVersionPolicy = policy;
  cacheTimestamp = now;

  return policy;
}

/**
 * Invalidate the version policy cache.
 * Should be called when version policy is updated via admin endpoint.
 */
export function invalidateVersionPolicyCache() {
  cachedVersionPolicy = null;
  cacheTimestamp = 0;
}
