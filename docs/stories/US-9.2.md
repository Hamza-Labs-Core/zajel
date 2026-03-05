# US-9.2: Log-Diagnostic Correlation

## Story
As an admin, I want to see server-side logs and client diagnostics for the same time window side by side, so that I can correlate client-reported errors with server-side events to diagnose issues faster.

## Acceptance Criteria
- The admin portal provides a "Correlation View" accessible from the Errors tab drill-down (US-2.3) or from the Server Health > Logs panel (US-9.1).
- The correlation view displays two vertically stacked panels: "Server Logs" (top) and "Client Diagnostics" (bottom), each with its own scrollable content area.
- A shared time-range bar at the top of the view controls both panels simultaneously. Selecting a time range (e.g., 15 minutes, 1 hour, 6 hours, or custom range via datetime pickers) updates both panels to show data from that window.
- A "Sync Scroll" toggle (default: ON) enables synchronized scrolling: scrolling in either panel automatically scrolls the other to the matching timestamp position. When toggled off, the panels scroll independently.
- The server logs panel shows entries from the selected VPS server (same as US-9.1), filtered to the shared time window.
- The client diagnostics panel shows error aggregates and raw diagnostic events from the D1 `error_aggregates` table for the same time window, including category, error signature, count, affected versions, and sample messages.
- Clicking an error signature in the client diagnostics panel highlights server log entries that occurred within a configurable proximity window (default: +/- 30 seconds) around the error's `last_seen` timestamp, by adding a yellow background highlight to matching log rows.
- Clicking a server log entry with level `error` or `warn` highlights client diagnostic entries that occurred within the same proximity window.
- A "correlation hint" badge appears on log entries where a probable correlation exists: a server-side error in the `Federation`, `Client`, `Relay`, or `Signaling` module occurring within 60 seconds of a client-reported `network`, `crypto`, or `protocol` error.
- When no client diagnostics exist for the selected time window, the diagnostics panel shows an empty state message: "No client diagnostics reported for this time range."
- When no server logs exist (server unreachable or buffer empty), the logs panel shows "Server logs unavailable" with the last-known server status.
- The view is responsive: on screens narrower than 1024px, the panels stack vertically with a shared time axis. On wider screens, they can optionally display side-by-side (toggled via a layout button).
- All data fetching respects admin JWT auth. No new authentication mechanisms are required.

## Technical Design

### Architecture
This story composes data from two existing sources through the admin-cf Worker:

1. **Server logs** -- fetched from a specific VPS server via the proxy endpoint created in US-9.1 (`GET /admin/api/logs/server/:serverId`).
2. **Client diagnostics** -- fetched from the D1 `error_aggregates` table via existing or new admin-cf API endpoints (from US-2.1 and the diagnostics ingestion pipeline).

The correlation logic runs client-side in the browser. No server-side join or correlation engine is required because:
- Both datasets are relatively small for a given time window (max hundreds of entries each).
- The correlation is timestamp-proximity-based, not requiring complex pattern matching.
- Running it client-side avoids a complex cross-service query that would need the admin-cf Worker to call both D1 and the VPS server, then join the results.

```
Browser (Correlation View)
  |
  +--> GET /admin/api/logs/server/:serverId?since=T1&until=T2
  |    (admin-cf --> VPS --> LogBuffer)
  |
  +--> GET /admin/api/errors?since=T1&until=T2
  |    (admin-cf --> D1 error_aggregates)
  |
  +--> Client-side correlation algorithm
       (match by timestamp proximity, module<->category heuristics)
```

### Implementation Details

**1. New API endpoint for time-windowed diagnostics (`packages/admin-cf/src/routes/errors.ts`):**

US-2.1 provides `GET /admin/api/errors` with a `range` parameter (`1h`, `24h`, `7d`). The correlation view needs precise `since`/`until` timestamps instead. Extend the existing handler:

```typescript
// Add support for explicit since/until params alongside the existing range param
const since = parseInt(url.searchParams.get('since') || '0', 10);
const until = parseInt(url.searchParams.get('until') || '0', 10);

let timeBucketThreshold: string;
if (since && until) {
  timeBucketThreshold = new Date(since).toISOString().slice(0, 13) + ':00:00';
  // Also add upper bound: WHERE time_bucket >= ? AND time_bucket <= ?
} else {
  // Existing range-based logic
}
```

This is a backward-compatible extension of the existing endpoint, not a new endpoint.

**2. Correlation algorithm (client-side JavaScript):**

The correlation runs entirely in the browser after both datasets are fetched:

