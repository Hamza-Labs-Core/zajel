# Plan 10: Diagnostics and Admin Portal — Comprehensive Architecture

## 1. Executive Summary

This plan expands the existing Zajel admin portal (`packages/admin-cf/`) and VPS admin dashboard (`packages/server-vps/src/admin/`) into a full-featured observability, diagnostics, and AI-powered issue management system. The system spans five new or expanded modules:

1. **Diagnostics Ingestion Worker** (`packages/diagnostics-cf/`) — CF Worker for receiving anonymous client diagnostics
2. **Log Processor Worker** (`packages/log-processor-cf/`) — CF Worker with Workers AI for pattern analysis and GitHub issue creation
3. **Admin Portal expansion** (`packages/admin-cf/`) — New dashboards for errors, metrics, active clients, security monitoring
4. **VPS Admin expansion** (`packages/server-vps/src/admin/`) — Server-side log collection, metrics export, notification hooks
5. **Flutter Diagnostics SDK** (`packages/app/lib/core/diagnostics/`) — Anonymous client-side telemetry collection and upload

---

## 2. Current Architecture Analysis

### What Exists Today

**Admin Portal (CF Worker — `packages/admin-cf/`):**
- JWT auth with Durable Object storage (`AdminUsersDO`)
- Two tabs: Servers (grid with aggregate stats) and Users (CRUD)
- Fetches server list via Service Binding to bootstrap worker (`BOOTSTRAP_SERVICE`)
- Inline HTML dashboard (no Vite build; raw template literals in `serveDashboard()`)
- Preact listed as dependency but not used in the current inline dashboard

**VPS Admin (`packages/server-vps/src/admin/`):**
- `MetricsCollector` — takes real-time snapshots (connections, entropy, federation, message rate)
- `AdminWebSocketHandler` — broadcasts metrics every 1s to connected admin clients
- `AdminRoutes` — REST API for `/admin/api/metrics`, `/admin/api/metrics/history`, `/admin/api/federation`, `/admin/api/scaling`
- Inline HTML dashboard with SVG charts (connections over time, entropy gauge, federation graph)
- Shared JWT auth with CF Worker (same `ZAJEL_ADMIN_JWT_SECRET`)

**App Logging (`packages/app/lib/core/logging/logger_service.dart`):**
- File-based logging with rotation (7-day retention, 5MB max per file)
- `LogEntry` with timestamp, level, tag, message
- Export via share sheet (mobile) or directory copy (desktop)
- No upload/reporting mechanism — logs stay local

**Bootstrap Server (`packages/server/`):**
- Rate limiting (`RateLimiter` — in-memory sliding window)
- Server registry via Durable Objects (`ServerRegistryDO`)
- Attestation registry (`AttestationRegistryDO`)
- No R2, D1, or KV bindings currently

### Gaps Identified
- No centralized error tracking or telemetry from clients
- No AI-based log analysis
- No GitHub integration for automated issue creation
- No security monitoring dashboards (rate limit violations, bad clients)
- No notification system
- No server-side log aggregation across VPS nodes
- VPS metrics history is in-memory only (lost on restart)
- Admin portal has only 2 tabs, no drill-down capability

---

## 3. System Architecture Overview

### Data Flow

```
Flutter App --> [diagnostics-cf Worker] --> R2 (raw logs)
                                        --> D1 (aggregated metrics)
                                        --> KV (active client counters)

VPS Server --> [admin-cf Worker] --> D1 (server metrics, logs)
                                  --> KV (server health cache)

[log-processor-cf Worker] <-- Cron Trigger (every 15 min)
                          --> reads R2 (raw logs)
                          --> reads D1 (error patterns)
                          --> Workers AI (analysis)
                          --> GitHub API (issue creation)
                          --> D1 (issue tracking)

[admin-cf Worker] --> reads D1, KV, R2
                   --> WebSocket (real-time to dashboard)
                   --> Notification channels (email, webhook)
```

### New CF Worker Services

| Service | Package | Purpose | Bindings |
|---------|---------|---------|----------|
| `zajel-diagnostics` | `packages/diagnostics-cf/` | Ingestion of client telemetry | D1, R2, KV |
| `zajel-log-processor` | `packages/log-processor-cf/` | AI analysis + GitHub issues | D1, R2, AI, Service Binding to diagnostics |
| `zajel-admin` (expanded) | `packages/admin-cf/` | Dashboard + notifications | D1, R2, KV, Service Bindings to diagnostics + bootstrap |

