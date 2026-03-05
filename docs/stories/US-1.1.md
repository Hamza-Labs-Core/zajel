# US-1.1: Anonymous Diagnostic Report Submission

## Story

As a Zajel app, I want to submit anonymous diagnostic reports to a central collection endpoint, so that the development team can understand error patterns without compromising user privacy.

## Acceptance Criteria

- POST to `/diagnostics/report` with a valid `DiagnosticReport` schema returns HTTP 200 with a JSON success response.
- No user-identifying data (IP address, device ID, persistent fingerprint) is stored in D1 or R2; `CF-Connecting-IP` is used only for rate limiting and then discarded.
- `sessionHash` is a SHA-256 of a random UUID generated per app session -- not persistent across app restarts.
- Invalid or malformed schemas return HTTP 400 with a descriptive error message (missing required fields, wrong types, unknown `platform` values).
- Request bodies exceeding 64 KB are rejected with HTTP 413.
- Rate limiting prevents abuse: maximum 10 reports per `sessionHash` per hour. Exceeding the limit returns HTTP 429.
- A global rate limit of 10,000 reports per hour prevents DDoS against R2 storage.
- Raw diagnostic reports are stored in R2 at the path `diagnostics/{YYYY}/{MM}/{DD}/{HH}/{sessionHash}_{timestamp}.json`.
- Error data from the report is aggregated into D1 `error_aggregates` table, grouped by time bucket (hour), error signature, app version, and platform.
- Performance metrics are aggregated into D1 `performance_aggregates` table with p50/p95/p99 percentile tracking.
- Network metrics are aggregated into D1 `network_aggregates` table.
- GET `/diagnostics/health` returns HTTP 200 with service name, status, and timestamp.
- CORS headers are present on all responses.

## Technical Design

### Architecture

This story creates the new `packages/diagnostics-cf/` Cloudflare Worker -- the central ingestion point for all Flutter client diagnostics. It sits at the edge, receives anonymous reports over HTTPS, validates and scrubs them, stores raw reports in R2 for later AI analysis (Epic 6), and writes aggregated metrics to D1 for dashboard queries (Epics 2-4).

```
Flutter App --HTTPS POST--> [diagnostics-cf Worker]
                              |
                              +--> R2: raw JSON report (retained 30 days)
                              +--> D1: error_aggregates, performance_aggregates, network_aggregates
                              +--> Rate limit check (native binding or KV-backed)
```

### Implementation Details

**Worker structure** follows the existing `packages/server/` pattern: a single `src/index.ts` entry point that routes requests to handler functions, with CORS handling modeled after `packages/server/src/cors.js`.

**Rate limiting** uses the Cloudflare Workers native Rate Limiting binding (GA since September 2025). Two bindings are configured:
1. `REPORT_RATE_LIMITER` -- keyed on `sessionHash` from the request body, 10 requests per 60 seconds.
2. `GLOBAL_RATE_LIMITER` -- keyed on a fixed string `"global"`, 10,000 requests per 3600 seconds.

The `sessionHash` rate limit key is extracted from the parsed body, so the body must be parsed before rate limiting is applied. For the global limiter, the check happens before body parsing.

**Request validation** follows the pattern in `packages/server/src/utils/request-validation.js` -- parse JSON body with a size limit (64 KB), then validate the schema fields. Required fields: `sessionHash`, `appVersion`, `buildNumber`, `platform`, `platformVersion`, `locale`, `timestamp`. Optional fields: `errors[]`, `performance`, `network`, `connectionType`.

**D1 aggregation** uses `INSERT ... ON CONFLICT` (UPSERT) to atomically update time-bucketed counters. Time buckets are ISO datetime strings truncated to the hour (e.g., `2026-03-03T14:00:00Z`). Percentile tracking for performance metrics uses a running approximation: on each report, the new value is merged into the existing p50/p95/p99 using a weighted average with `sample_count`.

**R2 storage** writes the raw JSON report with a key derived from timestamp and session hash. R2 lifecycle rules (configured outside the Worker, in the Cloudflare dashboard or via API) auto-delete objects after 30 days.

