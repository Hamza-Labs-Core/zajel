# US-3.2: Network Success Rates

## Story
As an admin, I want to see signaling and WebRTC establishment success rates, so that I can monitor the reliability of the peer-to-peer connection pipeline and quickly identify network-level degradation.

## Acceptance Criteria
- Gauge charts display current signaling connect success rate and WebRTC establishment success rate (0-100%)
- Trend lines show success rates over time with configurable range (1h, 6h, 24h, 7d)
- Breakdown by platform is available (per-platform success rate comparison)
- Relay vs. direct P2P usage distribution is shown as a pie/donut chart
- Latency percentiles (avg, p50, p95) are displayed for connection establishment
- Color-coded thresholds: green (>95%), yellow (85-95%), red (<85%)
- Data auto-refreshes every 30 seconds
- Numeric totals shown: total attempts, total successes, total failures for each metric

## Technical Design

### Architecture
This story adds a "Network" section within the Metrics tab of the admin-cf Preact SPA. It reads from the D1 `network_aggregates` table (populated by the diagnostics ingestion worker) and renders gauge charts, trend lines, and distribution charts. The data flow is:

```
Flutter App -> diagnostics-cf (ingestion) -> D1 network_aggregates
admin-cf API -> reads D1 -> Preact dashboard renders gauges + charts
```

The admin-cf Worker exposes `GET /admin/api/metrics/network` that queries D1 for network aggregate data. The Preact dashboard renders gauge components for current rates and line charts for historical trends.

### Implementation Details

**Backend (admin-cf Worker):**
- Add `handleNetworkMetrics` to `src/routes/metrics.ts` (created in US-3.1)
- Query `network_aggregates` table with platform, version, and time range filters
- Compute success rates from success/failure counts: `signaling_success_count / (signaling_success_count + signaling_failure_count)`
- Return both current rates (latest time bucket) and historical time series
- Include relay vs. direct P2P distribution from `relay_usage_count` and `direct_p2p_count`

**Frontend (Preact SPA):**
- Create `NetworkMetricsPanel` component within the Metrics tab
- **Gauge charts:** SVG arc-based gauges (similar to the entropy gauge in the VPS dashboard at `packages/server-vps/src/admin/routes.ts` lines 878-902 which uses SVG circle with stroke-dasharray/stroke-dashoffset). Create a reusable `GaugeChart` component.
- **Trend lines:** Reuse the `LineChart` component from US-3.1 to show success rate percentages over time
- **Pie/donut chart:** Create a `DonutChart` SVG component showing relay vs. direct P2P distribution
- **Latency display:** Show avg latency with p50/p95 breakdown using `MetricCard` components from US-3.1
- Use the same `FilterBar` component for platform/version/time range filtering

**Gauge rendering:**
- The existing VPS dashboard already has an SVG gauge pattern in `renderEntropyGauge()` (routes.ts lines 878-902) using SVG circles with stroke-dasharray and stroke-dashoffset. Extract this into a reusable Preact `GaugeChart` component with props for value, max, color thresholds, and label.

