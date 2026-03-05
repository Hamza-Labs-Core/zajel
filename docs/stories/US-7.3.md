# US-7.3: DDoS Indicators

## Story
As an admin, I want alerts when sudden connection spikes are detected, so that I can identify potential DDoS attacks early, assess their scope, and take mitigating action before they degrade service for legitimate users.

## Acceptance Criteria
- Connection rate chart showing connections per second over time with anomaly highlighting (shaded regions where rate exceeds threshold)
- Auto-alert triggered when connection rate exceeds 5x the rolling 5-minute average (baseline)
- Alert displayed as a dashboard toast notification and recorded in alert history
- Alert includes: timestamp, current connection rate, baseline rate, affected server(s), and estimated attack magnitude
- Connection breakdown during anomaly periods: by source region (derived from server region), by connection type (signaling vs relay), and by source diversity (many IPs = distributed, few IPs = single-source)
- Real-time WebSocket push of alerts to connected admin dashboards (via existing `AdminWebSocketHandler`)
- DDoS indicator panel in Security tab with: current threat level (normal / elevated / attack), active connection rate gauge, and historical attack events list
- Historical attack events retained in D1 for 30 days

## Technical Design

### Architecture
DDoS detection operates primarily on the VPS server side, where connection handling is direct and latency-sensitive. The detection algorithm runs in the `SecurityEventCollector`, analyzing connection rate patterns from `MetricsCollector` snapshots (which are already taken every second for the admin WebSocket broadcast).

The detection pipeline:
1. `MetricsCollector.takeSnapshot()` captures current connection count every 1 second (existing behavior)
2. `DDoSDetector` maintains a sliding window of connection rate deltas (connections/second)
3. When the rate exceeds 5x the rolling 5-minute average, a DDoS indicator event is generated
4. The event is pushed via the existing `AdminWebSocketHandler.sendAlert()` method
5. The event is aggregated and pushed to D1 via the metrics push cycle (every 60 seconds)

This approach requires no additional timers or polling -- it piggybacks on the existing 1-second metrics broadcast loop.

### Implementation Details

**DDoS Detection Algorithm:**

```
baseline = rolling_average(connection_rate, window=5_minutes)
current = connection_rate(last_second)
threshold_multiplier = 5.0

if current > baseline * threshold_multiplier:
    if not already_in_attack_state:
        emit_ddos_alert(current, baseline, multiplier=current/baseline)
        enter_attack_state()

if in_attack_state and current < baseline * 2.0:
    # Cooldown: rate must drop below 2x baseline to exit attack state
    exit_attack_state()
    emit_ddos_resolved_alert()
```

The algorithm uses hysteresis (different enter/exit thresholds) to prevent alert flapping during an active attack.

**Connection rate calculation:**

The existing `MetricsCollector` tracks total connections in each snapshot. The connection rate (new connections per second) is the delta between consecutive snapshots' total connection counts, factoring in disconnections. Since the VPS `index.ts` already tracks connections and disconnections:

- Track `connectionsThisSecond` counter (incremented in `wss.on('connection')`, reset each second)
- Track `disconnectionsThisSecond` counter (incremented in `ws.on('close')`, reset each second)
- Net rate = `connectionsThisSecond` (raw incoming rate is what matters for DDoS)

**Source diversity analysis:**

During an anomaly period, analyze the `ipConnectionCounts` Map (already maintained in `index.ts`, line 304) to determine if the attack is distributed (many unique IPs) or concentrated (few IPs with many connections). This data informs the alert metadata.

**Alert integration:**

