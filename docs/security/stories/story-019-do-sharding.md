# Story 019: Durable Object Sharding for High Availability

## Priority: MEDIUM-TERM
## Severity: MEDIUM
## Component: packages/server

## Summary

All three Durable Object types in the Cloudflare Worker bootstrap server (`SERVER_REGISTRY`, `ATTESTATION_REGISTRY`) use `idFromName('global')` to route all requests to a single global instance. This creates a single point of failure (SPOF) and a concurrency bottleneck: if the single DO instance becomes overloaded, unreachable (Cloudflare edge outage in the colocated region), or enters an error state, the entire bootstrap service is unavailable. Additionally, the single instance means all storage operations are serialized, limiting throughput to what one DO instance can handle.

## Current Behavior

**Server Registry DO routing** (`packages/server/src/index.js`, lines 103-104, 135-136):
```javascript
// GET /servers
const id = env.SERVER_REGISTRY.idFromName('global');
const stub = env.SERVER_REGISTRY.get(id);

// POST /servers, DELETE /servers/:id, POST /servers/heartbeat, etc.
const id = env.SERVER_REGISTRY.idFromName('global');
const stub = env.SERVER_REGISTRY.get(id);
```
The `TODO` comments on lines 101 and 133 acknowledge this limitation:
```javascript
// TODO: Single global instance - acceptable for current scale.
// Consider sharding by region when request volume grows.
```

**Attestation Registry DO routing** (`packages/server/src/index.js`, lines 149-150):
```javascript
const id = env.ATTESTATION_REGISTRY.idFromName('global');
const stub = env.ATTESTATION_REGISTRY.get(id);
```
Also has a TODO comment on line 148:
```javascript
// TODO: Single global instance - acceptable for current scale.
// Consider sharding by device_id prefix when request volume grows.
```

**DO serialization**: Cloudflare Durable Objects process requests serially within a single instance. This means:
- A slow `POST /attest/verify` (with HMAC computation) blocks all other attestation requests
- A `listServers()` call that scans all server entries blocks heartbeat processing
- The `alarm()` handler for cleanup blocks all requests during its execution

**Single-region hosting**: Cloudflare places a DO instance in a single datacenter. If that datacenter has an outage, the DO is unavailable until Cloudflare fails it over (which can take minutes).

**Storage limits**: A single DO instance has a 128KB per-value limit and 10GB total storage limit. While unlikely to be hit for the current use case, a single instance containing all server entries, all device entries, all nonces, all anomaly history, and all trusted keys will hit practical limits faster than a sharded approach.

## Expected Behavior

1. Server registry requests should be sharded by region (e.g., `idFromName('us-east')`, `idFromName('eu-west')`) so that a regional outage only affects that region's servers.
2. Attestation registry requests should be sharded by device_id prefix (e.g., first 2 characters) to distribute load across 256+ DO instances.
3. `GET /servers` should aggregate results from all regional shards.
4. Rate limiting, trusted keys, and version policy should use a separate "admin" DO shard that is not on the critical path for client requests.

## Root Cause Analysis

The `idFromName('global')` pattern was chosen for simplicity during initial development, as noted by the TODO comments in the code. For a small number of servers (< 100) and devices (< 1000), a single instance is adequate. The design assumed that sharding would be added before scale required it.

The challenge with sharding Durable Objects is that cross-shard operations (e.g., listing all servers across all regions) require fan-out requests from the Worker to multiple DO instances, adding latency and complexity. This is why the single-instance pattern was kept despite the known limitations.

## Affected Code

| File | Lines | Description |
|------|-------|-------------|
| `packages/server/src/index.js` | 103-104 | `GET /servers` -- single global DO |
| `packages/server/src/index.js` | 135-136 | Other `/servers/*` routes -- single global DO |
| `packages/server/src/index.js` | 149-150 | All `/attest/*` routes -- single global DO |
| `packages/server/src/durable-objects/server-registry-do.js` | 633-663 | `listServers` -- scans all entries in one DO |
| `packages/server/src/durable-objects/server-registry-do.js` | 769-841 | `heartbeat` -- reads all server entries for fleet analysis |
| `packages/server/src/durable-objects/attestation-registry-do.js` | 599-614 | `handleChallenge` -- scans all nonces to count per-device |

## Reproduction Steps

1. **Single-point failure**:
   - Determine which Cloudflare datacenter hosts the `global` DO instance (visible in response headers or Cloudflare dashboard).
   - If that datacenter experiences an outage, all bootstrap operations fail.
   - There is no failover to another region.

