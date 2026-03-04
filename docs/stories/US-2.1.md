# US-2.1: Error Rate Overview

## Story
As an admin, I want to see real-time error rates broken down by category, so that I can quickly identify unusual failures.

## Acceptance Criteria
- Dashboard shows a new "Errors" tab in the admin portal tab bar, between "Users" and any subsequent tabs.
- The Errors tab displays summary cards at the top showing:
  - Total errors in the selected time window (1h / 24h / 7d)
  - Error rate change compared to the previous equivalent window (e.g., "last 24h vs. prior 24h"), displayed as a percentage with up/down indicator
  - Count of active regression alerts (links to US-2.4)
  - Highest severity among recent errors (critical / high / medium / low)
- Below the summary cards, a table lists the top error signatures sorted by occurrence count (descending).
- Each row in the table shows: error signature (truncated hash), category, count, affected versions, affected platforms, severity, and last seen timestamp.
- A time-range selector allows switching between 1h, 24h, and 7d views.
- Data auto-refreshes every 30 seconds without a full page reload.
- All error data is fetched via authenticated API calls; unauthenticated requests return 401.
- When no errors exist for the selected time range, the dashboard shows an empty state message rather than a broken layout.

## Technical Design

### Architecture
This story adds:
1. A new API route handler (`packages/admin-cf/src/routes/errors.ts`) that queries the D1 `error_aggregates` table.
2. New API endpoints registered in the Worker entry point (`packages/admin-cf/src/index.ts`).
3. Frontend rendering for the Errors tab within the inline dashboard HTML (or Preact SPA if the migration from US-2.2 is done first).

The admin-cf Worker gains a D1 binding (`DIAGNOSTICS_DB`) to read pre-aggregated error data written by the diagnostics ingestion worker (`packages/diagnostics-cf/`). This story is read-only from the admin portal's perspective -- it only queries existing data.

### Implementation Details

**API route handler (`routes/errors.ts`):**
- Import `requireAuth` from `./auth.js` for JWT verification.
- Accept query params: `range` (enum: `1h`, `24h`, `7d`), `category` (optional filter), `limit` (default 50, max 200).
- Compute the `time_bucket` threshold based on the requested range using ISO datetime strings.
- Query D1 with:
  ```sql
  SELECT error_signature, category,
         SUM(count) as total_count,
         GROUP_CONCAT(DISTINCT app_version) as versions,
         GROUP_CONCAT(DISTINCT platform) as platforms,
         MIN(first_seen) as first_seen,
         MAX(last_seen) as last_seen,
         MAX(sample_message) as sample_message
  FROM error_aggregates
  WHERE time_bucket >= ?
  GROUP BY error_signature, category
  ORDER BY total_count DESC
  LIMIT ?
  ```
- For the "rate change" summary card, run a second query for the previous equivalent window and compute `((current - previous) / previous) * 100`.
- Return a `{ success: true, data: { summary, errors } }` response.

**Worker entry point changes (`index.ts`):**
- Import the new handler: `import { handleListErrors } from './routes/errors.js';`
- Add route: `else if (path === '/admin/api/errors' && method === 'GET')`.

**Frontend (inline HTML or Preact component):**
- Add "Errors" to the `.tabs` div.
- Create `renderErrors()` function following the same pattern as `renderServers()`.
- Summary cards use the existing `.aggregate-stats` / `.stat-card` CSS classes.
- Error table uses a new `.error-table` class styled consistently with `.user-list`.
- Add a 30-second `setInterval` timer that calls `loadErrors()` and re-renders. Clear the interval on tab switch.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/admin-cf/src/routes/errors.ts` | Create | Error list API handler with D1 queries |
| `packages/admin-cf/src/routes/index.ts` | Modify | Re-export from `errors.ts` |
| `packages/admin-cf/src/index.ts` | Modify | Register `/admin/api/errors` route; add "Errors" tab to dashboard HTML; add `renderErrors()` function |
| `packages/admin-cf/src/types.ts` | Modify | Add `ErrorAggregate`, `ErrorSummary` interfaces; extend `Env` with `DIAGNOSTICS_DB` D1 binding |
| `packages/admin-cf/wrangler.jsonc` | Modify | Add `d1_databases` binding for `DIAGNOSTICS_DB` |
| `packages/admin-cf/tests/e2e/admin-e2e.test.ts` | Modify | Add "Error Dashboard" test section |
| `packages/admin-cf/tests/e2e/helpers.ts` | Modify | Add `listErrors()` method to `AdminApiClient` |

### Data Models / Schemas

**TypeScript interfaces (added to `types.ts`):**

```typescript
/** Single error signature aggregate row */
interface ErrorAggregate {
  errorSignature: string;
  category: 'crash' | 'network' | 'crypto' | 'storage' | 'ui' | 'protocol' | 'other';
  totalCount: number;
  versions: string[];      // parsed from GROUP_CONCAT
  platforms: string[];     // parsed from GROUP_CONCAT
  firstSeen: number;       // Unix ms
  lastSeen: number;        // Unix ms
  sampleMessage: string;
}

/** Summary cards data */
interface ErrorSummary {
  totalErrors: number;
  rateChangePercent: number;  // positive = increase, negative = decrease
  regressionAlerts: number;
  highestSeverity: 'critical' | 'high' | 'medium' | 'low' | 'none';
}

