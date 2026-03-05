# US-2.3: Error Signature Drill-Down

## Story
As an admin, I want to click an error signature and see full details, so that I can investigate specific issues.

## Acceptance Criteria
- Clicking an error signature row in the error table (US-2.1) opens a detail view for that signature.
- The detail view displays:
  - Full error signature hash
  - Error category and sample error message
  - Scrubbed stack trace (formatted with syntax highlighting for readability)
  - Version distribution: table or bar chart showing error count per app version
  - Platform distribution: table or bar chart showing error count per platform
  - Occurrence timeline: small line chart showing error frequency over the selected time range
- A "Back" button returns to the error table without losing the table's scroll position or filter state.
- The detail view loads data from a dedicated API endpoint (`GET /admin/api/errors/:signature`).
- The detail view is accessible via a direct URL (e.g., `/admin/errors/a1b2c3d4...`) for sharing links between admins, following the existing SPA fallback routing pattern.
- When the requested error signature does not exist, the detail view shows a "Not Found" message.

## Technical Design

### Architecture
This story adds:
1. A new API endpoint (`GET /admin/api/errors/:signature`) that fetches detailed data for a single error signature from D1 and optionally R2 for raw sample reports.
2. Frontend detail view rendering, either as a new render function in the inline HTML or as a Preact component.
3. SPA-style navigation: the URL updates when drilling down, and direct navigation to the detail URL works via the existing catch-all `serveDashboard()` fallback.

### Implementation Details

**API route handler (added to `routes/errors.ts`):**
- New exported function `handleErrorDetail(request, env, signature)`.
- Query D1 for all rows matching the given signature:
  ```sql
  SELECT time_bucket, app_version, platform, count, first_seen, last_seen,
         sample_message, sample_stack_trace
  FROM error_aggregates
  WHERE error_signature = ?
  ORDER BY time_bucket DESC
  LIMIT 500
  ```
- Aggregate the results into:
  - `versionDistribution`: `{ [version]: totalCount }` via in-memory GROUP BY
  - `platformDistribution`: `{ [platform]: totalCount }` via in-memory GROUP BY
  - `occurrenceTimeline`: `{ timestamps: number[], counts: number[] }` grouped by time_bucket
  - `totalCount`: sum of all counts
  - `firstSeen` / `lastSeen`: min/max across all rows
  - `sampleMessage`: from the most recent row
  - `sampleStackTrace`: from the most recent row with a non-null stack trace
- Optionally, if R2 is bound (`DIAGNOSTICS_R2`), fetch 1-3 raw reports from R2 to provide richer context. List objects with prefix matching the signature, take the most recent. This is optional -- if R2 is not bound or the fetch fails, omit the raw samples gracefully.

**Worker entry point changes (`index.ts`):**
- Add route matching for `/admin/api/errors/` prefix with dynamic segment:
  ```typescript
  else if (path.startsWith('/admin/api/errors/') && method === 'GET') {
    // Exclude /admin/api/errors/trends and /admin/api/errors/regressions
    const suffix = path.substring('/admin/api/errors/'.length);
    if (suffix && suffix !== 'trends' && suffix !== 'regressions') {
      response = await handleErrorDetail(request, env, decodeURIComponent(suffix));
    }
  }
  ```
  Note: This route must be registered after the `/admin/api/errors/trends` and `/admin/api/errors/regressions` routes to avoid shadowing them.

**Frontend detail view:**
- When the user clicks an error row, update `state.activeView` to `'error-detail'` and `state.selectedSignature` to the signature hash.
- Use `history.pushState` to update the URL to `/admin/errors/{signature}` without a full page reload.
- `renderErrorDetail()` function:
  - Shows a header with the category badge and signature.
  - Renders the sample message in a styled `<pre>` block.
  - Renders the stack trace in a `<pre><code>` block with basic syntax highlighting (line numbers, file paths in a distinct color). Use CSS only -- no external syntax highlighting library.
  - Version and platform distributions as simple horizontal bar charts using CSS `width` percentages (no charting library needed for these simple visualizations).
  - Occurrence timeline using the uPlot instance from US-2.2 (if available) or a simple inline SVG sparkline.
