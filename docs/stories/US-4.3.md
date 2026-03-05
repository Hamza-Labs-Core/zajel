# US-4.3: Version Adoption Curve

## Story
As an admin, I want to see app version distribution over time, so that I can track adoption of new releases and decide when to deprecate old versions or investigate why users are not upgrading.

## Acceptance Criteria
- Dashboard displays a stacked area chart showing the number of active clients per app version over time
- The chart includes a time range selector with options: Last 24 hours, Last 7 days, Last 30 days
- Each app version is rendered as a distinct colored band in the stacked area
- Hovering over a point in the chart (or tapping on mobile) shows a tooltip with the exact counts per version at that time
- Versions are sorted by semver (newest on top of the stack)
- The chart clearly shows when a new version starts gaining adoption and old versions decline
- Data refreshes every 30 seconds for the current view

## Technical Design

### Architecture
This story adds a version adoption stacked area chart to the Active Clients tab. Unlike US-4.1 and US-4.2 which show real-time snapshots, this chart requires historical time-series data. The approach is:

1. **Data collection:** The diagnostics-cf heartbeat handler already stores `app_version` in the `client_heartbeats` table. To build a historical time-series, a periodic aggregation job (part of the diagnostics-cf worker) snapshots version counts into a new D1 table `version_history` at regular intervals (every 5 minutes).
2. **API:** The admin-cf worker exposes `GET /admin/api/clients/versions` which queries the `version_history` table for the requested time range.
3. **Frontend:** A stacked area chart rendered as inline SVG with multiple `<path>` elements (one per version).

### Implementation Details

**Backend — Aggregation (in diagnostics-cf):**

Add a scheduled task in the diagnostics-cf worker that runs every 5 minutes (using Cron Triggers or triggered by heartbeat ingestion):

```sql
INSERT INTO version_history (time_bucket, app_version, active_count)
SELECT
  (? / 300000) * 300000 AS time_bucket,
  app_version,
  COUNT(*) AS active_count
FROM client_heartbeats
WHERE last_seen > ? - 600000
GROUP BY app_version
-- Parameters: current timestamp, current timestamp
```

This snapshots the active-per-version counts into a time-series table.

**D1 Retention:**
- Keep 30 days of 5-minute resolution data
- A cleanup query runs during the cron: `DELETE FROM version_history WHERE time_bucket < ? - 30 * 86400000`

**Backend — API Route (`packages/admin-cf/src/routes/clients.ts`):**

Add `handleVersionAdoption(request, env)`:
- Accept query param `?range=24h|7d|30d` (default `7d`)
- Query `version_history` table for the time range
- Downsample if needed: for 7d, aggregate to 1-hour buckets; for 30d, aggregate to 6-hour buckets
- Return a structured response with time buckets and per-version counts

**D1 Query (24h, 5-min resolution):**
```sql
SELECT time_bucket, app_version, active_count
FROM version_history
WHERE time_bucket > ?
ORDER BY time_bucket ASC, app_version ASC
-- Parameter: Date.now() - 24 * 60 * 60 * 1000
```

**D1 Query (7d, 1-hour buckets):**
```sql
SELECT
  (time_bucket / 3600000) * 3600000 AS hour_bucket,
  app_version,
  AVG(active_count) AS active_count
FROM version_history
WHERE time_bucket > ?
GROUP BY hour_bucket, app_version
ORDER BY hour_bucket ASC, app_version ASC
-- Parameter: Date.now() - 7 * 24 * 60 * 60 * 1000
```

**Frontend — Stacked Area Chart:**

Build the chart as inline SVG following the same approach as the VPS dashboard's `drawConnectionChart()`:

1. Collect all unique versions from the data
2. Sort versions by semver (newest first — top of the stack)
3. For each time bucket, stack the version counts
4. Render each version's band as a `<path>` with the `fill` area between its cumulative baseline and cumulative top

**Version color palette:**
Assign colors dynamically from a predefined palette (8-10 colors). Map versions to colors in semver order. If there are more versions than colors, group the oldest versions into an "Other" category.

```javascript
const VERSION_PALETTE = [
  '#3b82f6', // blue (newest)
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#06b6d4', // cyan
  '#6366f1', // indigo
];
```

**Time range selector:**
Three buttons (24h / 7d / 30d) styled like the existing `.tab` CSS class. Clicking a button re-fetches the API with the corresponding `?range=` param.

**Tooltip:**
On hover, show a simple `<div>` overlay positioned near the cursor with the exact timestamp and per-version counts. On touch devices, the last tapped position is highlighted.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/diagnostics-cf/src/aggregation.ts` | Create | Scheduled aggregation logic for version history snapshots |
| `packages/diagnostics-cf/wrangler.jsonc` | Modify | Add cron trigger for aggregation (if not already present) |
| `packages/diagnostics-cf/src/schema.sql` | Modify | Add `version_history` table |
| `packages/admin-cf/src/routes/clients.ts` | Modify | Add `handleVersionAdoption()` handler |
| `packages/admin-cf/src/index.ts` | Modify | Add route for `/admin/api/clients/versions`; add stacked area chart to dashboard |
| `packages/admin-cf/src/types.ts` | Modify | Add `VersionAdoptionResponse`, `VersionTimeBucket` types |
| `packages/admin-cf/tests/clients.test.ts` | Modify | Add tests for version adoption endpoint |
| `packages/diagnostics-cf/tests/aggregation.test.ts` | Create | Tests for the aggregation logic |

### Data Models / Schemas

**New D1 Table (`version_history`):**
```sql
CREATE TABLE version_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time_bucket INTEGER NOT NULL,        -- Unix ms, truncated to 5-min boundary
  app_version TEXT NOT NULL,
  active_count INTEGER NOT NULL,
  UNIQUE(time_bucket, app_version)
);

