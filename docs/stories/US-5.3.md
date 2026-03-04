# US-5.3: Federation Topology

## Story
As an admin, I want to see the federation network graph, so that I can understand which servers are connected, identify isolated nodes, and monitor the health of the gossip-based federation mesh.

## Acceptance Criteria
- Server Health tab includes a "Federation Topology" section displaying an interactive network graph
- Graph shows each VPS server as a node, colored by membership status:
  - Green: alive (actively participating in gossip)
  - Yellow: suspect (missed recent pings, under suspicion timeout)
  - Red: failed (exceeded failure timeout, considered down)
  - Gray: left (gracefully departed the federation)
- Edges between nodes represent active gossip connections; edge thickness or style may indicate connection quality
- The local server (the one being viewed, if accessed from a specific VPS context) is visually distinguished (larger node, different border)
- Nodes display: shortened server ID (first 8 chars), region label, and connection count on hover/tooltip
- The graph layout automatically adjusts when nodes join or leave; supports drag-to-reposition individual nodes
- A legend explains the color coding and node/edge meanings
- The graph updates in real time when federation topology changes (via the existing VPS WebSocket `federation` message type, proxied through admin-cf)
- When no federation peers exist (single-server deployment), the graph shows a single node with a message: "Solo mode -- no federation peers connected"

## Technical Design

### Architecture
Federation topology data is already collected by the VPS `MetricsCollector.getFederationTopology()` method and broadcast via the `AdminWebSocketHandler` whenever the topology changes. The admin-cf portal needs to:

1. Aggregate topology data from all VPS servers (each VPS only knows its own view)
2. Merge the per-server topologies into a unified federation graph
3. Render the graph in the Preact SPA using a lightweight graph visualization library

```
VPS-1 --> /admin/api/federation --> { nodes: [...], edges: [...] }
VPS-2 --> /admin/api/federation --> { nodes: [...], edges: [...] }
VPS-N --> /admin/api/federation --> { nodes: [...], edges: [...] }

admin-cf Worker --> fetches topology from each VPS via proxy
               --> merges into unified graph (dedup nodes, union edges)
               --> returns to Preact SPA

Preact SPA --> renders interactive force-directed graph
```

### Implementation Details

**Backend (admin-cf Worker):**

1. Add `GET /admin/api/federation/topology` endpoint:
   - Fetches the server list from the bootstrap registry (reuses `fetchFromBootstrap`)
   - For each server, attempts to proxy `GET /admin/api/federation` to the VPS
   - Merges all topology responses: deduplicates nodes by `id`, unions all edges, takes the most recent status for each node (from the VPS that reports it as most-alive)
   - Falls back: if a VPS is unreachable, mark its node as "failed" in the merged graph
   - Caches the merged topology in `ADMIN_KV` with a 15-second TTL

2. The merging algorithm:
   - Create a `Map<serverId, FederationNode>` from all responses
   - For each node appearing in multiple responses, prefer status in order: alive > suspect > failed > left
   - Edges: collect all unique `{source, target}` pairs (normalize by sorting source/target so A->B and B->A are the same edge)
   - Add `latency` to edges if available from VPS metrics

**Frontend (Preact SPA):**

1. Use **Cytoscape.js** for the interactive graph rendering. It is framework-agnostic (works with Preact/vanilla JS), MIT-licensed, lightweight (~200KB minified), and supports:
   - Force-directed layout (cose layout) for automatic node positioning
   - Node coloring, sizing, and labeling
   - Edge styling (thickness, color, dashing)
   - Drag-to-reposition
   - Hover tooltips
   - Zoom and pan
   - Event handlers for node clicks

2. Create a `FederationGraph` Preact component:
   - On mount, fetches `/admin/api/federation/topology`
   - Initializes a Cytoscape instance targeting a container div
   - Maps `FederationNode[]` to Cytoscape node elements with classes for status coloring
   - Maps `FederationEdge[]` to Cytoscape edge elements
   - Sets up a 15-second polling interval for topology updates
   - On update, diffs the new graph against the current one and applies incremental changes (add/remove/update nodes and edges) to avoid layout jumps
   - Node click handler: navigates to that server's VPS dashboard (same SSO as US-5.1)

