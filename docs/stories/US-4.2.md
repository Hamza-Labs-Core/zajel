# US-4.2: Platform Breakdown

## Story
As an admin, I want to see active clients per platform, so that I can understand which platforms my users are on and prioritize testing, bug fixes, and feature development accordingly.

## Acceptance Criteria
- Dashboard displays a donut chart showing the distribution of active clients across platforms (Android, iOS, Windows, macOS, Linux, Web)
- Each segment shows the platform name and exact count
- The chart is color-coded with distinct colors per platform
- Data refreshes automatically every 30 seconds
- Platforms with zero active clients are omitted from the chart (no empty segments)
- A legend beside the donut chart lists each platform with its count and percentage
- The data is based on heartbeat freshness (last 10 minutes), consistent with US-4.1

## Technical Design

### Architecture
This story extends the Active Clients tab with a platform breakdown donut chart. The data source is the same `client_heartbeats` D1 table used in US-4.1, grouped by the `platform` column. A new API endpoint `/admin/api/clients/platforms` returns the aggregated platform counts, and the frontend renders a donut chart using pure SVG (no external chart library needed for this scope).

### Implementation Details

**Backend — API Route (`packages/admin-cf/src/routes/clients.ts`):**

Add a new handler `handlePlatformBreakdown(request, env)` to the existing clients route file:
- Query D1 for platform counts among active clients (heartbeat within 10 minutes)
- Return sorted array of `{ platform, count, percentage }` objects

**D1 Query:**
```sql
SELECT platform, COUNT(*) as count
FROM client_heartbeats
WHERE last_seen > ?
GROUP BY platform
ORDER BY count DESC
-- Parameter: Date.now() - 10 * 60 * 1000
```

Percentages are computed in the handler (not in SQL) to avoid floating-point issues in SQLite.

**Frontend — Donut Chart:**

Implement the donut chart as an inline SVG using `<circle>` elements with `stroke-dasharray` and `stroke-dashoffset` — the same technique already used in the VPS dashboard's entropy gauge (`renderEntropyGauge()`). Each platform gets a colored arc segment.

The donut chart construction:
1. Calculate total count across all platforms
2. For each platform, compute its arc length as `(count / total) * circumference`
3. Render stacked `<circle>` elements, each offset by the cumulative arc length of preceding segments
4. The donut hole is achieved by using a large `stroke-width` on circles with a smaller radius

**Platform color mapping:**
```javascript
const PLATFORM_COLORS = {
  android: '#3DDC84',   // Android green
  ios: '#007AFF',       // iOS blue
  windows: '#00BCF2',   // Windows blue
  macos: '#A2AAAD',     // macOS silver
  linux: '#FCC624',     // Linux/Tux yellow
  web: '#FF6B35',       // Web orange
};
```

**Legend rendering:**
A vertical list to the right of the donut chart showing colored bullets, platform names, counts, and percentages. Uses a simple flexbox layout.

**Auto-refresh:**
Shares the same 30-second `setInterval` timer as US-4.1 to avoid redundant timers. Both `/admin/api/clients/active` and `/admin/api/clients/platforms` are fetched in parallel (via `Promise.all`) on each refresh cycle.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/admin-cf/src/routes/clients.ts` | Modify | Add `handlePlatformBreakdown()` handler |
| `packages/admin-cf/src/index.ts` | Modify | Add route for `/admin/api/clients/platforms`; add donut chart rendering to Active Clients tab |
| `packages/admin-cf/src/types.ts` | Modify | Add `PlatformBreakdownResponse` and `PlatformCount` types |
| `packages/admin-cf/tests/clients.test.ts` | Modify | Add tests for platform breakdown endpoint |

### Data Models / Schemas

**API Response Schema:**
```typescript
interface PlatformBreakdownResponse {
  platforms: PlatformCount[];
  totalActive: number;
  lastUpdated: number;
}

