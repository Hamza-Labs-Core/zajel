# US-3.4: Federation Health Metrics

## Story
As an admin, I want to see gossip health, node availability, and sync latency, so that I can monitor the health of the SWIM gossip federation and detect partitioning or failure propagation issues early.

## Acceptance Criteria
- Node count is displayed with breakdown by status: alive, suspect, failed, left
- Status indicator shows overall gossip health: healthy (all alive), degraded (any suspect), critical (any failed or <50% alive)
- Gossip round-trip latency is displayed (p50, p95 from ping/ping-ack round trips)
- Sync completeness indicator shows what fraction of the expected membership each server agrees on
- Node availability timeline shows the up/down history of each federation member over time
- Data auto-refreshes every 30 seconds
- Federation topology summary (how many nodes, how many regions) is shown
- Color-coded: green for alive, yellow for suspect, red for failed

## Technical Design

### Architecture
This story adds a "Federation Health" section within the Metrics tab of the admin-cf Preact SPA. Federation data comes from two sources:

1. **Server metrics push (D1):** Each VPS pushes federation membership counts (alive, total) as part of the `ServerMetricsPush` from US-3.3
2. **Direct VPS federation API:** The existing `/admin/api/federation` endpoint on each VPS server (in `packages/server-vps/src/admin/routes.ts`) returns the full `FederationTopology` with nodes and edges. The admin-cf can proxy this for detailed topology data.
3. **Gossip round-trip latency:** Requires new instrumentation in the `FailureDetector` to track ping/ping-ack round-trip times, pushed as part of server metrics.

```
VPS GossipProtocol -> FailureDetector (tracks RTT) -> MetricsCollector -> push to D1
VPS /admin/api/federation -> admin-cf proxy -> Preact dashboard
D1 server_metrics (federation fields) -> admin-cf API -> Preact dashboard
```

### Implementation Details

**Backend: Gossip RTT instrumentation (server-vps):**
- Modify the `FailureDetector` in `packages/server-vps/src/federation/gossip/failure-detector.ts` to track round-trip times
- In the `ping()` method (line 106), record `startTime` (already done at line 118)
- In the `ack()` method (line 129), compute `rtt = Date.now() - pending.startTime` and store in a rolling window
- Add a `getLatencyStats()` method that computes p50, p95, p99 from the rolling RTT window
- Expose this through `GossipProtocol` and `MetricsCollector` so it becomes part of the metrics snapshot and push

**Backend: Sync completeness:**
- Each VPS knows its own membership list. When multiple VPS servers push their federation member counts to D1, the admin-cf can compare them.
- Sync completeness = min(alive counts across servers) / max(alive counts across servers). If all servers agree on the same alive count, completeness is 100%.
- A simpler metric: for each server, its `federation_alive_members / federation_total_members` ratio

**Backend (admin-cf Worker):**
- Add `handleFederationMetrics` to `src/routes/metrics.ts`
- Query D1 `server_metrics` for the latest federation fields (alive_members, total_members) per server
- Compute aggregate federation health status
- For detailed topology, proxy to a selected VPS server's `/admin/api/federation` endpoint (pick the first healthy server)
- Add gossip latency stats from the `server_metrics` table (new columns or JSON field)

**Frontend (Preact SPA):**
- Create `FederationHealthPanel` component within the Metrics tab
- **Status overview:** Large status badge (Healthy/Degraded/Critical) with node count breakdown
- **Latency display:** Show gossip RTT p50/p95 using `MetricCard` components
- **Sync completeness:** Horizontal bar showing percentage with green/yellow/red coloring
- **Node availability timeline:** Horizontal bars per server, colored by status over time (similar to a Gantt chart). Use SVG rectangles with time on x-axis and servers on y-axis.
- **Region summary:** Small table showing nodes per region (data already in `MetricsSnapshot.federation.regions` at `packages/server-vps/src/admin/types.ts` line 36)

