# US-7.4: Pairing Code Brute Force Detection

## Story
As an admin, I want to see brute-force pairing attempts, so that I can detect attackers who are systematically guessing pairing codes, assess the risk to user sessions, and take action to protect the pairing system's integrity.

## Acceptance Criteria
- Chart showing failed pair attempts over time (line chart, configurable: 1h / 24h / 7d)
- Alert triggered when failed pair attempts exceed a configurable threshold per source within a time window (default: 20 failures per 10 minutes per source hash)
- Per-source breakdown table showing: source hash, failed attempt count, distinct target codes tried, success rate, first seen, last seen, and alert status
- Alert distinguishes between: targeted brute force (many attempts at few codes) vs. scanning brute force (attempts across many codes)
- Integration with auto-quarantine from US-7.2: sources exceeding the brute force threshold can be automatically quarantined
- Pairing code entropy health indicator: shows how brute force activity correlates with the current pairing code space utilization (from existing entropy metrics)
- Dashboard auto-refreshes every 30 seconds

## Technical Design

### Architecture
Pairing code brute force detection is a specialized security analysis built on top of the existing pairing system in `SignalingHandler`. The detection leverages existing validation and failure paths:

1. **Failed pair attempts** -- when `handlePairRequest()` receives a `targetCode` that does not have an active WebSocket (line 251 in `signaling-handler.ts`), the requester gets a generic `pair_error`. This is the primary signal for brute force detection.

2. **Invalid pairing code format** -- already tracked in US-7.2 as `invalid_pairing_code` bad client events. These are code-format guesses (not matching the 6-char alphabet).

3. **Rate-limited pair requests** -- already tracked in US-7.1 as `pair_request_rate` violations. The existing rate limit of 10 pair requests per minute per WebSocket (from `RATE_LIMIT.MAX_PAIR_REQUESTS`) is the first defense layer.

The brute force detector maintains a per-source sliding window of failed pair attempts, analyzes the pattern (targeted vs. scanning), and generates alerts when thresholds are crossed.

### Implementation Details

**VPS-side: Brute force detection in SignalingHandler**

The `SignalingHandler.handlePairRequest()` method is the key integration point. Currently, when a target code is not found, it sends a generic error to the requester (lines 249-256). This story adds:

1. Emit a `pair_attempt_failed` event to the `SecurityEventCollector` with the source hash and a hashed version of the target code
2. The `BruteForceDetector` class maintains per-source sliding windows of failed attempts
3. When a source exceeds the threshold, emit a brute force alert

**Why hash the target code?**
- We need to track how many distinct codes a source is trying (to distinguish targeted vs scanning attacks)
- But storing actual pairing codes in security logs would be a privacy/security risk (reveals active codes)
- Solution: store a HMAC of the target code using a per-hour rotating key. This allows cardinality counting (distinct targets) without revealing actual codes.

**Brute force pattern classification:**

```
failed_attempts = count of pair_attempt_failed in window
distinct_targets = count of unique target_code_hashes in window

if failed_attempts > threshold:
    target_ratio = distinct_targets / failed_attempts

    if target_ratio > 0.8:
        pattern = 'scanning'  # Trying many different codes (dictionary attack)
    elif target_ratio < 0.2:
        pattern = 'targeted'  # Hammering a few specific codes
    else:
        pattern = 'mixed'
```

**Correlation with entropy metrics:**

The existing `SignalingHandler.getEntropyMetrics()` returns `activeCodes`, `peakActiveCodes`, and `collisionRisk`. The brute force dashboard correlates this with attack activity:
- If `activeCodes` is high AND scanning attacks are detected, the effective brute force probability per attempt is higher
- Display: "Active codes: 15,000 / 32^6 space = ~0.045% chance per guess. At 10 guesses/min, expected time to hit: ~15 days"
- This helps admins assess whether the pairing code length (currently 6 characters) is sufficient given observed attack patterns

**Integration with existing rate limiting:**

