# US-2.2: Error Trends Visualization

## Story
As an admin, I want to see error trends over time, so that I can identify patterns and correlate with deployments.

## Acceptance Criteria
- A stacked area chart displays error counts over time, with each error category rendered as a distinct colored area.
- The chart supports configurable time ranges: 1h (1-minute buckets), 24h (1-hour buckets), 7d (6-hour buckets).
- A time-range selector allows switching between ranges, re-rendering the chart with appropriate bucket granularity.
- Deployment markers are shown on the timeline as vertical dashed lines annotated with the version number, so admins can correlate error spikes with releases.
- Hovering over a point on the chart shows a tooltip with the exact timestamp, total count, and per-category breakdown.
- The chart auto-refreshes every 30 seconds (matching US-2.1 refresh cadence).
- The chart is responsive and renders correctly on screens from 768px to 1920px width.
- When no error data exists, the chart area shows an informative empty state rather than a blank canvas.

## Technical Design

### Architecture
This story adds:
1. A new API endpoint (`GET /admin/api/errors/trends`) that returns time-bucketed error counts suitable for chart rendering.
2. A lightweight charting solution integrated into the admin portal frontend.
3. Deployment marker data derived from distinct `app_version` first-seen timestamps in the `error_aggregates` table.

The trends endpoint is separate from the error list endpoint (US-2.1) because it returns data in a chart-optimized format (arrays of timestamps and counts per category) rather than a table-optimized format (rows per error signature).

### Implementation Details

**API route handler (added to `routes/errors.ts`):**
- New exported function `handleErrorTrends(request, env)`.
- Accept query params: `range` (`1h`, `24h`, `7d`), `category` (optional filter).
- Compute bucket granularity: 1h -> group by minute, 24h -> group by hour (use `time_bucket` as-is), 7d -> group by 6-hour blocks.
- Query D1:
  ```sql
  -- For 24h range (hourly buckets, already the native granularity):
  SELECT time_bucket, category, SUM(count) as total
  FROM error_aggregates
  WHERE time_bucket >= ?
  GROUP BY time_bucket, category
  ORDER BY time_bucket ASC
  ```
- For sub-hour granularity (1h range with 1-minute buckets), the `time_bucket` column is hourly, so this query returns hourly data even for the 1h range. If finer granularity is needed, a separate query against R2 raw reports would be required. For the initial implementation, 1h range still uses hourly buckets (at most 1-2 data points), which is acceptable. A future enhancement can add minute-level bucketing to the ingestion worker.
- For 7d range, aggregate hours into 6-hour blocks:
  ```sql
  SELECT
    substr(time_bucket, 1, 11) ||
    CASE
      WHEN CAST(substr(time_bucket, 12, 2) AS INTEGER) < 6 THEN '00'
      WHEN CAST(substr(time_bucket, 12, 2) AS INTEGER) < 12 THEN '06'
      WHEN CAST(substr(time_bucket, 12, 2) AS INTEGER) < 18 THEN '12'
      ELSE '18'
    END || ':00:00' as bucket_6h,
    category,
    SUM(count) as total
  FROM error_aggregates
  WHERE time_bucket >= ?
  GROUP BY bucket_6h, category
  ORDER BY bucket_6h ASC
  ```
- Deployment markers query:
  ```sql
  SELECT app_version, MIN(first_seen) as deploy_time
  FROM error_aggregates
  WHERE time_bucket >= ?
  GROUP BY app_version
  ORDER BY deploy_time ASC
  ```
- Transform query results into chart-friendly format: `{ timestamps: number[], series: { [category]: number[] }, deployments: { version, timestamp }[] }`.

**Charting library selection:**
- **uPlot** (MIT, ~45KB min) is the best fit: tiny footprint, Canvas 2D-based, handles time-series natively, supports stacked fills via its plugin API. No framework-specific wrapper needed -- it operates on a DOM element directly, which works in both the current inline HTML and a future Preact SPA.
- Add `uplot` to `devDependencies` in `packages/admin-cf/package.json`.
- For the inline HTML dashboard, load uPlot via a CDN `<script>` tag (`https://unpkg.com/uplot/dist/uPlot.iife.min.js`) and its CSS (`uPlot.min.css`). When migrating to a Preact SPA, switch to the npm import.
- Stacked area: uPlot does not include stacking in its core. Use the `stacking` plugin pattern from the uPlot demos (custom `paths` builder that offsets each series by the cumulative sum of prior series). This is ~30 lines of code.

**Frontend rendering:**
- Inside the Errors tab, below the summary cards (US-2.1) and above the error table, add a `<div id="error-trends-chart" style="width:100%;height:300px;"></div>`.
- After `renderErrors()` completes and the DOM is updated, initialize or update the uPlot instance.
- On time-range change, destroy the old uPlot instance and create a new one with fresh data.
- Deployment markers: use uPlot's `hooks.draw` to render vertical dashed lines at deployment timestamps with version labels.
- Tooltip: use uPlot's built-in cursor + `hooks.setCursor` to render a custom HTML tooltip div.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/admin-cf/src/routes/errors.ts` | Modify | Add `handleErrorTrends` handler |
| `packages/admin-cf/src/index.ts` | Modify | Register `GET /admin/api/errors/trends` route; add chart container div and uPlot initialization in frontend JS; add CDN script/CSS for uPlot |
| `packages/admin-cf/src/types.ts` | Modify | Add `ErrorTrendsResponse`, `DeploymentMarker` interfaces |
| `packages/admin-cf/package.json` | Modify | Add `uplot` to devDependencies |
| `packages/admin-cf/tests/e2e/admin-e2e.test.ts` | Modify | Add trends endpoint tests |
| `packages/admin-cf/tests/e2e/helpers.ts` | Modify | Add `getErrorTrends()` method to `AdminApiClient` |

