# US-5.1: Per-Server Status

## Story
As an admin, I want to see each VPS server's health status at a glance, so that I can quickly identify which servers need attention and navigate to their individual dashboards for deeper investigation.

## Acceptance Criteria
- Server Health tab displays a color-coded card grid showing all registered VPS servers
  - Green card: server healthy (heartbeat received within last 5 minutes)
  - Yellow card: server degraded (heartbeat older than 5 minutes but less than 10 minutes, or federation status is "suspect")
  - Red card: server offline (no heartbeat for 10+ minutes or federation status is "failed")
- Each card displays: server ID, region, connection count (total/relay/signaling), active pairing codes, collision risk level, last heartbeat timestamp, and federation peer count
- Clicking a server card opens that server's VPS admin dashboard in a new tab (passes JWT token via URL parameter for SSO)
- Card grid auto-refreshes every 30 seconds via polling; if the admin-cf WebSocket is connected, updates arrive in real time
- Aggregate summary row above the grid shows: total servers, healthy count, degraded count, offline count, total connections across all servers
- Cards are sorted by region, then by server ID; offline servers sort to the top within their region group
- Empty state shown when no servers are registered: "No VPS servers registered. Servers appear here after their first heartbeat to the bootstrap registry."

## Technical Design

### Architecture
This story enhances the existing "Servers" tab in admin-cf by adding it as a dedicated "Server Health" tab in the new tab structure. The data flow is:

```
admin-cf Worker --> Service Binding (BOOTSTRAP_SERVICE) --> bootstrap Worker
                --> /servers endpoint on bootstrap registry
                --> ServerRegistryDO returns list of registered servers
admin-cf Worker --> KV cache (ADMIN_KV) for server health snapshots
admin-cf Worker --> Preact SPA renders color-coded card grid
```

The existing `handleListServers` in `packages/admin-cf/src/routes/servers.ts` already fetches from the bootstrap registry and computes health status. This story extends it with KV-cached server metrics push data and builds a proper Preact component.

### Implementation Details

**Backend (admin-cf Worker):**
1. Extend `handleListServers` to merge bootstrap registry data with KV-cached VPS metrics data (pushed by US-5.4 heartbeat data or by the existing VPS admin metrics push)
2. Add a new endpoint `GET /admin/api/servers/health` that returns enriched server objects including federation peer info and last-known metrics
3. Cache server list in `ADMIN_KV` with a 30-second TTL to reduce load on the bootstrap registry DO

**Frontend (Preact SPA):**
1. Create a `ServerHealthTab` Preact component that replaces the current inline HTML server grid
2. Component fetches from `/admin/api/servers/health` on mount and every 30 seconds
3. Each `ServerCard` subcomponent renders the color-coded card with status badge, stats, and click handler
4. `AggregateSummary` subcomponent renders the totals row above the grid

**SSO click-through:**
The existing `openVpsDashboard` function in the inline HTML already constructs `baseUrl + '/admin/?token=' + token`. The Preact component replicates this behavior using the JWT stored in the SPA state.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/admin-cf/src/routes/servers.ts` | Modify | Add `handleServerHealth` endpoint; merge KV metrics with bootstrap data |
| `packages/admin-cf/src/index.ts` | Modify | Register new `/admin/api/servers/health` route |
| `packages/admin-cf/src/types.ts` | Modify | Add `EnrichedVpsServer` interface with metrics fields |
| `packages/admin-cf/src/dashboard/components/ServerHealthTab.tsx` | Create | Main tab component with auto-refresh and grid layout |
| `packages/admin-cf/src/dashboard/components/ServerCard.tsx` | Create | Individual server card with color-coded status |
| `packages/admin-cf/src/dashboard/components/AggregateSummary.tsx` | Create | Summary stats row above server grid |
| `packages/admin-cf/src/dashboard/hooks/useServerHealth.ts` | Create | Hook for fetching and polling server health data |
| `packages/admin-cf/wrangler.jsonc` | Modify | Add `ADMIN_KV` KV namespace binding |
| `packages/admin-cf/tests/routes/servers.test.ts` | Modify | Add tests for the new health endpoint |
| `packages/admin-cf/tests/dashboard/ServerHealthTab.test.tsx` | Create | Component tests for server grid rendering |

### Data Models / Schemas

```typescript
// Extended server type with health and metrics details
interface EnrichedVpsServer extends VpsServer {
  // Existing fields from VpsServer:
  // id, endpoint, region, lastHeartbeat, status, stats

  // New enriched fields:
  federation?: {
    aliveMembers: number;
    suspectMembers: number;
    totalMembers: number;
  };
  metrics?: {
    messageRate: { perSecond: number; perMinute: number };
    uptimeSeconds?: number;
    cpuPercent?: number;
    memoryMb?: number;
  };
  healthReason?: string;  // Human-readable reason for degraded/offline status
}