### Storage Strategy

| Store | Purpose | Why This Store |
|-------|---------|----------------|
| **D1** (SQLite) | Aggregated metrics, error signatures, issue tracking, server logs, notification config | Relational queries needed: GROUP BY time buckets, JOIN error signatures with versions, WHERE severity filtering |
| **R2** (Object Storage) | Raw diagnostic reports, log file archives | Large blobs (up to 5MB per log bundle), cheap storage, no query needed on raw data |
| **KV** | Active client counters, server health cache, rate limit state for bad clients, notification thresholds | Low-latency reads, TTL-based expiry for counters, eventually consistent is fine for counters |
| **Durable Objects** | `AdminUsersDO` (existing), `NotificationDO` (new — manages WebSocket connections for admin real-time push) | WebSocket hibernation API, consistent state for connected admin sessions |

---

## 4. Detailed Component Design

### 4.1 Diagnostics Ingestion Worker (`packages/diagnostics-cf/`)

**Responsibilities:**
- Accept anonymous diagnostic reports from Flutter apps
- Validate, scrub, and store reports
- Update aggregated counters
- Rate limit submissions per client fingerprint (anonymous hash)

**API Endpoints:**

```
POST /diagnostics/report     -- Submit a diagnostic report
POST /diagnostics/heartbeat  -- Client heartbeat (for active client counting)
GET  /diagnostics/health     -- Health check
```

**Diagnostic Report Schema:**

```typescript
interface DiagnosticReport {
  // Anonymous session fingerprint (SHA-256 of random session ID — NOT device ID)
  sessionHash: string;

  // App metadata (no user-identifying info)
  appVersion: string;
  buildNumber: string;
  platform: 'android' | 'ios' | 'windows' | 'macos' | 'linux' | 'web';
  platformVersion: string;  // e.g., "Android 14", "iOS 17.2"
  locale: string;           // e.g., "en-US" (for l10n bug correlation only)

  // Timing
  timestamp: number;        // Unix ms

  // Error reports (if any)
  errors?: DiagnosticError[];

  // Performance metrics (optional)
  performance?: PerformanceMetrics;

  // Network metrics (optional)
  network?: NetworkMetrics;

  // Connection type at report time
  connectionType?: 'direct_p2p' | 'relay' | 'none';
}

interface DiagnosticError {
  category: 'crash' | 'network' | 'crypto' | 'storage' | 'ui' | 'protocol' | 'other';
  message: string;          // Error message (scrubbed of any user data)
  stackTrace?: string;      // Stack trace (scrubbed — file paths only, no data)
  signature: string;        // SHA-256 hash of (category + top 3 stack frames)
  count: number;            // Number of occurrences in this session
  firstOccurrence: number;  // Timestamp
  lastOccurrence: number;   // Timestamp
}

interface PerformanceMetrics {
  startupTimeMs?: number;
  frameRateAvg?: number;
  frameRateP95?: number;
  memoryUsageMb?: number;
  memoryPeakMb?: number;
}

interface NetworkMetrics {
  signalingConnectSuccessRate?: number;  // 0.0-1.0
  signalingConnectAttempts?: number;
  webrtcEstablishSuccessRate?: number;
  webrtcEstablishAttempts?: number;
  relayUsageRate?: number;              // fraction of connections using relay
  avgLatencyMs?: number;
}
```

**D1 Tables (diagnostics DB):**

```sql
-- Aggregated error counts per time bucket
CREATE TABLE error_aggregates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time_bucket TEXT NOT NULL,          -- ISO datetime truncated to hour
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

-- Active client heartbeats (anonymous)
CREATE TABLE client_heartbeats (
  session_hash TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  connection_type TEXT,
  region TEXT,                         -- Server region, NOT user location
  last_seen INTEGER NOT NULL,
  session_start INTEGER NOT NULL
);

-- Performance metrics per time bucket
CREATE TABLE performance_aggregates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time_bucket TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  metric_name TEXT NOT NULL,          -- 'startup_time', 'frame_rate', 'memory'
  p50 REAL,
  p95 REAL,
  p99 REAL,
  sample_count INTEGER NOT NULL,
  UNIQUE(time_bucket, platform, app_version, metric_name)
);

-- Network metrics per time bucket
CREATE TABLE network_aggregates (
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
```

**R2 Storage Pattern:**

Raw diagnostic reports stored as:
```
diagnostics/{YYYY}/{MM}/{DD}/{HH}/{session_hash}_{timestamp}.json
```

