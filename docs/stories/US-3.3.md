# US-3.3: Server Metrics Overview

## Story
As an admin, I want to see CPU, memory, connection count, and throughput for each VPS server, so that I can monitor server-side resource utilization and identify servers that need attention.

## Acceptance Criteria
- Per-server metric cards display current values for: CPU usage (%), memory usage (MB), total connections, relay connections, signaling connections, message throughput (msgs/sec, msgs/min)
- Cards are color-coded by health: green (healthy), yellow (degraded), red (critical)
- Clicking a server card opens a historical chart view showing the metric over time
- Historical charts show at least 1 hour of data with configurable range
- Server list is auto-refreshed every 30 seconds
- Servers that have not reported metrics in >5 minutes show as "offline" with a stale indicator
- Aggregate summary row shows totals across all servers (total connections, total throughput)

## Technical Design

### Architecture
This story adds a "Server Metrics" section within the Metrics tab of the admin-cf Preact SPA. Unlike the app and network metrics (which come from client-side diagnostics in D1), server metrics come from two sources:

1. **Real-time snapshots:** Proxied from each VPS server's existing `/admin/api/metrics` endpoint (already implemented in `packages/server-vps/src/admin/routes.ts`)
2. **Historical data:** Stored in D1 via the server metrics push mechanism (the `ServerMetricsPush` interface defined in plan section 4.4, where each VPS pushes metrics to the diagnostics-cf worker every 60 seconds)

```
VPS Server -> diagnostics-cf (push every 60s) -> D1 server_metrics
admin-cf API -> reads D1 (historical) + proxies VPS (real-time) -> Preact dashboard
```

The admin-cf Worker exposes `GET /admin/api/metrics/server` which aggregates the latest metrics per server from D1 and optionally proxies real-time data from individual VPS servers.

### Implementation Details

**Backend (admin-cf Worker):**
- Add `handleServerMetrics` to `src/routes/metrics.ts`
- For the server list with current metrics: query D1 `server_metrics` table for the latest push per server (most recent `timestamp`)
- For historical drill-down: query D1 `server_metrics` for a specific server over a time range
- The existing server list from `packages/admin-cf/src/routes/servers.ts` already fetches from the bootstrap registry, but it only has connection counts, not CPU/memory. The new D1 table from metrics push has the full picture.
- Merge bootstrap registry data (server ID, region, endpoint, status) with D1 metrics data (CPU, memory, throughput) for a complete view

**Server Metrics D1 Table (new):**
- VPS servers push metrics every 60 seconds to the diagnostics-cf worker, which stores them in a `server_metrics` table
- This table needs to be created as part of the diagnostics-cf D1 schema

**Frontend (Preact SPA):**
- Create `ServerMetricsPanel` component within the Metrics tab
- Render a grid of server cards (following the existing server card pattern in `packages/admin-cf/src/index.ts` lines 807-833)
- Each card shows: server ID, region, CPU gauge, memory bar, connection counts, throughput
- Click handler expands to a detail view with historical line charts (reusing `LineChart` from US-3.1)
- Show aggregate summary row at the top with totals across all servers
- Health color determination:
  - Green: CPU < 70%, memory < 80% of available, connections < 1000
  - Yellow: CPU 70-90%, memory 80-95%, connections 1000-5000
  - Red: CPU > 90%, memory > 95%, connections > 5000 (thresholds from `packages/server-vps/src/admin/metrics.ts` lines 20-26)

**Staleness detection:**
- Compare `lastPushTimestamp` to current time; if > 5 minutes, mark as "offline/stale"
- Use the same `OFFLINE_TTL` constant (5 minutes) already defined in `packages/admin-cf/src/routes/servers.ts` line 17

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/admin-cf/src/routes/metrics.ts` | Modify | Add `handleServerMetrics` and `handleServerMetricsDetail` handlers |
| `packages/admin-cf/src/index.ts` | Modify | Add routing for `/admin/api/metrics/server` and `/admin/api/metrics/server/:serverId` |
| `packages/admin-cf/src/types.ts` | Modify | Add `ServerMetricsResponse`, `ServerMetricsDetailResponse` types |
| `packages/admin-cf/src/dashboard/ServerMetricsPanel.tsx` | Create | Preact component with server metric cards and drill-down |
| `packages/admin-cf/src/dashboard/components/ServerCard.tsx` | Create | Individual server metric card with mini gauges |
| `packages/admin-cf/src/dashboard/components/ProgressBar.tsx` | Create | Reusable horizontal progress bar (for CPU/memory) |
| `packages/admin-cf/src/dashboard/MetricsTab.tsx` | Modify | Add ServerMetricsPanel as a section |
| `packages/diagnostics-cf/src/schema.sql` | Modify | Add `server_metrics` table to D1 schema |
| `packages/diagnostics-cf/src/routes/server-push.ts` | Create | Endpoint for VPS servers to push metrics (`POST /diagnostics/server-metrics`) |
| `packages/admin-cf/tests/e2e/metrics-server.test.ts` | Create | E2E tests for server metrics API endpoints |

### Data Models / Schemas

**D1 Table (new -- for server metrics push):**
```sql
CREATE TABLE server_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL,
  region TEXT,
  timestamp INTEGER NOT NULL,             -- Unix ms
  connections_total INTEGER NOT NULL,
  connections_relay INTEGER NOT NULL,
  connections_signaling INTEGER NOT NULL,
  entropy_active_codes INTEGER,
  entropy_collision_risk TEXT,
  federation_alive_members INTEGER,
  federation_total_members INTEGER,
  message_rate_per_second REAL,
  message_rate_per_minute REAL,
  cpu_percent REAL,
  memory_mb REAL,
  uptime_seconds INTEGER
);

