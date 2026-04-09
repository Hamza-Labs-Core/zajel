# Diagnostics System — Gap Analysis

Audit of Plan 10 (`docs/plans/10-diagnostics-admin-portal.md`) vs actual implementation.
Conducted 2026-03-10.

---

## Critical Gap: Log Analysis Pipeline

The "Log Processor Worker" (`log-processor-cf`) does NOT process logs. It only reads
pre-categorized `error_aggregates` from D1. Actual logs from both servers and the app
are never analyzed for issue detection.

### Current State

| Log Source | Collected? | Stored Centrally? | AI Analyzed? |
|---|---|---|---|
| Client error aggregates | Yes (diagnostics-cf) | Yes (D1) | Yes (error_aggregates only) |
| VPS server logs | Yes (pushed every 10s) | Yes (D1 `server_logs`) | **No** |
| Flutter app logs (LoggerService) | **No** — local file only | **No** | **No** |

### What's Needed

1. **Flutter app log upload** — `LoggerService` writes to local files with 7-day rotation
   but has zero upload mechanism. Logs never leave the device.

2. **VPS server log AI analysis** — Logs are pushed to `diagnostics-cf` and stored in D1
   `server_logs` table, but `log-processor-cf` never queries this table. Only
   `error_aggregates` is read.

3. **Log filtering before send/store** — Raw log streams are noisy. Need:
   - **Deduplication**: Collapse repeated identical messages within a time window
     (e.g., "WebSocket reconnect failed" x500 in 1 minute becomes 1 entry with count=500).
     Must preserve significance — if a message appears after a long gap, it's a new event.
   - **Sampling**: At high volume, sample non-error logs (e.g., keep 100% of error/critical,
     10% of info/debug above a rate threshold).
   - **Rate limiting**: Cap log upload rate per session to prevent bandwidth abuse.
   - Both client-side (before HTTP send) and server-side (before D1 insert) filtering.

4. **Cross-source correlation** — Epic 9 US-9.2 describes viewing server logs and client
   diagnostics side-by-side for the same time window. The API route `log-correlation.ts`
   exists but the actual correlation logic and UI are unverified.

5. **GitHub issues are incomplete debugging artifacts** — The current issue body and labels
   are too sparse to be actionable. Here's what's missing:

   **Labels — current**: `['ai-detected', severity, component]`
   **Labels — needed**: Also tag with version, platform, and environment so issues can be
   filtered/searched by release, OS, and prod vs QA.
   Example: `['ai-detected', 'critical', 'crypto', 'v1.6.0', 'android', 'production']`
   When multiple versions/platforms are affected, use the primary (highest-count) one as
   label and list the rest in the body.

   **Body — missing sections**:

   a. **Version & Environment context** — Which version(s) the error appeared in, which
      environment (production/QA), and whether it's new to the latest version (regression
      signal). Currently versions are listed as plain text in "Affected Scope" but with no
      env info and no regression flag.

   b. **Related server logs** — Query `server_logs` D1 table for the time window
      `[cluster.firstSeen - 5min, cluster.lastSeen + 1min]` filtered by severity
      `warn`/`error`/`critical`. Include up to 20 entries in a collapsible section,
      ordered by timestamp. This gives server-side context for what was happening when
      the client errors occurred.

   c. **Related app logs** — Once app log upload is implemented, query the app logs table
      for the same time window. Include up to 20 entries in a separate collapsible section.

   d. **Stack traces from R2** — Fetch 2-3 raw reports from R2 for this error signature
      to get full stack traces (the `sample_stack_trace` in `error_aggregates` is often
      truncated by `GROUP_CONCAT`). `REPORTS_BUCKET` binding is declared but never used.

   e. **Timeline of events** — A chronological log showing when the error first appeared,
      how it ramped up, and what server-side events coincided. Not a chart — just a
      timestamped list of key moments.

