# US-5.2: Server Logs Viewer

## Story
As an admin, I want to view server logs with filtering from the central admin dashboard, so that I can investigate issues on any VPS server without having to SSH into individual machines or open their separate dashboards.

## Acceptance Criteria
- Server Health tab includes a "View Logs" action on each server card that opens a log viewer panel
- Log viewer panel provides:
  - **Server selector dropdown:** Switch between servers without leaving the viewer
  - **Severity filter dropdown:** Filter by `debug`, `info`, `warn`, `error`, or "all" (default: `warn` and above)
  - **Time range picker:** Predefined ranges (last 15m, 1h, 6h, 24h) and custom range inputs
  - **Keyword search:** Free-text search box that filters log messages containing the search term
  - **Auto-refresh toggle:** When enabled, polls for new logs every 5 seconds; visual indicator shows when auto-refresh is active
- Log entries display: timestamp (formatted to local timezone), severity badge (color-coded), module name, message text, and expandable metadata section
- Pagination: loads 100 entries per page with "Load More" button; newest entries appear at the top
- When a VPS server is unreachable, the viewer shows "Server unreachable — logs unavailable for this server" with the last known timestamp
- Log entries with severity `error` are highlighted with a red left border for quick scanning

## Technical Design

### Architecture
The log viewer proxies requests from the admin-cf Worker to individual VPS servers. The data flow is:

```
Admin Browser --> admin-cf Worker (GET /admin/api/logs/server/:serverId)
admin-cf Worker --> looks up server endpoint from bootstrap registry
admin-cf Worker --> HTTP GET to VPS server's /admin/api/logs endpoint
VPS server --> queries in-memory LogBuffer (circular buffer, 10,000 entries)
VPS server --> returns filtered, paginated log entries as JSON
admin-cf Worker --> returns to browser
```

This story requires implementing the `LogBuffer` on the VPS side (section 4.4 of the plan) and the proxy endpoint on the admin-cf side.

### Implementation Details

**VPS Server — LogBuffer and endpoint:**

1. Create a `LogBuffer` class in `packages/server-vps/src/admin/log-buffer.ts`:
   - Circular buffer backed by an array of fixed size (10,000 entries)
   - Each entry is a `ServerLogEntry` with timestamp, level, module, message, and optional metadata
   - Methods: `push(entry)`, `query(filters)` with severity/keyword/since/until/limit/offset support
   - The buffer replaces `console.log`/`console.warn`/`console.error` calls across the server by integrating with the existing `logger` utility in `packages/server-vps/src/utils/logger.ts`

2. Add two new endpoints to `AdminRoutes` in `packages/server-vps/src/admin/routes.ts`:
   - `GET /admin/api/logs` — query the LogBuffer with filter parameters
   - `GET /admin/api/logs/export` — export logs as NDJSON for a time range

**Admin CF Worker — Proxy endpoint:**

1. Add `GET /admin/api/logs/server/:serverId` to admin-cf that:
   - Looks up the server's endpoint from the bootstrap registry (via Service Binding)
   - Constructs the VPS URL: `https://<host>/admin/api/logs?<query_params>`
   - Forwards the admin JWT for auth
   - Returns the VPS response to the browser
   - Handles unreachable servers with appropriate error response

**Frontend (Preact SPA):**