3. Create a `FederationLegend` component showing color meanings and node/edge explanations.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/admin-cf/src/routes/federation.ts` | Create | `handleFederationTopology` — fetches from all VPS servers, merges, caches |
| `packages/admin-cf/src/index.ts` | Modify | Register `/admin/api/federation/topology` route |
| `packages/admin-cf/src/types.ts` | Modify | Add `MergedFederationTopology`, `MergedFederationNode`, `MergedFederationEdge` interfaces |
| `packages/admin-cf/src/dashboard/components/FederationGraph.tsx` | Create | Cytoscape-based interactive graph component |
| `packages/admin-cf/src/dashboard/components/FederationLegend.tsx` | Create | Legend explaining node colors and edge meanings |
| `packages/admin-cf/src/dashboard/hooks/useFederationTopology.ts` | Create | Hook for fetching and polling topology data |
| `packages/admin-cf/package.json` | Modify | Add `cytoscape` dependency |
| `packages/admin-cf/tests/routes/federation.test.ts` | Create | Tests for topology merge logic |
| `packages/admin-cf/tests/dashboard/FederationGraph.test.tsx` | Create | Component tests for graph rendering |

### Data Models / Schemas

```typescript
// Reuses existing types from packages/server-vps/src/admin/types.ts
// FederationTopology, FederationNode, FederationEdge

// Merged topology for the admin-cf unified view
interface MergedFederationTopology {
  nodes: MergedFederationNode[];
  edges: MergedFederationEdge[];
  lastUpdated: number;         // Timestamp of the merge
  serverCount: number;         // Total servers queried
  reachableCount: number;      // Servers that responded
}

interface MergedFederationNode {
  id: string;                  // Full server ID
  shortId: string;             // First 8 characters
  region: string;
  status: 'alive' | 'suspect' | 'failed' | 'left' | 'unknown';
  isReachable: boolean;        // Whether admin-cf could reach this VPS
  connections: number;         // Total connection count (if known)
  federationPeers: number;     // Number of gossip peers this node sees
  lastSeen: number;            // Most recent timestamp from any source
}

interface MergedFederationEdge {
  source: string;              // Server ID
  target: string;              // Server ID
  latency?: number;            // Round-trip latency in ms (if available)
  bidirectional: boolean;      // true if both sides report the connection
}

// Cytoscape element format (internal to the component)
interface CytoscapeNodeData {
  id: string;
  label: string;
  status: string;
  region: string;
  tooltip: string;
}

