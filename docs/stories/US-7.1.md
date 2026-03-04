# US-7.1: Rate Limit Violation Dashboard

## Story
As an admin, I want to see which endpoints are being rate-limited, so that I can identify abuse patterns, tune rate limit thresholds, and respond to potential attacks before they impact service quality.

## Acceptance Criteria
- Bar chart showing rate limit violations over time (configurable: 1h / 24h / 7d)
- Top-violated endpoints table ranked by violation count, showing endpoint name, violation count, unique sources, and trend direction
- Regional breakdown of violations (pie or donut chart by server region)
- Auto-refresh every 30 seconds with manual refresh button
- Time range selector to zoom into specific incident windows
- Data sourced from both VPS servers (WebSocket message rate limits, pair request rate limits, connection limits) and CF Workers (bootstrap rate limiter, admin login rate limiter)
- Dashboard requires authenticated admin session (JWT)
- Security dashboard tab and rate limit configuration require `super-admin` role

## Technical Design

### Architecture
The rate limit violation dashboard is a new view within the expanded admin portal (`packages/admin-cf/`). It aggregates security event data from two sources:

1. **VPS servers** -- push rate limit violation events to the diagnostics D1 database via the server metrics push mechanism (every 60 seconds).
2. **CF Workers** -- the bootstrap server (`packages/server/`) and admin portal (`packages/admin-cf/`) log their own rate limit violations directly to D1.

The admin portal reads from D1 via its `DIAGNOSTICS_DB` binding and serves the data through new REST endpoints. The Preact SPA renders the charts.

### Implementation Details

**VPS-side: Security event collection in MetricsCollector**

Extend `MetricsCollector` to track rate limit violations. The existing `ClientHandler` already has `checkRateLimit()` and `checkPairRequestRateLimit()` methods that return `false` when a client exceeds the limit. These are the integration points: when a rate limit check fails, emit a security event.

Add a `SecurityEventCollector` class that:
- Maintains an in-memory ring buffer of recent security events (last 10,000)
- Categorizes events by endpoint/type: `ws_message_rate`, `pair_request_rate`, `connection_per_ip`, `connection_total`, `oversized_message`
- Aggregates counts per time bucket (1-minute granularity)
- Exposes aggregated data via the server metrics push to CF diagnostics worker

**CF-side: D1 schema for security events**

Store aggregated rate limit violations in a new D1 table. Raw events stay in-memory on VPS; only aggregates are persisted.

**Admin portal: New API endpoints and dashboard tab**

Add endpoints under `/admin/api/security/` that query D1 for violation data. The Security tab renders:
- A stacked bar chart (violations over time, color-coded by violation type)
- A sortable table of top-violated endpoints
- A donut chart for regional breakdown

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/server-vps/src/admin/security-events.ts` | Create | `SecurityEventCollector` class -- ring buffer, categorization, aggregation |
| `packages/server-vps/src/admin/types.ts` | Modify | Add `SecurityEvent`, `SecurityEventAggregate`, `RateLimitViolation` types |
| `packages/server-vps/src/admin/metrics.ts` | Modify | Include security event aggregates in `MetricsSnapshot` and metrics push |
| `packages/server-vps/src/client/handler.ts` | Modify | Emit security events from `checkRateLimit()`, `checkPairRequestRateLimit()`, oversized message rejection, and per-IP/total connection limits in `index.ts` |
| `packages/server-vps/src/index.ts` | Modify | Wire `SecurityEventCollector` into connection limit checks |
| `packages/admin-cf/src/routes/security.ts` | Create | Route handlers for `/admin/api/security/rate-limits` |
| `packages/admin-cf/src/index.ts` | Modify | Register new security routes |
| `packages/admin-cf/src/types.ts` | Modify | Add `Env` bindings for `DIAGNOSTICS_DB` (D1) |
| `packages/diagnostics-cf/migrations/0001_security_events.sql` | Create | D1 migration for `rate_limit_violations` table |

### Data Models / Schemas

**D1 Table: `rate_limit_violations`**

```sql
CREATE TABLE rate_limit_violations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time_bucket TEXT NOT NULL,            -- ISO datetime truncated to minute
  server_id TEXT NOT NULL,
  server_region TEXT,
  violation_type TEXT NOT NULL,         -- 'ws_message_rate' | 'pair_request_rate' | 'connection_per_ip' | 'connection_total' | 'oversized_message' | 'bootstrap_rate' | 'admin_login_rate'
  endpoint TEXT NOT NULL,               -- '/ws' | '/pair_request' | '/connect' | '/diagnostics/report' | '/admin/api/auth/login' etc.
  count INTEGER NOT NULL DEFAULT 0,
  unique_sources INTEGER NOT NULL DEFAULT 0,  -- Distinct IPs (hashed for privacy)
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  UNIQUE(time_bucket, server_id, violation_type, endpoint)
);

