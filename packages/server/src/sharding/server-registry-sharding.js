/**
 * Server Registry Sharding Logic
 *
 * Routes server registration/heartbeat requests to regional shards.
 * Aggregates results from multiple shards for list operations.
 */

// Known regions for server deployment
export const KNOWN_REGIONS = [
  'us-east',
  'us-west',
  'eu-west',
  'eu-central',
  'ap-southeast',
  'ap-northeast',
  'default',  // Fallback for unknown regions and migration from 'global'
];

// Timeout for individual shard fetch during fan-out (ms)
const SHARD_FETCH_TIMEOUT = 3000;

/**
 * Get the shard ID for a given region.
 * Routes to 'default' shard for backward compatibility with 'global'.
 * Only regions in KNOWN_REGIONS are accepted; all others fall back to 'default'.
 *
 * @param {object} env - Cloudflare Worker environment
 * @param {string|null} region - Server region (e.g., 'us-east')
 * @returns {DurableObjectId}
 */
export function getServerRegistryShardId(env, region) {
  // Validate region against KNOWN_REGIONS to prevent unbounded shard creation.
  // Any region not in the known list falls back to 'default' so that all servers
  // remain discoverable via the fan-out in aggregateServerList.
  const normalizedRegion = typeof region === 'string' &&
                           KNOWN_REGIONS.includes(region)
    ? region
    : 'default';

  // Use 'region:' prefix for all shards (including default)
  // Legacy 'global' instance is accessed via 'default' for migration
  const shardName = `region:${normalizedRegion}`;

  return env.SERVER_REGISTRY.idFromName(shardName);
}

/**
 * Get stub for a specific region shard.
 *
 * @param {object} env - Cloudflare Worker environment
 * @param {string} region - Server region
 * @returns {DurableObjectStub}
 */
export function getServerRegistryShard(env, region) {
  const id = getServerRegistryShardId(env, region);
  return env.SERVER_REGISTRY.get(id);
}

/**
 * Aggregate server lists from all regional shards.
 * Handles partial failures gracefully (returns available results).
 * Each shard fetch is wrapped in a timeout to prevent slow shards from
 * blocking the entire response.
 *
 * @param {object} env - Cloudflare Worker environment
 * @param {Request} request - Original request for forwarding
 * @returns {Promise<{servers: Array, errors: Array}>}
 */
export async function aggregateServerList(env, request) {
  const results = await Promise.allSettled(
    KNOWN_REGIONS.map(async (region) => {
      const shard = getServerRegistryShard(env, region);

      // Clone request for each shard
      const shardRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
      });

      // Wrap each shard fetch in a timeout so one slow shard doesn't
      // delay the entire GET /servers response
      const response = await Promise.race([
        shard.fetch(shardRequest),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Shard ${region} timed out after ${SHARD_FETCH_TIMEOUT}ms`)), SHARD_FETCH_TIMEOUT)
        ),
      ]);

      if (!response.ok) {
        throw new Error(`Shard ${region} returned ${response.status}`);
      }

      const data = await response.json();
      return {
        region,
        servers: data.servers || [],
      };
    })
  );

  const servers = [];
  const errors = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const region = KNOWN_REGIONS[i];

    if (result.status === 'fulfilled') {
      servers.push(...result.value.servers);
    } else {
      errors.push({
        region,
        error: result.reason?.message || 'Unknown error',
      });
    }
  }

  return { servers, errors };
}

/**
 * Look up which regional shard a server belongs to by fan-out.
 * Used for heartbeat and DELETE routing when the region is unknown.
 *
 * @param {object} env - Cloudflare Worker environment
 * @param {string} serverId - The server ID to locate
 * @returns {Promise<string>} The region the server belongs to, or 'default'
 */
export async function findServerRegion(env, serverId) {
  // Fan-out lightweight HEAD/lookup requests to all regional shards
  const results = await Promise.allSettled(
    KNOWN_REGIONS.map(async (region) => {
      const shard = getServerRegistryShard(env, region);
      const lookupRequest = new Request(`http://internal/servers/lookup?serverId=${encodeURIComponent(serverId)}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await Promise.race([
        shard.fetch(lookupRequest),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), SHARD_FETCH_TIMEOUT)
        ),
      ]);

      if (response.ok) {
        const data = await response.json();
        if (data.found) {
          return region;
        }
      }
      throw new Error('not found');
    })
  );

  // Return the first region where the server was found
  for (const result of results) {
    if (result.status === 'fulfilled') {
      return result.value;
    }
  }

  // Server not found in any shard - use default
  return 'default';
}
