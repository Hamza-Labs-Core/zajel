# US-5.4: Heartbeat Freshness Timeline

## Story
As an admin, I want to see heartbeat gaps for each server, so that I can identify intermittent connectivity issues, understand when servers go offline and come back, and correlate outages with user-facing problems.

## Acceptance Criteria
- Server Health tab includes a "Heartbeat Timeline" section showing a horizontal timeline for each server
- Each timeline displays the last 24 hours with a resolution of 1-minute buckets
  - Green segments: heartbeat received within that minute
  - Red segments: no heartbeat received (gap)
  - Yellow segments: heartbeat received but with elevated latency or degraded status
- Gaps longer than 5 minutes are annotated with a duration label (e.g., "offline 12m")
- Hovering over any timeline segment shows: exact timestamp, heartbeat status, and latency (if available)
- Timelines are aligned vertically by server, sorted in the same order as the server card grid (region, then server ID; offline servers first)
- A summary line above the timelines shows overall fleet uptime percentage for the 24-hour window: `(total_green_minutes / (total_servers * 1440)) * 100`
- The timeline scrolls horizontally for narrow viewports; the server ID labels remain fixed on the left
- Current time is marked with a vertical hairline indicator that moves as time progresses
- The timeline auto-refreshes every 60 seconds by appending the latest data point

## Technical Design

### Architecture
Heartbeat data comes from two sources:

1. **Bootstrap registry heartbeats:** VPS servers send heartbeats to the bootstrap CF Worker every 60 seconds (configured via `ZAJEL_BOOTSTRAP_HEARTBEAT` in `packages/server-vps/src/config.ts`). The `ServerRegistryDO` in the bootstrap worker records `lastSeen` timestamps.

2. **Server metrics push (new):** VPS servers push `ServerMetricsPush` payloads every 60 seconds to the diagnostics-cf Worker (section 4.4 of the plan), which stores them in D1.

For the heartbeat timeline, we need historical heartbeat timestamps — not just the latest `lastSeen`. This requires a new storage mechanism.

```
VPS Server --> heartbeat every 60s --> bootstrap CF Worker
                                   --> ServerRegistryDO records lastSeen

VPS Server --> metrics push every 60s --> diagnostics-cf Worker (or admin-cf directly)
                                      --> D1 table: server_heartbeats

admin-cf Worker --> queries D1 for heartbeat history (last 24h per server)
               --> computes gap analysis
               --> returns timeline data to Preact SPA

Preact SPA --> renders horizontal timeline per server
```

### Implementation Details

**Backend — Heartbeat history storage (D1):**

1. Add a new D1 table `server_heartbeats` to track individual heartbeat events:
   ```sql
   CREATE TABLE server_heartbeats (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     server_id TEXT NOT NULL,
     timestamp INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'alive',
     latency_ms INTEGER,
     metrics_summary TEXT,        -- JSON: { connections, messageRate, cpuPercent }
     UNIQUE(server_id, timestamp)
   );
   CREATE INDEX idx_heartbeats_server_time ON server_heartbeats(server_id, timestamp);
   ```

2. Heartbeat ingestion: When the bootstrap worker receives a server heartbeat (or when a new VPS metrics push endpoint receives data), record a row in `server_heartbeats`. Since the bootstrap worker uses Durable Objects (not D1), the recording can happen via:
   - Option A: Admin-cf periodically polls the bootstrap registry and records heartbeats in its own D1 — simple but adds polling overhead
   - Option B: VPS servers push heartbeat data directly to an admin-cf endpoint — requires a new unauthenticated (but rate-limited) VPS-to-CF endpoint
   - **Chosen: Option A** — admin-cf runs a lightweight cron-like poll (every 60 seconds via a scheduled handler or on-demand when the timeline is viewed) that reads from the bootstrap registry and records heartbeats in D1. This avoids requiring VPS configuration changes.

3. Add `GET /admin/api/servers/heartbeat-timeline` endpoint to admin-cf:
   - Queries `server_heartbeats` for the requested time range (default 24h)
   - Computes 1-minute buckets for each server
   - Identifies gaps (no heartbeat for 2+ consecutive minutes, accounting for the 60s heartbeat interval)
   - Returns structured timeline data