1. Create a `ServerLogsViewer` component with filter controls and log entry list
2. Log entries rendered as a virtualized list for performance (only render visible entries)
3. Auto-refresh uses `setInterval` that re-fetches with `since` set to the latest entry's timestamp

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/server-vps/src/admin/log-buffer.ts` | Create | Circular buffer implementation for structured log entries |
| `packages/server-vps/src/admin/types.ts` | Modify | Add `ServerLogEntry` and `LogQueryParams` interfaces |
| `packages/server-vps/src/admin/routes.ts` | Modify | Add `/admin/api/logs` and `/admin/api/logs/export` route handlers |
| `packages/server-vps/src/admin/index.ts` | Modify | Wire LogBuffer into AdminModule; expose it to server components |
| `packages/server-vps/src/utils/logger.ts` | Modify | Integrate LogBuffer as a log sink alongside console output |
| `packages/admin-cf/src/routes/servers.ts` | Modify | Add `handleServerLogs` proxy function |
| `packages/admin-cf/src/index.ts` | Modify | Register `/admin/api/logs/server/:serverId` route with path param extraction |
| `packages/admin-cf/src/dashboard/components/ServerLogsViewer.tsx` | Create | Log viewer Preact component with filters and auto-refresh |
| `packages/admin-cf/src/dashboard/components/LogEntry.tsx` | Create | Individual log entry row with expandable metadata |
| `packages/admin-cf/src/dashboard/components/LogFilters.tsx` | Create | Filter bar with severity, time range, keyword, server selector |
| `packages/admin-cf/src/dashboard/hooks/useServerLogs.ts` | Create | Hook for fetching logs with filter state management |
| `packages/server-vps/tests/admin/log-buffer.test.ts` | Create | Unit tests for LogBuffer |
| `packages/admin-cf/tests/routes/server-logs.test.ts` | Create | Tests for the proxy endpoint |

### Data Models / Schemas

```typescript
// VPS-side log entry (packages/server-vps/src/admin/types.ts)
interface ServerLogEntry {
  timestamp: number;         // Unix milliseconds
  level: 'debug' | 'info' | 'warn' | 'error';
  module: string;            // 'Federation', 'Client', 'Relay', 'Admin', 'Gossip', 'DHT', etc.
  message: string;
  metadata?: Record<string, unknown>;  // Optional structured data (connection IDs, error codes, etc.)
}

// Query parameters for log filtering
interface LogQueryParams {
  severity?: 'debug' | 'info' | 'warn' | 'error';  // Minimum severity (inclusive)
  since?: number;            // Unix ms — entries after this timestamp
  until?: number;            // Unix ms — entries before this timestamp
  keyword?: string;          // Substring search in message field
  module?: string;           // Filter by module name
  limit?: number;            // Max entries to return (default 100, max 500)
  offset?: number;           // Pagination offset
}

