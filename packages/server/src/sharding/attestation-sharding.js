/**
 * Attestation Registry Sharding Logic
 *
 * Routes attestation requests to shards based on device_id prefix.
 * Uses first 2 hex characters for 256-way sharding.
 */

/**
 * Get the shard ID for a given device_id.
 * Uses first 2 hex characters to distribute across 256 shards.
 *
 * @param {object} env - Cloudflare Worker environment
 * @param {string|null} deviceId - Device identifier
 * @returns {DurableObjectId}
 */
export function getAttestationShardId(env, deviceId) {
  // Extract first 2 characters for shard key (00-ff for 256 shards)
  // Default to '00' for invalid/missing device_id
  let shardKey = '00';

  if (typeof deviceId === 'string' && deviceId.length >= 2) {
    // Take first 2 chars, lowercase, and validate hex
    const prefix = deviceId.substring(0, 2).toLowerCase();
    if (/^[0-9a-f]{2}$/.test(prefix)) {
      shardKey = prefix;
    }
  }

  const shardName = `device-shard:${shardKey}`;
  return env.ATTESTATION_REGISTRY.idFromName(shardName);
}

/**
 * Get stub for attestation shard handling a specific device.
 *
 * @param {object} env - Cloudflare Worker environment
 * @param {string} deviceId - Device identifier
 * @returns {DurableObjectStub}
 */
export function getAttestationShard(env, deviceId) {
  const id = getAttestationShardId(env, deviceId);
  return env.ATTESTATION_REGISTRY.get(id);
}

/**
 * Parse device_id from request body for shard routing.
 * Returns null if body cannot be parsed or device_id is missing.
 * This is a non-consuming peek - request body is not consumed.
 *
 * @param {Request} request - The incoming request
 * @returns {Promise<string|null>}
 */
export async function extractDeviceIdFromRequest(request) {
  try {
    // Clone request to avoid consuming body
    const clonedRequest = request.clone();

    // Check content type
    const contentType = clonedRequest.headers.get('Content-Type') || '';
    if (!contentType.includes('application/json')) {
      return null;
    }

    const body = await clonedRequest.json();
    return body.device_id || null;
  } catch (e) {
    // Invalid JSON or missing device_id
    return null;
  }
}
