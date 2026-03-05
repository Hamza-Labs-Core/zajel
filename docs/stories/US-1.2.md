# US-1.2: Client Heartbeat for Active Counting

## Story

As a Zajel app, I want to periodically send an anonymous heartbeat, so that the admin portal can show accurate active client counts.

## Acceptance Criteria

- POST to `/diagnostics/heartbeat` with `sessionHash`, `platform`, `appVersion`, and `connectionType` returns HTTP 200.
- Heartbeats are stored in the D1 `client_heartbeats` table, keyed by `sessionHash`.
- Repeated heartbeats from the same `sessionHash` update `last_seen` and `connection_type` without creating duplicate rows (UPSERT).
- Expired heartbeats (where `last_seen` is older than 10 minutes) are excluded from active client counts.
- Rate limiting: maximum 1 heartbeat per `sessionHash` per 5 minutes. Early heartbeats return HTTP 429.
- KV counters are updated on each heartbeat for fast dashboard reads: `active_clients_total`, `active_clients_{platform}`, `active_clients_version_{appVersion}`.
- KV counters have a TTL of 15 minutes so stale counts auto-expire.
- Missing or invalid `sessionHash` returns HTTP 400.
- Missing `platform` or `appVersion` returns HTTP 400.
- No IP address or persistent identifier is stored.
- CORS headers are present on all responses.

## Technical Design

### Architecture

The heartbeat endpoint extends the `packages/diagnostics-cf/` Worker created in US-1.1. It provides a lightweight keep-alive signal that the admin dashboard (Epic 4) uses to display active client counts without identifying individual users.

```
Flutter App --POST /diagnostics/heartbeat--> [diagnostics-cf Worker]
                                               |
                                               +--> D1: client_heartbeats (UPSERT)
                                               +--> KV: active_clients_* counters (TTL 15min)
```

The heartbeat flow is intentionally separated from the diagnostic report flow (US-1.1) because heartbeats are high-frequency (every 5 minutes) and low-payload, while reports are lower-frequency and carry substantial data. Keeping them as separate endpoints allows independent rate limiting and optimized handling.

### Implementation Details

**Handler function** (`handlers/heartbeat.ts`) receives the POST request, validates the body, checks the rate limit, then performs two async operations via `ctx.waitUntil()`:

1. **D1 UPSERT** into `client_heartbeats`: Updates `last_seen`, `connection_type`, and `app_version` if the session already exists, or inserts a new row with `session_start = now`.
2. **KV counter update**: Reads the current counter from KV, increments it, and writes back with a 15-minute TTL. This is a best-effort counter -- eventual consistency is acceptable since the dashboard displays approximate numbers.

**Rate limiting** uses the same approach as US-1.1. Since the native Rate Limiting binding only supports 10-second or 60-second periods, the 5-minute heartbeat rate limit is implemented by checking the `last_seen` timestamp in D1. If `now - last_seen < 300000` (5 minutes in ms), return 429. This is a simple and accurate approach that avoids KV's eventual consistency issues for rate limiting.

**Active client query** (used by the admin dashboard) runs: `SELECT COUNT(*) FROM client_heartbeats WHERE last_seen > ?` with the threshold being `now - 600000` (10 minutes). This query is served by the admin portal (Epic 4) but the data is written here.

**Stale heartbeat cleanup** is handled by a periodic task. The log-processor-cf cron job (Epic 6) or a dedicated D1 cleanup query runs `DELETE FROM client_heartbeats WHERE last_seen < ?` with a 1-hour threshold to prevent unbounded table growth. This cleanup is not part of the heartbeat request path -- it happens asynchronously.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/diagnostics-cf/src/handlers/heartbeat.ts` | Create | POST `/diagnostics/heartbeat` handler |
| `packages/diagnostics-cf/src/index.ts` | Modify | Add route for `/diagnostics/heartbeat` |
| `packages/diagnostics-cf/src/types.ts` | Modify | Add `HeartbeatRequest` interface |
| `packages/diagnostics-cf/src/counters.ts` | Create | KV counter update/read logic |
| `packages/diagnostics-cf/tests/unit/heartbeat.test.ts` | Create | Unit tests for heartbeat handler |
| `packages/diagnostics-cf/tests/unit/counters.test.ts` | Create | Unit tests for KV counter logic |

### Data Models / Schemas

**HeartbeatRequest (request body):**

```typescript
interface HeartbeatRequest {
  sessionHash: string;                                          // SHA-256 hex, 64 chars
  platform: 'android' | 'ios' | 'windows' | 'macos' | 'linux' | 'web';
  appVersion: string;                                           // semver
  connectionType?: 'direct_p2p' | 'relay' | 'none';
}
```

**D1 Table (already created in US-1.1 schema):**

```sql
-- client_heartbeats table (from US-1.1 schema.sql)
CREATE TABLE IF NOT EXISTS client_heartbeats (
  session_hash TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  connection_type TEXT,
  region TEXT,
  last_seen INTEGER NOT NULL,
  session_start INTEGER NOT NULL
);

-- Index for active client queries
CREATE INDEX IF NOT EXISTS idx_heartbeats_last_seen
  ON client_heartbeats(last_seen);