2. **Serialization bottleneck**:
   - Send 100 concurrent `POST /attest/verify` requests.
   - Measure latency: requests are queued and processed serially.
   - P99 latency increases linearly with concurrency.

3. **Alarm blocking**:
   - With 1000 server entries, the `alarm()` handler scans all entries and may delete stale ones.
   - During this scan (which involves multiple DO storage reads and writes), all incoming requests are queued.

## Impact Assessment

- **Availability**: A single DO instance failure takes down the entire bootstrap service for all federation servers and all client attestation.
- **Latency at scale**: With 1000+ servers heartbeating every 60 seconds and 100,000+ devices requesting attestation, the single instance becomes a serialization bottleneck.
- **Attack amplification**: A targeted DDoS against the single DO instance (e.g., via computationally expensive attestation requests) affects all users globally.
- **Blast radius**: Any bug that crashes the DO instance (unhandled exception, storage corruption) affects all functionality simultaneously.

## Proposed Fix

### 1. Server Registry: Shard by region

```javascript
// In index.js:
function getServerRegistryId(env, region) {
  // Normalize region to a shard key
  const shardKey = region || 'default';
  return env.SERVER_REGISTRY.idFromName(`region:${shardKey}`);
}

// For registration (knows region):
const id = getServerRegistryId(env, body.region);
const stub = env.SERVER_REGISTRY.get(id);

// For listing (fan-out):
const KNOWN_REGIONS = ['us-east', 'us-west', 'eu-west', 'eu-central', 'ap-southeast', 'default'];
const results = await Promise.all(
  KNOWN_REGIONS.map(region => {
    const id = getServerRegistryId(env, region);
    return env.SERVER_REGISTRY.get(id).fetch(request).then(r => r.json());
  })
);
const servers = results.flatMap(r => r.servers || []);
```

### 2. Attestation Registry: Shard by device_id prefix

```javascript
function getAttestationRegistryId(env, deviceId) {
  // Use first 2 hex chars of device_id as shard key (256 shards)
  const shardKey = deviceId ? deviceId.substring(0, 2).toLowerCase() : '00';
  return env.ATTESTATION_REGISTRY.idFromName(`shard:${shardKey}`);
}
```

### 3. Separate admin shard for trusted keys and version policy

```javascript
// Trusted keys and version policy go to a dedicated admin shard
// This keeps admin operations off the hot path
function getAdminRegistryId(env) {
  return env.SERVER_REGISTRY.idFromName('admin');
}
```

### 4. Fleet anomaly detection: Move to a separate aggregation shard

The current heartbeat handler reads all server entries for fleet-wide anomaly detection. With regional sharding, fleet analysis requires cross-shard aggregation. This should be done by a periodic "aggregator" Worker that:
1. Queries each regional shard for current metrics
2. Computes fleet-wide statistics
3. Distributes the fleet context back to each shard

## Acceptance Criteria

- [ ] Server registry is sharded by region (at least 5 regional shards + 1 default)
- [ ] Attestation registry is sharded by device_id prefix (256 shards)
- [ ] `GET /servers` aggregates results from all regional shards via fan-out
- [ ] Trusted key management uses a dedicated admin shard
- [ ] Version policy is served from a read-through cache in the Worker (not per-request DO fetch)
- [ ] Regional outage only affects servers in that region, not the entire service
- [ ] Heartbeat latency at P99 does not degrade with concurrent requests
- [ ] Backward compatible: existing storage is migrated to the default shard on first access
- [ ] Fan-out queries handle partial failures (one shard down, others still respond)

## Test Requirements

1. **Shard routing test**: Register servers with different regions, verify they go to correct shards
2. **Fan-out aggregation test**: Servers in 3 different shards, `GET /servers` returns all of them
3. **Partial failure test**: One shard returns an error, verify others still contribute to the response
4. **Device shard routing test**: Devices with different ID prefixes go to correct attestation shards
5. **Admin shard isolation test**: Key update on admin shard doesn't block server registration on regional shards
6. **Migration test**: Existing `global` shard data is accessible via the default regional shard

## Dependencies

- Related: Story 011 (Per-Endpoint Rate Limiting) -- rate limit state needs to account for sharded DOs
- Related: Story 017 (Transparency Log) -- audit log should be in the admin shard, not distributed across regional shards
- Related: Story 020 (IP Reputation Scoring) -- reputation state needs a cross-shard aggregation strategy
- Blocks: None (can be implemented incrementally, starting with server registry)