-- Index for efficient queries by server and time
CREATE INDEX idx_server_metrics_server_time
  ON server_metrics(server_id, timestamp DESC);

-- Cleanup: keep 7 days of data (purged by cron or on write)
```

**ServerMetricsPush (from VPS, already defined in plan section 4.4):**
```typescript
interface ServerMetricsPush {
  serverId: string;
  region: string;
  timestamp: number;
  metrics: {
    connections: { total: number; relay: number; signaling: number };
    entropy: { activeCodes: number; collisionRisk: string };
    federation: { aliveMembers: number; totalMembers: number };
    messageRate: { perSecond: number; perMinute: number };
    system: {
      cpuPercent: number;
      memoryMb: number;
      uptimeSeconds: number;
    };
  };
}
```

**API Response Schema (server list):**
```typescript
interface ServerMetricsResponse {
  servers: Array<{
    serverId: string;
    region: string;
    endpoint: string;
    status: 'healthy' | 'degraded' | 'offline';
    lastSeen: number;                      // Unix ms of last metrics push
    metrics: {
      cpuPercent: number;
      memoryMb: number;
      connectionsTotal: number;
      connectionsRelay: number;
      connectionsSignaling: number;
      messageRatePerSecond: number;
      messageRatePerMinute: number;
      entropyActiveCodes: number;
      federationAliveMembers: number;
      federationTotalMembers: number;
      uptimeSeconds: number;
    } | null;                              // null if server has never pushed metrics
  }>;
  aggregate: {
    totalServers: number;
    healthyServers: number;
    degradedServers: number;
    offlineServers: number;
    totalConnections: number;
    totalThroughput: number;               // msgs/min across all servers
  };
}
```

**API Response Schema (server detail):**
```typescript
interface ServerMetricsDetailResponse {
  serverId: string;
  region: string;
  history: Array<{
    timestamp: number;
    cpuPercent: number;
    memoryMb: number;
    connectionsTotal: number;
    messageRatePerMinute: number;
    federationAliveMembers: number;
  }>;
}
```

### API Endpoints

**GET /admin/api/metrics/server**

Returns the latest metrics for all known servers.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | | | Returns latest snapshot per server |

**Response (200):**
```json
{
  "success": true,
  "data": {
    "servers": [
      {
        "serverId": "srv-01",
        "region": "us-east",
        "endpoint": "wss://vps1.example.com",
        "status": "healthy",
        "lastSeen": 1709464800000,
        "metrics": {
          "cpuPercent": 35.2,
          "memoryMb": 256,
          "connectionsTotal": 142,
          "connectionsRelay": 80,
          "connectionsSignaling": 62,
          "messageRatePerSecond": 12,
          "messageRatePerMinute": 680,
          "entropyActiveCodes": 45,
          "federationAliveMembers": 3,
          "federationTotalMembers": 4,
          "uptimeSeconds": 864000
        }
      }
    ],
    "aggregate": {
      "totalServers": 4,
      "healthyServers": 3,
      "degradedServers": 1,
      "offlineServers": 0,
      "totalConnections": 520,
      "totalThroughput": 2800
    }
  }
}
```

**GET /admin/api/metrics/server/:serverId**

Returns historical metrics for a specific server.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `range` | query string | No | Time range: "1h", "6h", "24h", "7d" (default "1h") |

**Response (200):**
```json
{
  "success": true,
  "data": {
    "serverId": "srv-01",
    "region": "us-east",
    "history": [
      { "timestamp": 1709464800000, "cpuPercent": 35.2, "memoryMb": 256, "connectionsTotal": 142, "messageRatePerMinute": 680, "federationAliveMembers": 3 }
    ]
  }
}
```

**Response (401):** Unauthorized
**Response (404):** Server not found

## Dependencies
- **US-1.1 (Diagnostic Report Submission):** The diagnostics-cf worker must exist and accept server metrics pushes
- **US-3.1 (App Performance Metrics):** Shares `MetricsTab`, `LineChart`, `MetricCard`, `FilterBar` components
- **VPS admin module:** The existing `MetricsCollector` in `packages/server-vps/src/admin/metrics.ts` provides the `takeSnapshot()` data that the VPS will push to diagnostics-cf
- **D1 database:** The `zajel-diagnostics` D1 database must include the `server_metrics` table
- **VPS metrics push:** The VPS server needs a new periodic push mechanism to POST to `diagnostics-cf/diagnostics/server-metrics` (this could be a sub-task of this story or a separate thin story)

## Testing Strategy

**Unit Tests:**
- Test health status determination logic (healthy/degraded/offline based on CPU, memory, connection thresholds)
- Test staleness detection (>5 min since last push = offline)
- Test aggregate computation (sum connections, sum throughput across servers)
- Test D1 query for latest metrics per server (must pick most recent timestamp)
- Test historical query with time range filtering

**Integration Tests:**
- Test `GET /admin/api/metrics/server` with mocked D1 containing metrics from multiple servers
- Test `GET /admin/api/metrics/server/:serverId` with historical data
- Verify servers with no metrics data return `metrics: null`
- Verify offline detection for stale servers
- Verify aggregate sums are correct
- Verify auth requirement

**E2E Tests:**
- Seed D1 with server_metrics rows for multiple servers across time
- Call list endpoint and verify server ordering, health coloring
- Call detail endpoint and verify historical data points
- Test with one stale server (>5 min old) to verify offline status

## Technical Notes

**Codebase patterns to follow:**
- The existing `handleListServers` in `packages/admin-cf/src/routes/servers.ts` already fetches server list from the bootstrap registry and computes health status from heartbeat freshness. The new server metrics panel should merge this data with the richer D1 metrics data rather than replacing it. Use bootstrap registry for the authoritative server list (which servers exist, their endpoints), and D1 for the detailed metrics.
- The VPS `MetricsCollector.takeSnapshot()` (at `packages/server-vps/src/admin/metrics.ts` lines 78-108) already produces a `MetricsSnapshot` with connections, entropy, federation, and messageRate. The `ServerMetricsPush` extends this with system metrics (CPU, memory, uptime). The push mechanism should call `takeSnapshot()` and augment with `process.cpuUsage()` and `process.memoryUsage()` for Node.js system metrics.
- The VPS dashboard server cards in `packages/admin-cf/src/index.ts` lines 807-833 show a card grid with status badges. The new `ServerCard` component should follow this same visual pattern but add mini CPU/memory bars.
- Health thresholds in `packages/server-vps/src/admin/metrics.ts` lines 20-26 define CONNECTION_WARNING (1000) and CONNECTION_CRITICAL (5000). Reuse these constants.

**VPS metrics push implementation notes:**
- Add a 60-second `setInterval` in the VPS server that calls `metricsCollector.takeSnapshot()`, augments with system metrics, and POSTs to the diagnostics-cf endpoint
- The push URL should be configurable via `ZAJEL_DIAGNOSTICS_URL` environment variable
- The push should be fire-and-forget (no retry on failure; next push in 60s will succeed)
- Authentication: Use a shared secret or HMAC signature to prevent unauthorized pushes. The simplest approach is a `DIAGNOSTICS_PUSH_SECRET` that the VPS includes in an Authorization header.

**D1 data retention:**
- With 60-second pushes per server and, say, 10 servers, that is 144,000 rows per day (10 * 1440 minutes). At 7-day retention, that is ~1M rows. D1 handles this fine, but add a cleanup query that deletes rows older than 7 days, triggered on each push or via a separate cron.

**System metrics in Node.js:**
- `process.cpuUsage()` returns user + system microseconds; compute percentage over the push interval
- `process.memoryUsage().rss / (1024 * 1024)` for memory in MB
- `process.uptime()` for uptime seconds

## Estimation
**L (Large)** -- This story spans three packages (admin-cf frontend + backend, diagnostics-cf for the push endpoint and D1 schema, server-vps for the push mechanism). It requires a new D1 table, a new ingestion endpoint in diagnostics-cf, a new periodic push in the VPS server, new API endpoints in admin-cf, and new Preact components. The frontend portion reuses chart components from US-3.1, but the backend scope is the largest of the Epic 3 stories due to the cross-package coordination.
