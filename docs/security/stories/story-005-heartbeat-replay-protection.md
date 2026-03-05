# Story 005: Add Heartbeat Timestamp/Replay Protection

## Priority: THIS WEEK
## Severity: HIGH
## Component: packages/server (ServerRegistryDO), packages/server-vps (bootstrap-client)

## Summary

Federation heartbeat messages between VPS servers and the Cloudflare Workers bootstrap registry contain no timestamp, nonce, or sequence number. An attacker who captures a valid heartbeat request can replay it indefinitely to keep a stale or decommissioned server entry alive in the registry, inject false metrics into the anomaly detection system, or prevent legitimate TTL-based expiry of compromised nodes.

## Current Behavior

The heartbeat sender in `packages/server-vps/src/federation/bootstrap-client.ts` (lines 126-168) constructs a heartbeat body with only `serverId` and current metrics. There is no timestamp, nonce, or monotonic sequence number:

```typescript
// bootstrap-client.ts:131-137
const heartbeatBody: Record<string, unknown> = {
  serverId: identity.serverId,
  connections: metrics?.connections ?? 0,
  relayConnections: metrics?.relayConnections ?? 0,
  signalingConnections: metrics?.signalingConnections ?? 0,
  activeCodes: metrics?.activeCodes ?? 0,
};
```

The heartbeat handler in `packages/server/src/durable-objects/server-registry-do.js` (lines 706-842) accepts this body and updates `server.lastSeen` to `Date.now()` on the server side (line 733) without any validation of whether the request is fresh or replayed:

```javascript
// server-registry-do.js:733
server.lastSeen = Date.now();
```

No fields in the heartbeat body are checked for freshness. The handler blindly overwrites server metrics and timestamps.

## Expected Behavior