R2 lifecycle rules auto-delete after 30 days.

**Privacy Guardrails:**
- No IP logging (CF Worker strips `CF-Connecting-IP` from stored data, uses only for rate limiting)
- `sessionHash` is a SHA-256 of a random UUID generated per app session — not persistent across restarts
- Stack traces are scrubbed client-side before submission (file paths only, no variable values)
- Region is derived from server region (where the client connects), not from IP geolocation
- No device ID, user ID, or any persistent identifier is ever transmitted

**Rate Limiting:**
- 10 reports per session per hour (prevents abuse)
- 1 heartbeat per session per 5 minutes
- Global: 10,000 reports per hour (prevents DDoS on R2)

### 4.2 Log Processor Worker (`packages/log-processor-cf/`)

**Trigger:** Cron trigger every 15 minutes (configured in `wrangler.jsonc`).

**Workers AI Model:** `@cf/meta/llama-3.1-8b-instruct`
- 8B parameters sufficient for pattern matching and summarization
- Fast inference (<2s for typical prompts)
- Low cost ($0.011 per 1K input tokens, free tier: 10,000 neurons/day)
- Fallback: `@cf/mistral/mistral-7b-instruct-v0.1`

**Processing Pipeline:**

```
1. Query D1: SELECT error_signature, count, category, app_version,
   sample_message, sample_stack_trace
   FROM error_aggregates
   WHERE time_bucket > {last_run_time}
   GROUP BY error_signature
   HAVING SUM(count) >= threshold

2. For each significant error cluster:
   a. Check D1 issue_tracking: Has this signature been reported?
   b. If new signature OR significant spike over baseline:
      - Fetch 3-5 sample reports from R2 for context
      - Construct AI prompt
      - Call Workers AI for analysis
      - Parse structured output
      - Check GitHub for duplicate issues
      - Create GitHub issue if warranted
      - Record in D1 issue_tracking

3. Regression detection:
   - Compare current hour error rates vs. 24h rolling average
   - Flag if rate > 3x average for any signature
   - Flag if new signature appears only in latest version
```

**AI Prompt Template:**

```
You are a software engineer analyzing crash reports for a P2P encrypted
messaging app called Zajel. The app uses Flutter, WebRTC,
X25519+ChaCha20-Poly1305 encryption, and connects to VPS relay servers.

Analyze these error reports and provide a structured analysis:

Error Signature: {signature}
Category: {category}
Total Occurrences: {total_count} in last {time_window}
Affected Versions: {versions}
Affected Platforms: {platforms}

Sample Error Messages:
{sample_messages}

Sample Stack Traces:
{sample_stack_traces}

Provide your analysis in this exact JSON format:
{
  "title": "Brief issue title (max 80 chars)",
  "severity": "critical|high|medium|low",
  "component": "crypto|network|ui|storage|protocol|signaling|relay|webrtc|other",
  "description": "2-3 paragraph description of the likely root cause",
  "reproduction_hints": "How a developer might reproduce this",
  "suggested_fix": "Brief suggestion for fixing",
  "is_regression": true|false,
  "affected_users_estimate": "few|some|many|most"
}
```

**Token Budget per Analysis:**
- Input: ~500-800 tokens (prompt + samples)
- Output: ~200-300 tokens (structured JSON)
- Total per error cluster: ~1,000 tokens
- At 15-min intervals with max 20 clusters per run: ~20,000 tokens/hour
- Daily cost estimate: <$5 at current Workers AI pricing

**GitHub Issue Creation:**

```typescript
interface GitHubIssuePayload {
  title: string;                        // From AI analysis
  body: string;                         // Markdown with analysis + log excerpts
  labels: string[];                     // ['ai-detected', severity, component]
  assignees: string[];                  // ['claude'] — Claude as auto-assignee
}
```

Issue body template:
```markdown
## AI-Detected Issue

**Severity:** {severity}
**Component:** {component}
**Detection Time:** {timestamp}
**Error Signature:** `{signature}`

## Analysis

{ai_description}

## Affected Scope

- **Versions:** {versions}
- **Platforms:** {platforms}
- **Estimated Impact:** {affected_users_estimate}
- **Occurrences:** {count} in last {window}

## Reproduction Hints

{ai_reproduction_hints}

## Suggested Fix

{ai_suggested_fix}

## Scrubbed Log Excerpts

<details>
<summary>Sample Error Messages ({n} samples)</summary>

{scrubbed_samples}

</details>

---
*This issue was automatically created by the Zajel AI log analyzer.*
*Error signature: `{signature}`*
```