// KV key pattern for cached server metrics
// Key: `server:metrics:{serverId}`
// Value: JSON of ServerMetricsPush (from section 4.4 of the plan)
// TTL: 120 seconds (2x the 60-second push interval)
```

### API Endpoints

**GET /admin/api/servers/health**

Request: Requires `Authorization: Bearer <jwt>` header.

Query parameters:
- `region` (optional): Filter by region string

Response (200):
```json
{
  "success": true,
  "data": {
    "servers": [
      {
        "id": "srv-01",
        "endpoint": "wss://vps1.example.com:9000",
        "region": "us-east",
        "lastHeartbeat": 1709380800000,
        "status": "healthy",
        "healthReason": null,
        "stats": {
          "connections": 42,
          "relayConnections": 20,
          "signalingConnections": 22,
          "activeCodes": 15,
          "collisionRisk": "low"
        },
        "federation": {
          "aliveMembers": 3,
          "suspectMembers": 0,
          "totalMembers": 3
        },
        "metrics": {
          "messageRate": { "perSecond": 5, "perMinute": 180 },
          "uptimeSeconds": 86400
        }
      }
    ],
    "aggregate": {
      "totalServers": 3,
      "healthyServers": 2,
      "degradedServers": 1,
      "offlineServers": 0,
      "totalConnections": 120,
      "byRegion": { "us-east": 2, "eu-west": 1 }
    }
  }
}
```

## Dependencies
- **Internal:** Depends on the admin-cf Preact SPA migration (Phase 2 task: migrating from inline HTML to Preact). The Preact component cannot be created until the SPA shell with tab routing exists.
- **US-5.4 (Heartbeat Freshness Timeline):** The metrics push from VPS servers (section 4.4 of the plan) that populates KV is shared infrastructure. US-5.1 can function without it by relying solely on bootstrap registry data, but enriched metrics require the push mechanism.
- **External:** `ADMIN_KV` KV namespace must be created in Cloudflare dashboard or via wrangler before deployment.

## Testing Strategy

### Unit Tests
- `handleServerHealth` returns correct status colors based on heartbeat age thresholds (healthy < 5min, degraded 5-10min, offline > 10min)
- `handleServerHealth` merges KV metrics data when present and gracefully handles missing KV data
- Server sorting: offline servers sort to top within region groups
- Aggregate stats calculation is correct (healthy/degraded/offline counts, total connections)
- Region filter parameter works correctly

### Integration Tests
- Service Binding to bootstrap returns server list; admin-cf correctly enriches and returns
- KV cache hit avoids calling bootstrap registry; cache miss falls through

### Component Tests (Preact)
- `ServerHealthTab` renders correct number of cards for given server data
- `ServerCard` renders green/yellow/red classes based on status prop
- Click on card calls `window.open` with correct URL and token
- Empty state renders when server list is empty
- Auto-refresh triggers re-fetch after 30 seconds (use fake timers)

## Technical Notes

**Codebase patterns to follow:**
- The existing `handleListServers` in `packages/admin-cf/src/routes/servers.ts` already does the bootstrap fetch via Service Binding (lines 27-45) and health determination from heartbeat freshness (lines 90-125). The new endpoint should reuse `fetchFromBootstrap` and extend the health logic.
- The existing CF admin inline HTML already has `.server-card`, `.status-badge`, `.server-grid` CSS classes and the `openVpsDashboard` function. The Preact component should maintain visual parity with the existing design (dark theme with `--bg-primary: #0f172a` etc.).
- Auth pattern: use `requireAuth` from `packages/admin-cf/src/routes/auth.ts` which validates JWT and returns the payload or a 401 Response.
- The VPS admin types in `packages/server-vps/src/admin/types.ts` define `MetricsSnapshot` and `FederationTopology` — the enriched server data should use compatible shapes.

**UX best practices (from research):**
- Place critical status (offline/degraded servers) at the top, matching the F-pattern scanning behavior users apply to dashboards.
- Use color AND text labels together for status (not color alone) to maintain accessibility.
- Limit visible summary metrics to about five key numbers to prevent cognitive overload.
- Consider adding a subtle pulse animation on the status dot for healthy servers (already used in the VPS dashboard's `.status-dot` CSS).

**Gotcha — CF Workers cannot fetch bare IP addresses:** The existing code (line 88-89 comment in servers.ts) notes that CF Workers cannot call `http://<ip>` URLs due to Cloudflare error 1003. The click-through to VPS dashboards must use the WSS endpoint hostname, not an IP. The `openVpsDashboard` function already handles this conversion.

## Estimation
**M (Medium)** — The backend logic is largely an extension of the existing `handleListServers` with KV integration. The Preact component is a rewrite of existing inline HTML into proper components. No new infrastructure beyond a KV namespace. Estimated 2-3 days.
