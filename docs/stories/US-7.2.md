# US-7.2: Bad Client Detection

## Story
As an admin, I want to see clients that send malformed messages or fail signature verification, so that I can identify potentially malicious actors, investigate abuse patterns, and optionally quarantine repeat offenders to protect the network.

## Acceptance Criteria
- Table of anomalous client behaviors showing: source hash, violation type, violation count, first seen, last seen, and quarantine status
- Violation types include: malformed JSON messages, invalid message schema, invalid pairing code format, invalid public key format/length, peerId mismatch, oversized messages, attestation failures, and signature verification failures
- Sortable by violation count (descending by default) and recency
- Filterable by violation type and time range
- Auto-quarantine toggle (super-admin only): when enabled, clients exceeding a configurable threshold (default: 50 violations per hour) are automatically blocked for a configurable duration (default: 1 hour)
- Manual quarantine button per client row (super-admin only) to immediately block a source
- Quarantined clients receive a WebSocket close with code 4403 and reason "Quarantined" on new connection attempts
- Quarantine state stored in KV with TTL-based expiry
- Dashboard auto-refreshes every 30 seconds

## Technical Design

### Architecture
Bad client detection spans two layers:

1. **VPS server** (`packages/server-vps/`) -- the `ClientHandler` already validates every incoming message (JSON parsing, schema validation, peerId consistency, pairing code format, public key format). Each validation failure is currently an error response sent back to the client. This story adds event emission for every such failure, tracked per source hash.

2. **Admin portal** (`packages/admin-cf/`) -- aggregates bad client events from D1 and exposes them via API. Manages quarantine state in KV (shared across VPS servers via a simple lookup mechanism).

The quarantine enforcement path is: VPS server checks KV-backed quarantine list on new WebSocket connection (before processing any messages). If the source hash is quarantined, the connection is immediately closed.

### Implementation Details

**VPS-side: Bad client event tracking**

Extend `SecurityEventCollector` (from US-7.1) to also track bad client events. Each validation failure in `ClientHandler.handleMessage()` and `ClientHandler.validateMessage()` emits an event with the violation type and a hashed source identifier.

The source identifier is derived from the WebSocket's remote IP address, hashed with SHA-256 and truncated. Since Zajel does not store user identifiers, IP-based hashing is the only viable approach for tracking bad actors across connections.

**Bad client event types (mapped to existing validation code):**

| Violation Type | Source Code Location | Current Behavior |
|---|---|---|
| `malformed_json` | `handler.ts` line 434-438 (JSON.parse catch) | Sends error response |
| `invalid_schema` | `handler.ts` line 441-445 (validateMessage) | Sends error response |
| `invalid_pairing_code` | `signaling-handler.ts` line 141-143 (PAIRING_CODE.REGEX) | Sends error response |
| `invalid_public_key` | `signaling-handler.ts` lines 152-168 (base64/length) | Sends error response |
| `peer_id_mismatch` | `handler.ts` lines 449-456 (peerId consistency) | Sends error response |
| `oversized_message` | `handler.ts` lines 418-423 (MAX_MESSAGE_SIZE) | Close with 1009 |
| `attestation_failure` | `attestation-handler.ts` (attestation checks) | Close with 4001 |
| `unknown_message_type` | `handler.ts` line 604 (default case) | Sends error response |

**Quarantine enforcement:**

On new WebSocket connection in `packages/server-vps/src/index.ts`, before any message processing:
1. Hash the client IP (same algorithm as tracking)
2. Check an in-memory quarantine cache (refreshed from a central source every 30 seconds)
3. If quarantined, close with code 4403

The quarantine list is managed by the admin portal in KV and pushed to VPS servers via the existing admin WebSocket channel (the VPS already connects to the CF admin for metrics). Alternatively, VPS servers can poll a lightweight quarantine endpoint.

**Admin portal: Bad clients API and UI**

