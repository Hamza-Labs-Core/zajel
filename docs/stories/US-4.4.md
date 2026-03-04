# US-4.4: Connection Type Distribution

## Story
As an admin, I want to see direct P2P vs. relay usage, so that I can understand how effectively the peer-to-peer infrastructure is working and whether relay servers need scaling.

## Acceptance Criteria
- Dashboard displays a pie chart showing the distribution of connection types: direct P2P, relay, and none/disconnected
- Each segment shows the type name and exact count
- A trend line chart is displayed below the pie chart showing the P2P vs. relay ratio over time (last 24 hours by default)
- The pie chart refreshes every 30 seconds
- The trend line shows data at 5-minute resolution for the last 24 hours
- Hovering over a segment or trend line point shows a tooltip with exact numbers
- A percentage label is displayed for each connection type (e.g., "Direct P2P: 65%")

## Technical Design

### Architecture
This story adds two visualizations to the Active Clients tab: a pie chart for current connection type distribution and a historical trend line chart. The data source is the same `client_heartbeats` D1 table — the `connection_type` column records whether each session is using `direct_p2p`, `relay`, or `none`.

1. **Pie chart (real-time):** Query `client_heartbeats` with `GROUP BY connection_type` for active sessions (last 10 minutes)
2. **Trend line (historical):** Query a new `connection_type_history` D1 table (populated by the same aggregation cron from US-4.3) for the P2P-to-relay ratio over time

### Implementation Details

**Backend — API Route (`packages/admin-cf/src/routes/clients.ts`):**

Add `handleConnectionTypes(request, env)`:
- Query D1 for connection type counts among active clients
- Query D1 for historical connection type data for the trend line
- Return both in a single response to minimize round trips

**D1 Query (current distribution):**
```sql
SELECT connection_type, COUNT(*) as count
FROM client_heartbeats
WHERE last_seen > ?
GROUP BY connection_type
ORDER BY count DESC
-- Parameter: Date.now() - 10 * 60 * 1000
```

**D1 Query (trend data):**
```sql
SELECT time_bucket, connection_type, active_count
FROM connection_type_history
WHERE time_bucket > ?
ORDER BY time_bucket ASC
-- Parameter: Date.now() - 24 * 60 * 60 * 1000
```

**Aggregation (in diagnostics-cf, extending the US-4.3 cron):**

Add to the existing 5-minute aggregation cron:
```sql
INSERT OR REPLACE INTO connection_type_history (time_bucket, connection_type, active_count)
SELECT
  (? / 300000) * 300000 AS time_bucket,
  connection_type,
  COUNT(*) AS active_count
FROM client_heartbeats
WHERE last_seen > ? - 600000
GROUP BY connection_type
-- Parameters: current timestamp, current timestamp
```

**Frontend — Pie Chart:**

Use the same SVG `<circle>` + `stroke-dasharray` technique as the donut chart in US-4.2, but without the donut hole (full pie). Alternatively, keep it as a donut for visual consistency across the tab.

**Connection type color mapping:**
```javascript
const CONNECTION_COLORS = {
  direct_p2p: '#22c55e',  // Green — the desired state
  relay: '#f97316',        // Orange — functional but less ideal
  none: '#6b7280',         // Gray — disconnected
};
```

**Frontend — Trend Line Chart:**

Render a dual-line SVG chart (similar to `drawConnectionChart()` in the VPS dashboard):
- Green line for direct P2P count over time
- Orange line for relay count over time
- Gray dashed line for "none" (if applicable, usually minimal)
- Y-axis: count of sessions
- X-axis: time labels (every 4 hours)

**Layout:**
```
+---------------------------+----------------------------+
|     Pie Chart (250x250)   |   Legend + Stats            |
+---------------------------+----------------------------+
|   Trend Line Chart (full width, 200px tall)            |
+--------------------------------------------------------+
```

The pie chart and legend sit side by side in a flexbox row. The trend line chart spans the full width below.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/diagnostics-cf/src/aggregation.ts` | Modify | Add connection type aggregation to existing cron job |
| `packages/diagnostics-cf/src/schema.sql` | Modify | Add `connection_type_history` table |
| `packages/admin-cf/src/routes/clients.ts` | Modify | Add `handleConnectionTypes()` handler |
| `packages/admin-cf/src/index.ts` | Modify | Add route for `/admin/api/clients/connections`; add pie chart and trend line to dashboard |
| `packages/admin-cf/src/types.ts` | Modify | Add `ConnectionTypeResponse`, `ConnectionTypeTrend` types |
| `packages/admin-cf/tests/clients.test.ts` | Modify | Add tests for connection types endpoint |
| `packages/diagnostics-cf/tests/aggregation.test.ts` | Modify | Add tests for connection type aggregation |

### Data Models / Schemas

**New D1 Table (`connection_type_history`):**
```sql
CREATE TABLE connection_type_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time_bucket INTEGER NOT NULL,
  connection_type TEXT NOT NULL,
  active_count INTEGER NOT NULL,
  UNIQUE(time_bucket, connection_type)
);

CREATE INDEX idx_conn_type_history_bucket ON connection_type_history(time_bucket);
```

**API Response Schema:**
```typescript
interface ConnectionTypeResponse {
  current: ConnectionTypeCount[];   // Real-time distribution
  trend: ConnectionTypeTrend[];     // Historical trend (24h)
  totalActive: number;
  lastUpdated: number;
}