The `AdminWebSocketHandler` already has a `sendAlert()` method (`packages/server-vps/src/admin/websocket.ts`, line 189) that broadcasts to all connected admin clients. DDoS alerts use this existing channel with a new alert subtype.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/server-vps/src/admin/ddos-detector.ts` | Create | `DDoSDetector` class -- sliding window, baseline calculation, hysteresis state machine, alert generation |
| `packages/server-vps/src/admin/security-events.ts` | Modify | Add DDoS event recording and aggregation for D1 push |
| `packages/server-vps/src/admin/types.ts` | Modify | Add `DDoSAlert`, `DDoSIndicatorState`, `ThreatLevel`, `AttackEvent` types; extend `AdminWsMessage` with `ddos_alert` type |
| `packages/server-vps/src/admin/websocket.ts` | Modify | Integrate `DDoSDetector` into the 1-second broadcast loop; emit DDoS alerts via `sendAlert()` |
| `packages/server-vps/src/admin/metrics.ts` | Modify | Add connection rate tracking (connections/sec counter) |
| `packages/server-vps/src/index.ts` | Modify | Increment connection/disconnection counters for rate tracking |
| `packages/admin-cf/src/routes/security.ts` | Modify | Add `/admin/api/security/attacks` endpoint |
| `packages/diagnostics-cf/migrations/0003_ddos_events.sql` | Create | D1 migration for `attack_events` table |

### Data Models / Schemas

**D1 Table: `attack_events`**

```sql
CREATE TABLE attack_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL,
  server_region TEXT,
  attack_type TEXT NOT NULL,            -- 'connection_spike' | 'message_flood' (extensible)
  threat_level TEXT NOT NULL,           -- 'elevated' | 'attack'
  started_at INTEGER NOT NULL,
  ended_at INTEGER,                     -- NULL if ongoing
  peak_rate REAL NOT NULL,              -- Peak connections/second during event
  baseline_rate REAL NOT NULL,          -- Baseline rate when event started
  multiplier REAL NOT NULL,             -- peak_rate / baseline_rate
  unique_sources INTEGER,               -- Distinct source hashes during event
  total_connections INTEGER,            -- Total new connections during event
  affected_legitimate INTEGER,          -- Estimated legitimate connections impacted (from connection refusals)
  metadata TEXT,                        -- JSON: source diversity breakdown, connection type breakdown
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_ae_server ON attack_events(server_id);
CREATE INDEX idx_ae_time ON attack_events(started_at);
CREATE INDEX idx_ae_level ON attack_events(threat_level);
```

**TypeScript types:**

```typescript
type ThreatLevel = 'normal' | 'elevated' | 'attack';

interface DDoSIndicatorState {
  threatLevel: ThreatLevel;
  currentRate: number;           // connections/second
  baselineRate: number;          // 5-min rolling average
  multiplier: number;            // currentRate / baselineRate
  attackStartedAt: number | null;
  peakRate: number;
  uniqueSources: number;
}

interface DDoSAlert {
  type: 'ddos_alert';
  threatLevel: ThreatLevel;
  currentRate: number;
  baselineRate: number;
  multiplier: number;
  serverId: string;
  serverRegion: string;
  timestamp: number;
  sourceDiversity: {
    uniqueIPs: number;
    topSourcePercentage: number;  // % of connections from top source
    isDistributed: boolean;       // true if top source < 20%
  };
  connectionBreakdown: {
    signaling: number;
    relay: number;
  };
}

interface AttackEvent {
  id: number;
  serverId: string;
  serverRegion: string;
  attackType: string;
  threatLevel: ThreatLevel;
  startedAt: number;
  endedAt: number | null;
  peakRate: number;
  baselineRate: number;
  multiplier: number;
  uniqueSources: number;
  totalConnections: number;
}
```

**Extended AdminWsMessage:**

```typescript
type AdminWsMessage =
  | { type: 'metrics'; data: MetricsSnapshot }
  | { type: 'federation'; data: FederationTopology }
  | { type: 'alert'; data: { level: 'info' | 'warning' | 'error'; message: string } }
  | { type: 'ddos_indicator'; data: DDoSIndicatorState }
  | { type: 'ddos_alert'; data: DDoSAlert };
