# US-4.1: Anonymous Active Client Count

## Story
As an admin, I want to see total active clients without identifying individuals, so that I can gauge real-time platform adoption and usage without compromising user privacy.

## Acceptance Criteria
- Dashboard displays a single prominent number showing the count of currently active clients
- Active clients are defined as those whose heartbeat was received within the last 10 minutes
- A 24-hour sparkline chart is rendered beside the count, showing the trend over the past day
- No personally identifiable information is stored or displayed — counts are derived from ephemeral session hashes
- The count auto-refreshes every 30 seconds without requiring a page reload
- When no heartbeat data exists (cold start), the dashboard shows "0" with a "No data" indicator
- The API endpoint returns the current count, plus an array of historical counts (one per 5-minute bucket for the last 24 hours) for the sparkline

## Technical Design

### Architecture
This story adds a new "Active Clients" tab to the admin-cf portal and a backing API endpoint. The data flows as follows:

1. Flutter apps send anonymous heartbeats to the diagnostics-cf worker (`POST /diagnostics/heartbeat`) — implemented in US-1.2
2. The diagnostics-cf worker upserts into the `client_heartbeats` D1 table (keyed by `session_hash`) with a `last_seen` timestamp
3. The admin-cf worker exposes `GET /admin/api/clients/active` which queries D1 for active sessions (last_seen within 10 minutes) and historical bucketed counts from KV
4. The admin-cf dashboard renders the count and sparkline in a new Active Clients tab

The admin-cf worker connects to the diagnostics D1 database via a shared D1 binding (`DIAGNOSTICS_DB`).

### Implementation Details

**Backend — API Route (`packages/admin-cf/src/routes/clients.ts`):**

Create a new route handler following the pattern in `routes/servers.ts`:
- `handleActiveClients(request, env)` — queries D1 for current active count and KV for sparkline data
- Uses `requireAuth()` from `routes/auth.ts` for JWT verification
- Returns `{ success: true, data: { activeCount, sparkline } }`

**Active Count Query (D1):**
```sql
SELECT COUNT(*) as active_count
FROM client_heartbeats
WHERE last_seen > ?
-- Parameter: Date.now() - 10 * 60 * 1000 (10 minutes ago)
```

**Sparkline Data (KV):**
Store a rolling 24h time-series of active counts in KV under key `active_clients:sparkline`. Each entry is a 5-minute bucket: `{ timestamp: number, count: number }`. The diagnostics-cf heartbeat handler updates this on each heartbeat ingestion cycle. The admin-cf reads it via KV.

Alternatively, compute sparkline from D1 on each request:
```sql
SELECT
  (last_seen / 300000) * 300000 AS bucket,
  COUNT(DISTINCT session_hash) AS count
FROM client_heartbeats
WHERE last_seen > ?
GROUP BY bucket
ORDER BY bucket ASC
-- Parameter: Date.now() - 24 * 60 * 60 * 1000 (24 hours ago)
```

**Frontend — Dashboard Component:**

Add the Active Clients tab to the dashboard's tab bar in `serveDashboard()` (or in the future Preact SPA). The tab renders:
- A large `stat-value` number (following existing `.stat-card` / `.metric-value` CSS classes)
- An inline SVG sparkline beside it — a simple polyline rendered from the sparkline array