-- Index for platform breakdown queries
CREATE INDEX IF NOT EXISTS idx_heartbeats_platform
  ON client_heartbeats(platform, last_seen);

-- Index for version adoption queries
CREATE INDEX IF NOT EXISTS idx_heartbeats_version
  ON client_heartbeats(app_version, last_seen);
```

**KV Keys:**

| Key | Value | TTL | Purpose |
|-----|-------|-----|---------|
| `active_clients:total` | Integer count | 15 min | Total active clients |
| `active_clients:platform:{platform}` | Integer count | 15 min | Per-platform count |
| `active_clients:version:{appVersion}` | Integer count | 15 min | Per-version count |
| `active_clients:connection:{connectionType}` | Integer count | 15 min | Per-connection-type count |

### API Endpoints

**POST /diagnostics/heartbeat**

Request:
```json
{
  "sessionHash": "a1b2c3...",
  "platform": "android",
  "appVersion": "1.2.3",
  "connectionType": "direct_p2p"
}
```

Response (200):
```json
{
  "success": true,
  "data": {
    "nextHeartbeatMs": 300000
  }
}
```

The `nextHeartbeatMs` field tells the client when to send the next heartbeat, allowing the server to adjust the interval dynamically if needed.

Response (400 -- invalid request):
```json
{
  "success": false,
  "error": "Missing required field: sessionHash"
}
```

Response (429 -- too frequent):
```json
{
  "success": false,
  "error": "Heartbeat too frequent. Next allowed in 180 seconds."
}
```

## Dependencies

- **US-1.1** -- The heartbeat handler is added to the diagnostics Worker created in US-1.1. It relies on the D1 database, KV namespace, Worker scaffold, CORS, and `client_heartbeats` table schema defined there.
- **External dependencies:**
  - Same as US-1.1 (Cloudflare D1, KV, wrangler)

## Testing Strategy

- **Unit tests (`heartbeat.test.ts`):**
  - Valid heartbeat request returns 200 and correct response shape.
  - Missing `sessionHash` returns 400.
  - Missing `platform` returns 400.
  - Missing `appVersion` returns 400.
  - Invalid `platform` value (e.g., `"playstation"`) returns 400.
  - `sessionHash` not a 64-character hex string returns 400.
  - Repeated heartbeat from the same session updates `last_seen` (not creates a duplicate).
  - Heartbeat within 5 minutes of last one returns 429 with correct retry-after seconds.
  - Heartbeat after 5 minutes succeeds (200).
- **Unit tests (`counters.test.ts`):**
  - Counter increment writes to KV with correct key and TTL.
  - Counter reads return the correct value.
  - Missing counter key returns 0.
- **Integration tests:**
  - Submit heartbeat, query D1 to verify row was written with correct fields.
  - Submit two heartbeats with different `connectionType`, verify `connection_type` was updated.
  - Submit heartbeat, advance time by 11 minutes, verify the session is excluded from active count query.
  - Submit heartbeats from 3 different platforms, verify KV counters reflect 3 distinct platforms.

## Technical Notes

**Codebase patterns to follow:**
- The handler follows the same pattern as `handlers/report.ts` from US-1.1: validate body, apply rate limit, perform writes via `waitUntil()`, return JSON response.
- KV operations should use `env.DIAGNOSTICS_KV.put(key, value, { expirationTtl: 900 })` (15 minutes in seconds).
- The `region` field in `client_heartbeats` is populated from the `CF-IPCountry` header or `request.cf?.colo` (Cloudflare data center code). This is the edge location code, not the user's location -- it indicates which CF colo handled the request. This is acceptable for regional distribution analytics.

**External best practices applied:**
- KV counters are eventually consistent (up to 60 seconds). The dashboard should display these as approximate counts. For exact counts, the dashboard can fall back to a D1 `SELECT COUNT(*)` query, which is slower but precise.
- The heartbeat endpoint is intentionally lean -- no R2 writes, minimal D1 interaction -- to keep latency low and cost minimal at high frequency.
- KV TTL-based expiry ensures stale counters do not persist if the Worker stops receiving heartbeats (e.g., during an outage).

**Gotchas:**
- D1 `INSERT OR REPLACE` on a table with a `PRIMARY KEY` will replace the entire row, including `session_start`. Use `INSERT ... ON CONFLICT(session_hash) DO UPDATE SET last_seen = excluded.last_seen, connection_type = excluded.connection_type, app_version = excluded.app_version` to preserve `session_start`.
- KV counter increment is not atomic. Two concurrent heartbeats could read the same count and both write `count + 1` instead of `count + 2`. This is acceptable for approximate counters. For exact counts, the D1 query is the source of truth.
- The `CF-IPCountry` header is not always present (e.g., in local development). Handle `null` gracefully by defaulting to `"unknown"`.

## Estimation

**S (Small)** -- This story adds a single handler to the existing Worker, with a straightforward D1 UPSERT, simple KV counter writes, and basic validation. The D1 schema is already defined in US-1.1. Most of the complexity is in the rate-limit-by-timestamp logic.
