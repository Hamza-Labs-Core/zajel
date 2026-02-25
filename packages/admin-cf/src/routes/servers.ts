/**
 * Server list route handlers
 * Fetches VPS server info from the bootstrap registry
 *
 * Uses a CF Service Binding (BOOTSTRAP_SERVICE) to call the bootstrap
 * worker directly. This avoids 530 errors that occur when one CF Worker
 * calls another via its custom domain on the same Cloudflare zone.
 */

import type { Env, VpsServer, ApiResponse } from '../types.js';
import { requireAuth } from './auth.js';

// Default bootstrap URL if not configured (fallback for local dev)
const DEFAULT_BOOTSTRAP_URL = 'https://signal.zajel.hamzalabs.dev';

// Health check timeout in milliseconds
const HEALTH_CHECK_TIMEOUT = 5000;

// TTL for considering a server offline (5 minutes)
const OFFLINE_TTL = 5 * 60 * 1000;

/**
 * Fetch from the bootstrap registry, preferring the service binding.
 *
 * Service bindings route the request internally within Cloudflare,
 * bypassing the public internet and avoiding CF-to-CF 530 errors.
 * Falls back to a regular fetch if the binding is not configured
 * (e.g., during local development).
 */
async function fetchFromBootstrap(
  path: string,
  env: Env
): Promise<Response> {
  if (env.BOOTSTRAP_SERVICE) {
    // Use service binding — the URL is ignored for routing but must be valid
    return env.BOOTSTRAP_SERVICE.fetch(
      new Request(`https://bootstrap-internal${path}`, {
        headers: { 'Accept': 'application/json' },
      })
    );
  }

  // Fallback: fetch via public URL (works in local dev, fails in prod CF-to-CF)
  const bootstrapUrl = env.ZAJEL_BOOTSTRAP_URL || DEFAULT_BOOTSTRAP_URL;
  return fetch(`${bootstrapUrl}${path}`, {
    headers: { 'Accept': 'application/json' },
  });
}

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

  try {
    // Fetch server list from bootstrap registry
    const response = await fetchFromBootstrap('/servers', env);

    if (!response.ok) {
      return jsonResponse({
        success: false,
        error: `Bootstrap registry returned ${response.status}`,
      }, 502);
    }

    interface RegistryServer {
      serverId?: string;
      endpoint: string;
      region?: string;
      lastSeen?: number;
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
          lastHeartbeat: server.lastSeen || server.lastHeartbeat || Date.now(),
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
          // Convert WS endpoint to HTTP base URL (strip any path component)
          const wsUrl = new URL(server.endpoint.replace('wss://', 'https://').replace('ws://', 'http://'));
          const statsUrl = `${wsUrl.protocol}//${wsUrl.host}`;
          const statsResponse = await fetch(`${statsUrl}/stats`, {
            signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT),
          });

          console.log(`Health check ${statsUrl}/stats: ${statsResponse.status} ${statsResponse.statusText}`);
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
                pairingCodeEntropy?: {
                  collisionRisk?: 'low' | 'medium' | 'high';
                };
              }
              const metrics = await metricsResponse.json() as MetricsData;
              const risk = metrics.pairingCodeEntropy?.collisionRisk || metrics.collisionRisk;
              if (risk === 'high') {
                vpsServer.status = 'degraded';
              }
            }
          } else {
            vpsServer.status = 'degraded';
          }
        } catch (healthError) {
          // Server unreachable — log the error for debugging
          console.error(`Health check failed for ${server.endpoint}:`, healthError instanceof Error ? healthError.message : String(healthError));
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
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('Failed to fetch servers:', errMsg);
    return jsonResponse({
      success: false,
      error: `Failed to fetch server list from bootstrap registry: ${errMsg}`,
    }, 502);
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