// Log query response
interface LogQueryResponse {
  entries: ServerLogEntry[];
  total: number;             // Total matching entries (for pagination)
  hasMore: boolean;          // Whether more entries exist beyond offset+limit
  bufferSize: number;        // Current buffer occupancy
  oldestTimestamp: number;   // Timestamp of oldest entry in buffer
}
```

### API Endpoints

**VPS Server: GET /admin/api/logs**

Request: Requires JWT auth (cookie or Authorization header).

Query parameters:
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `severity` | string | `warn` | Minimum severity level |
| `since` | number | (none) | Unix ms — only entries after this time |
| `until` | number | (none) | Unix ms — only entries before this time |
| `keyword` | string | (none) | Substring match in message |
| `module` | string | (none) | Exact module name filter |
| `limit` | number | `100` | Max entries (capped at 500) |
| `offset` | number | `0` | Pagination offset |

Response (200):
```json
{
  "success": true,
  "data": {
    "entries": [
      {
        "timestamp": 1709380800000,
        "level": "error",
        "module": "Federation",
        "message": "Failed to connect to peer srv-abc123: connection timeout",
        "metadata": { "peerId": "srv-abc123", "attempt": 3 }
      }
    ],
    "total": 847,
    "hasMore": true,
    "bufferSize": 10000,
    "oldestTimestamp": 1709294400000
  }
}
```

**VPS Server: GET /admin/api/logs/export**

Query parameters: `since`, `until` (required), `severity` (optional).

Response: NDJSON stream (`Content-Type: application/x-ndjson`) with one JSON log entry per line.

**Admin CF: GET /admin/api/logs/server/:serverId**

Proxies the request to the target VPS server's `/admin/api/logs` endpoint. All query parameters are forwarded. The `:serverId` is resolved to an endpoint URL via the bootstrap registry.

Response: Same shape as the VPS endpoint response, or:
```json
{
  "success": false,
  "error": "Server srv-01 is unreachable",
  "lastKnownHeartbeat": 1709380800000
}
```

## Dependencies
- **US-5.1 (Per-Server Status):** The log viewer is accessed from server cards in the Server Health tab. US-5.1 must provide the server list and the card UI.
- **Admin-cf Preact SPA migration:** The log viewer is a Preact component; the SPA shell must exist.
- **VPS admin auth:** The proxy must forward valid JWT tokens. The shared JWT secret between admin-cf and VPS is already implemented.
- **External:** No new external dependencies. The VPS log buffer is in-memory only (no persistence beyond process lifetime, as specified in section 4.4).

## Testing Strategy

### Unit Tests
- **LogBuffer:**
  - Push entries and verify FIFO eviction when buffer exceeds 10,000 entries
  - Query with severity filter returns only entries at or above the specified level
  - Query with keyword filter performs case-insensitive substring match
  - Query with time range (since/until) returns correct subset
  - Query with module filter returns only matching module entries
  - Pagination (offset/limit) returns correct slices
  - Empty buffer returns empty array with `total: 0` and `hasMore: false`
- **Route handler:**
  - Validates query parameter types and ranges (limit capped at 500, offset non-negative)
  - Returns 401 for unauthenticated requests

### Integration Tests
- **Proxy endpoint (admin-cf):**
  - Resolves serverId to endpoint via bootstrap registry Service Binding
  - Returns 404 when serverId is not found in registry
  - Returns 502 with `lastKnownHeartbeat` when VPS server is unreachable
  - Forwards all query parameters correctly to VPS endpoint
  - Forwards JWT auth header to VPS endpoint

### Component Tests (Preact)
- `ServerLogsViewer` renders log entries from mock API response
- Severity filter dropdown changes API query parameter and re-fetches
- Keyword search debounces input (300ms) before triggering re-fetch
- Auto-refresh toggle starts/stops the polling interval
- Error entries render with red left border CSS class
- "Load More" button increments offset and appends entries
- Unreachable server state renders the appropriate error message

## Technical Notes

**Codebase patterns to follow:**
- The existing `AdminRoutes` class in `packages/server-vps/src/admin/routes.ts` uses `requireAuth` for all API endpoints and `sendJson` for responses. New log endpoints should follow this pattern exactly.
- The existing `logger` utility at `packages/server-vps/src/utils/logger.ts` is used throughout the server (e.g., `logger.federationEvent`, `logger.error`). Integrating LogBuffer means adding it as an additional output sink — the logger should write to both console and LogBuffer.
- The admin-cf proxy must handle the fact that CF Workers cannot fetch bare IP addresses (Cloudflare error 1003). If the VPS endpoint in the bootstrap registry is a bare IP URL, the proxy will fail. The servers.ts code already notes this limitation (lines 88-89). The proxy should use the WSS/HTTPS endpoint hostname, converting `wss://` to `https://`.
- The VPS admin routes already handle CORS via `cfAdminUrl` config (lines 28-33 in routes.ts). Log endpoints need the same CORS treatment.

**Performance considerations:**
- The circular buffer (10,000 entries) at ~200 bytes per entry is approximately 2MB in memory — acceptable for a VPS server.
- Keyword search on the buffer is O(n) where n is buffer size. For 10,000 entries this is fast enough (< 1ms). No indexing needed.
- The admin-cf proxy adds one network hop (CF edge to VPS). For log queries this latency (50-200ms) is acceptable since logs are not real-time critical.
- Auto-refresh at 5-second intervals using the `since` parameter (set to the latest entry timestamp) ensures only new entries are fetched, keeping payload size small.

**Security considerations:**
- Log entries may contain server-internal information (peer IDs, endpoints, error details). The proxy endpoint requires admin-level JWT auth.
- The keyword search should not be used as a vector for injection — it is purely a substring match on in-memory strings, not a database query.
- The NDJSON export endpoint should be rate-limited or restricted to super-admin role to prevent abuse.

## Estimation
**L (Large)** — This story spans two packages (server-vps and admin-cf) with new backend infrastructure (LogBuffer, log integration across the server, proxy endpoint) and a moderately complex frontend component (filters, pagination, auto-refresh, expandable entries). Estimated 4-5 days.