**Frontend (Preact SPA):**

1. Create a `HeartbeatTimeline` Preact component using SVG or Canvas for rendering:
   - Each server gets a horizontal bar divided into 1440 segments (24h * 60min)
   - Segments colored by status (green/red/yellow)
   - Segments are rendered as SVG `<rect>` elements within an `<svg>` for each server row
   - Hover triggers a tooltip via a positioned `<div>`

2. The timeline container uses `overflow-x: auto` for horizontal scrolling with sticky server labels on the left (CSS `position: sticky; left: 0`).

3. Time axis rendered at the top with hour markers (00:00, 01:00, ..., 23:00).

4. Gap annotations: for red segments spanning 5+ minutes, render a text label above the segment with the duration.

5. Current-time hairline: a vertical line positioned based on `(Date.now() - startOfWindow) / windowDuration * totalWidth`.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/admin-cf/src/routes/heartbeat.ts` | Create | `handleHeartbeatTimeline` — queries D1, computes timeline buckets; `recordHeartbeats` — polls bootstrap and records in D1 |
| `packages/admin-cf/src/index.ts` | Modify | Register `/admin/api/servers/heartbeat-timeline` route; add scheduled handler for heartbeat recording |
| `packages/admin-cf/src/types.ts` | Modify | Add `HeartbeatTimelineData`, `TimelineBucket`, `TimelineGap` interfaces |
| `packages/admin-cf/wrangler.jsonc` | Modify | Add `DIAGNOSTICS_DB` D1 binding (or a dedicated `ADMIN_DB` binding); add cron trigger for heartbeat polling |
| `packages/admin-cf/src/migrations/001_heartbeat_timeline.sql` | Create | D1 migration: `server_heartbeats` table and index |
| `packages/admin-cf/src/dashboard/components/HeartbeatTimeline.tsx` | Create | SVG-based timeline rendering component |
| `packages/admin-cf/src/dashboard/components/TimelineRow.tsx` | Create | Individual server timeline bar with segments |
| `packages/admin-cf/src/dashboard/components/TimelineTooltip.tsx` | Create | Hover tooltip showing segment details |
| `packages/admin-cf/src/dashboard/hooks/useHeartbeatTimeline.ts` | Create | Hook for fetching timeline data |
| `packages/admin-cf/tests/routes/heartbeat.test.ts` | Create | Unit tests for timeline computation and gap detection |
| `packages/admin-cf/tests/dashboard/HeartbeatTimeline.test.tsx` | Create | Component tests for timeline rendering |

### Data Models / Schemas

```typescript
// Timeline request/response types
interface HeartbeatTimelineRequest {
  since?: number;          // Unix ms (default: 24h ago)
  until?: number;          // Unix ms (default: now)
  serverIds?: string[];    // Filter to specific servers (default: all)
  bucketMinutes?: number;  // Bucket size in minutes (default: 1, max: 60)
}

interface HeartbeatTimelineResponse {
  servers: ServerTimeline[];
  summary: {
    fleetUptimePercent: number;  // Overall fleet uptime for the window
    totalGaps: number;           // Total gap events across all servers
    longestGap: {
      serverId: string;
      durationMinutes: number;
      startTime: number;
      endTime: number;
    } | null;
  };
  window: {
    start: number;
    end: number;
    bucketMinutes: number;
    totalBuckets: number;
  };
}

interface ServerTimeline {
  serverId: string;
  shortId: string;
  region: string;
  currentStatus: 'healthy' | 'degraded' | 'offline';
  buckets: TimelineBucket[];
  gaps: TimelineGap[];
  uptimePercent: number;       // Per-server uptime for the window
}

interface TimelineBucket {
  startTime: number;           // Unix ms of bucket start
  status: 'up' | 'down' | 'degraded';
  heartbeatCount: number;      // How many heartbeats received in this bucket (usually 0 or 1)
  avgLatencyMs?: number;       // Average latency for heartbeats in this bucket
}

interface TimelineGap {
  startTime: number;
  endTime: number;
  durationMinutes: number;
}