CREATE INDEX idx_rlv_time ON rate_limit_violations(time_bucket);
CREATE INDEX idx_rlv_type ON rate_limit_violations(violation_type);
```

**In-memory SecurityEvent (VPS)**

```typescript
interface SecurityEvent {
  timestamp: number;
  type: 'ws_message_rate' | 'pair_request_rate' | 'connection_per_ip'
      | 'connection_total' | 'oversized_message';
  endpoint: string;
  sourceHash: string;   // SHA-256 of IP, truncated to 8 chars (privacy)
  metadata?: Record<string, unknown>;
}

interface SecurityEventAggregate {
  timeBucket: string;
  violationType: string;
  endpoint: string;
  count: number;
  uniqueSources: number;
}
```

### API Endpoints

**`GET /admin/api/security/rate-limits`**

Query parameters:
- `since` (optional): Unix timestamp -- start of time range (default: 1 hour ago)
- `until` (optional): Unix timestamp -- end of time range (default: now)
- `type` (optional): Filter by violation type
- `serverId` (optional): Filter by server ID
- `limit` (optional): Max rows (default: 500)

Response:
```json
{
  "success": true,
  "data": {
    "violations": [
      {
        "timeBucket": "2026-03-03T14:30:00Z",
        "serverId": "vps-abc123",
        "serverRegion": "us-east-1",
        "violationType": "ws_message_rate",
        "endpoint": "/ws",
        "count": 47,
        "uniqueSources": 3,
        "firstSeen": 1709474400000,
        "lastSeen": 1709474459000
      }
    ],
    "summary": {
      "totalViolations": 234,
      "topEndpoints": [
        { "endpoint": "/ws", "count": 150, "type": "ws_message_rate" },
        { "endpoint": "/pair_request", "count": 84, "type": "pair_request_rate" }
      ],
      "byRegion": {
        "us-east-1": 180,
        "eu-west-1": 54
      },
      "byType": {
        "ws_message_rate": 150,
        "pair_request_rate": 84
      }
    }
  }
}
```

Auth: Requires valid JWT (admin or super-admin role).

## Dependencies
- **US-1.1** (Diagnostics Ingestion) -- the diagnostics CF worker and D1 database must exist for storing violation aggregates
- **Epic 2 / Admin Portal Migration** -- the Preact SPA migration (tabbed dashboard) must be in progress; this story adds the Security tab
- No external package dependencies -- uses existing D1 bindings and inline SVG charts matching existing dashboard patterns

## Testing Strategy
- **Unit tests**: `SecurityEventCollector` -- test ring buffer overflow, aggregation by time bucket, source hash uniqueness counting. Test violation type categorization for each rate limit trigger point.
- **Integration tests**: VPS admin routes -- mock `MetricsCollector` with security events, verify `/admin/api/security/rate-limits` returns correct aggregates. Test D1 query filtering by time range, type, and server.
- **E2E tests**: Trigger rate limit violations (send >100 messages in 1 minute to VPS WebSocket), verify the violation appears in the security dashboard API within 60 seconds.

## Technical Notes

**Existing patterns to follow:**
- The VPS `MetricsCollector` (`packages/server-vps/src/admin/metrics.ts`) already maintains a rolling history of snapshots in memory. The `SecurityEventCollector` should follow the same pattern: in-memory ring buffer with periodic aggregation.
- Rate limiting in the VPS is already implemented in `ClientHandler.checkRateLimit()` and `checkPairRequestRateLimit()` (`packages/server-vps/src/client/handler.ts`, lines 262-313). These methods currently return a boolean. The change is minimal: when returning `false`, also call `securityEvents.record(...)`.
- The bootstrap server rate limiter (`packages/server/src/rate-limiter.js`) is a simple sliding window. Its `check()` method returns `{ allowed, remaining }`. When `allowed === false`, log the violation.
- The admin CF login rate limiter (`packages/admin-cf/src/index.ts`, lines 19-22, `isRateLimited()`) can similarly emit events.
- Connection limits are checked in `packages/server-vps/src/index.ts` lines 310-323 (per-IP and total). These close the WebSocket with code 1013; add a security event emission before the close.

**Privacy considerations:**
- Source IPs must NOT be stored in D1. Use a truncated SHA-256 hash (first 8 hex chars) for unique-source counting. This allows counting distinct sources without identifying them.
- The `unique_sources` count in D1 is pre-computed during aggregation, not derivable from stored hashes.

**Best practices from external research:**
- Rate limit dashboards should show violations, bursts, and warnings with mini trend lines. Position critical metrics (total violations, top offending endpoint) at the top of the view.
- Use a small contrasting color set (3-5 colors) for violation types. Map to existing CSS variables: `--danger` for high-severity, `--warning` for medium, `--accent` for informational.
- Auto-refresh at 30-second intervals matches the existing admin dashboard polling pattern.

## Estimation
**M (Medium)** -- The VPS-side event collection is straightforward (instrumentation of existing boolean checks). The D1 schema and admin API are standard CRUD/query patterns. The chart rendering follows existing inline SVG patterns in the VPS dashboard. Primary effort is wiring the data pipeline from VPS memory to D1 via the metrics push, plus the new admin API endpoints and Preact tab.