interface ConnectionTypeCount {
  connectionType: 'direct_p2p' | 'relay' | 'none';
  count: number;
  percentage: number;  // 0.0 to 100.0
}

interface ConnectionTypeTrend {
  timestamp: number;
  direct_p2p: number;
  relay: number;
  none: number;
}
```

### API Endpoints

**`GET /admin/api/clients/connections`**

- **Auth:** Bearer JWT (admin or super-admin)
- **Query params:**
  - `trendHours` — Number of hours for the trend line (default: `24`, max: `168`)
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "current": [
      { "connectionType": "direct_p2p", "count": 28, "percentage": 66.7 },
      { "connectionType": "relay", "count": 12, "percentage": 28.6 },
      { "connectionType": "none", "count": 2, "percentage": 4.8 }
    ],
    "trend": [
      { "timestamp": 1709380800000, "direct_p2p": 25, "relay": 10, "none": 3 },
      { "timestamp": 1709381100000, "direct_p2p": 26, "relay": 11, "none": 3 },
      { "timestamp": 1709381400000, "direct_p2p": 28, "relay": 12, "none": 2 }
    ],
    "totalActive": 42,
    "lastUpdated": 1709384400000
  }
}
```
- **Response (401):** `{ "success": false, "error": "Unauthorized" }`

## Dependencies
- **US-1.2 (Client Heartbeat for Active Counting):** Heartbeats must include `connection_type` in the `client_heartbeats` table
- **US-4.1 (Anonymous Active Client Count):** Establishes the Active Clients tab, route file, and D1 binding infrastructure
- **US-4.3 (Version Adoption Curve):** Establishes the aggregation cron in diagnostics-cf — this story extends it with connection type aggregation
- **D1 schema migration:** The `connection_type_history` table must be created

## Testing Strategy

### Unit Tests
- Test `handleConnectionTypes` returns correct current distribution from D1 mock
- Test percentage calculation for various distributions (all P2P, all relay, mixed, single client)
- Test trend data returns correctly shaped time-series
- Test with no `connection_type` data (some heartbeats may have `null` connection type — treated as "none")
- Test unauthorized request returns 401
- Test `trendHours` query parameter validation (reject negative, >168)

### Integration Tests
- Seed D1 `client_heartbeats` with a mix of connection types
- Seed `connection_type_history` with 24h of trend data
- Verify current distribution matches expected counts
- Verify trend data is correctly ordered by timestamp
- Test aggregation cron produces correct connection type history entries

### E2E Tests
- Not applicable (internal admin tooling)

## Technical Notes

**Connection type values:**
The Flutter app sets `connection_type` in the heartbeat based on the current WebRTC connection state:
- `direct_p2p` — WebRTC data channel established directly between peers (ICE succeeded without relay)
- `relay` — WebRTC data channel established via TURN relay server
- `none` — No active P2P connection (e.g., app is open but not in a session)

The diagnostics-cf heartbeat handler should normalize `null`/empty values to `none`.

**Pie chart vs. donut chart:**
For visual consistency with US-4.2's platform donut chart, this story should also use a donut chart. The technique is identical — SVG `<circle>` with `stroke-dasharray` — but with different colors (green/orange/gray vs. the platform palette). Reusing the same rendering function with different data and colors is recommended.

**Trend line implementation:**
The trend line follows the exact SVG `<path>` pattern from the VPS dashboard's `drawConnectionChart()`. The difference is rendering 2-3 lines instead of 1:

```javascript
// For each connection type, build a path:
const path = trendData.map((d, i) => {
  const x = mapToX(d.timestamp);
  const y = mapToY(d.direct_p2p);  // or d.relay
  return (i === 0 ? 'M' : 'L') + x + ',' + y;
}).join(' ');
```

**P2P ratio as a key metric:**
The P2P-to-relay ratio is a critical operational metric for Zajel. High relay usage indicates:
- NAT traversal issues (STUN/TURN configuration problems)
- Firewall restrictions in user networks
- Potential need to scale TURN relay infrastructure

Consider adding a "P2P Success Rate" summary number (e.g., "65% P2P") as a prominent stat card above the charts.

**Handling `connection_type = null`:**
Some heartbeats may arrive without a `connection_type` if the client has not yet established any connection. These should be counted as `none` in both the real-time pie chart and the historical trend. The SQL query should use `COALESCE(connection_type, 'none')`:

```sql
SELECT COALESCE(connection_type, 'none') as connection_type, COUNT(*) as count
FROM client_heartbeats
WHERE last_seen > ?
GROUP BY COALESCE(connection_type, 'none')
```

**Aggregation cron extension:**
The US-4.3 cron already runs every 5 minutes. This story adds one more INSERT query to the same handler function. Both version_history and connection_type_history are populated in the same cron invocation to keep them in sync.

**D1 retention:**
Apply the same 30-day retention as `version_history`:
```sql
DELETE FROM connection_type_history WHERE time_bucket < ? - 30 * 86400000
```

## Estimation
**M (Medium)** — One new API endpoint returning both current and historical data, one new D1 table with aggregation (extending the existing cron from US-4.3), and two frontend visualizations (pie chart reusing the US-4.2 donut technique, trend line reusing the VPS dashboard line chart technique). Most of the patterns are established by prior stories; the main new work is the dual-line trend chart and the combined API response.