interface PlatformCount {
  platform: 'android' | 'ios' | 'windows' | 'macos' | 'linux' | 'web';
  count: number;
  percentage: number;  // 0.0 to 100.0, rounded to 1 decimal
}
```

**D1 Table (read-only, same as US-4.1):**
```sql
-- client_heartbeats table, grouping by platform column
-- platform values: 'android', 'ios', 'windows', 'macos', 'linux', 'web'
```

### API Endpoints

**`GET /admin/api/clients/platforms`**

- **Auth:** Bearer JWT (admin or super-admin)
- **Request:** No body
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "platforms": [
      { "platform": "android", "count": 25, "percentage": 59.5 },
      { "platform": "ios", "count": 12, "percentage": 28.6 },
      { "platform": "linux", "count": 3, "percentage": 7.1 },
      { "platform": "web", "count": 2, "percentage": 4.8 }
    ],
    "totalActive": 42,
    "lastUpdated": 1709384400000
  }
}
```
- **Response (401):** `{ "success": false, "error": "Unauthorized" }`

## Dependencies
- **US-1.2 (Client Heartbeat for Active Counting):** Heartbeats must be populating the `client_heartbeats` table with correct `platform` values
- **US-4.1 (Anonymous Active Client Count):** Shares the same D1 table, the same route file, and the same dashboard tab — US-4.1 should be implemented first to establish the route file structure and tab layout
- **D1 database binding:** The `DIAGNOSTICS_DB` D1 binding in admin-cf (added in US-4.1)

## Testing Strategy

### Unit Tests
- Test `handlePlatformBreakdown` with D1 mock returning multiple platforms
- Test with a single platform (donut should be a full circle)
- Test with no active clients (empty array returned)
- Test that percentage calculation is correct and sums to ~100%
- Test that platforms with 0 count are excluded from results
- Test unauthorized request returns 401

### Integration Tests
- Seed D1 with heartbeats across all 6 platforms with varying counts
- Verify the API returns correct counts and percentages
- Verify that stale heartbeats (>10 min old) are excluded from platform counts

### E2E Tests
- Not applicable (internal admin tooling)

## Technical Notes

**SVG donut chart approach (no external library):**
The donut chart uses the `stroke-dasharray` technique on SVG `<circle>` elements. This is the same technique already used in the VPS dashboard for the entropy gauge ring (`renderEntropyGauge()` in `packages/server-vps/src/admin/routes.ts`). The key difference is that the gauge uses a single arc, while the donut chart uses multiple stacked arcs with different `stroke-dashoffset` values.

For a lightweight Preact-specific option (when the dashboard migrates to Preact SPA), `react-minimal-pie-chart` is compatible with Preact and is under 2kB gzipped. However, for the current inline HTML approach, a pure SVG implementation avoids adding any dependency.

**Donut chart SVG construction pseudocode:**
```javascript
const circumference = 2 * Math.PI * radius;
let cumulativeOffset = 0;

platforms.forEach(p => {
  const arcLength = (p.count / total) * circumference;
  const dashoffset = circumference - arcLength;
  // Render <circle> with:
  //   stroke-dasharray: `${arcLength} ${circumference - arcLength}`
  //   stroke-dashoffset: `-${cumulativeOffset}`
  //   (negative offset rotates the arc to the correct start position)
  cumulativeOffset += arcLength;
});
```

**Privacy:**
- Only aggregate counts by platform are returned — no session hashes, no individual client data
- Platform strings are limited to the 6 known values; any unknown platform from the heartbeat is normalized to the closest match or excluded

**Color accessibility:**
The chosen platform colors have sufficient contrast against the dark dashboard background (`--bg-secondary: #1e293b`). The legend provides text labels so the chart is not reliant on color alone for identification.

## Estimation
**S (Small)** — One new API endpoint with a simple GROUP BY query, and a donut chart rendered with the same SVG circle technique already used in the codebase. The bulk of the work is the SVG donut math and legend layout, which is straightforward.