The sparkline implementation uses a zero-dependency inline SVG approach (following the pattern already used in the VPS dashboard's `drawConnectionChart()` function). The SVG is approximately 200px wide x 40px tall, rendered as a `<polyline>` with the data points mapped to x/y coordinates.

**Auto-refresh:**
Use `setInterval` at 30-second intervals to re-fetch `/admin/api/clients/active` and re-render the count + sparkline. This follows the same polling pattern the existing server tab uses (via `loadData()`).

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/admin-cf/src/routes/clients.ts` | Create | New route handler for active client endpoints |
| `packages/admin-cf/src/index.ts` | Modify | Add routing for `/admin/api/clients/active`, add Active Clients tab to dashboard |
| `packages/admin-cf/src/types.ts` | Modify | Add `ActiveClientsResponse`, `SparklineEntry` types; extend `Env` with `DIAGNOSTICS_DB` binding |
| `packages/admin-cf/wrangler.jsonc` | Modify | Add `d1_databases` binding for `DIAGNOSTICS_DB` and `kv_namespaces` for `ADMIN_KV` |
| `packages/admin-cf/tests/clients.test.ts` | Create | Unit tests for the active clients route handler |

### Data Models / Schemas

**D1 Table (already defined in plan section 4.1, used here for reads):**
```sql
CREATE TABLE client_heartbeats (
  session_hash TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  connection_type TEXT,
  region TEXT,
  last_seen INTEGER NOT NULL,
  session_start INTEGER NOT NULL
);
```

**API Response Schema:**
```typescript
interface ActiveClientsResponse {
  activeCount: number;           // Clients with heartbeat in last 10 min
  sparkline: SparklineEntry[];   // 24h of 5-minute buckets
  lastUpdated: number;           // Timestamp of query
}

interface SparklineEntry {
  timestamp: number;  // Start of 5-minute bucket (Unix ms)
  count: number;      // Distinct active sessions in that bucket
}
```

**KV Key (optional optimization):**
```
Key:   active_clients:sparkline
Value: JSON array of SparklineEntry (max 288 entries = 24h / 5min)
TTL:   86400 (24 hours)
```

### API Endpoints

**`GET /admin/api/clients/active`**

- **Auth:** Bearer JWT (admin or super-admin)
- **Request:** No body; optional query param `?hours=24` (default 24, max 168)
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "activeCount": 42,
    "sparkline": [
      { "timestamp": 1709380800000, "count": 38 },
      { "timestamp": 1709381100000, "count": 40 },
      { "timestamp": 1709381400000, "count": 42 }
    ],
    "lastUpdated": 1709384400000
  }
}
```
- **Response (401):** `{ "success": false, "error": "Unauthorized" }`
- **Response (502):** `{ "success": false, "error": "Failed to query diagnostics database" }`

## Dependencies
- **US-1.2 (Client Heartbeat for Active Counting):** The heartbeat endpoint in diagnostics-cf must exist and be populating the `client_heartbeats` D1 table before this dashboard can show meaningful data
- **D1 database provisioning:** The `zajel-diagnostics` D1 database must be created and the schema applied
- **Admin-cf wrangler.jsonc update:** D1 binding must be added (can be done as part of this story)

## Testing Strategy

### Unit Tests
- Test `handleActiveClients` with mocked D1 binding returning various counts (0, 1, 1000)
- Test that expired heartbeats (older than 10 minutes) are excluded from the count
- Test sparkline query returns correctly bucketed data
- Test unauthorized requests return 401
- Test D1 query failure returns 502 gracefully

### Integration Tests
- Using Miniflare (wrangler dev --local), seed the D1 `client_heartbeats` table with test data spanning 24 hours
- Verify the `/admin/api/clients/active` endpoint returns correct counts and sparkline
- Verify auto-refresh behavior does not accumulate stale data

### E2E Tests
- Not applicable for this story (admin dashboard is internal tooling)

## Technical Notes

**Existing patterns to follow:**
- The route handler structure in `packages/admin-cf/src/routes/servers.ts` is the exact pattern to replicate: auth check via `requireAuth()`, fetch data, return `jsonResponse()`
- The dashboard rendering in `serveDashboard()` uses inline HTML with template literals and a vanilla JS state management pattern (no Preact yet despite it being in `package.json`)
- The VPS dashboard already has an SVG chart implementation (`drawConnectionChart()`) that maps data to `<path>` elements — the sparkline should use the same approach but simpler (just a `<polyline>`)

**Privacy considerations:**
- The `client_heartbeats` table contains only `session_hash` (SHA-256 of a random per-session UUID), platform, version, and connection type — no IP, no device ID, no persistent identifier
- The admin API returns only aggregate counts, never individual session hashes
- D1 queries use `COUNT(*)` and `COUNT(DISTINCT session_hash)` — raw rows are never exposed to the dashboard

**KV vs D1 tradeoff for sparkline:**
- D1 approach (computing on read) is simpler and avoids synchronization issues, but adds query latency for 24h of data
- KV approach (pre-computed) is faster but requires the diagnostics-cf worker to maintain the time series
- Recommended: Start with D1 approach; optimize to KV if query latency becomes a problem (unlikely at <100K users)

**Cloudflare KV TTL patterns:**
- If using KV for caching the sparkline, set TTL to 86400s (24 hours) so stale data self-cleans
- KV reads are eventually consistent (typically <60s), which is acceptable for a 30-second refresh dashboard

## Estimation
**M (Medium)** — One new API endpoint with D1 query, one new dashboard tab section with SVG sparkline rendering. The route handler follows an established pattern, and the SVG sparkline is a simplified version of existing chart code. The main work is the D1 query, the wrangler binding setup, and the frontend sparkline rendering.