**CORS** uses the same permissive pattern as the bootstrap server since the diagnostics endpoint is unauthenticated and intended for client apps on any origin.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/diagnostics-cf/package.json` | Create | Package manifest with vitest, wrangler, typescript dependencies |
| `packages/diagnostics-cf/tsconfig.json` | Create | TypeScript config matching `packages/admin-cf/tsconfig.json` pattern |
| `packages/diagnostics-cf/wrangler.jsonc` | Create | Worker config with D1, R2, KV, and rate limit bindings |
| `packages/diagnostics-cf/vitest.config.ts` | Create | Vitest config matching `packages/admin-cf/vitest.config.ts` |
| `packages/diagnostics-cf/src/index.ts` | Create | Entry point with request routing and CORS |
| `packages/diagnostics-cf/src/types.ts` | Create | TypeScript interfaces for Env, DiagnosticReport, etc. |
| `packages/diagnostics-cf/src/handlers/report.ts` | Create | POST `/diagnostics/report` handler |
| `packages/diagnostics-cf/src/handlers/health.ts` | Create | GET `/diagnostics/health` handler |
| `packages/diagnostics-cf/src/validation.ts` | Create | Schema validation for diagnostic reports |
| `packages/diagnostics-cf/src/aggregation.ts` | Create | D1 upsert logic for error, performance, and network aggregates |
| `packages/diagnostics-cf/src/storage.ts` | Create | R2 raw report storage logic |
| `packages/diagnostics-cf/src/cors.ts` | Create | CORS header utility (adapted from `packages/server/src/cors.js`) |
| `packages/diagnostics-cf/src/schema.sql` | Create | D1 table definitions for all aggregate tables |
| `packages/diagnostics-cf/tests/unit/validation.test.ts` | Create | Unit tests for schema validation |
| `packages/diagnostics-cf/tests/unit/aggregation.test.ts` | Create | Unit tests for D1 aggregation logic |
| `packages/diagnostics-cf/tests/e2e/report.test.ts` | Create | E2E tests for report submission endpoint |

### Data Models / Schemas

**DiagnosticReport (request body):**

```typescript
interface DiagnosticReport {
  sessionHash: string;           // SHA-256 hex, 64 chars
  appVersion: string;            // semver, e.g. "1.2.3"
  buildNumber: string;           // numeric string
  platform: 'android' | 'ios' | 'windows' | 'macos' | 'linux' | 'web';
  platformVersion: string;       // e.g. "Android 14", "iOS 17.2"
  locale: string;                // BCP-47, e.g. "en-US"
  timestamp: number;             // Unix ms

  errors?: DiagnosticError[];
  performance?: PerformanceMetrics;
  network?: NetworkMetrics;
  connectionType?: 'direct_p2p' | 'relay' | 'none';
}

interface DiagnosticError {
  category: 'crash' | 'network' | 'crypto' | 'storage' | 'ui' | 'protocol' | 'other';
  message: string;
  stackTrace?: string;
  signature: string;             // SHA-256 hex of category + top 3 frames
  count: number;
  firstOccurrence: number;
  lastOccurrence: number;
}

interface PerformanceMetrics {
  startupTimeMs?: number;
  frameRateAvg?: number;
  frameRateP95?: number;
  memoryUsageMb?: number;
  memoryPeakMb?: number;
}

interface NetworkMetrics {
  signalingConnectSuccessRate?: number;
  signalingConnectAttempts?: number;
  webrtcEstablishSuccessRate?: number;
  webrtcEstablishAttempts?: number;
  relayUsageRate?: number;
  avgLatencyMs?: number;
}
```

**D1 Tables:**

```sql
CREATE TABLE IF NOT EXISTS error_aggregates (
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

CREATE TABLE IF NOT EXISTS performance_aggregates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time_bucket TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  p50 REAL,
  p95 REAL,
  p99 REAL,
  sample_count INTEGER NOT NULL,
  UNIQUE(time_bucket, platform, app_version, metric_name)
);

