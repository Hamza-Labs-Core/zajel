# US-9.1: Centralized Log Viewer

## Story
As an admin, I want to view logs from any VPS through the central dashboard, so that I can monitor and troubleshoot server behavior without SSHing into individual machines.

## Acceptance Criteria
- The Server Health tab in the admin portal includes a "Logs" panel that is accessible by selecting a specific VPS server.
- A server selector dropdown lists all registered VPS servers (fetched from the bootstrap registry via the existing `handleListServers` data flow). Selecting a server loads its logs.
- A severity filter dropdown allows filtering by `debug`, `info`, `warn`, `error`, or "all" (default: `info` and above).
- A time-range picker allows selecting logs from the last 5 minutes, 15 minutes, 1 hour, or 6 hours (default: 15 minutes).
- A keyword search input filters log entries whose `message` or `module` fields contain the search string (case-insensitive substring match).
- Logs are displayed in reverse-chronological order (newest first) in a scrollable, monospaced-font panel.
- Each log row shows: timestamp (ISO 8601 with milliseconds), severity badge (color-coded), module tag, and message. Metadata is expandable on click.
- Pagination: The viewer loads up to 200 entries per page with a "Load More" button for the next page (offset-based).
- An auto-refresh toggle, when enabled, polls the VPS every 10 seconds for new log entries and prepends them to the top of the list without losing scroll position.
- When the selected VPS server is unreachable, the viewer shows a clear "Server Offline" state rather than a spinner or blank panel.
- All log viewer API calls are authenticated with the admin JWT; unauthenticated requests return 401.
- The VPS-side `/admin/api/logs` endpoint respects the same JWT auth used by other admin API routes.
- No sensitive data (pairing codes, IP addresses, server keys) appears in logs served to the dashboard. The existing `logger` redaction in production mode continues to apply.

## Technical Design

### Architecture
This story spans two packages and introduces one new module:

1. **VPS Server (`packages/server-vps/`)** -- A new `LogBuffer` class captures structured log entries in an in-memory circular buffer. A new `/admin/api/logs` REST endpoint exposes these entries to authenticated callers. The existing `Logger` singleton is extended to write entries into the `LogBuffer` in addition to stdout.

2. **Admin Portal (`packages/admin-cf/`)** -- A new route handler proxies log requests from the dashboard to a specific VPS server. The dashboard frontend adds a log viewer panel to the Server Health tab.

Data flow:
```
Admin Dashboard (browser)
  --> GET /admin/api/logs/server/:serverId?severity=error&since=...&limit=200&keyword=crypto
  --> admin-cf Worker
  --> resolves server endpoint from bootstrap registry
  --> fetch() to VPS https://<endpoint>/admin/api/logs?severity=error&since=...&limit=200&keyword=crypto
  --> VPS LogBuffer query
  --> JSON response back through the chain
```

The admin-cf Worker cannot use service bindings to reach VPS servers (they are external, not CF Workers), so it performs an outbound `fetch()` to the VPS server's HTTPS endpoint, forwarding the admin JWT in the `Authorization` header. The VPS server verifies the JWT using the shared `ZAJEL_ADMIN_JWT_SECRET`.

### Implementation Details

**1. LogBuffer class (`packages/server-vps/src/admin/log-buffer.ts`):**

A circular buffer holding the most recent N structured log entries in memory.

```typescript
import type { ServerLogEntry } from './types.js';

export class LogBuffer {
  private buffer: ServerLogEntry[];
  private head: number = 0;
  private count: number = 0;
  private readonly capacity: number;
  private sequenceCounter: number = 0;

  constructor(capacity: number = 10000) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  push(entry: Omit<ServerLogEntry, 'sequence'>): void {
    const fullEntry: ServerLogEntry = {
      ...entry,
      sequence: ++this.sequenceCounter,
    };
    this.buffer[this.head] = fullEntry;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  query(options: LogQueryOptions): ServerLogEntry[] {
    // Iterate buffer entries, apply severity/since/until/keyword filters
    // Return entries in reverse-chronological order up to limit
    // Use offset for pagination
  }

  get size(): number {
    return this.count;
  }
}

interface LogQueryOptions {
  severity?: 'debug' | 'info' | 'warn' | 'error';
  since?: number;      // Unix ms
  until?: number;      // Unix ms
  keyword?: string;
  module?: string;
  limit?: number;      // default 200, max 500
  offset?: number;     // default 0
}
```

The buffer uses a fixed-size array with a head pointer that wraps around, giving O(1) insertion and O(n) querying where n = buffer capacity. At 10,000 entries with ~500 bytes per entry, this consumes roughly 5MB of memory -- acceptable for a VPS server.