/** GET /admin/api/errors response */
interface ErrorsResponse {
  summary: ErrorSummary;
  errors: ErrorAggregate[];
  range: '1h' | '24h' | '7d';
}
```

**D1 table (already defined in plan -- created by diagnostics-cf worker):**

```sql
CREATE TABLE error_aggregates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time_bucket TEXT NOT NULL,
  error_signature TEXT NOT NULL,
  category TEXT NOT NULL,
  app_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  sample_message TEXT,
  sample_stack_trace TEXT,
  UNIQUE(time_bucket, error_signature, app_version, platform)
);
```

**Index to add for query performance:**

```sql
CREATE INDEX idx_error_agg_time ON error_aggregates(time_bucket);
CREATE INDEX idx_error_agg_sig ON error_aggregates(error_signature);
```

### API Endpoints

**GET /admin/api/errors**

- Auth: Bearer JWT required (admin or super-admin)
- Query params:
  - `range`: `1h` | `24h` | `7d` (default: `24h`)
  - `category`: optional filter (one of the error categories)
  - `limit`: integer 1-200 (default: 50)
- Success response (200):
  ```json
  {
    "success": true,
    "data": {
      "summary": {
        "totalErrors": 142,
        "rateChangePercent": 23.5,
        "regressionAlerts": 1,
        "highestSeverity": "high"
      },
      "errors": [
        {
          "errorSignature": "a1b2c3d4...",
          "category": "network",
          "totalCount": 87,
          "versions": ["1.2.0", "1.2.1"],
          "platforms": ["android", "ios"],
          "firstSeen": 1709380800000,
          "lastSeen": 1709384400000,
          "sampleMessage": "WebRTC connection timed out"
        }
      ],
      "range": "24h"
    }
  }
  ```
- Error responses: 401 (unauthenticated), 400 (invalid params), 500 (D1 error)

## Dependencies
- **US-1.1 (Diagnostic Report Submission):** The `error_aggregates` D1 table must exist and be populated by the diagnostics ingestion worker.
- **Diagnostics D1 database:** Must be provisioned (`wrangler d1 create zajel-diagnostics`) and schema applied before this feature works.
- **No external package dependencies** for this story -- it uses D1 SQL queries and existing inline HTML patterns.

## Testing Strategy

- **Unit tests:**
  - Test the `handleListErrors` handler with a mock D1 binding that returns canned query results.
  - Test time-range calculation logic (1h/24h/7d boundary computation).
  - Test rate-change percentage calculation edge cases (division by zero when previous period has zero errors).
  - Test query param validation (invalid range, out-of-bounds limit).

- **Integration tests:**
  - Seed a D1 database with known `error_aggregates` rows across multiple time buckets.
  - Call `GET /admin/api/errors?range=1h` and verify the response matches expected aggregates.
  - Verify category filtering reduces the result set correctly.

- **E2E tests (added to `admin-e2e.test.ts`):**
  - `GET /admin/api/errors` returns 200 with valid structure or 200 with empty data when no errors exist.
  - `GET /admin/api/errors` returns 401 without auth header.
  - Verify response includes `summary` and `errors` fields with correct types.

## Technical Notes

**Codebase patterns to follow:**
- The existing `handleListServers` in `routes/servers.ts` is the closest analogue: it uses `requireAuth`, processes data, and returns via `jsonResponse`. Follow the same structure.
- The `Env` interface in `types.ts` currently has `ADMIN_USERS` (DO) and `BOOTSTRAP_SERVICE` (service binding). Extend it with `DIAGNOSTICS_DB?: D1Database` (optional so existing tests do not break).
- The inline dashboard in `index.ts` uses a `state.activeTab` pattern with `loadData()` dispatching by tab. Add `'errors'` to this dispatch.
- The existing `.stat-card` CSS class is reused for summary cards -- no new CSS needed for that section.
- Auto-refresh: The current dashboard does not auto-refresh. Implement it with `setInterval` inside `loadData()` for the errors tab, storing the interval ID on state so it can be cleared on tab switch.

**D1 query considerations:**
- D1 supports SQLite's `strftime()` for time bucketing. The `time_bucket` column is already pre-bucketed to hour granularity by the ingestion worker, so the admin query just needs a `WHERE time_bucket >= ?` filter.
- D1 has a 100KB response size limit per query. With a LIMIT of 200 rows each containing ~200 bytes, this stays well under the limit.
- Use parameterized queries (`stmt.bind(...)`) to prevent SQL injection.

**Empty state handling:**
- When `DIAGNOSTICS_DB` is not bound (e.g., during local dev or before D1 is provisioned), return `{ summary: { totalErrors: 0, ... }, errors: [], range }` with a 200 status rather than a 500 error. This matches the graceful degradation pattern used in `handleListServers` when bootstrap is unavailable.

## Estimation
**M (Medium)** -- The API endpoint is straightforward D1 SQL with existing auth patterns. The frontend is a new tab following established inline HTML conventions. The main work is in the D1 queries (including the rate-change comparison query) and the 30-second auto-refresh logic. Estimated 2-3 days.
