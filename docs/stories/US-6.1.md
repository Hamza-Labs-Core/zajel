# US-6.1: Automated Error Pattern Analysis

## Story

As a development team, I want the system to automatically analyze error patterns using AI, so that significant error clusters are identified, contextualized, and summarized without manual log triage.

## Acceptance Criteria

- A new Cloudflare Worker (`packages/log-processor-cf/`) is created with a cron trigger that fires every 15 minutes.
- On each run, the worker queries the `error_aggregates` table in D1 for error signatures that have accumulated above a configurable threshold (default: 5 occurrences) since the last processing run.
- For each significant error cluster, the worker fetches 3-5 sample raw reports from R2 to provide context.
- The worker calls Cloudflare Workers AI (`@cf/meta/llama-3.1-8b-instruct`) with a structured prompt including the error signature, category, total occurrences, affected versions/platforms, sample messages, and sample stack traces.
- The AI returns a structured JSON response containing: title (max 80 chars), severity (critical/high/medium/low), component (crypto/network/ui/storage/protocol/signaling/relay/webrtc/other), description (2-3 paragraphs), reproduction hints, suggested fix, is_regression flag, and affected_users_estimate (few/some/many/most).
- Workers AI JSON mode (`response_format: { type: "json_schema", json_schema: ... }`) is used to enforce structured output.
- Regression detection runs on each cycle: if the error rate for any signature in the current hour exceeds 3x the 24-hour rolling average, it is flagged as a regression.
- If a new error signature appears only in the latest app version, it is flagged as a potential version-specific regression.
- Each processing run is recorded in the `processing_runs` table with: run_start, run_end, errors_processed, issues_created, issues_updated, ai_calls_made, ai_tokens_used, and status (success/partial/failed).
- If Workers AI is unavailable, the worker records error clusters in D1 without AI analysis, sets status to "partial", and retries AI on the next cycle.
- A maximum of 20 error clusters are processed per run to stay within token budgets and execution time limits.
- The AI prompt includes Zajel-specific domain context (Flutter, WebRTC, X25519+ChaCha20-Poly1305, VPS relay servers) for better analysis quality.

## Technical Design

### Architecture

The Log Processor Worker is a standalone Cloudflare Worker (`packages/log-processor-cf/`) that operates on a 15-minute cron schedule. It reads from the shared D1 database and R2 bucket populated by the Diagnostics Ingestion Worker (`packages/diagnostics-cf/`), runs AI inference via the Workers AI binding, and writes analysis results back to D1.

```
Cron Trigger (*/15 * * * *)
    |
    v
[log-processor-cf Worker]
    |
    +-- reads D1 (error_aggregates, processing_runs)
    +-- reads R2 (raw diagnostic reports for context)
    +-- calls Workers AI (@cf/meta/llama-3.1-8b-instruct)
    +-- writes D1 (issue_tracking, processing_runs)
```

### Implementation Details

**Worker entry point (`src/index.ts`):**
Export a `scheduled()` handler following the CF Workers cron trigger pattern. The handler orchestrates the full pipeline: query new errors, fetch samples, run AI analysis, store results.

**Processing pipeline (`src/pipeline.ts`):**
1. Read `last_run_time` from the most recent `processing_runs` row.
2. Query `error_aggregates` for signatures with `SUM(count) >= threshold` since `last_run_time`, grouped by `error_signature`.
3. For each cluster (up to 20):
   a. Check `issue_tracking` -- skip if already analyzed in this cycle.
   b. Fetch 3-5 sample reports from R2 using the time-bucket path pattern.
   c. Build AI prompt from the template with cluster data and samples.
   d. Call `env.AI.run("@cf/meta/llama-3.1-8b-instruct", { messages, response_format })`.
   e. Parse and validate the JSON response against the expected schema.
   f. Store the analysis in `issue_tracking` (insert or update).
4. Run regression detection: compare current-hour rates vs. 24h rolling average.
5. Record the run in `processing_runs`.

**AI prompt template (`src/prompts.ts`):**
A dedicated module containing the system prompt, per-cluster user prompt template, and the JSON schema for structured output. The system prompt includes Zajel-specific context (Flutter, WebRTC, encryption stack) to improve analysis quality.

**Regression detector (`src/regression.ts`):**
Compares error rates in the current time bucket against the 24-hour rolling average. Flags any signature where `current_rate > 3 * avg_24h_rate`. Also flags signatures that appear exclusively in the latest app version.