**2. Logger integration:**

Modify the existing `Logger` class in `packages/server-vps/src/utils/logger.ts` to accept an optional `LogBuffer` reference. When set, every log call also pushes a structured `ServerLogEntry` into the buffer. The module tag is derived from the bracket-prefixed patterns already used throughout the codebase (e.g., `[Federation]`, `[Client]`, `[Admin WS]`).

```typescript
// In Logger constructor or via setter:
private logBuffer: LogBuffer | null = null;

setLogBuffer(buffer: LogBuffer): void {
  this.logBuffer = buffer;
}

// In each log method (debug, info, warn, error), after console output:
if (this.logBuffer) {
  this.logBuffer.push({
    timestamp: Date.now(),
    level,
    module: this.extractModule(message),
    message: this.stripModulePrefix(message),
    metadata: meta,
  });
}
```

For the existing `console.log`/`console.error` calls scattered throughout `index.ts` and other files that do not use the `logger` singleton, a process-level stdout/stderr interceptor is not needed. Instead, those calls will be migrated to use the `logger` singleton as part of this story, which is a net improvement in consistency.

**3. VPS admin logs endpoint (`packages/server-vps/src/admin/routes.ts`):**

Add `handleLogs` to `AdminRoutes`:

```typescript
private handleLogs(req: IncomingMessage, res: ServerResponse): boolean {
  const auth = requireAuth(req, res, this.config.jwtSecret);
  if (!auth) return true;

  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const severity = url.searchParams.get('severity') as LogLevel | null;
  const since = parseInt(url.searchParams.get('since') || '0', 10) || undefined;
  const until = parseInt(url.searchParams.get('until') || '0', 10) || undefined;
  const keyword = url.searchParams.get('keyword') || undefined;
  const module = url.searchParams.get('module') || undefined;
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  const entries = this.logBuffer.query({
    severity, since, until, keyword, module, limit, offset,
  });

  sendJson(res, {
    success: true,
    data: {
      entries,
      total: this.logBuffer.size,
      limit,
      offset,
    },
  });
  return true;
}
```

Register in `handleRequest`:
```typescript
if (path === '/admin/api/logs') {
  return this.handleLogs(req, res);
}
```

**4. Admin-CF proxy route (`packages/admin-cf/src/routes/logs.ts`):**

The admin-cf Worker resolves the server endpoint from the bootstrap registry, then proxies the log request to the VPS:

```typescript
export async function handleServerLogs(
  request: Request,
  env: Env,
  serverId: string
): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;

  // Look up server endpoint from bootstrap registry
  const serverEndpoint = await resolveServerEndpoint(serverId, env);
  if (!serverEndpoint) {
    return jsonResponse({ success: false, error: 'Server not found' }, 404);
  }

  // Convert WS endpoint to HTTPS base URL
  const baseUrl = serverEndpoint
    .replace('wss://', 'https://')
    .replace('ws://', 'http://');

  // Forward query params and auth token
  const url = new URL(request.url);
  const logsUrl = `${baseUrl}/admin/api/logs${url.search}`;
  const token = request.headers.get('Authorization');

  try {
    const vpsRes = await fetch(logsUrl, {
      headers: {
        'Authorization': token || '',
        'Accept': 'application/json',
      },
    });
    return new Response(vpsRes.body, {
      status: vpsRes.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return jsonResponse({
      success: false,
      error: 'VPS server unreachable',
    }, 502);
  }
}
```

**5. Frontend log viewer (inline HTML or Preact):**

