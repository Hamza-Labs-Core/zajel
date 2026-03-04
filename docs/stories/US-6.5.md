# US-6.5: Cost Monitoring

## Story

As an admin, I want to see AI tokens and GitHub API usage, so that I can monitor operational costs, detect anomalies, and ensure the AI pipeline stays within budget.

## Acceptance Criteria

- The admin portal displays a "Cost Monitoring" section within the AI Issues tab (or as a sub-tab).
- The section shows a table of recent processing runs with columns: Run Time, Duration, Errors Processed, Issues Created, Issues Updated, AI Calls Made, AI Tokens Used, and Status.
- Daily and weekly totals are displayed as summary cards: total AI tokens used (daily/weekly), total AI calls (daily/weekly), total GitHub issues created (daily/weekly), total GitHub API calls (daily/weekly), and estimated cost.
- A chart shows AI token usage over time (last 7 days, bucketed by hour or day).
- Estimated cost is calculated using the Workers AI pricing model ($0.011 per 1K input tokens) displayed as a running total.
- An alert threshold can be configured: if daily token usage exceeds the threshold, a warning is shown in the dashboard.
- The processing run history is queryable by time range.
- All data is sourced from the existing `processing_runs` table in D1 (populated by US-6.1).

## Technical Design

### Architecture

Cost monitoring is a read-only view built on top of the `processing_runs` table that the Log Processor Worker already populates (US-6.1). The admin-cf worker exposes new API endpoints that aggregate this data, and the dashboard renders it.

```
[Admin Portal SPA] -- AI Issues Tab -- Cost Monitoring Sub-section
    |
    +-- GET /admin/api/issues/processing-runs   -- recent runs
    +-- GET /admin/api/issues/cost-summary       -- aggregated costs
    |
    v
[admin-cf Worker]
    |
    +-- reads D1 (processing_runs)
```

### Implementation Details

**New API routes (`src/routes/issues.ts` extension):**
Add two new route handlers to the existing issues routes module:

1. `handleProcessingRuns(request, env)`:
   - Queries `processing_runs` with optional `since` and `until` timestamp parameters.
   - Returns paginated results ordered by `run_start DESC`.
   - Default: last 24 hours of runs (96 runs at 15-min intervals).

2. `handleCostSummary(request, env)`:
   - Aggregates `processing_runs` data into daily and weekly summaries.
   - Calculates totals for: ai_calls_made, ai_tokens_used, issues_created, issues_updated.
   - Computes estimated cost using configurable pricing (`AI_TOKEN_COST_PER_1K`).
   - Returns per-day breakdowns for the last 7 days plus weekly totals.

**Route registration (`src/index.ts`):**
Add routes:
- `GET /admin/api/issues/processing-runs` -> `handleProcessingRuns`
- `GET /admin/api/issues/cost-summary` -> `handleCostSummary`

**Dashboard UI:**
Add a "Cost Monitoring" section below the issues table in the AI Issues tab. The section contains:
1. **Summary cards:** Daily tokens, weekly tokens, daily cost, weekly cost, daily AI calls, daily issues created.
2. **Token usage chart:** Bar chart showing hourly or daily token usage over the last 7 days.
3. **Processing runs table:** Scrollable table showing recent runs with all columns.
4. **Alert indicator:** If daily tokens exceed the configured threshold, display a warning banner.

**Cost estimation formula:**
```
estimated_cost_usd = (total_tokens / 1000) * AI_TOKEN_COST_PER_1K
```
Default `AI_TOKEN_COST_PER_1K = 0.011` (Workers AI pricing for Llama 3.1 8B).

### Files to Create/Modify

