/**
 * Federation Topology Graph Unit Tests (US-5.3)
 *
 * Tests for handleFederationTopology route handler and classifyNodeStatus.
 * Mocks auth and D1 to test response structure and business logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleFederationTopology, classifyNodeStatus } from '../../src/routes/federation-topology.js';
import type { Env } from '../../src/types.js';

// ─── Mock Helpers ───────────────────────────────────────────

function mockRequest(token = 'valid-token'): Request {
  const url = new URL('https://admin.zajel.hamzalabs.dev/admin/api/federation/topology');
  return new Request(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}

interface PrepareCall {
  query: string;
  allResults?: unknown[];
}

function createMockD1(prepareCalls: PrepareCall[]): D1Database {
  const prepareFn = vi.fn().mockImplementation((query: string) => {
    for (const call of prepareCalls) {
      if (query.includes(call.query)) {
        return {
          bind: vi.fn().mockReturnThis(),
          all: vi.fn().mockResolvedValue({ results: call.allResults || [], success: true }),
          first: vi.fn().mockResolvedValue(null),
        };
      }
    }
    return {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [], success: true }),
      first: vi.fn().mockResolvedValue(null),
    };
  });

  return { prepare: prepareFn } as unknown as D1Database;
}

function createMockEnv(db?: D1Database): Env {
  return {
    ADMIN_USERS: {} as DurableObjectNamespace,
    ZAJEL_ADMIN_JWT_SECRET: 'test-secret-key-for-jwt-signing-32chars!!',
    DIAGNOSTICS_DB: db,
  };
}

// ─── Mock auth module ──────────────────────────────────────

vi.mock('../../src/routes/auth.js', () => ({
  requireAuth: vi.fn().mockResolvedValue({
    sub: 'user-1',
    username: 'admin',
    role: 'super-admin' as const,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
}));

// ─── classifyNodeStatus Tests ──────────────────────────────

describe('classifyNodeStatus', () => {
  it('returns "alive" for a fresh server with full membership', () => {
    const now = Date.now();
    expect(classifyNodeStatus(3, 3, now, now)).toBe('alive');
  });

  it('returns "alive" for a server seen 1 minute ago with full membership', () => {
    const now = Date.now();
    const oneMinuteAgo = now - 60 * 1000;
    expect(classifyNodeStatus(3, 3, oneMinuteAgo, now)).toBe('alive');
  });

  it('returns "suspect" when aliveMembers < totalMembers', () => {
    const now = Date.now();
    expect(classifyNodeStatus(2, 3, now, now)).toBe('suspect');
  });

  it('returns "suspect" when heartbeat is between 2-5 minutes old', () => {
    const now = Date.now();
    const threeMinutesAgo = now - 3 * 60 * 1000;
    expect(classifyNodeStatus(3, 3, threeMinutesAgo, now)).toBe('suspect');
  });

  it('returns "failed" when alive is 0 but total > 0', () => {
    const now = Date.now();
    expect(classifyNodeStatus(0, 3, now, now)).toBe('failed');
  });

  it('returns "failed" when alive is null but total > 0', () => {
    const now = Date.now();
    expect(classifyNodeStatus(null, 3, now, now)).toBe('failed');
  });

  it('returns "offline" when heartbeat is older than 5 minutes', () => {
    const now = Date.now();
    const sixMinutesAgo = now - 6 * 60 * 1000;
    expect(classifyNodeStatus(3, 3, sixMinutesAgo, now)).toBe('offline');
  });

  it('returns "offline" even with failed membership when heartbeat > 5 min', () => {
    const now = Date.now();
    const sixMinutesAgo = now - 6 * 60 * 1000;
    // Offline takes precedence over failed
    expect(classifyNodeStatus(0, 3, sixMinutesAgo, now)).toBe('offline');
  });

  it('returns "alive" when both aliveMembers and totalMembers are null', () => {
    const now = Date.now();
    // No federation data reported = no membership loss detected
    expect(classifyNodeStatus(null, null, now, now)).toBe('alive');
  });

  it('returns "alive" when totalMembers is 0', () => {
    const now = Date.now();
    // Server not in a federation (totalMembers=0) is just alive
    expect(classifyNodeStatus(0, 0, now, now)).toBe('alive');
  });
});

// ─── handleFederationTopology Tests ────────────────────────

describe('handleFederationTopology', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty graph when DIAGNOSTICS_DB not bound', async () => {
    const req = mockRequest();
    const env = createMockEnv(undefined);
    const res = await handleFederationTopology(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      success: boolean;
      data: {
        nodes: unknown[];
        edges: unknown[];
        summary: { totalNodes: number; aliveNodes: number; edgeCount: number; avgLatencyMs: null };
        lastUpdated: number;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.nodes).toEqual([]);
    expect(body.data.edges).toEqual([]);
    expect(body.data.summary.totalNodes).toBe(0);
    expect(body.data.summary.aliveNodes).toBe(0);
    expect(body.data.summary.edgeCount).toBe(0);
    expect(body.data.summary.avgLatencyMs).toBeNull();
    expect(typeof body.data.lastUpdated).toBe('number');
  });

  it('returns topology with nodes and edges', async () => {
    const now = Date.now();
    const db = createMockD1([
      {
        query: 'server_metrics',
        allResults: [
          {
            server_id: 'srv-01',
            region: 'us-east',
            timestamp: now,
            connections_total: 42,
            cpu_percent: 25.5,
            federation_alive_members: 3,
            federation_total_members: 3,
            gossip_rtt_p50_ms: 10,
          },
          {
            server_id: 'srv-02',
            region: 'eu-west',
            timestamp: now,
            connections_total: 80,
            cpu_percent: 45.0,
            federation_alive_members: 3,
            federation_total_members: 3,
            gossip_rtt_p50_ms: 20,
          },
          {
            server_id: 'srv-03',
            region: 'ap-southeast',
            timestamp: now,
            connections_total: 30,
            cpu_percent: 15.0,
            federation_alive_members: 3,
            federation_total_members: 3,
            gossip_rtt_p50_ms: 30,
          },
        ],
      },
    ]);

    const req = mockRequest();
    const env = createMockEnv(db);
    const res = await handleFederationTopology(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      success: boolean;
      data: {
        nodes: Array<{
          serverId: string;
          region: string;
          status: string;
          aliveMembers: number;
          totalMembers: number;
          cpuPercent: number;
          connectionsTotal: number;
          lastSeen: number;
        }>;
        edges: Array<{
          source: string;
          target: string;
          latencyMs: number;
          lastSeen: number;
        }>;
        summary: {
          totalNodes: number;
          aliveNodes: number;
          edgeCount: number;
          avgLatencyMs: number;
        };
      };
    };

    expect(body.success).toBe(true);

    // 3 nodes
    expect(body.data.nodes).toHaveLength(3);
    expect(body.data.nodes[0]!.serverId).toBe('srv-01');
    expect(body.data.nodes[0]!.region).toBe('us-east');
    expect(body.data.nodes[0]!.status).toBe('alive');
    expect(body.data.nodes[0]!.cpuPercent).toBe(25.5);
    expect(body.data.nodes[0]!.connectionsTotal).toBe(42);
    expect(body.data.nodes[0]!.aliveMembers).toBe(3);
    expect(body.data.nodes[0]!.totalMembers).toBe(3);

    // 3 edges (3 choose 2 = 3 pairs)
    expect(body.data.edges).toHaveLength(3);

    // Check first edge: srv-01 <-> srv-02
    const edge01to02 = body.data.edges.find(
      (e) => (e.source === 'srv-01' && e.target === 'srv-02') ||
             (e.source === 'srv-02' && e.target === 'srv-01'),
    );
    expect(edge01to02).toBeDefined();
    // Average of 10 and 20 = 15
    expect(edge01to02!.latencyMs).toBe(15);

    // Summary
    expect(body.data.summary.totalNodes).toBe(3);
    expect(body.data.summary.aliveNodes).toBe(3);
    expect(body.data.summary.edgeCount).toBe(3);
    expect(body.data.summary.avgLatencyMs).toBeGreaterThan(0);
  });

  it('classifies node status based on lastSeen freshness', async () => {
    const now = Date.now();
    const threeMinutesAgo = now - 3 * 60 * 1000;
    const sixMinutesAgo = now - 6 * 60 * 1000;

    const db = createMockD1([
      {
        query: 'server_metrics',
        allResults: [
          {
            server_id: 'srv-alive',
            region: 'us-east',
            timestamp: now,
            connections_total: 42,
            cpu_percent: 25,
            federation_alive_members: 3,
            federation_total_members: 3,
            gossip_rtt_p50_ms: 10,
          },
          {
            server_id: 'srv-suspect',
            region: 'eu-west',
            timestamp: threeMinutesAgo,
            connections_total: 20,
            cpu_percent: 10,
            federation_alive_members: 3,
            federation_total_members: 3,
            gossip_rtt_p50_ms: 50,
          },
          {
            server_id: 'srv-offline',
            region: 'ap-southeast',
            timestamp: sixMinutesAgo,
            connections_total: 0,
            cpu_percent: 0,
            federation_alive_members: 3,
            federation_total_members: 3,
            gossip_rtt_p50_ms: null,
          },
          {
            server_id: 'srv-failed',
            region: 'us-west',
            timestamp: now,
            connections_total: 5,
            cpu_percent: 5,
            federation_alive_members: 0,
            federation_total_members: 3,
            gossip_rtt_p50_ms: null,
          },
        ],
      },
    ]);

    const req = mockRequest();
    const env = createMockEnv(db);
    const res = await handleFederationTopology(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        nodes: Array<{ serverId: string; status: string }>;
      };
    };

    const nodeByServer = new Map(body.data.nodes.map((n) => [n.serverId, n.status]));
    expect(nodeByServer.get('srv-alive')).toBe('alive');
    expect(nodeByServer.get('srv-suspect')).toBe('suspect');
    expect(nodeByServer.get('srv-offline')).toBe('offline');
    expect(nodeByServer.get('srv-failed')).toBe('failed');
  });

  it('edges derived from servers in federation with avg RTT', async () => {
    const now = Date.now();
    const db = createMockD1([
      {
        query: 'server_metrics',
        allResults: [
          {
            server_id: 'srv-01',
            region: 'us-east',
            timestamp: now,
            connections_total: 42,
            cpu_percent: 25,
            federation_alive_members: 2,
            federation_total_members: 2,
            gossip_rtt_p50_ms: 10,
          },
          {
            server_id: 'srv-02',
            region: 'eu-west',
            timestamp: now,
            connections_total: 80,
            cpu_percent: 45,
            federation_alive_members: 2,
            federation_total_members: 2,
            gossip_rtt_p50_ms: 30,
          },
        ],
      },
    ]);

    const req = mockRequest();
    const env = createMockEnv(db);
    const res = await handleFederationTopology(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        edges: Array<{ source: string; target: string; latencyMs: number; lastSeen: number }>;
      };
    };

    expect(body.data.edges).toHaveLength(1);
    expect(body.data.edges[0]!.source).toBe('srv-01');
    expect(body.data.edges[0]!.target).toBe('srv-02');
    // Average of 10 and 30 = 20
    expect(body.data.edges[0]!.latencyMs).toBe(20);
    expect(body.data.edges[0]!.lastSeen).toBe(now);
  });

  it('summary computed correctly (counts, avg latency)', async () => {
    const now = Date.now();
    const threeMinutesAgo = now - 3 * 60 * 1000;

    const db = createMockD1([
      {
        query: 'server_metrics',
        allResults: [
          {
            server_id: 'srv-01',
            region: 'us-east',
            timestamp: now,
            connections_total: 42,
            cpu_percent: 25,
            federation_alive_members: 3,
            federation_total_members: 3,
            gossip_rtt_p50_ms: 10,
          },
          {
            server_id: 'srv-02',
            region: 'eu-west',
            timestamp: now,
            connections_total: 80,
            cpu_percent: 45,
            federation_alive_members: 3,
            federation_total_members: 3,
            gossip_rtt_p50_ms: 20,
          },
          {
            server_id: 'srv-03',
            region: 'ap-southeast',
            timestamp: threeMinutesAgo,
            connections_total: 30,
            cpu_percent: 15,
            federation_alive_members: 3,
            federation_total_members: 3,
            gossip_rtt_p50_ms: 30,
          },
        ],
      },
    ]);

    const req = mockRequest();
    const env = createMockEnv(db);
    const res = await handleFederationTopology(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        summary: {
          totalNodes: number;
          aliveNodes: number;
          edgeCount: number;
          avgLatencyMs: number;
        };
      };
    };

    expect(body.data.summary.totalNodes).toBe(3);
    // srv-03 is suspect (3 minutes ago), so only 2 alive
    expect(body.data.summary.aliveNodes).toBe(2);
    // 3 choose 2 = 3 edges (all are in federation with totalMembers > 1)
    expect(body.data.summary.edgeCount).toBe(3);
    // avgLatencyMs should be average of all edge latencies
    expect(body.data.summary.avgLatencyMs).toBeGreaterThan(0);
  });

  it('handles empty data (no servers)', async () => {
    const db = createMockD1([
      { query: 'server_metrics', allResults: [] },
    ]);

    const req = mockRequest();
    const env = createMockEnv(db);
    const res = await handleFederationTopology(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      success: boolean;
      data: {
        nodes: unknown[];
        edges: unknown[];
        summary: { totalNodes: number; aliveNodes: number; edgeCount: number; avgLatencyMs: null };
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.nodes).toEqual([]);
    expect(body.data.edges).toEqual([]);
    expect(body.data.summary.totalNodes).toBe(0);
    expect(body.data.summary.aliveNodes).toBe(0);
    expect(body.data.summary.edgeCount).toBe(0);
    expect(body.data.summary.avgLatencyMs).toBeNull();
  });

  it('handles servers with no gossip data (nodes but no edges)', async () => {
    const now = Date.now();
    const db = createMockD1([
      {
        query: 'server_metrics',
        allResults: [
          {
            server_id: 'srv-01',
            region: 'us-east',
            timestamp: now,
            connections_total: 42,
            cpu_percent: 25,
            federation_alive_members: 1,
            federation_total_members: 1,
            gossip_rtt_p50_ms: null,
          },
          {
            server_id: 'srv-02',
            region: 'eu-west',
            timestamp: now,
            connections_total: 80,
            cpu_percent: 45,
            federation_alive_members: 1,
            federation_total_members: 1,
            gossip_rtt_p50_ms: null,
          },
        ],
      },
    ]);

    const req = mockRequest();
    const env = createMockEnv(db);
    const res = await handleFederationTopology(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        nodes: unknown[];
        edges: unknown[];
        summary: { totalNodes: number; edgeCount: number; avgLatencyMs: null };
      };
    };

    // Nodes exist but no edges since totalMembers=1 (not a multi-member federation)
    expect(body.data.nodes).toHaveLength(2);
    expect(body.data.edges).toEqual([]);
    expect(body.data.summary.totalNodes).toBe(2);
    expect(body.data.summary.edgeCount).toBe(0);
    expect(body.data.summary.avgLatencyMs).toBeNull();
  });

  it('returns 500 on D1 error', async () => {
    const db = {
      prepare: vi.fn().mockImplementation(() => ({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockRejectedValue(new Error('D1 is unavailable')),
        first: vi.fn().mockRejectedValue(new Error('D1 is unavailable')),
      })),
    } as unknown as D1Database;

    const req = mockRequest();
    const env = createMockEnv(db);
    const res = await handleFederationTopology(req, env);

    expect(res.status).toBe(500);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('Failed to query federation topology');
  });

  it('deduplicates edges (A-B and B-A become one edge)', async () => {
    const now = Date.now();
    // Only 2 servers, should produce exactly 1 edge, not 2
    const db = createMockD1([
      {
        query: 'server_metrics',
        allResults: [
          {
            server_id: 'srv-alpha',
            region: 'us-east',
            timestamp: now,
            connections_total: 42,
            cpu_percent: 25,
            federation_alive_members: 2,
            federation_total_members: 2,
            gossip_rtt_p50_ms: 15,
          },
          {
            server_id: 'srv-beta',
            region: 'eu-west',
            timestamp: now,
            connections_total: 80,
            cpu_percent: 45,
            federation_alive_members: 2,
            federation_total_members: 2,
            gossip_rtt_p50_ms: 25,
          },
        ],
      },
    ]);

    const req = mockRequest();
    const env = createMockEnv(db);
    const res = await handleFederationTopology(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        edges: Array<{ source: string; target: string }>;
      };
    };

    // Exactly 1 edge, not 2
    expect(body.data.edges).toHaveLength(1);
    // Source should be alphabetically first
    expect(body.data.edges[0]!.source).toBe('srv-alpha');
    expect(body.data.edges[0]!.target).toBe('srv-beta');
  });

  it('returns correct response structure with all expected fields', async () => {
    const now = Date.now();
    const db = createMockD1([
      {
        query: 'server_metrics',
        allResults: [
          {
            server_id: 'srv-01',
            region: 'us-east',
            timestamp: now,
            connections_total: 42,
            cpu_percent: 25.5,
            federation_alive_members: 2,
            federation_total_members: 2,
            gossip_rtt_p50_ms: 10,
          },
        ],
      },
    ]);

    const req = mockRequest();
    const env = createMockEnv(db);
    const res = await handleFederationTopology(req, env);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    const body = await res.json() as {
      success: boolean;
      data: {
        nodes: Array<{
          serverId: string;
          region: string;
          endpoint: string;
          status: string;
          aliveMembers: number;
          totalMembers: number;
          cpuPercent: number;
          connectionsTotal: number;
          lastSeen: number;
        }>;
        edges: unknown[];
        summary: {
          totalNodes: number;
          aliveNodes: number;
          edgeCount: number;
          avgLatencyMs: number | null;
        };
        lastUpdated: number;
      };
    };

    expect(body.success).toBe(true);

    // Node field types
    const node = body.data.nodes[0]!;
    expect(typeof node.serverId).toBe('string');
    expect(typeof node.region).toBe('string');
    expect(typeof node.endpoint).toBe('string');
    expect(typeof node.status).toBe('string');
    expect(['alive', 'suspect', 'failed', 'offline']).toContain(node.status);
    expect(typeof node.aliveMembers).toBe('number');
    expect(typeof node.totalMembers).toBe('number');
    expect(typeof node.cpuPercent).toBe('number');
    expect(typeof node.connectionsTotal).toBe('number');
    expect(typeof node.lastSeen).toBe('number');

    // Summary field types
    expect(typeof body.data.summary.totalNodes).toBe('number');
    expect(typeof body.data.summary.aliveNodes).toBe('number');
    expect(typeof body.data.summary.edgeCount).toBe('number');

    // lastUpdated
    expect(typeof body.data.lastUpdated).toBe('number');
  });

  it('handles null region by defaulting to "unknown"', async () => {
    const now = Date.now();
    const db = createMockD1([
      {
        query: 'server_metrics',
        allResults: [
          {
            server_id: 'srv-01',
            region: null,
            timestamp: now,
            connections_total: 10,
            cpu_percent: null,
            federation_alive_members: null,
            federation_total_members: null,
            gossip_rtt_p50_ms: null,
          },
        ],
      },
    ]);

    const req = mockRequest();
    const env = createMockEnv(db);
    const res = await handleFederationTopology(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        nodes: Array<{ region: string; cpuPercent: number; aliveMembers: number; totalMembers: number }>;
      };
    };

    expect(body.data.nodes[0]!.region).toBe('unknown');
    expect(body.data.nodes[0]!.cpuPercent).toBe(0);
    expect(body.data.nodes[0]!.aliveMembers).toBe(0);
    expect(body.data.nodes[0]!.totalMembers).toBe(0);
  });

  it('edge latency uses available RTT when only one side reports gossip', async () => {
    const now = Date.now();
    const db = createMockD1([
      {
        query: 'server_metrics',
        allResults: [
          {
            server_id: 'srv-01',
            region: 'us-east',
            timestamp: now,
            connections_total: 42,
            cpu_percent: 25,
            federation_alive_members: 2,
            federation_total_members: 2,
            gossip_rtt_p50_ms: 50,
          },
          {
            server_id: 'srv-02',
            region: 'eu-west',
            timestamp: now,
            connections_total: 80,
            cpu_percent: 45,
            federation_alive_members: 2,
            federation_total_members: 2,
            gossip_rtt_p50_ms: null, // No gossip RTT reported by this server
          },
        ],
      },
    ]);

    const req = mockRequest();
    const env = createMockEnv(db);
    const res = await handleFederationTopology(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        edges: Array<{ latencyMs: number }>;
      };
    };

    // Only one side reports RTT (50), so latency should be 50 (not averaged with 0)
    expect(body.data.edges).toHaveLength(1);
    expect(body.data.edges[0]!.latencyMs).toBe(50);
  });

  it('no edges between servers when one is not in a multi-member federation', async () => {
    const now = Date.now();
    const db = createMockD1([
      {
        query: 'server_metrics',
        allResults: [
          {
            server_id: 'srv-01',
            region: 'us-east',
            timestamp: now,
            connections_total: 42,
            cpu_percent: 25,
            federation_alive_members: 3,
            federation_total_members: 3,
            gossip_rtt_p50_ms: 10,
          },
          {
            server_id: 'srv-02',
            region: 'eu-west',
            timestamp: now,
            connections_total: 10,
            cpu_percent: 5,
            federation_alive_members: 0,
            federation_total_members: 0, // Not in federation
            gossip_rtt_p50_ms: null,
          },
        ],
      },
    ]);

    const req = mockRequest();
    const env = createMockEnv(db);
    const res = await handleFederationTopology(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        nodes: unknown[];
        edges: unknown[];
      };
    };

    // Both nodes exist
    expect(body.data.nodes).toHaveLength(2);
    // No edges because srv-02 is not in a multi-member federation
    expect(body.data.edges).toEqual([]);
  });

  it('edge lastSeen is the max of both nodes timestamps', async () => {
    const now = Date.now();
    const twoMinutesAgo = now - 2 * 60 * 1000;

    const db = createMockD1([
      {
        query: 'server_metrics',
        allResults: [
          {
            server_id: 'srv-01',
            region: 'us-east',
            timestamp: now,
            connections_total: 42,
            cpu_percent: 25,
            federation_alive_members: 2,
            federation_total_members: 2,
            gossip_rtt_p50_ms: 10,
          },
          {
            server_id: 'srv-02',
            region: 'eu-west',
            timestamp: twoMinutesAgo,
            connections_total: 80,
            cpu_percent: 45,
            federation_alive_members: 2,
            federation_total_members: 2,
            gossip_rtt_p50_ms: 20,
          },
        ],
      },
    ]);

    const req = mockRequest();
    const env = createMockEnv(db);
    const res = await handleFederationTopology(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        edges: Array<{ lastSeen: number }>;
      };
    };

    // Edge lastSeen should be max(now, twoMinutesAgo) = now
    expect(body.data.edges[0]!.lastSeen).toBe(now);
  });
});