Add a log viewer panel to the Server Health tab following the existing rendering pattern. Key UI elements:
- Server selector: `<select>` populated from `state.servers`.
- Filter bar: severity dropdown, keyword input, time-range buttons.
- Log entries panel: a `<div>` with `overflow-y: auto; max-height: 600px; font-family: monospace; font-size: 0.8125rem;` containing individual log rows.
- Each log row: `<div class="log-entry log-{level}">` with colored left border for severity (green=info, yellow=warn, red=error, gray=debug).
- Auto-refresh toggle checkbox, polling with `setInterval(loadLogs, 10000)`.
- "Load More" button that increments the offset and appends older entries.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/server-vps/src/admin/log-buffer.ts` | Create | Circular buffer class for in-memory structured log storage |
| `packages/server-vps/src/admin/types.ts` | Modify | Add `ServerLogEntry` and `LogQueryOptions` interfaces |
| `packages/server-vps/src/utils/logger.ts` | Modify | Add `LogBuffer` integration; add `setLogBuffer()` method; add module-extraction logic |
| `packages/server-vps/src/admin/routes.ts` | Modify | Add `handleLogs` method; accept `LogBuffer` in constructor; register `/admin/api/logs` route |
| `packages/server-vps/src/admin/index.ts` | Modify | Create `LogBuffer` instance; pass to `AdminRoutes` and `Logger`; wire up in `createAdminModule` |
| `packages/server-vps/src/index.ts` | Modify | Migrate remaining `console.log/warn/error` calls to use the `logger` singleton for buffer capture |
| `packages/admin-cf/src/routes/logs.ts` | Create | Proxy handler that forwards log requests to specific VPS servers |
| `packages/admin-cf/src/routes/index.ts` | Modify | Re-export from `logs.ts` |
| `packages/admin-cf/src/index.ts` | Modify | Register `/admin/api/logs/server/:serverId` route; add log viewer rendering in dashboard HTML |
| `packages/admin-cf/src/types.ts` | Modify | Add `ServerLogEntry` interface (shared type) |

### Data Models / Schemas

**ServerLogEntry (VPS-side, in `packages/server-vps/src/admin/types.ts`):**

```typescript
interface ServerLogEntry {
  sequence: number;         // Monotonically increasing ID within buffer
  timestamp: number;        // Unix ms
  level: 'debug' | 'info' | 'warn' | 'error';
  module: string;           // e.g., 'Federation', 'Client', 'Relay', 'Admin', 'Zajel'
  message: string;          // The log message (already redacted by Logger)
  metadata?: Record<string, unknown>;  // Optional structured context
}
```

**LogQueryOptions (VPS-side):**

```typescript
interface LogQueryOptions {
  severity?: 'debug' | 'info' | 'warn' | 'error';  // Minimum severity filter
  since?: number;       // Unix ms, inclusive
  until?: number;       // Unix ms, inclusive
  keyword?: string;     // Substring match on message + module
  module?: string;      // Exact module filter
  limit?: number;       // Max entries to return (default 200, max 500)
  offset?: number;      // Pagination offset (default 0)
}
```

**LogsApiResponse (shared, returned by both VPS and admin-cf proxy):**

```typescript
interface LogsApiResponse {
  entries: ServerLogEntry[];
  total: number;         // Total entries in buffer (not matching -- just buffer size)
  limit: number;
  offset: number;
}
```

### API Endpoints

**VPS Server -- GET /admin/api/logs**

- Auth: Bearer JWT or `zajel_vps_token` cookie (same auth as other admin routes)
- Query params:
  - `severity`: `debug` | `info` | `warn` | `error` (minimum level; default: all)
  - `since`: Unix ms timestamp (default: 15 minutes ago)
  - `until`: Unix ms timestamp (default: now)
  - `keyword`: substring search (default: none)
  - `module`: exact module name filter (default: none)
  - `limit`: 1-500 (default: 200)
  - `offset`: 0+ (default: 0)
- Success response (200):
  ```json
  {
    "success": true,
    "data": {
      "entries": [
        {
          "sequence": 9842,
          "timestamp": 1709384400000,
          "level": "error",
          "module": "Federation",
          "message": "Failed to connect to discovered peer srv-****...****: Connection refused",
          "metadata": { "peerId": "srv-****...****" }
        }
      ],
      "total": 8734,
      "limit": 200,
      "offset": 0
    }
  }
  ```
- Error responses: 401 (unauthenticated), 400 (invalid params)

**VPS Server -- GET /admin/api/logs/export**

- Auth: Bearer JWT
- Query params: `since`, `until` (both required, Unix ms)
- Response: `application/json` with all matching entries (no limit cap, up to full buffer)
- Purpose: Bulk export for a time window, used by the log-diagnostic correlation feature (US-9.2)

**Admin-CF -- GET /admin/api/logs/server/:serverId**

- Auth: Bearer JWT (admin or super-admin)
- Query params: Same as VPS `/admin/api/logs` (forwarded verbatim)
- Success response (200): Proxied VPS response
- Error responses: 401 (unauthenticated), 404 (server not found in registry), 502 (VPS unreachable)

## Dependencies
- **US-5.1 (Per-Server Status):** The Server Health tab and server selector dropdown depend on the server list being available. However, the VPS-side `/admin/api/logs` endpoint can be built independently.
- **Existing admin JWT auth:** Both the VPS server and admin-cf Worker already share the `ZAJEL_ADMIN_JWT_SECRET`. No new auth infrastructure is needed.
- **Bootstrap registry:** The admin-cf proxy needs to resolve `serverId` to an endpoint URL. This uses the existing `handleListServers` data path.
- No new external packages required. The `LogBuffer` is a plain TypeScript class with no dependencies.

## Testing Strategy

- **Unit tests:**
  - `LogBuffer`: Test circular overwrite behavior (push > capacity entries, verify oldest are dropped). Test `query()` with severity filter, time-range filter, keyword filter, module filter, limit, and offset. Test empty buffer returns empty array. Test edge case where buffer is exactly at capacity.
  - `Logger` integration: Test that `setLogBuffer()` causes log calls to write into the buffer. Test that module extraction from bracketed prefixes works (e.g., `"[Federation] peer joined"` yields module `"Federation"` and message `"peer joined"`).
  - `handleLogs`: Mock `LogBuffer.query()`, verify correct params are passed through from query string. Test invalid query params return 400. Test missing auth returns 401.
  - Admin-CF `handleServerLogs`: Mock `fetch()` to VPS, verify correct URL construction and header forwarding. Test 502 response when VPS is unreachable. Test 404 when serverId is not in registry.

- **Integration tests:**
  - Start a VPS server, generate log entries by connecting a client, then call `GET /admin/api/logs` and verify entries contain expected modules (Client, Zajel) and levels.
  - Test pagination: push 500 entries, query with `limit=100&offset=0`, then `offset=100`, verify no overlap and correct ordering.
  - Test keyword filtering: push entries with known strings, verify only matching entries are returned.

- **E2E tests:**
  - Full flow: admin portal loads log viewer, selects a server, entries appear in the panel.
  - Verify severity color-coding renders correctly.
  - Verify "Server Offline" state when VPS is stopped.

## Technical Notes

**Codebase patterns observed:**
- The existing `Logger` singleton in `packages/server-vps/src/utils/logger.ts` uses `console.*` methods directly. Many places in `index.ts` also call `console.log` directly with bracket-prefix patterns like `[Zajel]`, `[Admin]`. The `LogBuffer` integration should intercept at the `Logger` class level, and the scattered `console.*` calls should be migrated to use the `logger` singleton. This migration is scoped to `packages/server-vps/src/index.ts` (approximately 20 calls) and `packages/server-vps/src/admin/` files.
- The `AdminRoutes` class currently takes `MetricsCollector` and `AdminConfig` in its constructor. It will also need a `LogBuffer` reference. To avoid expanding the constructor signature excessively, consider passing a single options object.
- The `MetricsCollector` maintains an in-memory history array with time-based trimming. The `LogBuffer` follows a similar in-memory-only approach. This is an intentional design decision: VPS server logs are ephemeral (lost on restart), which is acceptable because the diagnostics pipeline (US-1.x) handles persistent error tracking. The log buffer serves real-time and recent troubleshooting only.
- The `requireAuth` function in `packages/server-vps/src/admin/auth.ts` handles Bearer token, query param token, and cookie token extraction. The logs endpoint should use this same function -- no special auth needed.
- The admin-cf proxy in `routes/logs.ts` follows the same proxy pattern that `openVpsDashboard()` uses in the frontend: it converts the WS endpoint to an HTTPS base URL. The difference is the proxy runs server-side in the CF Worker rather than redirecting the browser.

**Circular buffer design rationale:**
- A fixed-size array with head pointer is chosen over a linked list or growing array because: (a) predictable memory usage, (b) no GC pressure from object allocations, (c) simple implementation. The `winston-circular-buffer` npm package exists for this pattern but introduces unnecessary dependencies; a ~60-line custom implementation is preferable.
- 10,000 entries was chosen based on: at 1 log/second average, this gives ~2.8 hours of history. At burst rates (100 logs/second during federation events), it gives ~100 seconds. The 6-hour time-range option in the UI may return fewer entries than expected during high-traffic periods; this is acceptable and documented in the UI with a "Buffer contains entries from {oldest_timestamp}" indicator.

**Severity filtering behavior:**
- When `severity=warn` is specified, the endpoint returns entries with level `warn` OR `error` (i.e., minimum severity level, not exact match). This matches the common log viewer convention and the existing `Logger.shouldLog()` logic.

## Estimation
**L (Large)** -- This story involves creating the `LogBuffer` class, modifying the `Logger` singleton, adding a VPS REST endpoint, migrating ~20 `console.*` calls to the logger, creating an admin-cf proxy route, and building a frontend log viewer panel with filtering, pagination, and auto-refresh. The backend work (LogBuffer + endpoint + logger integration) is approximately 2 days. The frontend log viewer with all filter controls and auto-refresh is approximately 2 days. The admin-cf proxy and testing add another day. Estimated 4-5 days.