// D1 row type
interface HeartbeatRow {
  id: number;
  server_id: string;
  timestamp: number;
  status: string;
  latency_ms: number | null;
  metrics_summary: string | null;
}
```

### API Endpoints

**GET /admin/api/servers/heartbeat-timeline**

Request: Requires `Authorization: Bearer <jwt>` header.

Query parameters:
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `since` | number | 24h ago | Unix ms start of window |
| `until` | number | now | Unix ms end of window |
| `serverIds` | string | (all) | Comma-separated server IDs |
| `bucketMinutes` | number | `1` | Bucket size (1, 5, 15, or 60) |

Response (200):
```json
{
  "success": true,
  "data": {
    "servers": [
      {
        "serverId": "ed25519:abc123...",
        "shortId": "srv-01",
        "region": "us-east",
        "currentStatus": "healthy",
        "buckets": [
          { "startTime": 1709294400000, "status": "up", "heartbeatCount": 1, "avgLatencyMs": 45 },
          { "startTime": 1709294460000, "status": "up", "heartbeatCount": 1, "avgLatencyMs": 52 },
          { "startTime": 1709294520000, "status": "down", "heartbeatCount": 0 },
          { "startTime": 1709294580000, "status": "down", "heartbeatCount": 0 }
        ],
        "gaps": [
          { "startTime": 1709294520000, "endTime": 1709294700000, "durationMinutes": 3 }
        ],
        "uptimePercent": 98.5
      }
    ],
    "summary": {
      "fleetUptimePercent": 97.2,
      "totalGaps": 4,
      "longestGap": {
        "serverId": "ed25519:def456...",
        "durationMinutes": 12,
        "startTime": 1709340000000,
        "endTime": 1709340720000
      }
    },
    "window": {
      "start": 1709294400000,
      "end": 1709380800000,
      "bucketMinutes": 1,
      "totalBuckets": 1440
    }
  }
}
```

**Scheduled Handler (Cron Trigger)**

A cron trigger runs every 60 seconds (matching the VPS heartbeat interval):
```jsonc
// wrangler.jsonc addition
"triggers": {
  "crons": ["* * * * *"]  // Every minute
}
```

The scheduled handler:
1. Fetches `/servers` from the bootstrap registry via Service Binding
2. For each server, inserts a row into `server_heartbeats` with the current timestamp and status derived from `lastSeen` freshness
3. Cleans up heartbeat rows older than 7 days to prevent unbounded D1 growth

## Dependencies
- **US-5.1 (Per-Server Status):** The Server Health tab must exist. The server list and health status determination logic is shared.
- **Admin-cf Preact SPA migration:** Required for the Preact component.
- **D1 database binding:** A D1 database must be created and bound to the admin-cf Worker. This may be the shared `DIAGNOSTICS_DB` from the diagnostics-cf Worker (if accessible via Service Binding) or a dedicated `ADMIN_DB`.
- **Cron trigger support:** The admin-cf Worker must be configured with a cron trigger for periodic heartbeat recording. Cloudflare Workers support cron triggers natively.
- **Bootstrap registry `/servers` endpoint:** Already exists and returns `lastSeen` timestamps for each registered server.

## Testing Strategy

### Unit Tests
- **Bucket computation:**
  - Given heartbeat timestamps at t=0, t=60, t=120, t=300 (gap at t=180, t=240), compute buckets with correct up/down status
  - Gap detection: correctly identifies gaps where no heartbeat was received for 2+ consecutive bucket periods
  - Gap duration annotation: gaps >= 5 minutes produce a `TimelineGap` entry
  - Bucket size aggregation: when `bucketMinutes=5`, heartbeats are grouped into 5-minute windows
- **Uptime calculation:**
  - 1440 buckets, 1400 green, 40 red = 97.22% uptime
  - Fleet uptime = average of per-server uptimes weighted by time
- **Heartbeat recording:**
  - Scheduled handler correctly inserts rows from bootstrap registry data
  - Duplicate heartbeats (same server, same minute) use UPSERT (ON CONFLICT IGNORE)
  - Cleanup removes rows older than 7 days
- **D1 query:**
  - Time range filtering returns correct subset of buckets
  - Server ID filtering works
  - Empty data (new server, no history) returns all-"down" buckets

### Integration Tests
- Scheduled handler polls bootstrap registry via Service Binding and writes to D1
- Timeline endpoint reads from D1 and returns correct structure
- Auth is enforced on the endpoint

### Component Tests (Preact)
- `HeartbeatTimeline` renders correct number of server rows for given data
- Timeline segments are green for "up" buckets and red for "down" buckets
- Gap annotations appear for gaps >= 5 minutes with correct duration text
- Current-time hairline is positioned correctly based on mock Date.now()
- Horizontal scroll works; server labels remain sticky
- Summary row shows correct fleet uptime percentage
- Tooltip appears on segment hover with timestamp and status
- Auto-refresh appends new bucket data without full re-render
- Empty state (no servers) shows appropriate message

## Technical Notes

**Codebase patterns to follow:**
- The bootstrap heartbeat interval is 60 seconds (line 53 in `packages/server-vps/src/config.ts`: `heartbeatInterval: envNumber('ZAJEL_BOOTSTRAP_HEARTBEAT', 60000)`). The timeline resolution (1-minute buckets) aligns with this interval.
- The bootstrap worker's `ServerRegistryDO` stores `lastSeen` per server but does not maintain a history. The heartbeat history storage in D1 is new infrastructure.
- The admin-cf wrangler.jsonc (line 26-32) already has Service Binding to `BOOTSTRAP_SERVICE`. The cron handler can reuse `fetchFromBootstrap` from `packages/admin-cf/src/routes/servers.ts`.
- The existing VPS admin dashboard uses SVG for charts (lines 932-982 in `packages/server-vps/src/admin/routes.ts`). The SVG-based timeline approach is consistent with the existing charting pattern.

**Heartbeat monitoring best practices (from research):**
- The heartbeat interval (60s) represents a trade-off: shorter intervals detect failures faster but increase network overhead. For the timeline visualization, 1-minute resolution is appropriate — it shows the actual heartbeat cadence without interpolation.
- Gap detection should use a threshold of 2x the heartbeat interval (120 seconds) before marking a bucket as "down". A single missed heartbeat could be a transient network blip; two consecutive misses indicate a real issue.
- False alert mitigation: a "degraded" (yellow) state for buckets where a heartbeat arrived but with latency above a threshold (e.g., > 5 seconds response time) helps distinguish between "completely down" and "struggling."
- Fleet uptime percentage is a standard SRE metric. For a 3-server fleet with 24h window: `totalGreenMinutes / (3 * 1440) * 100`.

**D1 storage considerations:**
- 1440 rows per server per day * 10 servers * 7 days retention = ~100,800 rows. D1 handles this easily within free tier.
- The `UNIQUE(server_id, timestamp)` constraint with `ON CONFLICT IGNORE` prevents duplicate rows if the cron handler runs slightly overlapping.
- The `idx_heartbeats_server_time` index enables efficient range queries for the timeline endpoint.
- D1 is SQLite-based and supports standard aggregate functions. The bucket computation can be done partially in SQL (GROUP BY time bucket) or fully in the Worker code.

**SVG rendering performance:**
- 1440 `<rect>` elements per server row * 10 servers = 14,400 SVG elements. This is within browser rendering limits but may cause jank during initial render on low-power devices. Mitigation: render only visible buckets using the scroll position, or use `<canvas>` for servers with many buckets and overlay SVG only for interactive elements (tooltips, annotations).
- For the initial implementation, SVG is preferred for simplicity and accessibility (elements can have `title` attributes for basic tooltip support). Canvas optimization can be a follow-up if performance issues arise.

**Cron trigger limitation:**
- Cloudflare Workers cron triggers have a minimum granularity of 1 minute, which aligns perfectly with the 60-second heartbeat interval. The cron trigger is configured as `"* * * * *"` (every minute).
- The scheduled handler has a 30-second execution timeout on the free plan (15 minutes on paid). Fetching the server list and inserting rows should complete well within this limit.

## Estimation
**L (Large)** — This story requires new D1 infrastructure (table, migrations, cron handler for data collection), a moderately complex backend (bucket computation, gap detection, uptime calculation), and a custom SVG-based timeline visualization in Preact. Estimated 4-6 days.
