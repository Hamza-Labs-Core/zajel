# US-3.1: App Performance Metrics

## Story
As an admin, I want to see app startup time percentiles, frame rates, and memory usage, so that I can monitor application health across the user base and detect performance regressions early.

## Acceptance Criteria
- Line charts display p50, p95, and p99 values for startup time, frame rate, and memory usage
- Charts are filterable by platform (Android, iOS, Windows, macOS, Linux, Web)
- Charts are filterable by app version
- 7-day history is available with configurable time range selector (1h, 6h, 24h, 7d)
- Data auto-refreshes every 30 seconds
- Empty states are shown gracefully when no data is available for a given filter combination
- Percentile values are displayed numerically alongside charts (current p50/p95/p99 summary cards)
- Color coding indicates thresholds: green (healthy), yellow (degraded), red (critical)

## Technical Design

### Architecture
This story adds an "App Performance" section within the new Metrics tab of the admin-cf Preact SPA. It reads aggregated performance data from the D1 `performance_aggregates` table (populated by the diagnostics ingestion worker from US-1.1) and renders it using lightweight chart components. The data flow is:

```
Flutter App -> diagnostics-cf (ingestion) -> D1 performance_aggregates
admin-cf API -> reads D1 -> Preact dashboard renders charts
```

The admin-cf Worker exposes a new REST endpoint `GET /admin/api/metrics/app` that queries D1 and returns time-bucketed percentile data. The Preact dashboard consumes this endpoint and renders line charts with filter controls.

### Implementation Details

**Backend (admin-cf Worker):**
- Add a new route handler `handleAppMetrics` in a new file `src/routes/metrics.ts`
- The handler queries the `performance_aggregates` table in D1 with filters for platform, version, time range, and metric name
- Returns JSON with time-bucketed arrays of { timeBucket, p50, p95, p99, sampleCount }
- Follow the existing pattern from `src/routes/servers.ts` for auth and response formatting