| File | Description |
|------|-------------|
| `packages/admin-cf/src/routes/issues.ts` | Add `handleProcessingRuns` and `handleCostSummary` handlers |
| `packages/admin-cf/src/index.ts` | Register new `/admin/api/issues/processing-runs` and `/admin/api/issues/cost-summary` routes |
| `packages/admin-cf/src/types.ts` | Add `ProcessingRun`, `CostSummary` interfaces |
| `packages/admin-cf/wrangler.jsonc` | Add `AI_TOKEN_COST_PER_1K` and `DAILY_TOKEN_ALERT_THRESHOLD` vars |
| `packages/admin-cf/tests/e2e/cost-monitoring.test.ts` | E2E tests for cost monitoring endpoints |

### Data Models / Schemas

**Processing Run (from D1, read-only in this story):**

```typescript
interface ProcessingRun {
  id: number;
  run_start: number;          // Unix ms
  run_end: number;
  errors_processed: number;
  issues_created: number;
  issues_updated: number;
  ai_calls_made: number;
  ai_tokens_used: number;
  status: 'success' | 'partial' | 'failed';
  duration_ms: number;        // Computed: run_end - run_start
}
```

**Cost Summary Response:**

```typescript
interface CostSummary {
  daily: {
    date: string;              // ISO date (YYYY-MM-DD)
    total_runs: number;
    successful_runs: number;
    failed_runs: number;
    total_errors_processed: number;
    total_issues_created: number;
    total_issues_updated: number;
    total_ai_calls: number;
    total_ai_tokens: number;
    estimated_cost_usd: number;
  }[];
  weekly_totals: {
    total_runs: number;
    successful_runs: number;
    failed_runs: number;
    total_errors_processed: number;
    total_issues_created: number;
    total_issues_updated: number;
    total_ai_calls: number;
    total_ai_tokens: number;
    estimated_cost_usd: number;
  };
  alert: {
    threshold: number;          // Configured daily token threshold
    today_tokens: number;
    is_exceeded: boolean;
  };
  pricing: {
    model: string;              // "@cf/meta/llama-3.1-8b-instruct"
    cost_per_1k_tokens: number; // 0.011
  };
}
```

### API Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/admin/api/issues/processing-runs` | List processing runs | JWT required |
| `GET` | `/admin/api/issues/cost-summary` | Aggregated cost data | JWT required |

**GET `/admin/api/issues/processing-runs` query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `since` | number | 24h ago | Start timestamp (Unix ms) |
| `until` | number | now | End timestamp (Unix ms) |
| `status` | string | (all) | Filter by run status |
| `page` | number | 1 | Page number |
| `page_size` | number | 50 | Items per page |

**GET `/admin/api/issues/cost-summary` query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `days` | number | 7 | Number of days to aggregate |

**Response examples:**

```json
// GET /admin/api/issues/processing-runs
{
  "success": true,
  "data": {
    "runs": [
      {
        "id": 142,
        "run_start": 1709395200000,
        "run_end": 1709395215000,
        "errors_processed": 12,
        "issues_created": 2,
        "issues_updated": 3,
        "ai_calls_made": 8,
        "ai_tokens_used": 7500,
        "status": "success",
        "duration_ms": 15000
      }
    ],
    "total": 96,
    "page": 1,
    "page_size": 50
  }
}

// GET /admin/api/issues/cost-summary
{
  "success": true,
  "data": {
    "daily": [
      {
        "date": "2026-03-03",
        "total_runs": 96,
        "successful_runs": 94,
        "failed_runs": 2,
        "total_errors_processed": 450,
        "total_issues_created": 5,
        "total_issues_updated": 12,
        "total_ai_calls": 180,
        "total_ai_tokens": 185000,
        "estimated_cost_usd": 2.04
      }
    ],
    "weekly_totals": { ... },
    "alert": {
      "threshold": 500000,
      "today_tokens": 185000,
      "is_exceeded": false
    },
    "pricing": {
      "model": "@cf/meta/llama-3.1-8b-instruct",
      "cost_per_1k_tokens": 0.011
    }
  }
}
```

## Dependencies

- **US-6.1** (Automated Error Pattern Analysis): The `processing_runs` table must exist and be populated by the log processor cron job.
- **US-6.3** (Issue Lifecycle Dashboard): The AI Issues tab must exist for the cost monitoring section to be embedded within it.
- **D1 database**: The `zajel-diagnostics` D1 binding must be accessible from admin-cf (added in US-6.3).