6. **Log retention / cleanup** — No mechanism to delete old logs from D1 or R2:
   - `server_logs` D1 table: No scheduled cleanup. Rows accumulate indefinitely.
   - `error_aggregates` D1 table: No scheduled cleanup.
   - R2 raw reports: Plan mentions 30-day lifecycle rule but this is a CF dashboard config,
     not enforced in code. No fallback cleanup cron.
   - `client_heartbeats` D1 table: Stale entries (sessions gone >24h) never pruned.
   - `security_events` D1 table: Has a 30-day auto-delete in the push handler, but only
     runs when new events are pushed — if push stops, old data stays forever.
   - `processing_runs` D1 table: Never cleaned up.
   - `alert_history` D1 table: Never cleaned up.
   - `notifications` D1 table: Never cleaned up.
   Need a scheduled cleanup cron that purges old data across all tables with configurable
   retention periods per table/severity.

---

## Gap: log-processor-cf

| Feature | Plan | Status | Notes |
|---|---|---|---|
| Query `error_aggregates` from D1 | Yes | Done | |
| Query `server_logs` from D1 | Not in plan but needed | **Missing** | Server logs stored but never analyzed |
| Query app logs | Not in plan but needed | **Missing** | App logs not even uploaded |
| R2 sample report fetching | Yes | **Missing** | `REPORTS_BUCKET` declared, never used |
| Regression detection (3x spike) | Yes | **Missing** | No 24h rolling average, no version-specific flags |
| Fallback AI model (Mistral) | Yes | **Missing** | Only Llama 3.1-8B, no retry with alt model |
| GitHub retry queue | Yes | **Missing** | `pending` status set but never retried on next cron |
| GitHub rate limit handling | Yes | **Missing** | No backoff, no `Retry-After` header parsing |
| GitHub issue assignees | `['claude']` | **Missing** | Assignees field not set in payload |
| Token/cost monitoring UI | Yes | **Missing** | `processing_runs` table has data, no dashboard display |
| GitHub labels: version | Needed | **Missing** | No version label (e.g. `v1.6.0`) on created issues |
| GitHub labels: platform | Needed | **Missing** | No platform label (e.g. `android`) on created issues |
| GitHub labels: environment | Needed | **Missing** | No env label (`production`/`qa`) — env not even tracked in pipeline |
| Related server logs in issue body | Needed | **Missing** | `server_logs` table exists but never queried by pipeline |
| Related app logs in issue body | Needed | **Missing** | App logs not uploaded; even when they are, pipeline won't query them |
| Full stack traces from R2 | Yes | **Missing** | `REPORTS_BUCKET` declared, never read — aggregated traces truncated |
| Event timeline in issue body | Needed | **Missing** | No chronological ramp-up context in issue |
| Log retention / cleanup cron | Needed | **Missing** | No scheduled deletion of old data in any D1 table |

---

## Gap: Flutter Diagnostics SDK

| Feature | Plan | Status | Notes |
|---|---|---|---|
| Error tracking | Yes | Done | FlutterError + PlatformDispatcher hooked |
| Error categorization | Yes | Done | 6 categories with heuristics |
| Error signature (SHA-256) | Yes | Done | Category + top 3 frames |
| Privacy scrubber | Yes | Done | IPs, emails, UUIDs, keys, paths, peer IDs |
| Opt-in toggle in settings | Yes | Done | Default OFF prod, ON QA |
| `performance_tracker.dart` | Yes | **Missing** | No file exists |
| Startup time measurement | Yes | **Missing** | |
| Frame rate tracking (SchedulerBinding) | Yes | **Missing** | |
| Memory usage tracking | Yes | **Missing** | |
| `network_tracker.dart` | Yes | **Missing** | No file exists |
| Signaling connect success rate | Yes | **Missing** | Callback defined, never wired |
| WebRTC establishment success rate | Yes | **Missing** | Callback defined, never wired |
| Relay vs direct P2P counting | Yes | **Missing** | |
| Latency measurement | Yes | **Missing** | |
| App log upload | Yes (Epic 9) | **Missing** | `LoggerService` is local-only, no HTTP upload |
| Report interval | 5 min | 10 min | Minor discrepancy |

---

## Gap: Admin Dashboard UI

Backend APIs are fully implemented (30+ endpoints). Frontend is the bottleneck.