- On initial page load, check if the URL matches `/admin/errors/{signature}` and auto-navigate to the detail view.
- "Back" button: calls `history.back()` and restores the error list view. Store the error list scroll position in state before navigating to detail.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/admin-cf/src/routes/errors.ts` | Modify | Add `handleErrorDetail` handler |
| `packages/admin-cf/src/index.ts` | Modify | Register `GET /admin/api/errors/:signature` route; add `renderErrorDetail()` function; add SPA URL parsing for direct detail navigation; add CSS for stack trace formatting and distribution bars |
| `packages/admin-cf/src/types.ts` | Modify | Add `ErrorDetail`, `VersionDistribution`, `PlatformDistribution` interfaces; extend `Env` with optional `DIAGNOSTICS_R2` binding |
| `packages/admin-cf/wrangler.jsonc` | Modify | Add `r2_buckets` binding for `DIAGNOSTICS_R2` (optional, for raw report access) |
| `packages/admin-cf/tests/e2e/admin-e2e.test.ts` | Modify | Add error detail endpoint tests |
| `packages/admin-cf/tests/e2e/helpers.ts` | Modify | Add `getErrorDetail(signature)` method to `AdminApiClient` |

### Data Models / Schemas

**TypeScript interfaces (added to `types.ts`):**

```typescript
/** Distribution entry for version or platform breakdowns */
interface DistributionEntry {
  name: string;     // version string or platform name
  count: number;
  percentage: number;  // 0-100
}

/** Occurrence timeline data point */
interface TimelinePoint {
  timestamp: number;  // Unix seconds
  count: number;
}