**Health determination:**
- Healthy: All known members are alive, gossip RTT p95 < 500ms
- Degraded: Any member is suspect, or gossip RTT p95 500-2000ms
- Critical: Any member is failed, fewer than 50% alive, or gossip RTT p95 > 2000ms

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/server-vps/src/federation/gossip/failure-detector.ts` | Modify | Add RTT tracking to ping/ack cycle; add `getLatencyStats()` method |
| `packages/server-vps/src/admin/metrics.ts` | Modify | Include gossip latency stats in `takeSnapshot()` output |
| `packages/server-vps/src/admin/types.ts` | Modify | Add `gossipLatency` field to `MetricsSnapshot` |
| `packages/admin-cf/src/routes/metrics.ts` | Modify | Add `handleFederationMetrics` handler |
| `packages/admin-cf/src/index.ts` | Modify | Add routing for `/admin/api/metrics/federation` |
| `packages/admin-cf/src/types.ts` | Modify | Add `FederationMetricsResponse` type |
| `packages/admin-cf/src/dashboard/FederationHealthPanel.tsx` | Create | Preact component with federation health overview |
| `packages/admin-cf/src/dashboard/components/StatusBadge.tsx` | Create | Reusable health status badge (Healthy/Degraded/Critical) |
| `packages/admin-cf/src/dashboard/components/AvailabilityTimeline.tsx` | Create | SVG timeline showing per-node up/down history |
| `packages/admin-cf/src/dashboard/MetricsTab.tsx` | Modify | Add FederationHealthPanel as a section |
| `packages/diagnostics-cf/src/schema.sql` | Modify | Add gossip latency columns to `server_metrics` table (or extend the push payload) |
| `packages/admin-cf/tests/e2e/metrics-federation.test.ts` | Create | E2E tests for federation metrics endpoint |
| `packages/server-vps/tests/failure-detector-latency.test.ts` | Create | Unit tests for RTT tracking in FailureDetector |

### Data Models / Schemas

**Extended server_metrics table (additions from US-3.3):**
```sql
-- Additional columns for federation health
ALTER TABLE server_metrics ADD COLUMN gossip_rtt_p50_ms REAL;
ALTER TABLE server_metrics ADD COLUMN gossip_rtt_p95_ms REAL;
ALTER TABLE server_metrics ADD COLUMN gossip_rtt_p99_ms REAL;
ALTER TABLE server_metrics ADD COLUMN gossip_ping_count INTEGER DEFAULT 0;
```

Note: If `server_metrics` is created fresh in US-3.3, include these columns in the initial CREATE TABLE instead of ALTER.

**Extended MetricsSnapshot (server-vps types):**
```typescript
// Added to MetricsSnapshot in packages/server-vps/src/admin/types.ts
interface MetricsSnapshot {
  // ... existing fields ...
  gossipLatency?: {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    pingCount: number;       // number of pings in the measurement window
  };
}
```

**FailureDetector latency tracking:**
```typescript
// Internal to FailureDetector
interface LatencyWindow {
  samples: number[];         // RTT values in ms, circular buffer
  maxSamples: number;        // e.g., 100 most recent pings
}
```

**API Response Schema:**
```typescript
interface FederationMetricsResponse {
  health: 'healthy' | 'degraded' | 'critical';
  summary: {
    totalNodes: number;
    aliveNodes: number;
    suspectNodes: number;
    failedNodes: number;
    regions: Record<string, number>;
  };
  gossipLatency: {
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
    pingCount: number;
  };
  syncCompleteness: number;               // 0-100 percentage
  perServer: Array<{
    serverId: string;
    region: string;
    aliveMembers: number;
    totalMembers: number;
    gossipRttP50Ms: number | null;
    gossipRttP95Ms: number | null;
    lastSeen: number;
  }>;
  availabilityHistory: Array<{
    serverId: string;
    region: string;
    timeline: Array<{
      timestamp: number;
      status: 'alive' | 'suspect' | 'failed' | 'offline';
    }>;
  }>;
}
```

### API Endpoints

**GET /admin/api/metrics/federation**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `range` | query string | No | Time range for availability history: "1h", "6h", "24h" (default "1h") |

**Response (200):**
```json
{
  "success": true,
  "data": {
    "health": "healthy",
    "summary": {
      "totalNodes": 4,
      "aliveNodes": 4,
      "suspectNodes": 0,
      "failedNodes": 0,
      "regions": { "us-east": 2, "eu-west": 1, "ap-south": 1 }
    },
    "gossipLatency": {
      "p50Ms": 45.2,
      "p95Ms": 120.8,
      "p99Ms": 250.1,
      "pingCount": 240
    },
    "syncCompleteness": 100,
    "perServer": [
      {
        "serverId": "srv-01",
        "region": "us-east",
        "aliveMembers": 4,
        "totalMembers": 4,
        "gossipRttP50Ms": 42.0,
        "gossipRttP95Ms": 115.3,
        "lastSeen": 1709464800000
      }
    ],
    "availabilityHistory": [
      {
        "serverId": "srv-01",
        "region": "us-east",
        "timeline": [
          { "timestamp": 1709461200000, "status": "alive" },
          { "timestamp": 1709462100000, "status": "suspect" },
          { "timestamp": 1709462400000, "status": "alive" }
        ]
      }
    ]
  }
}
```

**Response (401):** Unauthorized

## Dependencies
- **US-3.3 (Server Metrics Overview):** The `server_metrics` D1 table and VPS push mechanism must exist; this story extends the push payload with gossip latency data
- **US-3.1 (App Performance Metrics):** Shares `MetricsTab`, `MetricCard`, `LineChart` components
- **VPS federation module:** The existing `GossipProtocol`, `FailureDetector`, and `Membership` classes in `packages/server-vps/src/federation/gossip/` are modified to add latency tracking
- **VPS admin module:** The `MetricsCollector` in `packages/server-vps/src/admin/metrics.ts` already reads federation info via `getFederationInfo()` (line 236) -- this is extended with gossip latency

## Testing Strategy

**Unit Tests:**
- Test `FailureDetector.getLatencyStats()` with various RTT sample sets
  - Empty samples: returns nulls
  - Single sample: p50 = p95 = p99 = that value
  - Normal distribution: verify percentile calculations are correct
  - Circular buffer overflow: verify oldest samples are evicted
- Test health determination logic (healthy/degraded/critical thresholds)
- Test sync completeness calculation across multiple servers with varying member counts
- Test availability timeline construction from D1 time-series data

**Integration Tests:**
- Test `GET /admin/api/metrics/federation` with mocked D1 containing server_metrics rows with federation fields
- Verify correct health status computation
- Verify sync completeness calculation with divergent server views
- Verify availability history respects time range parameter
- Verify auth requirement

**E2E Tests:**
- Seed D1 with server_metrics rows simulating a federation with status changes over time
- Call federation metrics endpoint and verify response matches expected health, latency, and timeline data
- Test degraded scenario: seed data with one server showing suspect members

**VPS-level Tests:**
- Test modified `FailureDetector` ping/ack cycle correctly records RTT
- Test `MetricsCollector.takeSnapshot()` includes gossipLatency field
- Test that gossip latency data is included in the push payload

## Technical Notes

**Codebase patterns to follow:**
- The `FailureDetector` in `packages/server-vps/src/federation/gossip/failure-detector.ts` already records `startTime` in `PendingPing` (line 28) and clears it on `ack()` (line 129-141). The RTT computation is a natural extension: `Date.now() - pending.startTime` at the point where `ack()` succeeds.
- The `MetricsCollector.getFederationInfo()` method (lines 236-257) already collects alive/suspect/total members and regions. Adding `gossipLatency` requires accessing the failure detector through the gossip protocol: `this.federation.getGossip()` is not currently exposed, but `FederationManager` has `getGossip()` (line 166 of federation-manager.ts). The `MetricsCollector` receives a `FederationManager` in its constructor, so it can access the gossip protocol.
- However, `GossipProtocol` does not currently expose the `FailureDetector` directly. Either add a `getFailureDetector()` accessor to `GossipProtocol`, or add a `getLatencyStats()` method to `GossipProtocol` that delegates to the failure detector.
- The VPS dashboard already has a federation topology visualization (lines 984-1028 of routes.ts). The admin-cf federation health panel is a higher-level view focused on health metrics rather than topology. The topology graph is better suited for the Server Health Dashboard (Epic 5).

**SWIM protocol monitoring best practices:**
- Key health signals for a SWIM-based federation are: (1) convergence time (how quickly all nodes agree on membership changes), (2) false positive rate (nodes incorrectly marked as failed), and (3) gossip RTT (indicates network health between nodes).
- The Lifeguard extension to SWIM (used by HashiCorp Memberlist) recommends monitoring "local health" to detect when a node itself is overloaded and may be slow to respond to pings, leading to false positives. While we don't implement Lifeguard, monitoring gossip RTT per-server provides similar insight.
- Sync completeness is computed by comparing each server's view of the alive member count. Divergence indicates a partition or delayed convergence.

**Percentile computation in the FailureDetector:**
- Use a sorted array approach for percentile computation since the sample window is small (100 samples):
  ```typescript
  function percentile(sorted: number[], p: number): number {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }
  ```
- Circular buffer: maintain a fixed-size array with a write pointer that wraps around. When computing stats, copy and sort.

**Availability timeline construction:**
- The availability timeline is reconstructed from the D1 `server_metrics` rows by looking at each server's `federation_alive_members` and comparing to expected totals, plus the timestamp gaps (missing push = offline).
- Represent as a list of status transitions rather than per-minute data points to keep the payload small.

**D1 query for federation health aggregation:**
```sql
-- Latest federation view per server
SELECT server_id, region,
       federation_alive_members, federation_total_members,
       gossip_rtt_p50_ms, gossip_rtt_p95_ms,
       timestamp as last_seen
FROM server_metrics
WHERE (server_id, timestamp) IN (
  SELECT server_id, MAX(timestamp) FROM server_metrics GROUP BY server_id
);
```

## Estimation
**L (Large)** -- This story requires modifications across three layers: (1) VPS gossip protocol instrumentation (FailureDetector RTT tracking, MetricsCollector extension), (2) admin-cf backend (new D1 queries, federation health computation, sync completeness algorithm), and (3) admin-cf frontend (new panel with status badge, latency cards, availability timeline). The availability timeline is a novel visualization component. The RTT instrumentation touches the core gossip protocol, which requires careful testing to avoid regressions in failure detection behavior.