```javascript
function correlateEntries(serverLogs, clientErrors, proximityMs = 30000) {
  const correlations = new Map(); // logSequence -> [errorSignature, ...]

  // Build a sorted array of client error timestamps
  const errorTimestamps = clientErrors.map(e => ({
    signature: e.errorSignature,
    timestamp: e.lastSeen,
    category: e.category,
  })).sort((a, b) => a.timestamp - b.timestamp);

  // For each server log entry, find client errors within proximity
  for (const log of serverLogs) {
    const matches = errorTimestamps.filter(e =>
      Math.abs(e.timestamp - log.timestamp) <= proximityMs
    );

    if (matches.length > 0) {
      correlations.set(log.sequence, matches.map(m => m.signature));
    }
  }

  return correlations;
}
```

**Heuristic correlation hints** go further than pure timestamp proximity. They use module-to-category mapping to flag likely causal relationships:

```javascript
const MODULE_CATEGORY_MAP = {
  'Federation':  ['network', 'protocol'],
  'Client':      ['network', 'protocol', 'crypto'],
  'Relay':       ['network'],
  'Signaling':   ['network', 'protocol'],
  'Crypto':      ['crypto'],
  'Storage':     ['storage'],
};

function hasHeuristicCorrelation(logEntry, errorEntry) {
  const relatedCategories = MODULE_CATEGORY_MAP[logEntry.module] || [];
  return relatedCategories.includes(errorEntry.category)
    && Math.abs(logEntry.timestamp - errorEntry.lastSeen) <= 60000;
}
```

**3. Synchronized scrolling implementation:**

Both panels share a virtual time axis. Each panel tracks its visible time range based on scroll position. When the user scrolls one panel, the other panel scrolls to show entries at the same timestamp:

```javascript
function syncScroll(sourcePanel, targetPanel, sourceEntries, targetEntries) {
  // Find the timestamp at the top of the visible area in the source panel
  const scrollRatio = sourcePanel.scrollTop / sourcePanel.scrollHeight;
  const visibleIndex = Math.floor(scrollRatio * sourceEntries.length);
  const targetTimestamp = sourceEntries[visibleIndex]?.timestamp;

  if (!targetTimestamp) return;

  // Find the closest entry in the target panel
  const targetIndex = findClosestIndex(targetEntries, targetTimestamp);
  const targetRow = targetPanel.querySelector(`[data-index="${targetIndex}"]`);
  if (targetRow) {
    targetRow.scrollIntoView({ block: 'start', behavior: 'auto' });
  }
}
```

The sync uses `requestAnimationFrame` debouncing to avoid scroll jank. A `syncing` flag prevents infinite scroll loops (panel A scrolls panel B, which would scroll panel A).

**4. Shared time-range bar component:**

A horizontal bar at the top contains:
- Preset buttons: 15m, 1h, 6h
- Custom range: two `<input type="datetime-local">` fields
- A miniature timeline showing the density of events (log entries + error counts per minute) as small vertical bars, giving the admin a visual hint of where activity clusters are.

When the time range changes, both `loadServerLogs()` and `loadClientDiagnostics()` are called in parallel, and the panels re-render when both resolve.

**5. Frontend rendering (dashboard HTML):**

The correlation view is added as a sub-view, accessible from:
- Server Health tab > server card click > "Correlate" button
- Errors tab > error signature click > "Correlate with Server Logs" link (opens the correlation view pre-filtered to the error's time window and with the relevant server pre-selected if identifiable from the error's metadata)

The view uses a URL hash fragment for deep-linking: `#/correlate?server=srv-01&since=1709380800000&until=1709384400000&signature=abc123`

```javascript
function renderCorrelationView() {
  return `
    <div class="correlation-view">
      <div class="correlation-toolbar">
        ${renderTimeRangeBar()}
        <label class="sync-toggle">
          <input type="checkbox" id="sync-scroll" checked>
          Sync Scroll
        </label>
        <button id="layout-toggle" class="layout-btn">
          ${state.correlationLayout === 'stacked' ? 'Side by Side' : 'Stacked'}
        </button>
      </div>

      <div class="correlation-panels ${state.correlationLayout}">
        <div class="panel server-logs-panel" id="logs-panel">
          <div class="panel-header">
            <h3>Server Logs</h3>
            <select id="server-selector">
              ${state.servers.map(s => `<option value="${s.id}">${s.id} (${s.region})</option>`).join('')}
            </select>
          </div>
          <div class="panel-content" id="logs-content">
            ${renderLogEntries(state.correlationLogs, state.correlationHighlights)}
          </div>
        </div>

        <div class="panel diagnostics-panel" id="diagnostics-panel">
          <div class="panel-header">
            <h3>Client Diagnostics</h3>
          </div>
          <div class="panel-content" id="diagnostics-content">
            ${renderDiagnosticEntries(state.correlationErrors, state.correlationHighlights)}
          </div>
        </div>
      </div>
    </div>
  `;
}
```

**CSS additions for the correlation view:**