**Frontend (Preact SPA):**
- Create a new Preact component `MetricsTab` that replaces the inline HTML metrics section
- Within `MetricsTab`, create an `AppPerformancePanel` component
- Use lightweight SVG-based line charts (following the pattern already established in the VPS dashboard's `drawConnectionChart()` function which uses inline SVG path generation)
- Add filter dropdowns for platform and version, and a time range selector
- Use Preact Signals for reactive state management of filter selections and chart data
- Auto-refresh via `setInterval` at 30-second cadence, pausing when the tab is not visible (`document.hidden`)

**Chart rendering approach:**
- Since the existing VPS dashboard already renders SVG charts inline (see `drawConnectionChart` in `packages/server-vps/src/admin/routes.ts` lines 932-981), follow the same SVG path generation approach for consistency
- Render three line series per chart (p50 in blue, p95 in yellow, p99 in red) on the same axes
- Include grid lines, axis labels, and a hover tooltip showing exact values
- Use the existing CSS variable color scheme (--accent, --warning, --danger)

**Percentile thresholds (startup time):**
- Green: p95 < 3000ms
- Yellow: p95 3000-5000ms
- Red: p95 > 5000ms

**Percentile thresholds (frame rate):**
- Green: p50 > 55fps
- Yellow: p50 45-55fps
- Red: p50 < 45fps

**Percentile thresholds (memory):**
- Green: p95 < 200MB
- Yellow: p95 200-400MB
- Red: p95 > 400MB

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/admin-cf/src/routes/metrics.ts` | Create | New route handler for `GET /admin/api/metrics/app` with D1 queries |
| `packages/admin-cf/src/index.ts` | Modify | Add routing for `/admin/api/metrics/app` endpoint |
| `packages/admin-cf/src/types.ts` | Modify | Add `DIAGNOSTICS_DB` D1 binding to `Env` interface; add `AppMetricsResponse` type |
| `packages/admin-cf/wrangler.jsonc` | Modify | Add `d1_databases` binding for `DIAGNOSTICS_DB` |
| `packages/admin-cf/src/dashboard/MetricsTab.tsx` | Create | Preact component for the Metrics tab container |
| `packages/admin-cf/src/dashboard/AppPerformancePanel.tsx` | Create | Preact component with line charts, filters, summary cards |
| `packages/admin-cf/src/dashboard/components/LineChart.tsx` | Create | Reusable SVG line chart component (multi-series) |
| `packages/admin-cf/src/dashboard/components/FilterBar.tsx` | Create | Reusable filter dropdown bar (platform, version, time range) |
| `packages/admin-cf/src/dashboard/components/MetricCard.tsx` | Create | Summary card showing a single metric with threshold coloring |
| `packages/admin-cf/tests/e2e/metrics-app.test.ts` | Create | E2E tests for the app metrics API endpoint |

### Data Models / Schemas

**D1 Table (already defined in plan, populated by diagnostics-cf):**
```sql
CREATE TABLE performance_aggregates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time_bucket TEXT NOT NULL,          -- ISO datetime truncated to hour
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  metric_name TEXT NOT NULL,          -- 'startup_time', 'frame_rate', 'memory'
  p50 REAL,
  p95 REAL,
  p99 REAL,
  sample_count INTEGER NOT NULL,
  UNIQUE(time_bucket, platform, app_version, metric_name)
);
```

**API Response Schema:**
```typescript
interface AppMetricsResponse {
  metrics: {
    metricName: string;       // 'startup_time' | 'frame_rate' | 'memory'
    unit: string;             // 'ms' | 'fps' | 'MB'
    dataPoints: Array<{
      timeBucket: string;     // ISO datetime
      p50: number | null;
      p95: number | null;
      p99: number | null;
      sampleCount: number;
    }>;
    current: {                // Latest bucket summary
      p50: number | null;
      p95: number | null;
      p99: number | null;
    };
  }[];
  filters: {
    platforms: string[];      // Available platforms in data
    versions: string[];       // Available versions in data
  };
}
```

### API Endpoints

**GET /admin/api/metrics/app**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `platform` | query string | No | Filter by platform (e.g., "android") |
| `version` | query string | No | Filter by app version (e.g., "1.2.0") |
| `range` | query string | No | Time range: "1h", "6h", "24h", "7d" (default "24h") |
| `metric` | query string | No | Specific metric: "startup_time", "frame_rate", "memory" (default: all) |

**Response (200):**
```json
{
  "success": true,
  "data": {
    "metrics": [
      {
        "metricName": "startup_time",
        "unit": "ms",
        "dataPoints": [
          { "timeBucket": "2026-03-03T10:00:00Z", "p50": 1200, "p95": 2800, "p99": 4500, "sampleCount": 150 }
        ],
        "current": { "p50": 1200, "p95": 2800, "p99": 4500 }
      }
    ],
    "filters": {
      "platforms": ["android", "ios", "web"],
      "versions": ["1.2.0", "1.1.0"]
    }
  }
}
```

**Response (401):** Unauthorized (missing or invalid JWT)

## Dependencies
- **US-1.1 (Diagnostic Report Submission):** The `performance_aggregates` D1 table must be populated by the diagnostics ingestion worker
- **Epic 2 (Error Dashboard) or admin-cf Preact migration:** The Preact SPA infrastructure and tab routing must be in place; this can be built in parallel if the tab shell is stubbed
- **D1 database:** The `zajel-diagnostics` D1 database must be created and bound to admin-cf

## Testing Strategy

**Unit Tests:**
- Test the D1 query builder for `handleAppMetrics` with various filter combinations (platform, version, range)
- Test percentile threshold classification logic (green/yellow/red)
- Test time range to SQL WHERE clause conversion
- Test empty result handling (no data for filters)

**Integration Tests:**
- Test `GET /admin/api/metrics/app` with mocked D1 database containing sample performance_aggregates rows
- Verify correct filtering behavior: platform filter, version filter, time range filter, combined filters
- Verify response schema matches `AppMetricsResponse` interface
- Verify auth requirement (401 without token)

**E2E Tests:**
- Seed D1 with sample data, call the API, verify response structure and data accuracy
- Verify that the Preact dashboard renders charts when navigating to the Metrics tab (if Preact SPA E2E is in scope)

## Technical Notes

**Codebase patterns to follow:**
- The existing VPS dashboard in `packages/server-vps/src/admin/routes.ts` uses inline SVG chart generation (see `drawConnectionChart` at lines 932-981) with direct SVG path construction. The admin-cf Preact SPA should use the same approach but as reusable Preact components rather than DOM innerHTML manipulation.
- Auth pattern: Use `requireAuth()` from `packages/admin-cf/src/routes/auth.ts` which returns a Response on failure or the JWT payload on success.
- The admin-cf `package.json` already includes Preact 10.x and `@preact/preset-vite`, confirming the Preact + Vite toolchain is ready.
- The existing dashboard uses CSS variables (--bg-primary, --bg-secondary, --accent, --success, --warning, --danger) which should be reused for consistency.

**D1 query patterns:**
- D1 uses SQLite semantics. For percentiles, the data is pre-aggregated by the diagnostics worker (p50/p95/p99 computed at ingestion time), so dashboard queries are simple SELECT with GROUP BY time_bucket.
- For time range filtering, use `WHERE time_bucket >= datetime('now', '-24 hours')` syntax.
- D1 does not support window functions in all SQLite versions, so avoid relying on LAG/LEAD for trend computation; compute trends client-side.

**Chart library decision:**
- Avoid pulling in Chart.js or D3 as dependencies to keep the bundle small (Preact's value proposition). Instead, use hand-rolled SVG components following the existing inline SVG pattern in the VPS dashboard. This aligns with the existing codebase approach and keeps the admin-cf bundle lightweight.

**Preact Signals:**
- Use Preact Signals (`@preact/signals`) for reactive filter state and data fetching state, as recommended by current Preact best practices. Signals provide fine-grained reactivity without full re-renders.

## Estimation
**M (Medium)** -- The backend is a straightforward D1 query endpoint following existing patterns. The frontend requires building reusable SVG chart components in Preact, which involves moderate complexity for axis scaling, multi-series rendering, and responsive layout. The bulk of the effort is in the chart components, which will be reused across US-3.2 and US-3.3.
