/**
 * Server list route handlers
 * Fetches VPS server info from the bootstrap registry
 */

import type { Env, VpsServer, ApiResponse } from '../types.js';
import { requireAuth } from './auth.js';

// Default bootstrap URL if not configured
const DEFAULT_BOOTSTRAP_URL = 'https://signal.zajel.hamzalabs.dev';

// Health check timeout in milliseconds
const HEALTH_CHECK_TIMEOUT = 5000;

// TTL for considering a server offline (5 minutes)
const OFFLINE_TTL = 5 * 60 * 1000;

/**
 * List all VPS servers with their health status
 */
export async function handleListServers(
  request: Request,
  env: Env
): Promise<Response> {
  // Verify authentication
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  const bootstrapUrl = env.ZAJEL_BOOTSTRAP_URL || DEFAULT_BOOTSTRAP_URL;

  try {
    // Fetch server list from bootstrap registry
    const response = await fetch(`${bootstrapUrl}/servers`, {
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      return jsonResponse({
        success: false,
        error: `Bootstrap registry returned ${response.status}`,
      }, 502);
    }

    interface RegistryServer {
      endpoint: string;
      region?: string;
      lastHeartbeat?: number;
    }

    const registryData = await response.json() as { servers?: RegistryServer[] };
    const registryServers = registryData.servers || [];

    // Enrich with health checks and stats (in parallel)
    const servers: VpsServer[] = await Promise.all(
      registryServers.map(async (server: RegistryServer, index: number) => {
        const vpsServer: VpsServer = {
          id: `srv-${String(index + 1).padStart(2, '0')}`,
          endpoint: server.endpoint,
          region: server.region || 'unknown',
          lastHeartbeat: server.lastHeartbeat || Date.now(),
          status: 'healthy',
        };

        // Check if server is offline based on heartbeat
        const timeSinceHeartbeat = Date.now() - vpsServer.lastHeartbeat;
        if (timeSinceHeartbeat > OFFLINE_TTL) {
          vpsServer.status = 'offline';
          return vpsServer;
        }

        // Try to fetch stats from the server
        try {
          const statsUrl = server.endpoint.replace('wss://', 'https://').replace('ws://', 'http://');
          const statsResponse = await fetch(`${statsUrl}/stats`, {
            signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT),
          });

          if (statsResponse.ok) {
            interface StatsData {
              connections?: number;
              relayConnections?: number;
              signalingConnections?: number;
              activeCodes?: number;
              collisionRisk?: 'low' | 'medium' | 'high';
            }
            const stats = await statsResponse.json() as StatsData;
            vpsServer.stats = {
              connections: stats.connections || 0,
              relayConnections: stats.relayConnections || 0,
              signalingConnections: stats.signalingConnections || 0,
              activeCodes: stats.activeCodes || 0,
              collisionRisk: stats.collisionRisk || 'low',
            };

            // Check if metrics endpoint returns degraded status
            const metricsResponse = await fetch(`${statsUrl}/metrics`, {
              signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT),
            });
            if (metricsResponse.ok) {
              interface MetricsData {
                collisionRisk?: 'low' | 'medium' | 'high';
              }
              const metrics = await metricsResponse.json() as MetricsData;
              if (metrics.collisionRisk === 'high') {
                vpsServer.status = 'degraded';
              }
            }
          } else {
            vpsServer.status = 'degraded';
          }
        } catch {
          // Server unreachable
          vpsServer.status = 'offline';
        }

        return vpsServer;
      })
    );

    // Sort by region, then by ID
    servers.sort((a, b) => {
      if (a.region !== b.region) {
        return a.region.localeCompare(b.region);
      }
      return a.id.localeCompare(b.id);
    });

    // Calculate aggregate stats
    const aggregateStats = {
      totalServers: servers.length,
      healthyServers: servers.filter((s) => s.status === 'healthy').length,
      degradedServers: servers.filter((s) => s.status === 'degraded').length,
      offlineServers: servers.filter((s) => s.status === 'offline').length,
      totalConnections: servers.reduce((sum, s) => sum + (s.stats?.connections || 0), 0),
      byRegion: groupByRegion(servers),
    };

    return jsonResponse({
      success: true,
      data: {
        servers,
        aggregate: aggregateStats,
      },
    });
  } catch (error) {
    console.error('Failed to fetch servers:', error);
    return jsonResponse({
      success: false,
      error: 'Failed to fetch server list',
    }, 500);
  }
}

/**
 * Group servers by region
 */
function groupByRegion(servers: VpsServer[]): Record<string, number> {
  const groups: Record<string, number> = {};
  for (const server of servers) {
    groups[server.region] = (groups[server.region] || 0) + 1;
  }
  return groups;
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