```css
.correlation-panels.stacked {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.correlation-panels.side-by-side {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

.panel-content {
  max-height: 400px;
  overflow-y: auto;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.8125rem;
  background: var(--bg-card);
  border-radius: 0.5rem;
  padding: 0.5rem;
}

.log-entry.highlighted,
.diagnostic-entry.highlighted {
  background: rgba(234, 179, 8, 0.15);
  border-left: 3px solid var(--warning);
}

.correlation-hint {
  display: inline-block;
  background: rgba(59, 130, 246, 0.2);
  color: var(--accent);
  font-size: 0.625rem;
  padding: 0.125rem 0.375rem;
  border-radius: 0.25rem;
  margin-left: 0.5rem;
}
```

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/admin-cf/src/routes/errors.ts` | Modify | Add `since`/`until` timestamp parameters to the existing errors endpoint for precise time-window queries |
| `packages/admin-cf/src/index.ts` | Modify | Add correlation view rendering function; register URL hash routing for `#/correlate`; add CSS for correlation panels |
| `packages/admin-cf/src/types.ts` | Modify | Add `CorrelationHint` interface |
| `packages/server-vps/src/admin/routes.ts` | Modify | Ensure `/admin/api/logs/export` endpoint is registered (if not done in US-9.1) for bulk export without pagination limit |

### Data Models / Schemas

**CorrelationHint (admin-cf frontend, in-memory only):**

```typescript
interface CorrelationHint {
  logSequence: number;          // ServerLogEntry.sequence
  errorSignature: string;       // From error_aggregates
  confidence: 'high' | 'medium' | 'low';
  reason: string;               // e.g., "Federation error 12s before network diagnostic"
}
```

Confidence levels:
- **high**: Same module-category mapping AND timestamp within 30 seconds
- **medium**: Same module-category mapping AND timestamp within 60 seconds, OR different mapping but within 10 seconds
- **low**: Timestamp proximity only (within 30 seconds, no module-category match)

**CorrelationViewState (frontend state extension):**

```typescript
interface CorrelationViewState {
  correlationLogs: ServerLogEntry[];
  correlationErrors: ErrorAggregate[];
  correlationHighlights: Map<number, string[]>;  // logSequence -> errorSignatures
  correlationHints: CorrelationHint[];
  correlationLayout: 'stacked' | 'side-by-side';
  correlationSyncEnabled: boolean;
  correlationTimeRange: { since: number; until: number };
  selectedServerId: string | null;
  selectedSignature: string | null;  // Pre-selected error signature from drill-down
}
```

### API Endpoints

No new API endpoints are created in this story. It reuses:

1. **GET /admin/api/logs/server/:serverId** (from US-9.1) -- with `since` and `until` query params.
2. **GET /admin/api/errors** (from US-2.1, extended) -- with new optional `since` and `until` query params alongside the existing `range` param.

The extension to `GET /admin/api/errors`:
- New query params (all optional, mutually exclusive with `range`):
  - `since`: Unix ms timestamp
  - `until`: Unix ms timestamp
- When `since` and `until` are provided, they take precedence over `range`.
- The SQL query changes from `WHERE time_bucket >= ?` to `WHERE time_bucket >= ? AND time_bucket <= ?`.
- Response schema is unchanged.

## Dependencies
- **US-9.1 (Centralized Log Viewer):** The server logs panel depends on the VPS `/admin/api/logs` endpoint and the admin-cf proxy created in US-9.1. This is a hard dependency.
- **US-2.1 (Error Rate Overview):** The client diagnostics panel depends on `GET /admin/api/errors` being available and the D1 `error_aggregates` table being populated. This is a hard dependency.
- **US-2.3 (Error Signature Drill-Down):** The "Correlate with Server Logs" link in the error detail view depends on US-2.3 existing. This is a soft dependency -- the correlation view can be accessed directly from Server Health even without the drill-down link.
- **US-1.1 (Diagnostic Report Submission):** Client diagnostics data must be flowing into the D1 database for the diagnostics panel to show meaningful data.
- No new external packages required. All correlation logic is implemented in vanilla JavaScript running in the browser.

## Testing Strategy

- **Unit tests:**
  - `correlateEntries()`: Test with overlapping timestamps (entries at T and T+10s should correlate with proximity=30s). Test with non-overlapping timestamps (entries 2 minutes apart should not correlate). Test with empty arrays for either input. Test that correlation is bidirectional (log->error and error->log both work).
  - `hasHeuristicCorrelation()`: Test each module-category pair in `MODULE_CATEGORY_MAP`. Test that unmapped modules return no correlation. Test the 60-second window boundary (59s correlates, 61s does not).
  - Confidence level assignment: Test high (within 30s + matching category), medium (within 60s + matching, or within 10s + non-matching), low (proximity only).
  - Time-range bar: Test that preset buttons (15m, 1h, 6h) compute correct `since`/`until` timestamps. Test custom range validation (until > since).