**Fallback handling (`src/fallback.ts`):**
Wraps AI calls in try/catch. On failure, records the cluster raw data in `issue_tracking` with `ai_analysis: null` and marks the processing run as "partial". The next cycle will detect un-analyzed clusters and retry.

### Files to Create/Modify

| File | Description |
|------|-------------|
| `packages/log-processor-cf/package.json` | Package manifest with dependencies (wrangler, vitest, @cloudflare/workers-types) |
| `packages/log-processor-cf/wrangler.jsonc` | Worker config with D1, R2, AI bindings and cron trigger |
| `packages/log-processor-cf/tsconfig.json` | TypeScript configuration |
| `packages/log-processor-cf/vitest.config.ts` | Test configuration following admin-cf pattern |
| `packages/log-processor-cf/src/index.ts` | Entry point with `scheduled()` handler |
| `packages/log-processor-cf/src/pipeline.ts` | Main processing pipeline orchestration |
| `packages/log-processor-cf/src/prompts.ts` | AI prompt templates and JSON schema |
| `packages/log-processor-cf/src/regression.ts` | Regression detection logic |
| `packages/log-processor-cf/src/fallback.ts` | Graceful degradation when AI/services are down |
| `packages/log-processor-cf/src/types.ts` | TypeScript interfaces for all data models |
| `packages/log-processor-cf/src/db.ts` | D1 query helpers (error aggregates, issue tracking, processing runs) |
| `packages/log-processor-cf/src/r2.ts` | R2 sample report fetching |
| `packages/log-processor-cf/tests/unit/pipeline.test.ts` | Pipeline logic unit tests |
| `packages/log-processor-cf/tests/unit/regression.test.ts` | Regression detection tests |
| `packages/log-processor-cf/tests/unit/prompts.test.ts` | Prompt construction tests |

### Data Models / Schemas

**D1 Tables (shared `zajel-diagnostics` database):**

```sql
-- Issue tracking (created by this story)
CREATE TABLE issue_tracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  error_signature TEXT NOT NULL UNIQUE,
  github_issue_number INTEGER,
  github_issue_url TEXT,
  severity TEXT NOT NULL,
  component TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  ai_analysis TEXT,                       -- JSON blob of full AI output
  first_detected INTEGER NOT NULL,
  last_detected INTEGER NOT NULL,
  total_occurrences INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Processing run history (created by this story)
CREATE TABLE processing_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_start INTEGER NOT NULL,
  run_end INTEGER NOT NULL,
  errors_processed INTEGER NOT NULL,
  issues_created INTEGER NOT NULL,
  issues_updated INTEGER NOT NULL,
  ai_calls_made INTEGER NOT NULL,
  ai_tokens_used INTEGER NOT NULL,
  status TEXT NOT NULL                   -- 'success', 'partial', 'failed'
);
```

**AI Response Schema (for Workers AI JSON mode):**

```json
{
  "type": "json_schema",
  "json_schema": {
    "type": "object",
    "properties": {
      "title": { "type": "string", "maxLength": 80 },
      "severity": { "type": "string", "enum": ["critical", "high", "medium", "low"] },
      "component": { "type": "string", "enum": ["crypto", "network", "ui", "storage", "protocol", "signaling", "relay", "webrtc", "other"] },
      "description": { "type": "string" },
      "reproduction_hints": { "type": "string" },
      "suggested_fix": { "type": "string" },
      "is_regression": { "type": "boolean" },
      "affected_users_estimate": { "type": "string", "enum": ["few", "some", "many", "most"] }
    },
    "required": ["title", "severity", "component", "description", "reproduction_hints", "suggested_fix", "is_regression", "affected_users_estimate"]
  }
}
```