CREATE INDEX idx_version_history_bucket ON version_history(time_bucket);
```

**API Response Schema:**
```typescript
interface VersionAdoptionResponse {
  range: '24h' | '7d' | '30d';
  buckets: VersionTimeBucket[];
  versions: string[];               // All unique versions in the response, sorted by semver
  lastUpdated: number;
}

interface VersionTimeBucket {
  timestamp: number;                 // Start of time bucket (Unix ms)
  counts: Record<string, number>;   // { "1.2.0": 15, "1.1.0": 8, ... }
}
```

### API Endpoints

**`GET /admin/api/clients/versions`**

- **Auth:** Bearer JWT (admin or super-admin)
- **Query params:**
  - `range` — `24h` | `7d` | `30d` (default: `7d`)
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "range": "7d",
    "buckets": [
      {
        "timestamp": 1709380800000,
        "counts": { "1.2.0": 25, "1.1.0": 12, "1.0.0": 5 }
      },
      {
        "timestamp": 1709384400000,
        "counts": { "1.2.0": 28, "1.1.0": 10, "1.0.0": 4 }
      }
    ],
    "versions": ["1.2.0", "1.1.0", "1.0.0"],
    "lastUpdated": 1709384400000
  }
}
```
- **Response (401):** `{ "success": false, "error": "Unauthorized" }`

## Dependencies
- **US-1.2 (Client Heartbeat for Active Counting):** Heartbeats must include `app_version` in the `client_heartbeats` table
- **US-4.1 (Anonymous Active Client Count):** Establishes the Active Clients tab, route file, and D1 binding infrastructure
- **Diagnostics-cf worker:** Must be deployed with cron trigger support for periodic aggregation
- **D1 schema migration:** The `version_history` table must be created before aggregation can run

## Testing Strategy

### Unit Tests
- Test aggregation logic: given a set of heartbeats with different versions, verify correct counts per version per bucket
- Test `handleVersionAdoption` with various time ranges (24h, 7d, 30d)
- Test downsampling: verify 7d range aggregates to hourly buckets
- Test semver sorting: "1.10.0" sorts after "1.9.0", "2.0.0" sorts after "1.99.0"
- Test empty data returns empty buckets array
- Test that "Other" grouping triggers when version count exceeds palette size

### Integration Tests
- Seed `version_history` with 48 hours of 5-minute data across 3 versions
- Query with `?range=24h` and verify correct data shape and resolution
- Query with `?range=7d` and verify downsampled hourly buckets
- Verify D1 retention cleanup removes data older than 30 days

### E2E Tests
- Not applicable (internal admin tooling)

## Technical Notes

**Stacked area chart construction:**
The stacked area chart is the most complex visualization in Epic 4. The approach:
1. For each time bucket, compute cumulative counts (stack the versions)
2. For each version, create a `<path>` that traces the upper boundary left-to-right, then the lower boundary right-to-left, forming a closed polygon
3. Fill each polygon with the version's color at ~70% opacity

This is more complex than the simple line chart in `drawConnectionChart()` but follows the same SVG `<path>` construction pattern.

**Semver sorting:**
Use a simple semver comparison: split on ".", compare each segment as integers. No need for a full semver library — Zajel versions follow strict `major.minor.patch` format.

```javascript
function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
  }
  return 0;
}
```

**Cron trigger for aggregation:**
The diagnostics-cf `wrangler.jsonc` should include:
```jsonc
{
  "triggers": {
    "crons": ["*/5 * * * *"]  // Every 5 minutes
  }
}
```
The worker's `scheduled()` handler runs the aggregation query.

**Performance considerations:**
- 30 days at 5-minute resolution = 8,640 rows per version. With 5 versions, that is ~43,200 rows — well within D1 capacity
- Downsampling to hourly (7d) or 6-hourly (30d) buckets keeps response payload under 50KB
- For the 24h view, 288 buckets x 5 versions = ~1,440 data points, which renders smoothly as SVG

**Future migration to Preact:**
When the dashboard migrates to Preact SPA (as planned in the architecture doc), this chart can be replaced with a proper charting component like `preact-chartjs-2` wrapping Chart.js. For now, inline SVG is consistent with the existing codebase approach.

## Estimation
**L (Large)** — This story involves both backend and frontend complexity: a new D1 table, a periodic aggregation cron job in diagnostics-cf, a query endpoint with downsampling logic, and a stacked area chart (the most complex SVG rendering in this epic). The cron trigger setup in diagnostics-cf adds cross-package coordination.
