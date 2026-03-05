# US-6.3: Issue Lifecycle Dashboard

## Story

As an admin, I want to track AI-created issues from detection to resolution, so that I can monitor how effectively the AI pipeline is identifying and surfacing bugs, and how quickly the team addresses them.

## Acceptance Criteria

- A new "AI Issues" tab is added to the admin portal (`packages/admin-cf/`) dashboard.
- The tab displays a table of all AI-detected issues with columns: Title, Severity, Component, Status, Assignee, GitHub Link, Detection Time, and Resolution Time.
- The table is sortable by severity, status, and detection time.
- The table supports filtering by: severity (critical/high/medium/low), component, and status (open/acknowledged/in-progress/resolved).
- Clicking a row opens a detail view showing: the full AI analysis (description, reproduction hints, suggested fix), affected versions and platforms, occurrence count, scrubbed log excerpts, and a link to the GitHub issue.
- Time-to-detection metric is displayed: the elapsed time from the first occurrence of the error signature to the creation of the AI issue.
- Time-to-fix metric is displayed: the elapsed time from AI issue creation to the GitHub issue being closed (synced from GitHub or manually marked).
- An "Acknowledge" action is available on each issue, which updates the status from "open" to "acknowledged" in D1.
- Summary cards at the top show: total open issues, critical issues count, average time-to-detection, and average time-to-fix.
- The table auto-refreshes every 30 seconds.
- All views require JWT authentication (existing admin auth).

## Technical Design

### Architecture

The AI Issues Dashboard is a new tab in the existing admin portal Preact SPA. It reads from the `issue_tracking` and `processing_runs` tables in the shared D1 database via new API endpoints added to the admin-cf worker.

```
[Admin Portal SPA]
    |
    +-- GET /admin/api/issues           -- list with filtering
    +-- GET /admin/api/issues/:id       -- detail view
    +-- POST /admin/api/issues/:id/acknowledge -- status update
    |
    v
[admin-cf Worker]
    |
    +-- reads D1 (issue_tracking, processing_runs)
```

### Implementation Details

**New API routes (`src/routes/issues.ts`):**
Following the pattern from `packages/admin-cf/src/routes/servers.ts`:
- `handleListIssues(request, env)` -- queries `issue_tracking` with optional query params for filtering and sorting. Returns paginated results.
- `handleGetIssue(request, env, id)` -- queries single issue by ID with full `ai_analysis` JSON blob.
- `handleAcknowledgeIssue(request, env, id)` -- updates issue status to "acknowledged" with acknowledging user info.

**Route registration (`src/index.ts`):**
Add new route handlers to the existing fetch handler switch, following the same pattern as existing `/admin/api/users` and `/admin/api/servers` routes. All routes require auth via `requireAuth()`.

**Dashboard tab (Preact SPA or inline JS):**
The existing dashboard uses inline HTML with vanilla JS. If the migration to Preact SPA has been done by the time this story is implemented, build as a Preact component. Otherwise, add a new tab section to the existing inline dashboard following the pattern for "Servers" and "Users" tabs.

The tab includes:
1. **Summary cards row:** Open issues count, critical count, avg time-to-detection, avg time-to-fix.
2. **Filter bar:** Dropdowns for severity, component, status.
3. **Issues table:** Sortable columns with click-to-detail.
4. **Detail panel:** Slides in on row click, shows full AI analysis.

**Auto-refresh:**
Use `setInterval()` (30s) to re-fetch the issues list, matching the existing dashboard refresh pattern.

### Files to Create/Modify

| File | Description |
|------|-------------|
| `packages/admin-cf/src/routes/issues.ts` | New route handlers for issue CRUD |
| `packages/admin-cf/src/index.ts` | Register new `/admin/api/issues` routes |
| `packages/admin-cf/src/types.ts` | Add issue-related interfaces to Env and response types |
| `packages/admin-cf/wrangler.jsonc` | Add D1 binding for `zajel-diagnostics` database |
| `packages/admin-cf/tests/e2e/issues.test.ts` | E2E tests for issue API endpoints |

### Data Models / Schemas

**API Response: Issue List**

```typescript
interface IssueListItem {
  id: number;
  error_signature: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  component: string;
  status: 'open' | 'acknowledged' | 'in-progress' | 'resolved';
  title: string;                          // Extracted from ai_analysis JSON
  github_issue_number: number | null;
  github_issue_url: string | null;
  total_occurrences: number;
  first_detected: number;                 // Unix ms
  last_detected: number;
  created_at: number;
  time_to_detection_ms: number | null;    // first_detected - first error occurrence
  time_to_fix_ms: number | null;          // resolved_at - created_at
}

interface IssueListResponse {
  issues: IssueListItem[];
  total: number;
  page: number;
  page_size: number;
  summary: {
    total_open: number;
    total_critical: number;
    avg_time_to_detection_ms: number;
    avg_time_to_fix_ms: number;
  };
}
```

**API Response: Issue Detail**