| Feature | API | UI | Notes |
|---|---|---|---|
| Preact SPA migration | N/A | **Not done** | Still ~2000 lines inline HTML template literals |
| Servers tab | Done | Done | |
| Users tab | Done | Done | |
| Errors tab | Done | Done | Trends chart, signature table, regression banner |
| Metrics tab | Done | **Partial** | Gauges and cards rendered; no histograms, no latency percentiles |
| Active Clients tab | Done | **Missing** | No tab in HTML; no donut/sparkline/area charts |
| Server Health tab | Done | **Missing** | No tab; no logs viewer, topology graph, heartbeat timeline |
| Security tab | Done | **Missing** | No tab; no rate limit/DDoS/brute force charts |
| AI Issues tab | Done | **Missing** | No tab; no issue table, Kanban, or detail view |
| Notifications tab | Done | **Missing** | No tab; no config form, history, or test button |
| Error signature drill-down | Done | **Missing** | API returns detail, no UI for it |
| Cost monitoring display | Done | **Missing** | `GET /admin/api/ai/costs` exists, no UI |

---

## Gap: Admin-CF Bindings

| Binding | Plan | Status |
|---|---|---|
| `BOOTSTRAP_SERVICE` | Yes | Done |
| `DIAGNOSTICS_DB` | Yes | Done |
| `ADMIN_KV` | Yes | Done |
| `SEND_EMAIL` | Yes | Done |
| `DIAGNOSTICS_SERVICE` | Yes | **Missing** — Service Binding to diagnostics-cf not in wrangler |
| `DIAGNOSTICS_R2` | Yes | **Missing** — R2 bucket binding not in wrangler |

---

## Gap: VPS Server

| Feature | Plan | Status | Notes |
|---|---|---|---|
| LogBuffer (10K circular) | Yes | Done | Class exists and works |
| Log push to diagnostics-cf | Yes | Done | Every 10s, batch 200, threshold 100 |
| Metrics push to diagnostics-cf | Yes | Done | Every 60s |
| Security event push | Yes | Done | Rate limits, DDoS, brute force, bad clients |
| `GET /admin/api/logs` | Yes | **Missing** | LogBuffer.query() exists but no HTTP route |
| `GET /admin/api/logs/export` | Yes | **Missing** | No HTTP route |
| LogBuffer wired to AdminRoutes | Yes | **Missing** | LogBuffer class not instantiated in routes |

---

## Gap: Security & Notifications

| Feature | Plan | Status | Notes |
|---|---|---|---|
| NotificationDO (WebSocket) | Yes | Done | Hibernation API, broadcast, storage |
| Email channel | Yes | Done | CF Email Workers, HTML, unsubscribe |
| Webhook channel | Yes | Done | Generic, Slack, Discord, retry |
| Alert rules CRUD | Yes | Done | 11 condition types, super-admin gated |
| Default alert rules (6) | Yes | Done | Auto-seeded on first run |
| Alert engine cron (5 min) | Yes | Done | |
| VPS security detectors | Yes | Done | BruteForce, DDoS, BadClient |
| Security events ingestion | Yes | Done | `POST /diagnostics/security-events` |
| Rate limit violation API | Yes | Done | Timeline, top endpoints, regions |
| Bad client API | Yes | Done | Categories, quarantine flags |
| DDoS indicators API | Yes | Done | Spike detection, anomaly flags |
| Pairing brute force API | Yes | Done | Timeline, top offenders |
| Notification settings UI | Yes | **Missing** | API exists, no dashboard tab |
| Unsubscribe HTTP endpoint | Yes | **Missing** | JWT generated but no route to handle it |

---

## New Requirement: Log Filtering & Deduplication

Not in original plan. Required before scaling log ingestion.

### Client-Side (Flutter)

1. **Message deduplication window**: Track last N unique log messages with timestamps.
   If same message repeats within configurable window (e.g., 30s), increment counter
   instead of creating new entry. When window expires or message changes, flush with
   `count` field. Exception: if gap between occurrences > window, treat as new event.

2. **Severity-based sampling**: At high log rates (>100 entries/min):
   - `error` / `critical`: Always send (100%)
   - `warn`: Send 50%
   - `info`: Send 10%
   - `debug`: Send 1% or drop entirely in production

3. **Rate cap**: Max 500 log entries per upload batch. Max 1 upload per 30 seconds.
   Drop oldest non-error entries when cap exceeded.

4. **Significance detection**: A message that hasn't appeared in >5 minutes is always
   significant, even if it appeared 1000 times before. Reset dedup counter on gap.

