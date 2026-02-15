# Plan: Single global Durable Object instance is a single point of failure

**Issue**: issue-server-24.md
**Severity**: MEDIUM
**Area**: Server
**Files to modify**: `packages/server/src/index.js`, `packages/server/src/durable-objects/server-registry-do.js`, `packages/server/src/durable-objects/attestation-registry-do.js`

## Analysis

In `packages/server/src/index.js`, all Durable Object routing uses a single global instance per type:

- Line 89: `const id = env.SERVER_REGISTRY.idFromName('global');` (for GET /servers)
- Line 119: `const id = env.SERVER_REGISTRY.idFromName('global');` (for all other /servers/* routes)
- Line 126: `const id = env.ATTESTATION_REGISTRY.idFromName('global');` (for all /attest/* routes)

This means all server registry operations and all attestation operations are serialized through a single Durable Object instance each. Cloudflare DOs process requests sequentially within a single instance.

Currently the system has two active DO types (per `wrangler.jsonc` lines 11-20):
- `ServerRegistryDO` (binding: `SERVER_REGISTRY`)
- `AttestationRegistryDO` (binding: `ATTESTATION_REGISTRY`)

## Fix Steps

This is an architectural improvement that should be implemented incrementally:

### Phase 1: Document and assess (immediate)
1. Add a code comment in `index.js` at lines 89, 119, and 126 acknowledging the single-instance limitation and noting it is acceptable for current scale.

### Phase 2: Shard ServerRegistryDO (when scale demands)
1. Shard by region: Use `env.SERVER_REGISTRY.idFromName(region)` where `region` comes from the request body or a geo header (`request.cf.continent` or `request.cf.country`).
2. For `GET /servers`, fan out to all known region shards and aggregate results.
3. For `POST /servers`, route to the region shard based on the `region` field in the request body.
4. For `DELETE /servers/:id`, either store a region-to-server mapping or broadcast the delete.

### Phase 3: Shard AttestationRegistryDO (when scale demands)
1. Shard by `device_id` prefix: Use `env.ATTESTATION_REGISTRY.idFromName(device_id.substring(0, 2))` to distribute across 256 shards.
2. Challenge and verify operations already include `device_id`, so routing is straightforward.
3. `upload-reference` and `version_policy` are admin operations that could stay on a dedicated admin shard or be replicated to all shards.

### Phase 1 Implementation (recommended now)
1. In `index.js`, add comments at lines 89, 119, 126:
```js
// TODO: Single global instance - acceptable for current scale.
// Consider sharding by region/device_id prefix when request volume grows.
```

## Testing

- For Phase 1: No functional changes, just comments.
- For Phase 2/3 (future): Load testing to verify sharded routing correctly distributes requests and aggregates responses.

## Risk Assessment

- **Phase 1 (comments only)**: Zero risk.
- **Phase 2/3 (sharding)**: Significant architectural change. Requires careful handling of cross-shard queries (e.g., listing all servers across regions), data migration, and version policy replication. Should only be implemented when actual load justifies the complexity.
- The current single-instance design is acceptable for early-stage deployment with limited server count and attestation traffic.
