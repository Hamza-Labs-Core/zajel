/**
 * Federation Topology Graph API (US-5.3)
 *
 * Provides a graph structure for visualizing the federation network:
 * - Nodes: each server with status, metrics, and position info
 * - Edges: connections between servers derived from gossip RTT data
 * - Summary: aggregate statistics for the graph
 *
 * GET /admin/api/federation/topology
 */

import type {
  Env,
  ApiResponse,
  TopologyNode,
  TopologyEdge,
  TopologySummary,
  FederationTopologyData,
} from '../types.js';
import { requireAuth } from './auth.js';

/** TTL for considering a server offline (5 minutes in ms) */
const OFFLINE_TTL = 5 * 60 * 1000;

/** TTL for considering a server suspect (2 minutes in ms) */
const SUSPECT_TTL = 2 * 60 * 1000;

/** D1 row type for topology node query */
interface TopologyNodeRow {
  server_id: string;
  region: string | null;
  timestamp: number;
  connections_total: number;
  cpu_percent: number | null;
  federation_alive_members: number | null;
  federation_total_members: number | null;
  gossip_rtt_p50_ms: number | null;
}

/** D1 row type for gossip edge query (pairwise RTT from server_metrics) */
interface GossipEdgeRow {
  source_server_id: string;
  target_server_id: string;
  avg_rtt_ms: number;
  last_seen: number;
}

/**
 * Classify node status based on heartbeat freshness and federation membership.
 */
export function classifyNodeStatus(
  aliveMembers: number | null,
  totalMembers: number | null,
  lastSeen: number,
  now: number,
): 'alive' | 'suspect' | 'failed' | 'offline' {
  const elapsed = now - lastSeen;

  // Offline: no heartbeat within 5 minutes
  if (elapsed > OFFLINE_TTL) {
    return 'offline';
  }

  // Failed: server reports zero alive members out of a nonzero total
  if (totalMembers !== null && totalMembers > 0 && (aliveMembers === null || aliveMembers === 0)) {
    return 'failed';
  }

  // Suspect: heartbeat stale (2-5 min) or partial membership loss
  if (elapsed > SUSPECT_TTL) {
    return 'suspect';
  }
  if (
    aliveMembers !== null &&
    totalMembers !== null &&
    totalMembers > 0 &&
    aliveMembers < totalMembers
  ) {
    return 'suspect';
  }

  return 'alive';
}

/**
 * Handle GET /admin/api/federation/topology
 *
 * Returns the federation topology graph with nodes, edges, and summary.
 */
export async function handleFederationTopology(
  request: Request,
  env: Env,
): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  const now = Date.now();

  // If DIAGNOSTICS_DB is not bound, return empty graph
  if (!env.DIAGNOSTICS_DB) {
    const emptyData: FederationTopologyData = {
      nodes: [],
      edges: [],
      summary: {
        totalNodes: 0,
        aliveNodes: 0,
        edgeCount: 0,
        avgLatencyMs: null,
      },
      lastUpdated: now,
    };
    return jsonResponse({ success: true, data: emptyData });
  }

  try {
    // Query 1: Latest metrics per server for nodes (bounded to last 10 min)
    const tenMinutesAgo = now - 10 * 60 * 1000;
    const nodesResult = await env.DIAGNOSTICS_DB.prepare(`
      SELECT sm.server_id, sm.region, sm.timestamp,
             sm.connections_total, sm.cpu_percent,
             sm.federation_alive_members, sm.federation_total_members,
             sm.gossip_rtt_p50_ms
      FROM server_metrics sm
      INNER JOIN (
        SELECT server_id, MAX(timestamp) as max_ts
        FROM server_metrics
        WHERE timestamp >= ?
        GROUP BY server_id
      ) latest ON sm.server_id = latest.server_id AND sm.timestamp = latest.max_ts
      ORDER BY sm.server_id ASC
    `).bind(tenMinutesAgo).all<TopologyNodeRow>();

    const nodeRows = nodesResult.results ?? [];

    // Build nodes
    const nodes: TopologyNode[] = nodeRows.map((row) => ({
      serverId: row.server_id,
      region: row.region || 'unknown',
      endpoint: '',  // Endpoint comes from bootstrap registry, not D1
      status: classifyNodeStatus(
        row.federation_alive_members,
        row.federation_total_members,
        row.timestamp,
        now,
      ),
      aliveMembers: row.federation_alive_members ?? 0,
      totalMembers: row.federation_total_members ?? 0,
      cpuPercent: row.cpu_percent ?? 0,
      connectionsTotal: row.connections_total,
      lastSeen: row.timestamp,
    }));

    // Build edges: pair each server with every other server where both
    // report being in the federation (totalMembers > 1 and aliveMembers > 0).
    // Use their gossip RTT p50 as a latency proxy.
    const edges: TopologyEdge[] = [];
    const seenPairs = new Set<string>();

    for (let i = 0; i < nodeRows.length; i++) {
      for (let j = i + 1; j < nodeRows.length; j++) {
        const a = nodeRows[i]!;
        const b = nodeRows[j]!;

        // Both must report being part of a federation with multiple members
        const aInFederation = (a.federation_total_members ?? 0) > 1 && (a.federation_alive_members ?? 0) > 0;
        const bInFederation = (b.federation_total_members ?? 0) > 1 && (b.federation_alive_members ?? 0) > 0;

        if (!aInFederation || !bInFederation) continue;

        // Deduplicate: canonical key is alphabetically sorted pair
        const pairKey = [a.server_id, b.server_id].sort().join('::');
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        // Average the gossip RTT p50 from both nodes (where available)
        const rtts: number[] = [];
        if (a.gossip_rtt_p50_ms !== null) rtts.push(a.gossip_rtt_p50_ms);
        if (b.gossip_rtt_p50_ms !== null) rtts.push(b.gossip_rtt_p50_ms);

        const avgLatency = rtts.length > 0
          ? Math.round((rtts.reduce((sum, v) => sum + v, 0) / rtts.length) * 100) / 100
          : 0;

        edges.push({
          source: a.server_id,
          target: b.server_id,
          latencyMs: avgLatency,
          lastSeen: Math.max(a.timestamp, b.timestamp),
        });
      }
    }

    // Compute summary
    const aliveNodes = nodes.filter((n) => n.status === 'alive').length;
    const allLatencies = edges.map((e) => e.latencyMs).filter((l) => l > 0);
    const avgLatencyMs = allLatencies.length > 0
      ? Math.round((allLatencies.reduce((sum, v) => sum + v, 0) / allLatencies.length) * 100) / 100
      : null;

    const summary: TopologySummary = {
      totalNodes: nodes.length,
      aliveNodes,
      edgeCount: edges.length,
      avgLatencyMs,
    };

    const data: FederationTopologyData = {
      nodes,
      edges,
      summary,
      lastUpdated: now,
    };

    return jsonResponse({ success: true, data });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('Federation topology query failed:', errMsg);
    return jsonResponse(
      { success: false, error: 'Failed to query federation topology' },
      500,
    );
  }
}

/**
 * JSON response helper
 */
function jsonResponse<T>(data: ApiResponse<T>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
