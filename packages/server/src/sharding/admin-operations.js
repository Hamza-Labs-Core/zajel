/**
 * Admin Shard Operations
 *
 * Trusted keys and version policy are stored in a dedicated admin shard
 * to keep admin operations off the hot path for client attestation.
 */

/**
 * Get the admin shard for server registry operations (trusted keys).
 *
 * @param {object} env - Cloudflare Worker environment
 * @returns {DurableObjectStub}
 */
export function getServerRegistryAdminShard(env) {
  const id = env.SERVER_REGISTRY.idFromName('admin');
  return env.SERVER_REGISTRY.get(id);
}

/**
 * Get the admin shard for attestation registry operations (version policy).
 * This is the single authoritative source for getAttestationAdminShard.
 *
 * @param {object} env - Cloudflare Worker environment
 * @returns {DurableObjectStub}
 */
export function getAttestationAdminShard(env) {
  const id = env.ATTESTATION_REGISTRY.idFromName('admin');
  return env.ATTESTATION_REGISTRY.get(id);
}