New API endpoints query D1 for aggregated bad client data. The UI renders a data table within the Security tab.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/server-vps/src/admin/security-events.ts` | Modify | Add bad client event recording and per-source aggregation (extends US-7.1 work) |
| `packages/server-vps/src/admin/quarantine.ts` | Create | `QuarantineManager` -- in-memory cache of quarantined source hashes with periodic sync |
| `packages/server-vps/src/admin/types.ts` | Modify | Add `BadClientEvent`, `BadClientAggregate`, `QuarantineEntry` types |
| `packages/server-vps/src/client/handler.ts` | Modify | Emit bad client events from each validation failure path |
| `packages/server-vps/src/client/signaling-handler.ts` | Modify | Accept a callback for bad client events on pairing code / public key validation failures |
| `packages/server-vps/src/index.ts` | Modify | Add quarantine check on WebSocket connection; wire `QuarantineManager` |
| `packages/admin-cf/src/routes/security.ts` | Modify | Add `/admin/api/security/bad-clients` and `/admin/api/security/quarantine` endpoints |
| `packages/admin-cf/src/index.ts` | Modify | Register quarantine routes |
| `packages/diagnostics-cf/migrations/0002_bad_clients.sql` | Create | D1 migration for `bad_client_events` table |

### Data Models / Schemas

**D1 Table: `bad_client_events`**

```sql
CREATE TABLE bad_client_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time_bucket TEXT NOT NULL,              -- ISO datetime truncated to minute
  server_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,              -- Truncated SHA-256 of client IP
  violation_type TEXT NOT NULL,           -- 'malformed_json' | 'invalid_schema' | 'invalid_pairing_code' | 'invalid_public_key' | 'peer_id_mismatch' | 'oversized_message' | 'attestation_failure' | 'unknown_message_type'
  count INTEGER NOT NULL DEFAULT 1,
  sample_message TEXT,                    -- Truncated error message (no PII)
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  UNIQUE(time_bucket, server_id, source_hash, violation_type)
);

CREATE INDEX idx_bce_source ON bad_client_events(source_hash);
CREATE INDEX idx_bce_time ON bad_client_events(time_bucket);
CREATE INDEX idx_bce_type ON bad_client_events(violation_type);
```

**KV: Quarantine entries**

Key pattern: `quarantine:{source_hash}`
Value: JSON `{ "reason": "auto|manual", "quarantinedAt": 1709474400000, "expiresAt": 1709478000000, "quarantinedBy": "system|admin_username" }`
TTL: Set on the KV entry itself (matching `expiresAt`)

**TypeScript types:**

```typescript
interface BadClientEvent {
  timestamp: number;
  sourceHash: string;
  violationType: string;
  serverId: string;
  sampleMessage?: string;
}

interface BadClientAggregate {
  sourceHash: string;
  totalViolations: number;
  violationTypes: Record<string, number>;
  firstSeen: number;
  lastSeen: number;
  isQuarantined: boolean;
  quarantineExpires?: number;
}

interface QuarantineEntry {
  sourceHash: string;
  reason: 'auto' | 'manual';
  quarantinedAt: number;
  expiresAt: number;
  quarantinedBy: string;
}