**Wrangler configuration (`wrangler.jsonc`):**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "zajel-log-processor",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-01",

  "triggers": {
    "crons": ["*/15 * * * *"]
  },

  "ai": {
    "binding": "AI"
  },

  "d1_databases": [
    { "binding": "DIAGNOSTICS_DB", "database_name": "zajel-diagnostics", "database_id": "<to-be-created>" }
  ],

  "r2_buckets": [
    { "binding": "DIAGNOSTICS_R2", "bucket_name": "zajel-diagnostics" }
  ],

  "vars": {
    "ERROR_THRESHOLD": "5",
    "MAX_CLUSTERS_PER_RUN": "20",
    "REGRESSION_MULTIPLIER": "3"
  }
}
```

### API Endpoints

This story does not expose HTTP API endpoints. The worker is triggered exclusively by the cron schedule. For local testing, the `/__scheduled` route (exposed by `wrangler dev --test-scheduled`) can be used to simulate cron invocations.

## Dependencies

- **US-1.1** (Diagnostics Ingestion): Requires the `error_aggregates` table to be populated with data from client diagnostic reports.
- **US-1.4** (Error Categorization and Signature): Relies on stable error signatures for clustering.
- **Cloudflare Workers AI**: The `@cf/meta/llama-3.1-8b-instruct` model must be available via the AI binding.
- **Cloudflare D1**: Shared `zajel-diagnostics` database must be provisioned.
- **Cloudflare R2**: Shared `zajel-diagnostics` bucket must contain raw reports.
- **@cloudflare/workers-types**: TypeScript types for Workers AI, D1, R2 bindings.
- **wrangler ^4.x**: For deployment and local development.

## Testing Strategy

- **Unit tests (`tests/unit/pipeline.test.ts`):**
  - Mock D1 queries to return known error clusters; verify correct AI prompt construction.
  - Mock AI responses; verify correct parsing and D1 writes.
  - Test threshold filtering: clusters below threshold are skipped.
  - Test max cluster cap: only first 20 clusters processed.
  - Test run recording: `processing_runs` row created with correct stats.

- **Unit tests (`tests/unit/regression.test.ts`):**
  - Cluster with current rate > 3x 24h average is flagged.
  - Cluster with rate <= 3x average is not flagged.
  - New signature in latest version only is flagged as regression.
  - Signature present across multiple versions is not flagged as version-specific.

- **Unit tests (`tests/unit/prompts.test.ts`):**
  - Prompt includes all required fields from cluster data.
  - JSON schema is valid and matches expected structure.
  - Sample messages and stack traces are correctly interpolated.

- **Fallback tests:**
  - AI call throws: run completes with status "partial", clusters stored without analysis.
  - D1 query fails: run records as "failed" with zero processed.
  - R2 sample fetch fails: AI called with available data only.

- **Integration tests (against Miniflare):**
  - Seed D1 with error aggregates and R2 with sample reports.
  - Trigger scheduled handler.
  - Verify issue_tracking rows created with AI analysis.
  - Verify processing_runs row with correct statistics.

## Technical Notes

**Codebase patterns to follow:**
- The existing `packages/admin-cf/` and `packages/server/` workers use JSONC-format wrangler config files. Follow the same pattern.
- TypeScript is used in `admin-cf`; this worker should also use TypeScript with the same `@cloudflare/workers-types` dependency.
- The `vitest.config.ts` pattern from `admin-cf` (verbose reporters, 30s timeout, single worker) should be replicated.
- The existing `Env` interface pattern from `admin-cf/src/types.ts` should be followed for type-safe environment bindings.

**Workers AI specifics:**
- Workers AI supports JSON mode via `response_format: { type: "json_schema", json_schema: {...} }` in the messages-style API. This was added in Feb 2025. If the schema is too complex the model may fail with `JSON Mode couldn't be met` -- keep the schema flat.
- JSON mode does not support streaming -- this is fine for cron-triggered batch processing.
- Fallback model `@cf/mistral/mistral-7b-instruct-v0.1` should be attempted if the primary model fails.
- Token budget: ~1,000 tokens per cluster analysis. At 20 clusters per run, that is ~20,000 tokens per 15-minute cycle.

**Cron trigger specifics:**
- The `scheduled()` handler receives `controller: ScheduledController, env: Env, ctx: ExecutionContext`.
- Use `controller.cron` to identify which schedule fired if multiple crons are added later.
- Local testing via `curl http://localhost:8787/cdn-cgi/handler/scheduled`.

**Prompt injection mitigation:**
- Error messages and stack traces from user devices are placed in structured data fields within the prompt, never mixed with system instructions.
- The system prompt explicitly states the expected output format.
- Input data is truncated to prevent oversized prompts (max 500 chars per sample message, max 1000 chars per stack trace).

## Estimation

**L (Large)** -- This story creates a new CF Worker package from scratch, implements the full AI analysis pipeline with structured output, regression detection, fallback handling, and cron scheduling. The AI prompt engineering and output validation require careful tuning. Estimated 4-5 days of development effort.
