# US-2.4: Regression Detection

## Story
As an admin, I want automatic flagging when error rates spike after a new version release.

## Acceptance Criteria
- A regression is automatically flagged when the error count for any error signature in the latest app version exceeds 3x the rate of the same signature in the previous version over an equivalent time window.
- A regression banner appears at the top of the Errors tab (above the summary cards from US-2.1) when one or more regressions are active.
- The banner shows: number of active regressions, the most severe one, and a "View All" link.
- Clicking "View All" or the regression count card (US-2.1) shows a regressions list with:
  - Error signature (clickable, links to US-2.3 detail view)
  - Category
  - Current version and its error rate
  - Previous version and its error rate
  - Rate multiplier (e.g., "4.2x")
  - First detected timestamp
- Regressions are computed on the server side via a dedicated API endpoint (`GET /admin/api/errors/regressions`).
- Regression data auto-refreshes with the same 30-second cadence as US-2.1.
- Regressions automatically clear when the error rate for the latest version drops below 1.5x the previous version rate (hysteresis to prevent flapping).
- When no regressions are detected, the banner is hidden and the regression alert count in the summary card shows 0.

## Technical Design

### Architecture
This story adds:
1. A new API endpoint (`GET /admin/api/errors/regressions`) that computes regressions by comparing error rates across the two most recent app versions.
2. Regression detection logic that runs as part of the API query (not a background job) -- it is computed on-demand from the existing `error_aggregates` data.
3. Frontend regression banner and regression list UI.

The regression detection is stateless and query-driven: it does not persist regression state in D1. This simplifies the implementation and avoids stale state issues. Each API call recomputes regressions from current data.

### Implementation Details

**Regression detection algorithm:**

1. Determine the two most recent app versions:
   ```sql
   SELECT DISTINCT app_version
   FROM error_aggregates
   WHERE time_bucket >= ?
   ORDER BY app_version DESC
   LIMIT 2
   ```
   Use semantic version ordering. If only one version exists, return empty regressions (nothing to compare against).

2. For each error signature present in the latest version, compute the error rate (count per hour) for both versions over the comparison window (default 24h):
   ```sql
   SELECT
     error_signature,
     category,
     app_version,
     SUM(count) as total_count,
     COUNT(DISTINCT time_bucket) as bucket_count
   FROM error_aggregates
   WHERE time_bucket >= ?
     AND app_version IN (?, ?)
   GROUP BY error_signature, category, app_version
   ```

3. For each signature, compute:
   - `currentRate = total_count_current / hours_in_window`
   - `previousRate = total_count_previous / hours_in_window`
   - `multiplier = currentRate / previousRate`
   - Flag as regression if `multiplier >= 3.0`
   - Clear regression if `multiplier < 1.5` (hysteresis)

4. Sort regressions by multiplier descending (worst first).

**Version comparison edge cases:**
- If a signature exists in the current version but not in the previous version, it is a "new error" -- flag as regression if the count exceeds a minimum threshold (10 occurrences in 24h) to avoid flagging rare one-off errors.
- If a signature exists in the previous version but not the current version, it is a "resolved error" -- not a regression.
- If only one app version exists in the data, return an empty regressions array.
- Version ordering: compare versions using semver rules. If versions are not valid semver, fall back to lexicographic ordering.

**API route handler (added to `routes/errors.ts`):**
- New exported function `handleErrorRegressions(request, env)`.
- Accept query params: `window` (`6h`, `24h`, `48h`, default: `24h`), `threshold` (multiplier, default: `3.0`).
- Return a list of regression objects sorted by multiplier descending.

**Frontend rendering:**
- Regression banner: a `<div class="regression-banner">` styled with `--danger` background color, positioned at the top of the Errors tab content.
  ```html
  <div class="regression-banner">
    <span class="regression-icon">&#9888;</span>
    <span><strong>{count} regression(s) detected</strong> —
      Worst: {signature} ({multiplier}x increase in {category})</span>
    <button id="view-regressions-btn">View All</button>
  </div>
  ```
- Regression list: toggled by clicking "View All". Renders as a table below the banner.
  ```html
  <table class="regression-table">
    <thead>
      <tr><th>Signature</th><th>Category</th><th>Current (v{cur})</th>
          <th>Previous (v{prev})</th><th>Multiplier</th><th>Detected</th></tr>
    </thead>
    <tbody>...</tbody>
  </table>
  ```