**Deduplication:**
- Search existing open issues by error signature before creating
- If match found: add a comment with updated counts
- If match found but closed: reopen if error count exceeds threshold
- Cap at 10 issues per cron run

**Fallback Behavior:**
- Workers AI unavailable: skip AI analysis, still record error clusters in D1
- GitHub API down: queue issue creation in D1, retry on next cron run
- GitHub rate limit hit: backoff and retry

**D1 Tables (shared with diagnostics):**

```sql
-- Issue tracking
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

-- Processing run history
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

### 4.3 Admin Portal Dashboard Expansion (`packages/admin-cf/`)

**Architecture Decision: Move from inline HTML to Preact SPA**

The current dashboard is ~900 lines of inline HTML. The expanded dashboards need multiple views, routing, charts, and real-time data binding. Preact is already in `package.json`.

**New Tab Structure:**

```
Servers        (existing, enhanced)
Users          (existing)
Errors         (NEW)
Metrics        (NEW)
Active Clients (NEW)
Server Health  (NEW)
Security       (NEW)
AI Issues      (NEW)
Notifications  (NEW — settings)
```

**New API Endpoints:**

```
// Error Dashboard
GET  /admin/api/errors                    -- Error aggregates with filtering
GET  /admin/api/errors/:signature         -- Error detail by signature
GET  /admin/api/errors/trends             -- Error trends over time
GET  /admin/api/errors/regressions        -- Regression alerts

// Metrics Dashboard
GET  /admin/api/metrics/app               -- App performance metrics
GET  /admin/api/metrics/network           -- Network metrics
GET  /admin/api/metrics/server            -- Server metrics (proxied from VPS)

// Active Clients
GET  /admin/api/clients/active            -- Active client counts
GET  /admin/api/clients/platforms         -- Platform breakdown
GET  /admin/api/clients/versions          -- Version adoption
GET  /admin/api/clients/connections       -- Connection type distribution

// Security
GET  /admin/api/security/rate-limits      -- Rate limit violations
GET  /admin/api/security/bad-clients      -- Bad client reports
GET  /admin/api/security/attacks          -- Attack detection events

// AI Issues
GET  /admin/api/issues                    -- AI-detected issues
GET  /admin/api/issues/:id               -- Issue detail
POST /admin/api/issues/:id/acknowledge   -- Mark issue as acknowledged

// Server Logs
GET  /admin/api/logs/server/:serverId    -- Server logs (proxied from VPS)

