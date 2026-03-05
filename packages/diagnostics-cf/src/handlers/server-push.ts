/**
 * POST /diagnostics/server-metrics — Server metrics push handler.
 *
 * Accepts periodic metrics snapshots from VPS servers and stores
 * them in the D1 server_metrics table. Authenticated via a shared
 * secret (server-to-server, not JWT).
 *
 * Also performs cleanup of rows older than 7 days on each push
 * to keep the table size bounded.
 */

import type { Env, ServerMetricsPush, ApiResponse } from '../types.js';

/** Maximum age for server metrics rows (7 days in milliseconds). */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Maximum request body size for metrics push (16 KB). */
const MAX_PUSH_BODY_SIZE = 16 * 1024;

/**
 * Validate the server metrics push payload.
 * Returns null on success or an error string on failure.
 */
export function validateServerMetricsPush(
  body: unknown,
): { valid: true; data: ServerMetricsPush } | { valid: false; error: string } {
  if (body === null || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be a JSON object' };
  }

  const obj = body as Record<string, unknown>;

  // serverId
  if (!obj['serverId'] || typeof obj['serverId'] !== 'string') {
    return { valid: false, error: 'Missing or invalid field: serverId' };
  }

  // region
  if (!obj['region'] || typeof obj['region'] !== 'string') {
    return { valid: false, error: 'Missing or invalid field: region' };
  }

  // timestamp
  if (typeof obj['timestamp'] !== 'number' || obj['timestamp'] <= 0) {
    return { valid: false, error: 'Missing or invalid field: timestamp' };
  }

  // metrics
  if (!obj['metrics'] || typeof obj['metrics'] !== 'object') {
    return { valid: false, error: 'Missing or invalid field: metrics' };
  }

  const metrics = obj['metrics'] as Record<string, unknown>;

  // metrics.connections
  if (!metrics['connections'] || typeof metrics['connections'] !== 'object') {
    return { valid: false, error: 'Missing or invalid field: metrics.connections' };
  }
  const conn = metrics['connections'] as Record<string, unknown>;
  if (typeof conn['total'] !== 'number' || typeof conn['relay'] !== 'number' || typeof conn['signaling'] !== 'number') {
    return { valid: false, error: 'metrics.connections must have numeric total, relay, signaling' };
  }

  // metrics.entropy
  if (!metrics['entropy'] || typeof metrics['entropy'] !== 'object') {
    return { valid: false, error: 'Missing or invalid field: metrics.entropy' };
  }
  const entropy = metrics['entropy'] as Record<string, unknown>;
  if (typeof entropy['activeCodes'] !== 'number' || typeof entropy['collisionRisk'] !== 'string') {
    return { valid: false, error: 'metrics.entropy must have numeric activeCodes and string collisionRisk' };
  }

  // metrics.federation
  if (!metrics['federation'] || typeof metrics['federation'] !== 'object') {
    return { valid: false, error: 'Missing or invalid field: metrics.federation' };
  }
  const fed = metrics['federation'] as Record<string, unknown>;
  if (typeof fed['aliveMembers'] !== 'number' || typeof fed['totalMembers'] !== 'number') {
    return { valid: false, error: 'metrics.federation must have numeric aliveMembers and totalMembers' };
  }

  // metrics.messageRate
  if (!metrics['messageRate'] || typeof metrics['messageRate'] !== 'object') {
    return { valid: false, error: 'Missing or invalid field: metrics.messageRate' };
  }
  const rate = metrics['messageRate'] as Record<string, unknown>;
  if (typeof rate['perSecond'] !== 'number' || typeof rate['perMinute'] !== 'number') {
    return { valid: false, error: 'metrics.messageRate must have numeric perSecond and perMinute' };
  }

  // metrics.system
  if (!metrics['system'] || typeof metrics['system'] !== 'object') {
    return { valid: false, error: 'Missing or invalid field: metrics.system' };
  }
  const sys = metrics['system'] as Record<string, unknown>;
  if (typeof sys['cpuPercent'] !== 'number' || typeof sys['memoryMb'] !== 'number' || typeof sys['uptimeSeconds'] !== 'number') {
    return { valid: false, error: 'metrics.system must have numeric cpuPercent, memoryMb, uptimeSeconds' };
  }

  // metrics.gossipLatency (optional — backward compatible)
  let gossipLatency: ServerMetricsPush['metrics']['gossipLatency'] = undefined;
  if (metrics['gossipLatency'] && typeof metrics['gossipLatency'] === 'object') {
    const gl = metrics['gossipLatency'] as Record<string, unknown>;
    if (typeof gl['p50Ms'] !== 'number' || typeof gl['p95Ms'] !== 'number' ||
        typeof gl['p99Ms'] !== 'number' || typeof gl['pingCount'] !== 'number') {
      return { valid: false, error: 'metrics.gossipLatency must have numeric p50Ms, p95Ms, p99Ms, pingCount' };
    }
    gossipLatency = {
      p50Ms: gl['p50Ms'] as number,
      p95Ms: gl['p95Ms'] as number,
      p99Ms: gl['p99Ms'] as number,
      pingCount: gl['pingCount'] as number,
    };
  }

  return {
    valid: true,
    data: {
      serverId: obj['serverId'] as string,
      region: obj['region'] as string,
      timestamp: obj['timestamp'] as number,
      metrics: {
        connections: {
          total: conn['total'] as number,
          relay: conn['relay'] as number,
          signaling: conn['signaling'] as number,
        },
        entropy: {
          activeCodes: entropy['activeCodes'] as number,
          collisionRisk: entropy['collisionRisk'] as string,
        },
        federation: {
          aliveMembers: fed['aliveMembers'] as number,
          totalMembers: fed['totalMembers'] as number,
        },
        messageRate: {
          perSecond: rate['perSecond'] as number,
          perMinute: rate['perMinute'] as number,
        },
        system: {
          cpuPercent: sys['cpuPercent'] as number,
          memoryMb: sys['memoryMb'] as number,
          uptimeSeconds: sys['uptimeSeconds'] as number,
        },
        gossipLatency,
      },
    },
  };
}