/** GET /admin/api/errors/:signature response */
interface ErrorDetailResponse {
  errorSignature: string;
  category: string;
  totalCount: number;
  firstSeen: number;         // Unix ms
  lastSeen: number;          // Unix ms
  sampleMessage: string;
  sampleStackTrace: string | null;
  versionDistribution: DistributionEntry[];
  platformDistribution: DistributionEntry[];
  occurrenceTimeline: TimelinePoint[];
  /** Optional raw report samples from R2 */
  rawSamples?: Array<{
    timestamp: number;
    sessionHash: string;
    report: Record<string, unknown>;
  }>;
}
```

### API Endpoints

**GET /admin/api/errors/:signature**

- Auth: Bearer JWT required (admin or super-admin)
- Path params:
  - `signature`: URL-encoded error signature hash (SHA-256 hex string)
- Query params:
  - `range`: `1h` | `24h` | `7d` (default: `7d`) -- controls the occurrence timeline window
- Success response (200):
  ```json
  {
    "success": true,
    "data": {
      "errorSignature": "a1b2c3d4e5f6...",
      "category": "network",
      "totalCount": 342,
      "firstSeen": 1709200000000,
      "lastSeen": 1709384400000,
      "sampleMessage": "WebRTC data channel failed: ICE connection timeout",
      "sampleStackTrace": "packages/app/lib/services/webrtc_service.dart:142\npackages/app/lib/services/connection_manager.dart:87\npackages/app/lib/core/p2p/peer_connection.dart:201",
      "versionDistribution": [
        { "name": "1.2.1", "count": 280, "percentage": 81.9 },
        { "name": "1.2.0", "count": 62, "percentage": 18.1 }
      ],
      "platformDistribution": [
        { "name": "android", "count": 210, "percentage": 61.4 },
        { "name": "ios", "count": 132, "percentage": 38.6 }
      ],
      "occurrenceTimeline": [
        { "timestamp": 1709380800, "count": 12 },
        { "timestamp": 1709384400, "count": 45 }
      ]
    }
  }
  ```
- Error responses: 401 (unauthenticated), 404 (signature not found), 500 (D1 error)

## Dependencies
- **US-2.1 (Error Rate Overview):** The error table with clickable rows must exist. The D1 binding and route handler file must be in place.
- **US-2.2 (Error Trends Visualization):** Optional dependency for reusing the uPlot chart instance for the occurrence timeline. If US-2.2 is not yet complete, fall back to an SVG sparkline.
- **US-1.1 (Diagnostic Report Submission):** The `error_aggregates` table must be populated.

## Testing Strategy

- **Unit tests:**
  - Test `handleErrorDetail` with mock D1 returning rows for a known signature. Verify version and platform distribution calculations including percentage computation.
  - Test with a signature that has no matching rows -- verify 404 response.
  - Test distribution percentage calculation: given counts [100, 50, 50], verify percentages are [50.0, 25.0, 25.0].
  - Test that `sampleStackTrace` falls back gracefully when all rows have null stack traces.
  - Test occurrence timeline ordering (ascending by timestamp).

- **Integration tests:**
  - Seed D1 with error_aggregates for a specific signature across 3 versions and 2 platforms.
  - Call `GET /admin/api/errors/{signature}` and verify all distribution entries are present and sum to the total.
  - Verify occurrence timeline timestamps are within the requested range.

- **E2E tests:**
  - `GET /admin/api/errors/{known_signature}` returns 200 with complete detail structure.
  - `GET /admin/api/errors/nonexistent_signature_000` returns 404.
  - `GET /admin/api/errors/{signature}` returns 401 without auth.
  - If errors exist, verify that `versionDistribution` percentages sum to approximately 100.

- **Manual testing:**
  - Click an error row in the dashboard, verify the detail view opens with correct data.
  - Verify the URL updates to `/admin/errors/{signature}`.
  - Copy the URL, open in a new tab, verify the detail view loads directly.
  - Click "Back", verify return to the error table with scroll position preserved.
  - Test with a signature that has a very long stack trace (>50 lines) -- verify scrollable display.

## Technical Notes

**Codebase patterns to follow:**
- Dynamic route extraction follows the pattern in `index.ts` line 90: `const userId = path.substring('/admin/api/users/'.length)`. Apply the same approach for the signature parameter.
- The SPA fallback routing already exists: any `/admin/*` path serves `serveDashboard()` (line 99-101 in `index.ts`). The frontend JS must parse `window.location.pathname` on init to detect if a detail view should be shown.

**Route ordering concern:**
- The `/admin/api/errors/:signature` route must not match `/admin/api/errors/trends` or `/admin/api/errors/regressions`. Handle this by checking for known sub-paths first:
  ```typescript
  if (path === '/admin/api/errors/trends') { ... }
  else if (path === '/admin/api/errors/regressions') { ... }
  else if (path.startsWith('/admin/api/errors/') && path !== '/admin/api/errors/') { ... }
  ```

**Stack trace formatting:**
- Stack traces from the diagnostics worker are pre-scrubbed (file paths and line numbers only). Render with line numbers using a CSS counter or explicit numbering.
- Use a monospace font and a dark background (consistent with `--bg-primary` in the existing theme).
- Long stack traces should be in a scrollable container with `max-height: 400px; overflow-y: auto`.

**R2 raw sample access:**
- R2 objects are stored at `diagnostics/{YYYY}/{MM}/{DD}/{HH}/{session_hash}_{timestamp}.json`. To find samples for a given signature, we would need to scan R2 objects and parse them, which is expensive. Instead, rely on the D1 `sample_message` and `sample_stack_trace` columns which are already cached. R2 access is reserved for future "View Full Report" functionality.
- For this initial implementation, skip R2 access entirely and set `rawSamples` to undefined. The `DIAGNOSTICS_R2` binding in the `Env` type should still be added as optional for forward compatibility.

**Performance:**
- The detail query is bounded by `LIMIT 500`. For signatures with thousands of hourly buckets (possible over 7d across many versions/platforms), 500 rows is sufficient for accurate distribution and timeline data.
- In-memory aggregation of 500 rows is negligible for the Worker CPU budget.

## Estimation
**M (Medium)** -- The API endpoint is a single D1 query with in-memory aggregation. The frontend detail view is mostly HTML/CSS with no new library dependencies (the occurrence timeline can use a simple SVG sparkline). The SPA routing for direct URL access adds moderate complexity. Estimated 2-3 days.