// Notifications
GET  /admin/api/notifications/config     -- Notification configuration
POST /admin/api/notifications/config     -- Update notification settings
GET  /admin/api/notifications/history    -- Notification history
```

**Service Bindings (updated wrangler.jsonc):**

```jsonc
{
  "services": [
    { "binding": "BOOTSTRAP_SERVICE", "service": "zajel-signaling" },
    { "binding": "DIAGNOSTICS_SERVICE", "service": "zajel-diagnostics" }
  ],
  "d1_databases": [
    { "binding": "DIAGNOSTICS_DB", "database_name": "zajel-diagnostics" }
  ],
  "r2_buckets": [
    { "binding": "DIAGNOSTICS_R2", "bucket_name": "zajel-diagnostics" }
  ],
  "kv_namespaces": [
    { "binding": "ADMIN_KV", "id": "<to-be-created>" }
  ]
}
```

**Dashboard Design Per Tab:**

**Error Dashboard:**
- Top: Summary cards — Total errors (24h), Error rate change, Regression alerts, Top severity
- Chart: Error rate over time (stacked area by category)
- Table: Top error signatures sorted by count
- Click signature for drill-down: Full message, scrubbed stack trace, version/platform distribution
- Regression banner: Auto-detected regressions with version comparison

**Metrics Dashboard:**
- App Performance: Startup time histogram (p50/p95/p99), frame rate distribution, memory usage
- Network: Signaling connect success rate (gauge), WebRTC establishment rate, relay vs. direct P2P pie, latency percentiles
- Server Metrics: Per-server cards with CPU, memory, connections
- Federation: Gossip health gauge, node availability, sync latency

**Active Clients Dashboard:**
- Total active count (big number with 24h sparkline)
- Platform breakdown: Donut chart
- Version adoption: Stacked area chart
- Connection type: Bar chart (direct P2P vs. relay)
- Session duration: Histogram

**Server Health Dashboard:**
- Server status grid: Color-coded cards (green/yellow/red)
- Server logs viewer: Severity filter, time range, keyword search, auto-refresh
- Federation topology: Interactive graph
- Heartbeat freshness: Timeline showing gaps per server

**Security Dashboard:**
- Rate limit violations: Bar chart + top-violated endpoints
- Bad client tracking: Table of anomalous behaviors
- Attack indicators: DDoS, federation attacks, brute force
- Rate limit configuration: Editable form (super-admin only)

**AI Issues Dashboard:**
- Table: Title, Severity, Component, Status, Created, GitHub link
- Detail view: Full AI analysis, affected versions, log excerpts
- Time-to-detection metric
- Issue lifecycle: Kanban columns (Detected -> Assigned -> In Progress -> Resolved)

### 4.4 VPS Server Log Collection & Export

**New Endpoints:**

```
GET /admin/api/logs?severity=error&since=1709380800&limit=200&keyword=crypto
GET /admin/api/logs/export?since=1709380800&until=1709384400
```

**Implementation:** A `LogBuffer` captures structured log entries in a circular buffer (last 10,000 entries in memory), queryable via the admin API.

```typescript
interface ServerLogEntry {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  module: string;      // 'Federation', 'Client', 'Relay', 'Admin', etc.
  message: string;
  metadata?: Record<string, unknown>;
}
```

**Server Metrics Push** (every 60 seconds to diagnostics worker):

```typescript
interface ServerMetricsPush {
  serverId: string;
  region: string;
  timestamp: number;
  metrics: {
    connections: { total: number; relay: number; signaling: number };
    entropy: { activeCodes: number; collisionRisk: string };
    federation: { aliveMembers: number; totalMembers: number };
    messageRate: { perSecond: number; perMinute: number };
    system: {
      cpuPercent: number;
      memoryMb: number;
      uptimeSeconds: number;
    };
  };
}
```

### 4.5 Flutter Diagnostics SDK (`packages/app/lib/core/diagnostics/`)

**New Files:**

```
diagnostics/
  diagnostics_service.dart       -- Main service (collection, scrubbing, upload)
  diagnostics_models.dart        -- Report and metric data classes
  error_tracker.dart             -- Catches and categorizes errors
  performance_tracker.dart       -- Startup time, frame rate, memory
  network_tracker.dart           -- Signaling/WebRTC success rates
  scrubber.dart                  -- Privacy scrubbing for stack traces and messages
```

**Integration Points:**
- `error_tracker.dart` wraps `FlutterError.onError` and `PlatformDispatcher.instance.onError`
- `network_tracker.dart` listens to `SignalingClient` and `WebRTCService` events
- `performance_tracker.dart` uses `SchedulerBinding.instance.addTimingsCallback` for frame timing
- `diagnostics_service.dart` batches and sends via HTTPS POST every 5 minutes

**Opt-In Model:**
- Default ON for QA, OFF for production until user enables
- Setting stored in shared preferences, exposed in Settings UI
- When disabled, no data leaves the device

**Privacy Scrubber:**
```dart
class DiagnosticsScrubber {
  static String scrubStackTrace(String trace) { ... }
  static String scrubErrorMessage(String message) { ... }
}
```

### 4.6 Notification System

**`NotificationDO` Durable Object** in `packages/admin-cf/`:
1. Maintains WebSocket connections to admin dashboard clients (real-time push)
2. Evaluates alert rules against incoming metric data
3. Dispatches to configured channels

**Notification Channels:**

| Channel | Mechanism | Configuration |
|---------|-----------|---------------|
| Dashboard (real-time) | WebSocket via NotificationDO | Always on for connected admins |
| Email | CF Email Workers or external API | SMTP config in Worker secrets |
| Webhook | HTTP POST to configured URL | URL + optional auth header |

**Alert Rules (D1):**

```sql
CREATE TABLE alert_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  condition_type TEXT NOT NULL,
  threshold_value REAL,
  threshold_unit TEXT,
  severity TEXT NOT NULL,
  channels TEXT NOT NULL,             -- JSON array
  enabled INTEGER NOT NULL DEFAULT 1,
  cooldown_minutes INTEGER DEFAULT 60,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_triggered_at INTEGER
);