**Success rate computation:**
- Signaling success rate: `SUM(signaling_success_count) / (SUM(signaling_success_count) + SUM(signaling_failure_count)) * 100`
- WebRTC success rate: `SUM(webrtc_success_count) / (SUM(webrtc_success_count) + SUM(webrtc_failure_count)) * 100`
- Handle division by zero (no attempts = show "N/A" not 0%)

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/admin-cf/src/routes/metrics.ts` | Modify | Add `handleNetworkMetrics` handler for `GET /admin/api/metrics/network` |
| `packages/admin-cf/src/index.ts` | Modify | Add routing for `/admin/api/metrics/network` endpoint |
| `packages/admin-cf/src/types.ts` | Modify | Add `NetworkMetricsResponse` type |
| `packages/admin-cf/src/dashboard/NetworkMetricsPanel.tsx` | Create | Preact component with gauges, trend lines, distribution chart |
| `packages/admin-cf/src/dashboard/components/GaugeChart.tsx` | Create | Reusable SVG gauge component (arc with percentage) |
| `packages/admin-cf/src/dashboard/components/DonutChart.tsx` | Create | Reusable SVG donut chart for distribution visualization |
| `packages/admin-cf/src/dashboard/MetricsTab.tsx` | Modify | Add NetworkMetricsPanel as a section |
| `packages/admin-cf/tests/e2e/metrics-network.test.ts` | Create | E2E tests for the network metrics API endpoint |

### Data Models / Schemas

**D1 Table (already defined in plan, populated by diagnostics-cf):**
```sql
CREATE TABLE network_aggregates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time_bucket TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  signaling_success_count INTEGER DEFAULT 0,
  signaling_failure_count INTEGER DEFAULT 0,
  webrtc_success_count INTEGER DEFAULT 0,
  webrtc_failure_count INTEGER DEFAULT 0,
  relay_usage_count INTEGER DEFAULT 0,
  direct_p2p_count INTEGER DEFAULT 0,
  avg_latency_ms REAL,
  sample_count INTEGER NOT NULL,
  UNIQUE(time_bucket, platform, app_version)
);
```

**API Response Schema:**
```typescript
interface NetworkMetricsResponse {
  current: {
    signalingSuccessRate: number | null;   // 0-100 percentage
    signalingAttempts: number;
    webrtcSuccessRate: number | null;      // 0-100 percentage
    webrtcAttempts: number;
    relayUsageRate: number | null;         // 0-100 percentage
    avgLatencyMs: number | null;
  };
  trends: {
    signalingRate: Array<{
      timeBucket: string;
      successRate: number | null;
      attempts: number;
    }>;
    webrtcRate: Array<{
      timeBucket: string;
      successRate: number | null;
      attempts: number;
    }>;
    latency: Array<{
      timeBucket: string;
      avgLatencyMs: number | null;
    }>;
  };
  distribution: {
    relayCount: number;
    directP2pCount: number;
    totalConnections: number;
  };
  platformBreakdown: Array<{
    platform: string;
    signalingSuccessRate: number | null;
    webrtcSuccessRate: number | null;
    avgLatencyMs: number | null;
    sampleCount: number;
  }>;
  filters: {
    platforms: string[];
    versions: string[];
  };
}
```

### API Endpoints

**GET /admin/api/metrics/network**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `platform` | query string | No | Filter by platform |
| `version` | query string | No | Filter by app version |
| `range` | query string | No | Time range: "1h", "6h", "24h", "7d" (default "24h") |

**Response (200):**
```json
{
  "success": true,
  "data": {
    "current": {
      "signalingSuccessRate": 97.5,
      "signalingAttempts": 1240,
      "webrtcSuccessRate": 92.1,
      "webrtcAttempts": 980,
      "relayUsageRate": 15.3,
      "avgLatencyMs": 145.2
    },
    "trends": {
      "signalingRate": [
        { "timeBucket": "2026-03-03T10:00:00Z", "successRate": 98.2, "attempts": 52 }
      ],
      "webrtcRate": [
        { "timeBucket": "2026-03-03T10:00:00Z", "successRate": 91.5, "attempts": 41 }
      ],
      "latency": [
        { "timeBucket": "2026-03-03T10:00:00Z", "avgLatencyMs": 142.0 }
      ]
    },
    "distribution": {
      "relayCount": 150,
      "directP2pCount": 830,
      "totalConnections": 980
    },
    "platformBreakdown": [
      { "platform": "android", "signalingSuccessRate": 96.8, "webrtcSuccessRate": 90.2, "avgLatencyMs": 168.0, "sampleCount": 620 }
    ],
    "filters": {
      "platforms": ["android", "ios", "web"],
      "versions": ["1.2.0", "1.1.0"]
    }
  }
}
```

**Response (401):** Unauthorized

## Dependencies
- **US-1.1 (Diagnostic Report Submission):** The `network_aggregates` D1 table must be populated by the diagnostics ingestion worker
- **US-3.1 (App Performance Metrics):** Shares the `MetricsTab` container, `FilterBar`, `MetricCard`, and `LineChart` components
- **D1 database:** The `zajel-diagnostics` D1 database must be bound to admin-cf

## Testing Strategy

**Unit Tests:**
- Test success rate computation with various count combinations (all success, all failure, mixed, zero attempts)
- Test division-by-zero handling (returns null, not NaN or Infinity)
- Test D1 query construction with filter combinations
- Test platform breakdown aggregation logic

**Integration Tests:**
- Test `GET /admin/api/metrics/network` with mocked D1 containing sample network_aggregates rows
- Verify correct success rate calculation across multiple time buckets
- Verify platform breakdown returns per-platform rates
- Verify distribution counts are correctly summed
- Verify auth requirement (401 without token)
- Verify time range filtering works correctly

**E2E Tests:**
- Seed D1 with network aggregate data across multiple platforms and time buckets
- Call API and verify response schema and calculated rates match expected values
- Verify edge case: no data returns null rates (not 0)

## Technical Notes

**Codebase patterns to follow:**
- The VPS dashboard's `renderEntropyGauge()` function (in `packages/server-vps/src/admin/routes.ts` lines 878-902) provides an exact pattern for SVG gauge rendering. It uses SVG `<circle>` with `stroke-dasharray` and `stroke-dashoffset` to create an arc gauge. The Preact `GaugeChart` component should follow this same SVG technique but as a proper component with typed props.
- The VPS `MetricsCollector` already tracks connection counts (relay vs. signaling) at `packages/server-vps/src/admin/metrics.ts` lines 78-98. The client-side network metrics in D1 complement this with success/failure rates from the app perspective.

**D1 query considerations:**
- Success rates should be computed in SQL using `CAST` for float division: `CAST(SUM(signaling_success_count) AS REAL) / NULLIF(SUM(signaling_success_count) + SUM(signaling_failure_count), 0) * 100`
- Use `NULLIF` to handle zero-attempt buckets (returns NULL instead of division by zero)
- For the "current" values, use the most recent time bucket with non-zero sample_count
- Group by time_bucket for trends, group by platform for breakdown

**Gauge thresholds:**
- These thresholds reflect Zajel's P2P architecture where some WebRTC failures are expected (NAT traversal issues, network transitions) while signaling should be highly reliable since it goes through the VPS relay.

**Donut chart rendering:**
- Use SVG `<circle>` elements with `stroke-dasharray` segments, similar to the gauge but showing proportional segments. Two segments (relay and direct P2P) with distinct colors from the CSS palette.

## Estimation
**M (Medium)** -- The backend adds another D1 query handler to the metrics route file, following the same pattern established in US-3.1. The frontend requires two new chart components (GaugeChart, DonutChart) plus composition of existing components. The gauge component closely follows the existing VPS dashboard pattern, reducing the design effort. The platform breakdown table is straightforward.