- The regression count feeds into the `regressionAlerts` field of the summary cards (US-2.1). This story updates the `loadErrors()` function to also call the regressions endpoint and merge the count into the summary.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/admin-cf/src/routes/errors.ts` | Modify | Add `handleErrorRegressions` handler with regression detection logic |
| `packages/admin-cf/src/index.ts` | Modify | Register `GET /admin/api/errors/regressions` route; add regression banner HTML and CSS; update `loadErrors()` to fetch regressions; add regression list rendering |
| `packages/admin-cf/src/types.ts` | Modify | Add `Regression`, `RegressionResponse` interfaces |
| `packages/admin-cf/tests/e2e/admin-e2e.test.ts` | Modify | Add regressions endpoint tests |
| `packages/admin-cf/tests/e2e/helpers.ts` | Modify | Add `getErrorRegressions()` method to `AdminApiClient` |

### Data Models / Schemas

**TypeScript interfaces (added to `types.ts`):**

```typescript
/** A detected regression for an error signature */
interface Regression {
  errorSignature: string;
  category: string;
  currentVersion: string;
  previousVersion: string;
  currentRate: number;       // errors per hour in current version
  previousRate: number;      // errors per hour in previous version
  multiplier: number;        // currentRate / previousRate (>= 3.0 threshold)
  currentTotal: number;      // total count in current version within window
  previousTotal: number;     // total count in previous version within window
  firstDetected: number;     // Unix ms — earliest time_bucket for this signature in current version
  sampleMessage: string;
}