The existing pair request rate limit (10 per minute per WebSocket) is the first defense layer. The brute force detector operates at a higher level, tracking failed attempts across multiple WebSocket connections from the same source (IP hash). An attacker who disconnects and reconnects gets a new rate limit window but the same source hash, so the brute force detector still catches them.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/server-vps/src/admin/brute-force-detector.ts` | Create | `BruteForceDetector` class -- per-source sliding windows, pattern classification, alert generation |
| `packages/server-vps/src/admin/security-events.ts` | Modify | Add `pair_attempt_failed` event type and brute force aggregation for D1 push |
| `packages/server-vps/src/admin/types.ts` | Modify | Add `BruteForceAlert`, `BruteForcePattern`, `PairAttemptEvent` types |
| `packages/server-vps/src/client/signaling-handler.ts` | Modify | Emit `pair_attempt_failed` event when target code not found in `handlePairRequest()` |
| `packages/server-vps/src/admin/websocket.ts` | Modify | Broadcast brute force alerts via admin WebSocket |
| `packages/admin-cf/src/routes/security.ts` | Modify | Add `/admin/api/security/brute-force` endpoint |
| `packages/diagnostics-cf/migrations/0004_brute_force.sql` | Create | D1 migration for `brute_force_events` table |

### Data Models / Schemas

**D1 Table: `brute_force_events`**

```sql
CREATE TABLE brute_force_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time_bucket TEXT NOT NULL,              -- ISO datetime truncated to minute
  server_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,              -- Truncated SHA-256 of client IP
  failed_attempts INTEGER NOT NULL,
  distinct_targets INTEGER NOT NULL,      -- Unique target code hashes attempted
  successful_pairs INTEGER NOT NULL DEFAULT 0,
  pattern TEXT NOT NULL,                  -- 'scanning' | 'targeted' | 'mixed'
  alert_triggered INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  UNIQUE(time_bucket, server_id, source_hash)
);

CREATE INDEX idx_bf_source ON brute_force_events(source_hash);
CREATE INDEX idx_bf_time ON brute_force_events(time_bucket);
CREATE INDEX idx_bf_alert ON brute_force_events(alert_triggered);
```

**D1 Table: `brute_force_alerts`**

```sql
CREATE TABLE brute_force_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  pattern TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL,
  distinct_targets INTEGER NOT NULL,
  window_minutes INTEGER NOT NULL,
  threat_assessment TEXT,                 -- JSON: entropy correlation, time-to-hit estimate
  triggered_at INTEGER NOT NULL,
  resolved_at INTEGER,
  action_taken TEXT,                      -- 'none' | 'auto_quarantined' | 'manual_quarantined'
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_bfa_time ON brute_force_alerts(triggered_at);
CREATE INDEX idx_bfa_source ON brute_force_alerts(source_hash);
```

**TypeScript types:**

```typescript
type BruteForcePattern = 'scanning' | 'targeted' | 'mixed';

interface PairAttemptEvent {
  timestamp: number;
  sourceHash: string;
  targetCodeHash: string;  // HMAC of target code (not the actual code)
  success: boolean;
  serverId: string;
}

interface BruteForceDetectorConfig {
  failureThreshold: number;         // default: 20
  windowMinutes: number;            // default: 10
  autoQuarantineEnabled: boolean;   // ties into US-7.2
}

interface BruteForceAlert {
  type: 'brute_force_alert';
  sourceHash: string;
  pattern: BruteForcePattern;
  failedAttempts: number;
  distinctTargets: number;
  successRate: number;
  windowMinutes: number;
  serverId: string;
  serverRegion: string;
  timestamp: number;
  threatAssessment: {
    activeCodes: number;
    codeSpace: number;            // 32^6 = 1,073,741,824
    hitProbabilityPerAttempt: number;
    estimatedTimeToHitMinutes: number;
    collisionRisk: 'low' | 'medium' | 'high';
  };
}