interface QuarantineConfig {
  autoQuarantineEnabled: boolean;
  violationThreshold: number;      // default: 50
  thresholdWindowMinutes: number;  // default: 60
  quarantineDurationMinutes: number; // default: 60
}
```

### API Endpoints

**`GET /admin/api/security/bad-clients`**

Query parameters:
- `since` (optional): Unix timestamp (default: 24 hours ago)
- `until` (optional): Unix timestamp (default: now)
- `type` (optional): Filter by violation type
- `sortBy` (optional): `count` | `lastSeen` (default: `count`)
- `limit` (optional): Max results (default: 100)

Response:
```json
{
  "success": true,
  "data": {
    "clients": [
      {
        "sourceHash": "a1b2c3d4",
        "totalViolations": 127,
        "violationTypes": {
          "malformed_json": 80,
          "invalid_schema": 47
        },
        "firstSeen": 1709470800000,
        "lastSeen": 1709474400000,
        "isQuarantined": false,
        "quarantineExpires": null
      }
    ],
    "summary": {
      "totalBadClients": 12,
      "totalViolations": 450,
      "quarantinedCount": 2
    }
  }
}
```

Auth: Requires valid JWT (admin or super-admin role).

**`POST /admin/api/security/quarantine`**

Request body:
```json
{
  "sourceHash": "a1b2c3d4",
  "durationMinutes": 60,
  "reason": "Repeated malformed messages"
}
```

Response:
```json
{
  "success": true,
  "data": {
    "sourceHash": "a1b2c3d4",
    "quarantinedAt": 1709474400000,
    "expiresAt": 1709478000000
  }
}
```

Auth: Requires super-admin role.

**`DELETE /admin/api/security/quarantine/:sourceHash`**

Removes quarantine for a specific source hash.

Auth: Requires super-admin role.

**`GET /admin/api/security/quarantine/config`**

Returns current auto-quarantine configuration.

Auth: Requires super-admin role.

**`POST /admin/api/security/quarantine/config`**

Updates auto-quarantine configuration.

Auth: Requires super-admin role.

## Dependencies
- **US-7.1** (Rate Limit Violation Dashboard) -- the `SecurityEventCollector` class and D1 security events infrastructure must exist
- **US-1.1** (Diagnostics Ingestion) -- D1 and KV bindings must be configured
- **Admin Portal SPA migration** -- the Security tab must exist in the tabbed dashboard

## Testing Strategy
- **Unit tests**: `SecurityEventCollector` -- verify bad client event recording, per-source aggregation, and threshold detection. `QuarantineManager` -- test cache lookup, TTL expiry, auto-quarantine trigger logic.
- **Integration tests**: Send a sequence of malformed WebSocket messages to VPS; verify events appear in security API. Test quarantine enforcement: add a source hash to quarantine, attempt connection from that "IP" (mock), verify WebSocket closes with 4403.
- **E2E tests**: Send 60 malformed JSON messages from a test client; verify the client appears in the bad clients table with correct violation count. Test manual quarantine via API and verify subsequent connections are refused.

## Technical Notes

**Existing patterns to follow:**
- The `requireSuperAdmin()` middleware in `packages/admin-cf/src/routes/auth.ts` (line 114) already enforces super-admin role checks. Use this for quarantine management endpoints.
- The `ClientHandler.validateMessage()` method (`packages/server-vps/src/client/handler.ts`, lines 319-411) is the central validation point. It returns an error string on failure. The calling code (line 441-445) sends the error. Add event emission at this same point.
- The `SignalingHandler` constructor accepts a deps object with callbacks (`packages/server-vps/src/client/signaling-handler.ts`, line 31). Add a `recordBadClientEvent` callback to the deps interface.
- Per-IP tracking already exists in `packages/server-vps/src/index.ts` (line 304, `ipConnectionCounts` Map). The quarantine check naturally fits alongside this check.

**Privacy considerations:**
- Source hashes are truncated SHA-256 of IP addresses. This means approximately 2^32 IPs map to 2^32 possible hashes (no collision concern at practical scale), but the hash is not reversible to an IP.
- The `sample_message` field in D1 stores only the validation error message (e.g., "register: peerId must be a string"), never the actual message content from the client.
- Quarantine applies to the hashed IP, not to any user identity. CGNAT users sharing an IP may be collateral, so quarantine durations should default to short periods (1 hour).

**Best practices from external research:**
- Modern brute force attackers throttle attempts to stay under alerting thresholds. The auto-quarantine threshold should be tunable, and the dashboard should show trend lines per source so admins can spot slow-and-steady abuse patterns.
- Machine learning-based anomaly detection is ideal but complex; for V1, a simple threshold-based approach is sufficient. The threshold should be configurable per violation type (e.g., malformed JSON is higher signal than unknown message type).

## Estimation
**L (Large)** -- This story requires changes across multiple layers (VPS client handler, signaling handler, security collector, admin API, KV quarantine, and dashboard UI). The quarantine enforcement path is a new cross-system feature (admin KV to VPS connection check). The number of validation points to instrument in `ClientHandler` and `SignalingHandler` is significant. Testing requires mocking multiple failure paths.