- **Integration tests:**
  - Extended `GET /admin/api/errors` endpoint: Test that `since` and `until` params correctly filter the D1 query. Test that `since`/`until` take precedence over `range` when both are provided. Test backward compatibility: requests with only `range` still work.
  - Test that calling both endpoints in parallel (logs + errors) for the same time window returns data with overlapping timestamps.

- **E2E tests:**
  - Navigate to the correlation view, select a server and time range, verify both panels populate.
  - Click an error signature, verify server log entries highlight with yellow background.
  - Toggle sync scroll off, verify panels scroll independently.
  - Toggle layout between stacked and side-by-side, verify responsive behavior.
  - Test with no diagnostic data: verify empty state message appears in diagnostics panel.
  - Test with offline server: verify "Server logs unavailable" message in logs panel.

## Technical Notes

**Codebase patterns observed:**
- The existing dashboard in `packages/admin-cf/src/index.ts` uses a `state` object with `activeTab` and `render()` function pattern. The correlation view should be added as a sub-view accessible from multiple tabs. Using a URL hash fragment (`#/correlate?...`) keeps the single-page navigation simple without introducing a router dependency.
- The existing `renderServers()` function demonstrates the pattern for building complex UI with template literals. The correlation view follows the same approach but is more complex due to the dual-panel layout.
- The inline dashboard does not use Preact yet (it is listed as a dependency but not used). If the Preact migration (mentioned in plan Section 4.3) has been completed by the time this story is implemented, the correlation view should be a Preact component using signals for reactive state updates. If still using inline HTML, the template literal approach is the fallback.
- The `openVpsDashboard()` function in the admin-cf frontend shows how server endpoints are resolved and used. The correlation view's server selector follows the same pattern but routes through the admin-cf proxy instead of opening a new tab.

**Timestamp alignment considerations:**
- Server logs use `Date.now()` on the VPS (Unix ms). Client diagnostics use `lastSeen` from `error_aggregates` which stores Unix ms from the diagnostics ingestion worker. Both timestamps are set server-side (VPS wall clock and CF Worker wall clock respectively), so they may have minor clock skew (typically <1 second between CF and VPS). The 30-second default proximity window is generous enough to absorb this skew.
- The `time_bucket` column in `error_aggregates` is truncated to the hour. When filtering by `since`/`until`, the query uses `time_bucket >= ?` where `?` is the hour-truncated version of `since`. This means the diagnostics panel may include entries from up to 59 minutes before the requested `since` time. For the correlation view, this is acceptable because the individual entries have precise `last_seen` timestamps that can be used for client-side filtering.

**Performance considerations:**
- The correlation algorithm is O(n*m) where n = server logs and m = client errors. For typical time windows (1 hour), n is ~200-3600 entries and m is ~10-50 error signatures. This completes in <10ms in the browser, so no optimization (e.g., binary search on sorted timestamps) is needed.
- Both API calls are made in parallel using `Promise.all()`. The expected latency is max(VPS response time, D1 query time), typically ~200-500ms.
- The miniature timeline density visualization requires counting entries per minute bucket for both datasets. This is computed once after data loads and stored in state -- not recomputed on every render.

**Synchronized scrolling edge cases:**
- When one panel has many entries and the other has few (e.g., 500 log entries but only 3 error signatures), scrolling the dense panel may cause the sparse panel to "jump" between its few entries. To handle this gracefully, the sync algorithm maps scroll position to timestamp rather than to entry index, and the sparse panel highlights the closest available entry without physically scrolling if the target timestamp falls between entries.
- The `requestAnimationFrame` debounce prevents scroll event storms. A `syncing` boolean flag prevents the recursive loop where panel A's scroll handler triggers panel B's scroll, which triggers panel A again.

**Deep-linking for cross-tab navigation:**
- From the Errors tab (US-2.3), clicking "Correlate with Server Logs" navigates to `#/correlate?signature=abc123&since=T1&until=T2`. The correlation view parses these hash params on load, pre-selects the error signature, and auto-selects the most likely server (based on where the error was reported, if that metadata is available, or defaulting to the first server).
- From the Server Health tab (US-9.1), clicking "Correlate" on a log entry navigates to `#/correlate?server=srv-01&since=T1&until=T2&logTimestamp=T3`. The view pre-selects the server and time window, and highlights entries near `logTimestamp`.

## Estimation
**L (Large)** -- The backend changes are minimal (extending an existing query with `since`/`until` parameters). The bulk of the work is frontend: the dual-panel layout, synchronized scrolling, the correlation algorithm with heuristic hints, the time-range bar with density visualization, click-to-highlight interactions, and responsive layout toggling. The synchronized scrolling alone requires careful debouncing and edge-case handling. Estimated 4-5 days.
