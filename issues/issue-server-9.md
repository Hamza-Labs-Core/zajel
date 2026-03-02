# [HIGH] Unbounded storage growth in device and server registrations

**Area**: Server
**File**: packages/server/src/durable-objects/attestation-registry-do.js:217, packages/server/src/durable-objects/server-registry-do.js:82
**Type**: Security

**Description**: Both `device:{device_id}` entries in `AttestationRegistryDO` and `server:{serverId}` entries in `ServerRegistryDO` grow without bound. While server entries have TTL-based cleanup during `listServers()`, this cleanup only runs when someone calls `GET /servers`. Device entries have no expiration or cleanup mechanism at all.

The `serverId` and `device_id` values come directly from client input with no format validation, so an attacker can use random UUIDs to create unlimited unique entries.

**Impact**:
- Unbounded Durable Object storage consumption leading to increased billing costs.
- Degraded performance as `storage.list()` operations slow down with millions of keys.
- Potential denial of service if storage limits are hit.

**Fix**:
1. Add an alarm-based cleanup for stale server entries in `ServerRegistryDO`.
2. Add TTL and periodic cleanup for device entries in `AttestationRegistryDO`.
3. Validate `serverId` and `device_id` format and length (e.g., max 64 chars, alphanumeric + hyphens only).
4. Consider adding a maximum number of entries and rejecting new registrations when the limit is reached.