CREATE TABLE alert_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER NOT NULL,
  triggered_at INTEGER NOT NULL,
  message TEXT NOT NULL,
  channels_notified TEXT NOT NULL,
  acknowledged_at INTEGER,
  acknowledged_by TEXT,
  FOREIGN KEY (rule_id) REFERENCES alert_rules(id)
);
```

**Default Alert Rules:**

1. Error rate > 100/hour for any category -> warning
2. New critical crash signature detected -> critical
3. Server offline for > 5 minutes -> critical
4. Rate limit violations > 1000/hour -> warning
5. AI creates new GitHub issue -> info
6. Error rate spike > 3x 24h average -> warning

---

## 5. User Stories

### Epic 1: Diagnostics Ingestion

**US-1.1: Anonymous Diagnostic Report Submission**
As a Zajel app, I want to submit anonymous diagnostic reports to a central collection endpoint, so that the development team can understand error patterns without compromising user privacy.
- Acceptance: POST to `/diagnostics/report` with valid schema returns 200; no user-identifying data is stored; invalid schemas return 400; rate limiting prevents abuse.

**US-1.2: Client Heartbeat for Active Counting**
As a Zajel app, I want to periodically send an anonymous heartbeat, so that the admin portal can show accurate active client counts.
- Acceptance: POST to `/diagnostics/heartbeat` with sessionHash, platform, version, and connectionType; expired heartbeats (>10 min) are excluded from active counts.

**US-1.3: Diagnostics Opt-In Setting**
As a Zajel user, I want to opt in/out of diagnostics collection in the app settings, so that I control whether my app sends telemetry.
- Acceptance: Toggle in settings; default OFF in production, ON in QA; when OFF, no HTTP requests are made.

**US-1.4: Error Categorization and Signature**
As a Zajel app, I want errors automatically categorized and assigned a stable signature, so that duplicate errors are correctly grouped.
- Acceptance: Signature is SHA-256 of category + top 3 meaningful stack frames; two identical crashes produce the same signature.

**US-1.5: Privacy Scrubbing**
As a Zajel user, I want all diagnostic data scrubbed of personal information before it leaves my device, so that my privacy is protected.
- Acceptance: Stack traces contain only file paths and line numbers; no IP addresses, pairing codes, keys, or peer IDs in transmitted data; automated tests verify scrubbing.

### Epic 2: Error Dashboard

**US-2.1: Error Rate Overview**
As an admin, I want to see real-time error rates broken down by category, so that I can quickly identify unusual failures.
- Acceptance: Dashboard shows error count per category for last 1h/24h/7d; auto-refreshes every 30 seconds.

**US-2.2: Error Trends Visualization**
As an admin, I want to see error trends over time, so that I can identify patterns and correlate with deployments.
- Acceptance: Stacked area chart with configurable time range; deployment markers shown on timeline.

**US-2.3: Error Signature Drill-Down**
As an admin, I want to click an error signature and see full details, so that I can investigate specific issues.
- Acceptance: Detail view shows sample messages, stack traces, version distribution, platform distribution, and occurrence timeline.

**US-2.4: Regression Detection**
As an admin, I want automatic flagging when error rates spike after a new version release.
- Acceptance: Banner alert when error count in latest version is >3x the rate in previous version.

### Epic 3: Metrics Dashboard

**US-3.1: App Performance Metrics**
As an admin, I want to see app startup time percentiles, frame rates, and memory usage.
- Acceptance: Line charts with p50/p95/p99; filterable by platform and version; 7-day history.

**US-3.2: Network Success Rates**
As an admin, I want to see signaling and WebRTC establishment success rates.
- Acceptance: Gauge charts showing current rates; trend lines over time; breakdown by platform.

**US-3.3: Server Metrics Overview**
As an admin, I want to see CPU, memory, connection count, and throughput for each VPS server.
- Acceptance: Per-server metric cards with current values; historical charts on click.

**US-3.4: Federation Health Metrics**
As an admin, I want to see gossip health, node availability, and sync latency.
- Acceptance: Node count and status; gossip round-trip latency; sync completeness indicator.

### Epic 4: Active Clients Dashboard

**US-4.1: Anonymous Active Client Count**
As an admin, I want to see total active clients without identifying individuals.
- Acceptance: Single number with 24h sparkline; based on heartbeat freshness (last 10 min).

**US-4.2: Platform Breakdown**
As an admin, I want to see active clients per platform.
- Acceptance: Donut chart with exact counts; refreshed every 30 seconds.

**US-4.3: Version Adoption Curve**
As an admin, I want to see app version distribution over time.
- Acceptance: Stacked area chart; time range selector.

**US-4.4: Connection Type Distribution**
As an admin, I want to see direct P2P vs. relay usage.
- Acceptance: Pie chart with counts; trend line over time.

### Epic 5: Server Health Dashboard

**US-5.1: Per-Server Status**
As an admin, I want to see each VPS server's health status at a glance.
- Acceptance: Color-coded card grid; click opens VPS dashboard.

**US-5.2: Server Logs Viewer**
As an admin, I want to view server logs with filtering from the central dashboard.
- Acceptance: Severity dropdown, time range picker, keyword search, auto-refresh.

**US-5.3: Federation Topology**
As an admin, I want to see the federation network graph.
- Acceptance: Graph with nodes colored by status; edges between connected servers.

**US-5.4: Heartbeat Freshness Timeline**
As an admin, I want to see heartbeat gaps for each server.
- Acceptance: Timeline per server; gaps highlighted in red.

### Epic 6: AI-Powered Log Analysis

**US-6.1: Automated Error Pattern Analysis**
As a development team, I want the system to automatically analyze error patterns using AI.
- Acceptance: AI runs every 15 minutes; generates structured analysis for error clusters above threshold.

**US-6.2: Automated GitHub Issue Creation**
As a development team, I want the AI to automatically create GitHub issues for significant error patterns.
- Acceptance: Issue created with AI-generated title, description, severity/component labels, "ai-detected" label; Claude assigned; no duplicates.

**US-6.3: Issue Lifecycle Dashboard**
As an admin, I want to track AI-created issues from detection to resolution.
- Acceptance: Table with status, assignee, PR link; time-to-detection and time-to-fix metrics.

**US-6.4: Deduplication**
As a development team, I want the AI to avoid creating duplicate issues.
- Acceptance: Existing open issues searched by signature; if found, comment added; if closed and re-occurring, issue reopened.

**US-6.5: Cost Monitoring**
As an admin, I want to see AI tokens and GitHub API usage.
- Acceptance: Processing run history; daily/weekly totals displayed.

### Epic 7: Security Monitoring

**US-7.1: Rate Limit Violation Dashboard**
As an admin, I want to see which endpoints are being rate-limited.
- Acceptance: Bar chart over time; top-violated endpoints; regional breakdown.

**US-7.2: Bad Client Detection**
As an admin, I want to see clients that send malformed messages or fail signature verification.
- Acceptance: Table of anomalous behaviors; violation counts; auto-quarantine toggle.

**US-7.3: DDoS Indicators**
As an admin, I want alerts when sudden connection spikes are detected.
- Acceptance: Connection rate chart with anomaly highlighting; auto-alert at 5x normal.

**US-7.4: Pairing Code Brute Force Detection**
As an admin, I want to see brute-force pairing attempts.
- Acceptance: Failed pair attempt chart; alert when exceeds threshold per session.

### Epic 8: Notifications

**US-8.1: Real-Time Dashboard Notifications**
As an admin, I want real-time alerts via WebSocket.
- Acceptance: Toast notifications; alert sound for critical; notification bell with unread count.

**US-8.2: Email Notifications**
As an admin, I want email alerts for critical events.
- Acceptance: Configurable addresses; severity filter; cooldown; unsubscribe link.

**US-8.3: Webhook Notifications**
As an admin, I want webhook URLs for Slack/Discord integration.
- Acceptance: Configurable URL with auth header; alert payload includes severity, message, dashboard link.

**US-8.4: Alert Rule Management**
As a super-admin, I want to create, edit, and delete alert rules.
- Acceptance: CRUD UI; condition types include error rate, server offline, attack detected, AI issue; cooldown period.

### Epic 9: Server Logs Integration

**US-9.1: Centralized Log Viewer**
As an admin, I want to view logs from any VPS through the central dashboard.
- Acceptance: Server selector; severity filter; time range; keyword search; pagination.

**US-9.2: Log-Diagnostic Correlation**
As an admin, I want to see server-side logs and client diagnostics for the same time window side by side.
- Acceptance: Time-range correlation view; synchronized scrolling.

---

## 6. Scaling Considerations

### Cost Estimates (Monthly)

| Users | R2 Storage | D1 | Workers AI | KV | Total |
|-------|------------|-----|------------|-----|-------|
| 100 | Free | Free | Free | Free | $0 |
| 10,000 | ~$1 | Free | ~$5 | Free | ~$6 |
| 100,000 | ~$3 | ~$5 | ~$50 | ~$1 | ~$59 |

### Scaling Notes
- **100 users:** All free tiers sufficient
- **10,000 users:** ~120K reports/day, ~600MB/day R2, D1 well within limits
- **100,000 users:** ~1.2M reports/day, ~6GB/day R2; consider sampling (10%), D1 sharding by time range, reduced AI frequency

---

## 7. Security Considerations

- All existing JWT auth preserved; new dashboards require authenticated admin session
- Security dashboard and alert rule management require `super-admin` role
- Diagnostics endpoint is unauthenticated (clients submit without login); protected via rate limiting, schema validation, size limits
- No PII ever stored; session hashes are ephemeral; R2 encrypted at rest
- AI prompts never include user-identifying data
- GitHub token scoped to minimum permissions (`issues:write`, `repo:read`)
- Prompt injection mitigation: input data placed in structured fields, not mixed with instructions

---

## 8. Implementation Phases

### Phase 1: Foundation (2-3 weeks)
1. Create `packages/diagnostics-cf/` Worker with R2 + D1 bindings
2. Implement diagnostic report ingestion with validation and scrubbing
3. Implement client heartbeat endpoint
4. Create D1 schema and aggregation logic
5. Build Flutter `DiagnosticsService` with error tracking and privacy scrubber
6. Add diagnostics opt-in toggle to app settings

### Phase 2: Admin Dashboard Core (2-3 weeks)
1. Migrate admin-cf from inline HTML to Preact SPA
2. Implement tab routing for new sections
3. Build Error Dashboard with D1-backed API
4. Build Active Clients Dashboard
5. Add D1/R2/KV bindings to admin-cf wrangler.jsonc
6. Add Service Binding from admin-cf to diagnostics-cf

### Phase 3: Server Integration (1-2 weeks)
1. Add `LogBuffer` to VPS server for structured log capture
2. Implement `/admin/api/logs` endpoint on VPS
3. Implement server metrics push to diagnostics-cf
4. Build Server Health Dashboard and Server Logs Viewer tabs
5. Build Metrics Dashboard (app + server + network)

### Phase 4: AI Pipeline (2-3 weeks)
1. Create `packages/log-processor-cf/` Worker with AI binding
2. Implement error cluster analysis with Workers AI
3. Implement GitHub API integration for issue creation
4. Implement deduplication and issue lifecycle management
5. Build AI Issues Dashboard tab
6. Configure cron trigger

### Phase 5: Security & Notifications (1-2 weeks)
1. Add security event collection to VPS admin metrics
2. Build Security Dashboard
3. Implement `NotificationDO` for real-time admin push
4. Build alert rule engine and notification dispatching
5. Add email and webhook channels
6. Build Notifications settings tab

### Phase 6: Polish & Testing (1-2 weeks)
1. End-to-end testing of full pipeline
2. Load testing diagnostics ingestion
3. Dashboard UX polish and responsive design
4. Documentation and runbook
5. Cost monitoring dashboard

---

## 9. Reliability & Graceful Degradation

| Failure Scenario | Behavior |
|-----------------|----------|
| Workers AI unavailable | Log processor records clusters raw; skips AI; retries next cycle |
| GitHub API down | Issue creation queued in D1; retried next cron run |
| GitHub rate limit | Backoff; cap at 10 issues per run; alert admin |
| R2 write failure | Report still aggregated in D1; raw report lost |
| D1 write failure | Report dropped; Worker returns 503; client retries |
| VPS unreachable | Dashboard shows "offline"; logs unavailable for that server |
| Diagnostics Worker down | Flutter client silently drops reports (fire-and-forget) |
| Admin WebSocket disconnected | Dashboard falls back to polling every 30 seconds |

---

## 10. Key Technical Decisions

1. **D1 over DOs for analytics:** D1 supports SQL aggregation (GROUP BY, percentiles) essential for dashboards
2. **R2 for raw logs:** Reports can be 1-10KB each; millions of them would be expensive in D1
3. **KV for counters:** Sub-millisecond reads and TTL expiry for high-frequency operations
4. **Preact over raw HTML:** Current inline approach doesn't scale to 9+ tabs with charts
5. **Workers AI over external APIs:** Keeps data within CF infrastructure; predictable pricing
6. **Cron over event-driven:** Batches work efficiently; prevents cost overruns from spikes
7. **Session hash, not device ID:** Random UUID per app launch, hashed; no persistent tracking