```typescript
interface IssueDetail extends IssueListItem {
  ai_analysis: {
    title: string;
    severity: string;
    component: string;
    description: string;
    reproduction_hints: string;
    suggested_fix: string;
    is_regression: boolean;
    affected_users_estimate: string;
  } | null;
  affected_versions: string[];            // Derived from error_aggregates
  affected_platforms: string[];           // Derived from error_aggregates
  sample_messages: string[];              // Scrubbed samples
}
```

**Updated Env interface:**

```typescript
interface Env {
  // ... existing bindings
  DIAGNOSTICS_DB: D1Database;           // New: shared diagnostics D1
}
```

### API Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/admin/api/issues` | List issues with filtering | JWT required |
| `GET` | `/admin/api/issues/:id` | Get issue detail | JWT required |
| `POST` | `/admin/api/issues/:id/acknowledge` | Acknowledge an issue | JWT required |

**GET `/admin/api/issues` query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `severity` | string | (all) | Filter by severity |
| `component` | string | (all) | Filter by component |
| `status` | string | (all) | Filter by status |
| `sort_by` | string | `created_at` | Sort column |
| `sort_order` | string | `desc` | `asc` or `desc` |
| `page` | number | 1 | Page number |
| `page_size` | number | 25 | Items per page |

**Response format (follows existing admin-cf pattern):**

```json
{
  "success": true,
  "data": {
    "issues": [...],
    "total": 42,
    "page": 1,
    "page_size": 25,
    "summary": {
      "total_open": 12,
      "total_critical": 3,
      "avg_time_to_detection_ms": 900000,
      "avg_time_to_fix_ms": 86400000
    }
  }
}
```

## Dependencies

- **US-6.1** (Automated Error Pattern Analysis): The `issue_tracking` and `processing_runs` tables must exist and be populated.
- **US-6.2** (Automated GitHub Issue Creation): Issues should have `github_issue_number` and `github_issue_url` populated for the GitHub link column.
- **Existing admin-cf auth**: JWT authentication is already implemented and reused.
- **D1 database**: The `zajel-diagnostics` D1 database must be accessible from admin-cf via a new binding.

## Testing Strategy

- **Unit tests:**
  - Query builder constructs correct SQL for each filter combination.
  - Pagination logic returns correct offsets and limits.
  - Summary calculation correctly computes averages from D1 data.
  - Acknowledge endpoint updates status and records acknowledger.

- **API E2E tests (`tests/e2e/issues.test.ts`):**
  - Following the pattern from `packages/admin-cf/tests/e2e/admin-e2e.test.ts`:
  - Seed D1 with test issue_tracking rows.
  - `GET /admin/api/issues` without auth returns 401.
  - `GET /admin/api/issues` with valid JWT returns issue list.
  - `GET /admin/api/issues?severity=critical` returns only critical issues.
  - `GET /admin/api/issues?status=open&sort_by=severity&sort_order=desc` returns sorted list.
  - `GET /admin/api/issues/:id` returns full detail with ai_analysis.
  - `GET /admin/api/issues/999` returns 404.
  - `POST /admin/api/issues/:id/acknowledge` updates status to "acknowledged".
  - `POST /admin/api/issues/:id/acknowledge` on already-acknowledged issue is idempotent.

- **Dashboard UI tests (if Preact migration is complete):**
  - Summary cards render correct counts.
  - Table rows match API response.
  - Filter dropdowns trigger API calls with correct params.
  - Row click opens detail panel.
  - Auto-refresh fires every 30 seconds.

## Technical Notes

**Codebase patterns to follow:**
- Route handlers in `packages/admin-cf/src/routes/` follow a consistent pattern: import `requireAuth` from `./auth.js`, check auth at the top, then handle the request. The `handleListIssues` handler should follow `handleListServers` as a reference.
- The `jsonResponse()` helper pattern from `servers.ts` should be replicated.
- The existing `ApiResponse<T>` generic interface from `types.ts` is used for all responses.
- The dashboard currently uses inline HTML with vanilla JS (not yet Preact). The new tab should follow the existing `renderServers()` / `renderUsers()` pattern unless the Preact migration (described in Section 4.3 of the plan) has been completed.

**D1 query considerations:**
- D1 supports standard SQL with some limitations. Use `CASE WHEN` for conditional sorting (e.g., severity ordering: critical=0, high=1, medium=2, low=3).
- Use parameterized queries (`?` placeholders) for all user-supplied filter values to prevent SQL injection.
- For the summary aggregations, use a separate query or a CTE to avoid scanning the full table twice.

**Time-to-detection calculation:**
- `time_to_detection_ms = issue_tracking.created_at - MIN(error_aggregates.first_seen)` for the matching signature.
- This requires a JOIN or subquery against `error_aggregates`.

**Wrangler.jsonc update:**
- Add `DIAGNOSTICS_DB` D1 binding to admin-cf's wrangler.jsonc, following the same pattern as the existing `ADMIN_USERS` Durable Object binding.

## Estimation

**M (Medium)** -- Three new API endpoints following established patterns, plus a dashboard tab that follows the existing tab structure. The D1 queries are straightforward. The main complexity is in the summary aggregation queries and the detail view with parsed AI analysis. Estimated 2-3 days.