### Server-Side (diagnostics-cf)

1. **Ingestion dedup**: Before D1 insert, check if identical `(category, message_hash,
   server_id)` tuple exists in current time bucket. If yes, increment count.

2. **Retention-based cleanup**: Scheduled cron to purge old data across all tables:

   | Table | Retention | Notes |
   |---|---|---|
   | `server_logs` (info/debug) | 7 days | High volume, low value after initial analysis |
   | `server_logs` (warn) | 14 days | |
   | `server_logs` (error/critical) | 30 days | Keep longer for post-mortem |
   | `error_aggregates` | 90 days | Needed for trend analysis |
   | `client_heartbeats` | 24 hours | Stale sessions are useless |
   | `security_events` | 30 days | Already has partial cleanup, make it cron-based |
   | `processing_runs` | 90 days | For cost trend analysis |
   | `alert_history` | 90 days | |
   | `notifications` | 30 days | |
   | `performance_aggregates` | 90 days | |
   | `network_aggregates` | 90 days | |
   | R2 raw reports | 30 days | CF lifecycle rule + fallback cron |

3. **Global rate limit per server**: Max 1000 log entries per server per minute.
   Return 429 if exceeded.

---

## Implementation Priority

### P0 — Core log analysis (the main gap)

1. Flutter: Add log upload to `LoggerService` with dedup/sampling/rate limiting
2. `log-processor-cf`: Query `server_logs` table in addition to `error_aggregates`
3. `log-processor-cf`: Query uploaded app logs (once #1 is done)
4. `log-processor-cf`: Implement log filtering at ingestion (dedup, sampling)
5. `log-processor-cf`: Enrich GitHub issues with full context:
   a. **Labels**: Add version (primary affected), platform (primary affected), environment
   b. **Related server logs**: Query `server_logs` for `[firstSeen - 5min, lastSeen + 1min]`,
      severity >= warn, limit 20 — add as collapsible "Server Logs" section
   c. **Related app logs**: Same time-window query on app logs table (once uploaded)
   d. **Full stack traces from R2**: Fetch 2-3 raw reports via `REPORTS_BUCKET` for
      untruncated traces — add as collapsible "Full Stack Traces" section
   e. **Event timeline**: Chronological list of when error first appeared, count ramp-up,
      coinciding server events
6. `diagnostics-cf`: Scheduled cleanup cron — purge old rows from all D1 tables
   per retention policy (see table above), verify R2 lifecycle rule is active
7. `diagnostics-cf`: Track environment (production/QA) in `error_aggregates` —
   currently not captured anywhere in the pipeline. Needs `--dart-define=ENVIRONMENT`
   propagated through DiagnosticReport → aggregation → error cluster

### P1 — Missing pipeline features

8. `log-processor-cf`: Regression detection (3x spike vs 24h rolling average)
9. `log-processor-cf`: GitHub retry queue for `pending` issues
10. `log-processor-cf`: Fallback AI model (Mistral)
11. `log-processor-cf`: GitHub rate limit handling with backoff
12. Flutter: `performance_tracker.dart` (startup time, frame rate, memory)
13. Flutter: `network_tracker.dart` (signaling/WebRTC success rates, latency)

### P2 — Dashboard UI

14. Admin: Migrate to Preact SPA (current inline HTML doesn't scale)
15. Admin: Active Clients tab UI
16. Admin: Server Health tab UI (logs viewer, topology, heartbeat timeline)
17. Admin: Security tab UI (rate limits, DDoS, brute force charts)
18. Admin: AI Issues tab UI (issue table, detail view, Kanban)
19. Admin: Notifications settings tab UI
20. Admin: Error signature drill-down UI
21. Admin: AI cost monitoring display

### P3 — Loose ends

22. VPS: Wire LogBuffer into AdminRoutes (`GET /admin/api/logs`, `/logs/export`)
23. Admin: Add `DIAGNOSTICS_SERVICE` and `DIAGNOSTICS_R2` bindings
24. Admin: Unsubscribe HTTP endpoint
25. `log-processor-cf`: Set GitHub issue assignees (`['claude']` per plan)
26. Flutter: Fix report interval (10min → 5min per plan)
27. `error_aggregates`: Add `environment` column (production/qa) to schema