/** GET /admin/api/errors/regressions response */
interface RegressionResponse {
  regressions: Regression[];
  currentVersion: string;
  previousVersion: string;
  window: '6h' | '24h' | '48h';
  threshold: number;
  computedAt: number;        // Unix ms — when this computation was performed
}
```

No new D1 tables are required. Regressions are computed on-the-fly from the existing `error_aggregates` table.

### API Endpoints

**GET /admin/api/errors/regressions**

- Auth: Bearer JWT required (admin or super-admin)
- Query params:
  - `window`: `6h` | `24h` | `48h` (default: `24h`) -- comparison time window
  - `threshold`: float >= 1.0 (default: `3.0`) -- minimum multiplier to flag as regression
- Success response (200):
  ```json
  {
    "success": true,
    "data": {
      "regressions": [
        {
          "errorSignature": "a1b2c3d4e5f6...",
          "category": "crypto",
          "currentVersion": "1.3.0",
          "previousVersion": "1.2.1",
          "currentRate": 15.2,
          "previousRate": 3.1,
          "multiplier": 4.9,
          "currentTotal": 365,
          "previousTotal": 74,
          "firstDetected": 1709380800000,
          "sampleMessage": "ChaCha20-Poly1305 decrypt failed: invalid tag"
        }
      ],
      "currentVersion": "1.3.0",
      "previousVersion": "1.2.1",
      "window": "24h",
      "threshold": 3.0,
      "computedAt": 1709384400000
    }
  }
  ```
- Empty regressions (200):
  ```json
  {
    "success": true,
    "data": {
      "regressions": [],
      "currentVersion": "1.3.0",
      "previousVersion": "1.2.1",
      "window": "24h",
      "threshold": 3.0,
      "computedAt": 1709384400000
    }
  }
  ```
- Error responses: 401 (unauthenticated), 400 (invalid params), 500 (D1 error)

## Dependencies
- **US-2.1 (Error Rate Overview):** The Errors tab, D1 binding, and route handler file must exist. The `regressionAlerts` field in the summary cards is populated by this story.
- **US-2.3 (Error Signature Drill-Down):** Regression list links to the detail view for each signature. If US-2.3 is not yet complete, the links can be rendered but will not navigate to a detail view.
- **US-1.1 (Diagnostic Report Submission):** The `error_aggregates` table must contain data for at least two distinct app versions for meaningful regression detection.

## Testing Strategy

- **Unit tests:**
  - Test regression computation with mock data:
    - Two versions, one signature with 4x rate increase -> should flag as regression.
    - Two versions, one signature with 2x rate increase -> should NOT flag (below 3.0 threshold).
    - Two versions, one signature with 1.3x rate after being flagged -> should clear (below 1.5 hysteresis).
    - New signature only in current version with 15 occurrences -> should flag.
    - New signature only in current version with 3 occurrences -> should NOT flag (below minimum threshold of 10).
    - Only one version in data -> empty regressions.
  - Test version ordering: `["1.2.0", "1.10.0", "1.3.0"]` should identify `1.10.0` as current and `1.3.0` as previous (semver ordering).
  - Test division-by-zero edge case: signature in current version with zero in previous version (new error path).
  - Test with `threshold` query param set to custom value (e.g., 2.0).

- **Integration tests:**
  - Seed D1 with error_aggregates for two versions:
    - Version "1.2.0": signature "abc" with 10 errors/hour
    - Version "1.3.0": signature "abc" with 40 errors/hour (4x regression)
    - Version "1.3.0": signature "def" with 5 errors/hour (new, below threshold)
  - Call `GET /admin/api/errors/regressions?window=24h` and verify exactly one regression is returned for "abc" with multiplier ~4.0.
  - Verify "def" is not flagged because its count is below the minimum threshold.

- **E2E tests:**
  - `GET /admin/api/errors/regressions` returns 200 with valid schema.
  - `GET /admin/api/errors/regressions` returns 401 without auth.
  - Verify `regressions` is an array (may be empty if no regressions exist in the test environment).
  - Verify `currentVersion` and `previousVersion` are strings.

- **Manual testing:**
  - Seed data with a known regression (3x+ rate increase in a newer version).
  - Load the Errors tab and verify the regression banner appears.
  - Click "View All" and verify the regressions table renders with correct data.
  - Click a signature in the regression table and verify navigation to the detail view (US-2.3).
  - Verify the regression count in the summary cards matches the banner count.

## Technical Notes

**Codebase patterns to follow:**
- This handler follows the same structure as `handleListErrors` and `handleErrorTrends`: auth check, query params parsing, D1 queries, data transformation, JSON response.
- The regression banner CSS should use the existing `--danger` color variable for the background and be consistent with the status badges already used in the server cards.

**Regression detection approach -- comparison with industry practices:**
- Datadog's regression detection flags issues when a resolved error reappears. Our approach is different: we compare error rates across versions, which is more useful for catching regressions introduced by new code.
- Pinterest's approach uses statistical change-point detection to identify regressions in time-series data. Our 3x-threshold approach is simpler but effective for the expected data volumes. A future enhancement could apply a Z-score or Mann-Whitney U test for more statistical rigor.
- The hysteresis threshold (1.5x to clear, 3.0x to flag) prevents "flapping" where a regression repeatedly triggers and clears as error rates fluctuate near the threshold. This pattern is standard in alerting systems.

**Semantic version ordering:**
- Use a simple semver comparison: split on `.`, compare each segment as integers. For non-numeric segments (e.g., "1.3.0-beta"), fall back to lexicographic comparison.
- Implementation: a `compareSemver(a, b)` utility function in the errors route handler (or a shared utils file). Do not add a `semver` npm dependency -- the comparison logic is ~15 lines.

**Performance:**
- The regression query scans `error_aggregates` filtered by `time_bucket >= ?` and `app_version IN (?, ?)`. With an index on `time_bucket`, this is efficient even for large datasets.
- The in-memory aggregation groups by `error_signature` across two versions. For up to 1,000 unique signatures, this is negligible CPU.
- The regression endpoint is called every 30 seconds by all connected admin clients. D1 caches repeated identical queries, so the actual database load is minimal.

**Minimum occurrence threshold for new errors:**
- When a signature appears only in the current version (no previous version data), the "multiplier" is mathematically undefined (division by zero). Instead of treating all new errors as regressions, apply a minimum threshold of 10 occurrences in the comparison window. This filters out rare one-off errors while still catching genuinely new, frequent errors introduced by the new version.

## Estimation
**M (Medium)** -- The API logic is moderately complex (version comparison, rate computation, hysteresis) but does not require new infrastructure or external dependencies. The frontend is a banner and table, following existing patterns. The semver comparison utility is straightforward. Estimated 2-3 days.