/**
 * Handle POST /diagnostics/server-metrics request.
 */
export async function handleServerMetricsPush(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Authenticate via shared secret
  if (!env.SERVER_METRICS_SECRET) {
    return jsonResponse(
      { success: false, error: 'Server metrics ingestion not configured' },
      503,
    );
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || authHeader !== `Bearer ${env.SERVER_METRICS_SECRET}`) {
    return jsonResponse(
      { success: false, error: 'Unauthorized' },
      401,
    );
  }

  // Check content length
  const contentLength = request.headers.get('Content-Length');
  if (contentLength && parseInt(contentLength, 10) > MAX_PUSH_BODY_SIZE) {
    return jsonResponse(
      { success: false, error: 'Request body too large' },
      413,
    );
  }

  // Parse JSON body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      { success: false, error: 'Invalid JSON body' },
      400,
    );
  }

  // Validate
  const validation = validateServerMetricsPush(body);
  if (!validation.valid) {
    return jsonResponse(
      { success: false, error: validation.error },
      400,
    );
  }

  const data = validation.data;
  const m = data.metrics;

  // Insert into D1 (including optional gossip latency columns)
  const gl = m.gossipLatency;
  const insertPromise = env.DB.prepare(
    `INSERT INTO server_metrics (
      server_id, region, timestamp,
      connections_total, connections_relay, connections_signaling,
      entropy_active_codes, entropy_collision_risk,
      federation_alive_members, federation_total_members,
      message_rate_per_second, message_rate_per_minute,
      cpu_percent, memory_mb, uptime_seconds,
      gossip_rtt_p50_ms, gossip_rtt_p95_ms, gossip_rtt_p99_ms, gossip_ping_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      data.serverId,
      data.region,
      data.timestamp,
      m.connections.total,
      m.connections.relay,
      m.connections.signaling,
      m.entropy.activeCodes,
      m.entropy.collisionRisk,
      m.federation.aliveMembers,
      m.federation.totalMembers,
      m.messageRate.perSecond,
      m.messageRate.perMinute,
      m.system.cpuPercent,
      m.system.memoryMb,
      m.system.uptimeSeconds,
      gl?.p50Ms ?? null,
      gl?.p95Ms ?? null,
      gl?.p99Ms ?? null,
      gl?.pingCount ?? 0,
    )
    .run();

  // Cleanup old rows (fire-and-forget via waitUntil)
  const cutoffMs = Date.now() - RETENTION_MS;
  const cleanupPromise = env.DB.prepare(
    'DELETE FROM server_metrics WHERE timestamp < ?',
  )
    .bind(cutoffMs)
    .run();

  // Fire both writes; cleanup is background
  ctx.waitUntil(
    cleanupPromise.catch((err) => {
      console.error('Server metrics cleanup error:', err);
    }),
  );

  try {
    await insertPromise;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('Failed to insert server metrics:', errMsg);
    return jsonResponse(
      { success: false, error: 'Failed to store metrics' },
      500,
    );
  }

  return jsonResponse(
    { success: true, data: { received: true } },
    200,
  );
}

/**
 * JSON response helper.
 */
function jsonResponse<T>(
  body: ApiResponse<T>,
  status: number,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