interface BruteForceSourceSummary {
  sourceHash: string;
  failedAttempts: number;
  distinctTargets: number;
  successfulPairs: number;
  successRate: number;
  pattern: BruteForcePattern;
  firstSeen: number;
  lastSeen: number;
  alertTriggered: boolean;
  isQuarantined: boolean;
}
```

### API Endpoints

**`GET /admin/api/security/brute-force`**

Query parameters:
- `since` (optional): Unix timestamp (default: 24 hours ago)
- `until` (optional): Unix timestamp (default: now)
- `sourceHash` (optional): Filter by specific source
- `pattern` (optional): Filter by attack pattern
- `alertsOnly` (optional): boolean -- show only sources that triggered alerts
- `limit` (optional): Max results (default: 100)

Response:
```json
{
  "success": true,
  "data": {
    "sources": [
      {
        "sourceHash": "e5f6g7h8",
        "failedAttempts": 87,
        "distinctTargets": 72,
        "successfulPairs": 0,
        "successRate": 0.0,
        "pattern": "scanning",
        "firstSeen": 1709470800000,
        "lastSeen": 1709474400000,
        "alertTriggered": true,
        "isQuarantined": true
      }
    ],
    "timeline": [
      {
        "timeBucket": "2026-03-03T14:30:00Z",
        "failedAttempts": 23,
        "successfulPairs": 5,
        "uniqueSources": 4
      }
    ],
    "alerts": [
      {
        "id": 1,
        "sourceHash": "e5f6g7h8",
        "pattern": "scanning",
        "failedAttempts": 87,
        "distinctTargets": 72,
        "triggeredAt": 1709474000000,
        "actionTaken": "auto_quarantined"
      }
    ],
    "entropyCorrelation": {
      "activeCodes": 15000,
      "codeSpace": 1073741824,
      "currentHitProbability": 0.0000140,
      "collisionRisk": "low"
    },
    "summary": {
      "totalFailedAttempts": 312,
      "uniqueAttackers": 8,
      "alertsTriggered": 3,
      "autoQuarantined": 2
    }
  }
}
```

Auth: Requires valid JWT (admin or super-admin role).

## Dependencies
- **US-7.1** (Rate Limit Violation Dashboard) -- `SecurityEventCollector` and D1 infrastructure
- **US-7.2** (Bad Client Detection) -- quarantine system for auto-quarantine integration
- **Existing pairing system** -- `SignalingHandler` in `packages/server-vps/src/client/signaling-handler.ts`
- No external package dependencies (HMAC uses Node.js built-in `crypto`)

## Testing Strategy
- **Unit tests**: `BruteForceDetector` -- test sliding window expiry, threshold crossing, pattern classification (scanning: high target diversity, targeted: low target diversity, mixed). Test edge cases: exactly at threshold, window rollover, same source across window boundaries. Test HMAC target code hashing produces consistent hashes within the same hour and different hashes across hours.
- **Integration tests**: Simulate a sequence of `pair_attempt_failed` events for a single source, verify alert generation at threshold. Simulate scanning pattern (many distinct targets) and targeted pattern (few targets, many attempts), verify correct classification. Test auto-quarantine integration: verify that when brute force threshold is crossed and auto-quarantine is enabled, the source is added to the quarantine KV.
- **E2E tests**: From a test client, register with a pairing code, then send 25 `pair_request` messages with non-existent target codes. Verify: (1) the first 10 are rate-limited by the existing `MAX_PAIR_REQUESTS` rate limit, (2) after reconnecting and retrying, the brute force detector aggregates all attempts, (3) the alert appears in `/admin/api/security/brute-force`.

## Technical Notes

**Existing patterns to follow:**
- The `SignalingHandler.handlePairRequest()` method (`packages/server-vps/src/client/signaling-handler.ts`, lines 221-269) is where failed pair attempts are detected. The key lines are 249-256: when `targetWs` is not found (code not registered), a generic error is sent. This is the only code path where a failed pair attempt occurs (other failures like "not registered" or "same code" are client errors, not brute force indicators).
- The existing `checkPairRequestRateLimit()` method (`packages/server-vps/src/client/handler.ts`, lines 290-313) limits to 10 pair requests per minute per WebSocket. This means a single WebSocket can attempt at most 10 codes per minute. An attacker must reconnect to get a new rate limit window, but the brute force detector tracks by IP hash across connections.
- The pairing code alphabet is defined in `PAIRING_CODE.REGEX` (`packages/server-vps/src/constants.ts`, line 53): 32 possible characters, 6 positions = 32^6 = ~1.07 billion possible codes. This is the denominator for hit probability calculations.

**Brute force math for pairing codes:**
- With 6-character codes from a 32-char alphabet: 32^6 = 1,073,741,824 possible codes
- If there are N active codes, probability of hitting one per random guess = N / 1,073,741,824
- At N=15,000 active codes: P(hit) = ~0.0014% per guess
- At 10 guesses/minute (rate limit): expected time to first hit = 1/(P * 10) minutes = ~7,143 minutes = ~5 days
- At N=100,000 active codes: expected time drops to ~18 hours
- This math should be displayed in the dashboard to give admins an intuitive sense of risk

**Distinguishing legitimate failures from brute force:**
- Legitimate pair failures happen when a user mistypes a code. These are typically: 1-2 failures followed by a success, from the same source. Pattern: low failure count, high success rate.
- Brute force: many failures, zero or near-zero successes, from the same source. Pattern: high failure count, 0% success rate.
- The detector should track success rate per source to avoid alerting on legitimate users who make occasional typos.

**HMAC key rotation for target code hashing:**
- Use the server's identity key seed as the HMAC key base, combined with an hourly timestamp component
- Key = HMAC-SHA256(server_identity_seed, floor(timestamp / 3600000))
- This means target code hashes change every hour, preventing long-term correlation while allowing within-window cardinality counting

**Privacy considerations:**
- Actual pairing codes are NEVER stored in security event logs or D1
- Target codes are HMAC-hashed with hourly rotation before any logging
- Source IPs are SHA-256 hashed and truncated (same as US-7.1 and US-7.2)
- The `successfulPairs` count comes from tracking that the same source hash later appears in a `pair_matched` event, not from logging which codes were matched

## Estimation
**M (Medium)** -- The core brute force detector is a focused class with a clear algorithm. The primary integration point is a single method in `SignalingHandler`. The pattern classification logic is straightforward (ratio-based). The main complexity is in the HMAC target code hashing and the entropy correlation math, both of which are self-contained computations. The D1 schema and admin API follow the same patterns established in US-7.1 and US-7.2.