```

### API Endpoints

**`GET /admin/api/security/attacks`**

Query parameters:
- `since` (optional): Unix timestamp (default: 7 days ago)
- `until` (optional): Unix timestamp (default: now)
- `serverId` (optional): Filter by server
- `threatLevel` (optional): Filter by level
- `limit` (optional): Max results (default: 50)

Response:
```json
{
  "success": true,
  "data": {
    "currentState": {
      "threatLevel": "normal",
      "currentRate": 2.3,
      "baselineRate": 2.1,
      "multiplier": 1.1,
      "attackStartedAt": null,
      "peakRate": 0,
      "uniqueSources": 0
    },
    "events": [
      {
        "id": 1,
        "serverId": "vps-abc123",
        "serverRegion": "us-east-1",
        "attackType": "connection_spike",
        "threatLevel": "attack",
        "startedAt": 1709380800000,
        "endedAt": 1709382600000,
        "peakRate": 150.0,
        "baselineRate": 3.0,
        "multiplier": 50.0,
        "uniqueSources": 2847,
        "totalConnections": 45000
      }
    ],
    "summary": {
      "totalEvents": 3,
      "attackEvents": 1,
      "elevatedEvents": 2,
      "avgDurationMinutes": 12
    }
  }
}
```

Auth: Requires valid JWT (admin or super-admin role).

## Dependencies
- **US-7.1** (Rate Limit Violation Dashboard) -- the `SecurityEventCollector` and D1 security infrastructure must exist
- **Existing VPS admin module** -- the `AdminWebSocketHandler` and `MetricsCollector` are already functional; this story extends them
- No external package dependencies

## Testing Strategy
- **Unit tests**: `DDoSDetector` -- test baseline calculation with known connection rate sequences. Test hysteresis: verify alert enters at 5x, does not exit until below 2x. Test alert cooldown prevents duplicates. Test edge cases: zero baseline (first 5 minutes), single spike vs sustained attack.
- **Integration tests**: Feed simulated connection events into `DDoSDetector` and verify: correct alert emission via mock `AdminWebSocketHandler`, correct attack event recording for D1 push, correct threat level transitions.
- **E2E tests**: Open 50 rapid WebSocket connections to VPS within 1 second (from test harness), verify the admin WebSocket receives a `ddos_alert` message. Verify the attack event appears in `/admin/api/security/attacks` within 60 seconds.

## Technical Notes

**Existing patterns to follow:**
- The `AdminWebSocketHandler.broadcastMetrics()` method (`packages/server-vps/src/admin/websocket.ts`, lines 128-172) already runs every 1 second and checks for scaling level changes to emit alerts. The DDoS detector integrates into this same loop -- after broadcasting metrics, call `ddosDetector.evaluate(snapshot)`.
- The existing alert mechanism (`type: 'alert'` in `AdminWsMessage`) is used for scaling warnings. DDoS alerts should use a distinct message type (`type: 'ddos_indicator'` for state updates, `type: 'ddos_alert'` for threshold crossings) so the dashboard can render them differently.
- The `ipConnectionCounts` Map in `packages/server-vps/src/index.ts` (line 304) already tracks per-IP connections. This provides source diversity analysis without additional data structures.

**Threshold calibration:**
- The 5x multiplier is a starting point. Real DDoS attacks against WebSocket services can produce 100x-1000x normal rates. The threshold should be configurable via admin API (future enhancement in US-8.4 Alert Rule Management).
- The 5-minute baseline window is chosen to be long enough to smooth out normal traffic bursts (e.g., when a popular channel starts streaming) but short enough to detect rapid attacks. For servers with very low baseline traffic (< 1 connection/second), an absolute minimum threshold (e.g., 10 connections/second) prevents false positives.

**Performance considerations:**
- The sliding window for baseline calculation uses a fixed-size circular buffer (300 entries = 5 minutes at 1-second intervals). Memory cost: ~2.4KB per VPS server. CPU cost: O(1) per tick (running sum maintained incrementally).
- Source diversity analysis during an attack scans the `ipConnectionCounts` Map. In normal operation this is tiny (<100 entries). During a DDoS with millions of connections, the Map could grow large. The per-IP connection limit (`CONNECTION_LIMITS.MAX_CONNECTIONS_PER_IP = 50`) bounds Map growth to `totalConnections / 50` entries in the worst case.

**DDoS mitigation is out of scope:**
- This story detects and alerts. Automatic mitigation (e.g., enabling Cloudflare Under Attack Mode, activating a WAF rule, or dynamically reducing per-IP limits) is a separate concern that would be covered by alert rules (US-8.4) or manual admin action.

## Estimation
**M (Medium)** -- The core DDoS detector is a self-contained class with a well-defined algorithm (sliding window + hysteresis). Integration into the existing 1-second broadcast loop is minimal. The D1 schema and admin API follow established patterns. The main complexity is in the source diversity analysis and ensuring the detector handles edge cases (cold start, very low traffic, sustained vs burst attacks).