interface CytoscapeEdgeData {
  id: string;
  source: string;
  target: string;
  latency?: number;
}
```

### API Endpoints

**GET /admin/api/federation/topology**

Request: Requires `Authorization: Bearer <jwt>` header.

Response (200):
```json
{
  "success": true,
  "data": {
    "nodes": [
      {
        "id": "ed25519:abc123...",
        "shortId": "ed25519:a",
        "region": "us-east",
        "status": "alive",
        "isReachable": true,
        "connections": 42,
        "federationPeers": 2,
        "lastSeen": 1709380800000
      },
      {
        "id": "ed25519:def456...",
        "shortId": "ed25519:d",
        "region": "eu-west",
        "status": "alive",
        "isReachable": true,
        "connections": 38,
        "federationPeers": 2,
        "lastSeen": 1709380795000
      }
    ],
    "edges": [
      {
        "source": "ed25519:abc123...",
        "target": "ed25519:def456...",
        "latency": 85,
        "bidirectional": true
      }
    ],
    "lastUpdated": 1709380810000,
    "serverCount": 3,
    "reachableCount": 2
  }
}
```

## Dependencies
- **US-5.1 (Per-Server Status):** The Server Health tab must exist for the federation graph to have a home. The server list (bootstrap registry data) is also needed to know which VPS servers to query.
- **Admin-cf Preact SPA migration:** Required for the Preact component.
- **Existing VPS federation endpoint:** The VPS already exposes `GET /admin/api/federation` (in `packages/server-vps/src/admin/routes.ts`, lines 84-88) which returns `FederationTopology` via `MetricsCollector.getFederationTopology()`. No VPS-side changes needed.
- **External:** `cytoscape` npm package (MIT license, ~200KB minified). Compatible with Preact since it is framework-agnostic and renders to a DOM container.
- **CF Worker limitation:** CF Workers cannot fetch bare IP addresses. If VPS servers use IP-based endpoints, the proxy will fail for those. The implementation must handle this gracefully (mark node as unreachable).

## Testing Strategy

### Unit Tests
- **Topology merge logic:**
  - Two VPS responses with overlapping nodes: deduplication produces one entry per unique server ID
  - Status precedence: alive > suspect > failed > left when different VPS servers report different statuses for the same node
  - Edge deduplication: A->B from VPS-1 and B->A from VPS-2 collapse into one bidirectional edge
  - Unreachable VPS: its self-node marked as "failed" with `isReachable: false`
  - Single VPS (solo mode): returns one node, zero edges
  - Latency on edges: averaged when both sides report latency
- **Cache:**
  - KV hit within TTL returns cached topology
  - KV miss triggers fresh fetch from all VPS servers

### Integration Tests
- Admin-cf fetches topology from multiple VPS mock servers and returns merged result
- Admin-cf handles partial failure (one VPS down, others respond) gracefully
- Auth is enforced on the endpoint

### Component Tests (Preact)
- `FederationGraph` initializes Cytoscape with correct number of nodes and edges from mock data
- Node colors map correctly: alive=green, suspect=yellow, failed=red, left=gray
- Solo mode renders single node with solo message text
- `FederationLegend` renders all status colors with labels
- Graph updates incrementally: adding a node does not reset positions of existing nodes
- Node click triggers navigation to VPS dashboard

## Technical Notes

**Why Cytoscape.js over alternatives:**
- **vis.js** (vis-network): Also MIT, also framework-agnostic. However, Cytoscape.js has better documentation for custom styling, more flexible layout algorithms, and better support for incremental graph updates. vis.js is also suitable but Cytoscape.js is the more actively maintained option.
- **D3.js force graph:** Lower-level; requires more code to implement drag, zoom, tooltips, and incremental updates. Better for custom visualizations but overkill for a standard node-edge graph.
- **reagraph / WebGL-based:** React-specific and heavyweight. Unnecessary for a graph with at most a few dozen nodes.
- Cytoscape.js is used in production by Grafana for their service topology visualization, validating its suitability for infrastructure monitoring dashboards.

**Codebase patterns to follow:**
- The existing VPS dashboard inline HTML already renders a federation graph using absolute-positioned `<div>` nodes (lines 984-1028 in routes.ts). The Preact component replaces this with a proper graph library while maintaining the same dark-theme color scheme.
- The existing `FederationTopology` type in `packages/server-vps/src/admin/types.ts` defines `FederationNode` with `id`, `region`, `status`, `isLocal` and `FederationEdge` with `source`, `target`, optional `latency`. The admin-cf merged type extends these.
- The `MetricsCollector.getFederationTopology()` method (lines 130-163 in metrics.ts) builds the topology from the `FederationManager.getMembers()` call. Each VPS only sees its own direct peers, not the full mesh — hence the need for server-side merging.

**SWIM gossip specifics:**
- The SWIM protocol uses probe (ping), indirect probe (ping-req), and state sync messages. The membership table tracks each node's status as alive/suspect/failed/left with an incarnation number for conflict resolution.
- When visualizing, "suspect" is an important intermediate state — it means the node missed a ping round but has not yet been declared failed. The suspicion timeout is configurable (`ZAJEL_SUSPICION_TIMEOUT`, default 2s).
- The gossip state exchange happens every 30 seconds by default (`ZAJEL_STATE_EXCHANGE_INTERVAL`). The topology visualization should poll at a comparable or slower rate (15 seconds chosen).

**Gotcha — partial views:**
Each VPS server only knows about the peers it has direct gossip connections with. In a 5-node mesh, VPS-1 might see {VPS-2, VPS-3} while VPS-3 sees {VPS-1, VPS-4, VPS-5}. The merge must union all views to reconstruct the full topology. Edge bidirectionality tracking helps identify asymmetric connectivity issues.

## Estimation
**L (Large)** — The backend topology merge logic is moderately complex (multi-server fetch, deduplication, status precedence). The frontend Cytoscape integration requires library setup, custom styling, incremental update diffing, and interactive features. Estimated 4-5 days.