### Data Models / Schemas

**TypeScript interfaces (added to `types.ts`):**

```typescript
/** A deployment marker for the trends chart */
interface DeploymentMarker {
  version: string;
  timestamp: number;  // Unix ms
}

/** GET /admin/api/errors/trends response */
interface ErrorTrendsResponse {
  /** Array of Unix timestamps (seconds) for the x-axis */
  timestamps: number[];
  /** Map of category name to array of counts, aligned with timestamps */
  series: Record<string, number[]>;
  /** Deployment markers to overlay on the chart */
  deployments: DeploymentMarker[];
  /** The time range that was queried */
  range: '1h' | '24h' | '7d';
  /** Bucket granularity in human-readable form */
  bucketSize: '1min' | '1h' | '6h';
}
```

**Chart data format (uPlot):**
uPlot expects data as an array of arrays where index 0 is timestamps (in seconds, not ms) and subsequent indices are series values:
```javascript
// [timestamps, category1_counts, category2_counts, ...]
[
  [1709380800, 1709384400, 1709388000],  // timestamps (epoch seconds)
  [5, 12, 3],   // crash
  [2, 8, 1],    // network
  [0, 1, 0],    // crypto
]
```

### API Endpoints

**GET /admin/api/errors/trends**

- Auth: Bearer JWT required (admin or super-admin)
- Query params:
  - `range`: `1h` | `24h` | `7d` (default: `24h`)
  - `category`: optional filter (limits to a single category)
- Success response (200):
  ```json
  {
    "success": true,
    "data": {
      "timestamps": [1709380800, 1709384400, 1709388000],
      "series": {
        "crash": [5, 12, 3],
        "network": [2, 8, 1],
        "crypto": [0, 1, 0],
        "storage": [0, 0, 0],
        "ui": [1, 0, 2],
        "protocol": [0, 0, 0],
        "other": [0, 1, 0]
      },
      "deployments": [
        { "version": "1.2.1", "timestamp": 1709383200000 }
      ],
      "range": "24h",
      "bucketSize": "1h"
    }
  }
  ```
- Error responses: 401 (unauthenticated), 400 (invalid params), 500 (D1 error)

## Dependencies
- **US-2.1 (Error Rate Overview):** The Errors tab, route handler file, and D1 binding must exist. This story extends them.
- **US-1.1 (Diagnostic Report Submission):** The `error_aggregates` D1 table must be populated.
- **uPlot library:** Added as a dependency in this story. MIT-licensed, no GPL concerns.

## Testing Strategy

- **Unit tests:**
  - Test `handleErrorTrends` with mock D1 returning known time-bucketed rows. Verify the response is correctly transformed into the `{ timestamps, series }` format.
  - Test 6-hour bucket aggregation logic: given hourly data, verify correct grouping into 6-hour blocks.
  - Test deployment marker extraction: verify that distinct `app_version` entries produce correct markers.
  - Test edge case: empty D1 results produce `{ timestamps: [], series: {}, deployments: [] }`.

- **Integration tests:**
  - Seed D1 with error_aggregates spanning 48 hours across multiple categories and versions.
  - Query with `range=24h` and verify timestamps are in ascending order, series arrays are aligned with timestamps, and deployment markers correspond to version first-seen times.
  - Query with `range=7d` and verify bucket aggregation produces fewer data points than the 24h query.

- **E2E tests:**
  - `GET /admin/api/errors/trends` returns 200 with the expected schema.
  - `GET /admin/api/errors/trends` returns 401 without auth.
  - Verify the `series` object keys are valid error categories.

- **Manual visual testing:**
  - Load the dashboard with seeded data and visually verify the stacked area chart renders correctly.
  - Verify deployment markers appear at correct positions.
  - Verify tooltip shows correct values on hover.
  - Test responsive behavior at 768px and 1920px widths.

## Technical Notes

**Codebase patterns to follow:**
- The API handler follows the same `requireAuth` + query + `jsonResponse` pattern used throughout `routes/`.
- The frontend chart initialization happens in `attachEventListeners()` after DOM is rendered, since the inline HTML approach uses `innerHTML` which requires post-render DOM access.

**uPlot integration notes:**
- uPlot expects timestamps in seconds (not milliseconds). Convert D1's ISO datetime strings via `new Date(time_bucket).getTime() / 1000`.
- For stacked areas, each series value represents the raw count (not cumulative). The stacking plugin handles cumulative offset during rendering.
- uPlot's `destroy()` method must be called before re-creating a chart to prevent memory leaks. Store the instance reference on `window` or in the app state.
- CDN fallback: if the CDN is unreachable, the chart area should show "Chart unavailable" rather than a JS error crashing the page. Wrap chart init in a try/catch.

**Performance considerations:**
- 7d of hourly data is at most 168 rows per category, or ~1,176 rows total across 7 categories. This is well within D1's performance envelope.
- uPlot can handle 150,000 data points in ~90ms. Our data sets (<2,000 points) will render in under 1ms.

**Deployment marker caveats:**
- Deployment markers are inferred from the first appearance of a new `app_version` in the error data, not from an explicit deployment event. This means a version only shows up as a marker once an error is reported for it. For a more accurate approach, a separate `deployments` table could be populated by CI/CD, but that is out of scope for this story.

## Estimation
**L (Large)** -- The API endpoint involves multi-query logic (trends + deployments) with bucket aggregation, and the frontend requires integrating a third-party charting library (uPlot) with stacking, tooltips, and deployment marker overlays. The chart plugin code and responsive handling add complexity beyond a typical CRUD endpoint. Estimated 4-5 days.