1. Every heartbeat message must include a `timestamp` (sender's wall clock) and a `nonce` (cryptographically random, unique per request).
2. The server must reject heartbeats where:
   - `timestamp` is older than a configurable window (e.g., 2 minutes in the past).
   - `timestamp` is too far in the future (e.g., more than 30 seconds).
   - `nonce` has been seen before within the replay window.
3. Optionally, a monotonic `sequenceNumber` per serverId should be enforced (server rejects heartbeats with a sequence number less than or equal to the last accepted one).
4. The nonce store must be bounded (auto-pruned to prevent memory exhaustion).

## Root Cause Analysis

The heartbeat protocol was designed for simplicity, relying solely on the `SERVER_REGISTRY_SECRET` Bearer token for authentication (line 417-424). However, authentication alone does not provide replay protection. If an attacker captures a single valid heartbeat (e.g., via a compromised network path, server logs, or MITM on a misconfigured deployment), they can:

1. **Keep a dead server alive**: Replaying old heartbeats resets `lastSeen` to the current time (line 733), preventing TTL-based cleanup (the 5-minute `serverTTL` at line 301).
2. **Pollute anomaly detection**: The `AnomalyDetector.analyze()` function (lines 48-118) relies on the accuracy of metrics history. Replayed heartbeats with stale metrics will create false history entries, potentially masking real anomalies or triggering false positives.
3. **Subvert quarantine**: A quarantined server's operator could replay old clean heartbeats to reduce the exponentially-decayed anomaly score (line 814: `existing.score * 0.8`), eventually dropping below the quarantine threshold.

The `register()` call in `bootstrap-client.ts:45-88` also lacks replay protection, but registration is a less frequent operation and typically happens only at startup. Heartbeats are the primary ongoing attack surface since they occur every `heartbeatInterval` (line 183).

Additionally, the heartbeat sender does not include the `SERVER_REGISTRY_SECRET` in requests. Looking at `bootstrap-client.ts:146-149`, the heartbeat POST only sets `Content-Type: application/json` -- no `Authorization` header. The server-side auth check at line 417-423 uses a conditional: `if (this.env.SERVER_REGISTRY_SECRET && !this.verifyServerAuth(request))`, meaning it only enforces auth when the secret is configured. But even when it IS configured, the client never sends it. This is a separate but compounding issue -- if the secret is not sent, the server either rejects all heartbeats (when secret is set) or accepts them without any auth (when secret is not set).

## Affected Code

| File | Lines | Description |
|------|-------|-------------|
| `packages/server-vps/src/federation/bootstrap-client.ts` | 126-168 | `heartbeat()` function -- constructs and sends heartbeat body |
| `packages/server-vps/src/federation/bootstrap-client.ts` | 45-88 | `register()` function -- same replay issue |
| `packages/server/src/durable-objects/server-registry-do.js` | 706-842 | `heartbeat()` handler -- accepts body without freshness checks |
| `packages/server/src/durable-objects/server-registry-do.js` | 733 | `server.lastSeen = Date.now()` -- blindly updates timestamp |
| `packages/server/src/durable-objects/server-registry-do.js` | 769-807 | Anomaly history updated with potentially replayed metrics |

## Reproduction Steps

1. Set up a VPS server registered with the bootstrap registry.
2. Capture a valid heartbeat HTTP request (e.g., from server logs or a network proxy).
3. Stop the VPS server so it should naturally expire from the registry after 5 minutes.
4. Replay the captured heartbeat request repeatedly using `curl` or a script.
5. Observe that the server entry remains alive in the registry indefinitely, with `lastSeen` being updated to the current time on every replay.
6. Query `GET /servers` and confirm the dead server still appears in the list.

## Impact Assessment

- **Registry poisoning**: Dead or compromised servers remain visible to clients querying `GET /servers`, directing users to non-functional or malicious endpoints.
- **Anomaly detection bypass**: Replaying clean-metric heartbeats resets anomaly scores, allowing a compromised server to escape quarantine.
- **Federation integrity**: The SWIM gossip protocol relies on the bootstrap registry as a seed list. Stale entries degrade peer discovery reliability.
- **Blast radius**: All clients using the bootstrap server for federation discovery are affected. In the worst case, a single captured heartbeat can keep a rogue server entry alive forever.

## Proposed Fix

### 1. Client-side (bootstrap-client.ts)

Add `timestamp`, `nonce`, and `sequenceNumber` to every heartbeat:

```typescript
let heartbeatSeq = 0;

async function heartbeat(): Promise<BootstrapServerEntry[]> {
  const url = `${baseUrl}/servers/heartbeat`;
  const metrics = getMetrics?.();

  heartbeatSeq++;

  const heartbeatBody: Record<string, unknown> = {
    serverId: identity.serverId,
    timestamp: Date.now(),
    nonce: crypto.randomUUID(),
    sequenceNumber: heartbeatSeq,
    connections: metrics?.connections ?? 0,
    relayConnections: metrics?.relayConnections ?? 0,
    signalingConnections: metrics?.signalingConnections ?? 0,
    activeCodes: metrics?.activeCodes ?? 0,
  };

  // ... rest of function
}
```

Also add the `Authorization` header with `SERVER_REGISTRY_SECRET` to heartbeat, register, and unregister requests (this is currently missing).

### 2. Server-side (server-registry-do.js)

Add freshness and replay validation in the `heartbeat()` handler:

```javascript
// Constants
const HEARTBEAT_MAX_AGE_MS = 2 * 60 * 1000;  // 2 minutes
const HEARTBEAT_MAX_FUTURE_MS = 30 * 1000;    // 30 seconds
const NONCE_EXPIRY_MS = 5 * 60 * 1000;        // 5 minutes

async heartbeat(request, corsHeaders) {
  const body = await parseJsonBody(request, 2048);
  const { serverId, timestamp, nonce, sequenceNumber } = body;

  // ... existing serverId validation ...

  // Validate timestamp freshness
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return new Response(
      JSON.stringify({ error: 'Missing or invalid timestamp' }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  const now = Date.now();
  const age = now - timestamp;
  if (age > HEARTBEAT_MAX_AGE_MS) {
    return new Response(
      JSON.stringify({ error: 'Heartbeat timestamp too old' }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
  if (age < -HEARTBEAT_MAX_FUTURE_MS) {
    return new Response(
      JSON.stringify({ error: 'Heartbeat timestamp too far in future' }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  // Validate nonce uniqueness
  if (typeof nonce !== 'string' || nonce.length < 16) {
    return new Response(
      JSON.stringify({ error: 'Missing or invalid nonce' }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  const nonceKey = `nonce:${nonce}`;
  const existingNonce = await this.state.storage.get(nonceKey);
  if (existingNonce) {
    return new Response(
      JSON.stringify({ error: 'Replay detected: duplicate nonce' }),
      { status: 409, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
  // Store nonce with TTL (cleaned up by alarm)
  await this.state.storage.put(nonceKey, { timestamp: now });

  // Validate sequence number (monotonic increase)
  if (typeof sequenceNumber === 'number' && Number.isFinite(sequenceNumber)) {
    const server = await this.state.storage.get(`server:${serverId}`);
    if (server && typeof server.lastSequenceNumber === 'number') {
      if (sequenceNumber <= server.lastSequenceNumber) {
        return new Response(
          JSON.stringify({ error: 'Replay detected: stale sequence number' }),
          { status: 409, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
    }
  }

  // ... rest of handler, storing sequenceNumber on server entry ...
}
```

### 3. Nonce cleanup in alarm()

Extend the existing alarm handler to also prune expired nonces:

```javascript
async alarm() {
  // ... existing stale server cleanup ...

  // Clean up expired nonces
  const nonces = await this.state.storage.list({ prefix: 'nonce:' });
  const expiredNonces = [];
  for (const [key, data] of nonces) {
    if (now - data.timestamp >= NONCE_EXPIRY_MS) {
      expiredNonces.push(key);
    }
  }
  // Batch delete expired nonces
  for (let i = 0; i < expiredNonces.length; i += 128) {
    await this.state.storage.delete(expiredNonces.slice(i, i + 128));
  }
}
```

## Acceptance Criteria

- [ ] Heartbeat requests include `timestamp` (ms since epoch), `nonce` (UUID or 128-bit random hex), and `sequenceNumber` (monotonically increasing integer)
- [ ] Server rejects heartbeats with timestamps older than 2 minutes
- [ ] Server rejects heartbeats with timestamps more than 30 seconds in the future
- [ ] Server rejects heartbeats with previously-seen nonces (HTTP 409)
- [ ] Server rejects heartbeats with sequence numbers less than or equal to the last accepted sequence for that serverId
- [ ] Nonces are automatically pruned from storage after 5 minutes by the alarm handler
- [ ] Registration requests also include timestamp and nonce fields
- [ ] Client sends `Authorization: Bearer <SECRET>` header on heartbeat, register, and unregister requests when `SERVER_REGISTRY_SECRET` is configured
- [ ] Existing VPS servers continue to function during rollout (server should accept heartbeats without replay fields during a brief migration window, with a deprecation warning log)

## Test Requirements

- **Unit tests** for timestamp validation: test edge cases around the 2-minute and 30-second boundaries.
- **Unit tests** for nonce deduplication: send two heartbeats with the same nonce, assert the second is rejected with 409.
- **Unit tests** for sequence number enforcement: send a heartbeat with seq=5, then seq=3, assert the second is rejected.
- **Integration test**: Capture a heartbeat request, wait for it to age past the window, replay it, assert rejection.
- **Alarm test**: Verify nonce cleanup removes entries older than 5 minutes without affecting fresh entries.
- **Migration test**: Verify that heartbeats without the new fields are handled gracefully during the migration window (accepted with a warning log, or rejected with a clear error depending on migration phase).

## Dependencies

- No blocking dependencies on other stories.
- This story should be implemented alongside fixing the missing `Authorization` header in `bootstrap-client.ts` for heartbeat/register/unregister calls. That missing header is a prerequisite for the replay protection to be meaningful -- without auth, an attacker can craft their own heartbeats anyway.