## Testing Strategy

- **Unit tests:**
  - Cost calculation: verify `(tokens / 1000) * rate` produces correct USD values.
  - Daily aggregation: given a set of processing_runs, verify correct grouping by date.
  - Weekly totals: verify summation across all days.
  - Alert threshold: verify `is_exceeded` is true when daily tokens > threshold.
  - Edge cases: no processing runs in time range returns zeros, not errors.

- **API E2E tests (`tests/e2e/cost-monitoring.test.ts`):**
  - Seed D1 with `processing_runs` rows spanning 7 days.
  - `GET /admin/api/issues/processing-runs` returns runs sorted by time descending.
  - `GET /admin/api/issues/processing-runs?since={ts}&until={ts}` filters correctly.
  - `GET /admin/api/issues/processing-runs?status=failed` returns only failed runs.
  - `GET /admin/api/issues/cost-summary` returns daily array with correct aggregations.
  - `GET /admin/api/issues/cost-summary?days=3` returns only 3 days of data.
  - Alert threshold correctly reflects today's token usage.
  - Unauthenticated requests return 401.

- **Dashboard visual tests (manual or snapshot):**
  - Summary cards show correct values matching API response.
  - Token usage chart renders with correct data points.
  - Processing runs table is scrollable and shows all columns.
  - Warning banner appears when alert threshold is exceeded.

## Technical Notes

**D1 aggregation queries:**
The cost summary endpoint needs to aggregate `processing_runs` by day. D1 supports `strftime()` for date formatting and `GROUP BY` for aggregation:

```sql
SELECT
  strftime('%Y-%m-%d', run_start / 1000, 'unixepoch') AS date,
  COUNT(*) AS total_runs,
  SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successful_runs,
  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_runs,
  SUM(errors_processed) AS total_errors_processed,
  SUM(issues_created) AS total_issues_created,
  SUM(issues_updated) AS total_issues_updated,
  SUM(ai_calls_made) AS total_ai_calls,
  SUM(ai_tokens_used) AS total_ai_tokens
FROM processing_runs
WHERE run_start >= ?
GROUP BY date
ORDER BY date DESC;
```

**Cost estimation accuracy:**
- The `ai_tokens_used` value recorded by the log processor is the actual token count returned by the Workers AI API response. The cost estimate is therefore reasonably accurate.
- Workers AI pricing may change; the `AI_TOKEN_COST_PER_1K` is a configurable var so it can be updated without code changes.
- The free tier (10,000 neurons/day) is not factored into the cost display -- the estimate shows gross cost, not net-of-free-tier cost.

**Alert threshold configuration:**
- `DAILY_TOKEN_ALERT_THRESHOLD` defaults to 500,000 tokens/day (~$5.50/day).
- This is a simple static threshold. A future enhancement could add dynamic anomaly detection.

**Codebase patterns:**
- Follow the same route handler pattern as US-6.3 (`handleListIssues`).
- The `jsonResponse()` helper and `requireAuth()` middleware from the existing codebase are reused.
- Date handling: D1 timestamps are stored as Unix milliseconds (consistent with `error_aggregates.first_seen` and `issue_tracking.created_at`). Use JavaScript `Date` for display formatting.

**Chart rendering:**
- The current dashboard uses inline HTML without a charting library. For the token usage chart, options include:
  - Simple CSS bar chart (no library needed, matches existing inline approach).
  - Inline SVG chart (used by the VPS admin dashboard in `packages/server-vps/`).
  - If Preact migration is complete, a lightweight charting library like `uPlot` or `Chart.js` could be used.

## Estimation

**S (Small)** -- This is a read-only view over data already being collected. Two API endpoints with SQL aggregation queries, summary cards, and a simple table/chart. No new data collection or complex logic. Estimated 1-2 days.