CREATE TABLE IF NOT EXISTS network_aggregates (
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

CREATE TABLE IF NOT EXISTS client_heartbeats (
  session_hash TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  connection_type TEXT,
  region TEXT,
  last_seen INTEGER NOT NULL,
  session_start INTEGER NOT NULL
);
```

### API Endpoints

**POST /diagnostics/report**

Request:
```json
{
  "sessionHash": "a1b2c3...",
  "appVersion": "1.2.3",
  "buildNumber": "42",
  "platform": "android",
  "platformVersion": "Android 14",
  "locale": "en-US",
  "timestamp": 1709380800000,
  "errors": [
    {
      "category": "crypto",
      "message": "ChaCha20 decrypt failed: invalid tag",
      "stackTrace": "packages/app/lib/core/crypto/crypto_service.dart:142\n...",
      "signature": "abc123...",
      "count": 3,
      "firstOccurrence": 1709380700000,
      "lastOccurrence": 1709380800000
    }
  ],
  "performance": {
    "startupTimeMs": 1200,
    "frameRateAvg": 58.5
  },
  "network": {
    "signalingConnectSuccessRate": 0.95,
    "signalingConnectAttempts": 20
  },
  "connectionType": "direct_p2p"
}
```

Response (200):
```json
{
  "success": true,
  "data": {
    "reportId": "diagnostics/2026/03/03/14/a1b2c3_1709380800000.json"
  }
}
```

Response (400 -- invalid schema):
```json
{
  "success": false,
  "error": "Missing required field: sessionHash"
}
```

Response (429 -- rate limited):
```json
{
  "success": false,
  "error": "Rate limit exceeded. Maximum 10 reports per session per hour."
}
```

**GET /diagnostics/health**

Response (200):
```json
{
  "status": "ok",
  "service": "zajel-diagnostics",
  "timestamp": "2026-03-03T14:00:00.000Z"
}
```

## Dependencies

- No dependencies on other user stories -- this is the foundational story for the diagnostics pipeline.
- **External dependencies:**
  - Cloudflare D1 database (created via `wrangler d1 create zajel-diagnostics`)
  - Cloudflare R2 bucket (created via `wrangler r2 bucket create zajel-diagnostics`)
  - Cloudflare Workers Rate Limiting binding (requires wrangler >= 4.36.0)
  - TypeScript, vitest, wrangler as dev dependencies

## Testing Strategy

- **Unit tests:**
  - `validation.test.ts` -- Test all valid and invalid report schemas: missing fields, wrong types, oversized bodies, boundary values for numeric fields, invalid platform values, malformed sessionHash (not 64 hex chars).
  - `aggregation.test.ts` -- Test D1 upsert logic: first insert, duplicate key update (count increment, timestamp update), percentile approximation math.
- **Integration tests:**
  - `report.test.ts` -- Full request-response cycle using mock D1/R2/KV bindings (following the `MockStorage`/`MockState` pattern from `packages/server/tests/e2e/bootstrap.test.js`). Tests: valid report returns 200, invalid schema returns 400, oversized body returns 413, verify R2 object was written, verify D1 rows were inserted/updated.
- **E2E tests:**
  - Deploy to QA environment and verify report submission against live D1/R2 bindings.
  - Verify rate limiting: submit 11 reports with the same sessionHash within one minute, confirm 11th returns 429.

## Technical Notes

**Codebase patterns to follow:**
- The Worker entry point should mirror `packages/admin-cf/src/index.ts` structure: CORS preflight handling, route matching, JSON response helper, error catch-all returning 500.
- Type definitions should follow `packages/admin-cf/src/types.ts` pattern: separate `Env` interface with all bindings, request/response types, and public API types.
- Request validation should follow `packages/server/src/utils/request-validation.js`: parse body with size limit first, then validate fields.
- Test setup should follow `packages/server/tests/e2e/bootstrap.test.js`: mock storage classes, mock environment factory, vitest with `vi.useFakeTimers()` for time-dependent tests.

**External best practices applied:**
- Use Cloudflare bindings (D1, R2, KV, Rate Limit) as direct in-process references -- never use the REST API from within a Worker.
- The native Rate Limiting binding (GA September 2025) is preferred over KV-based rate limiting for simplicity and accuracy. It provides per-location rate limiting with sub-millisecond latency.
- `period` for the rate limit binding must be either 10 or 60 seconds. For the "10 per hour" session limit, use a KV-based counter with TTL as a fallback since the native binding only supports 10s or 60s periods. Alternatively, use the 60-second period and set the limit accordingly (e.g., 1 per 60 seconds approximates 10 per hour but is coarser).
- For the global limiter, a 60-second period with limit 167 (10000/60) approximates the hourly cap per CF location.
- R2 lifecycle rules for 30-day auto-deletion must be configured outside the Worker (via dashboard or Terraform).
- All `waitUntil` patterns should be used for D1/R2 writes that can happen after the response is sent, to minimize response latency.

**Gotchas:**
- D1 `INSERT ... ON CONFLICT` syntax is SQLite-based. Use `ON CONFLICT(time_bucket, error_signature, app_version, platform) DO UPDATE SET count = count + excluded.count, last_seen = MAX(last_seen, excluded.last_seen)`.
- R2 writes can fail silently if the bucket does not exist. The Worker should still succeed (aggregate in D1) even if R2 write fails, as noted in the plan's reliability table.
- KV is eventually consistent (up to 60 seconds globally). This is acceptable for rate limit counters -- a few extra requests may slip through during propagation.

## Estimation

**L (Large)** -- This story creates an entirely new Worker package from scratch, including project scaffolding, three storage integrations (D1, R2, rate limiting), schema validation, aggregation logic, CORS, and comprehensive tests. The D1 schema design and aggregation UPSERT logic require careful implementation.
