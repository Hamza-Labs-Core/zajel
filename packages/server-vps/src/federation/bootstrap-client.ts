/**
 * Bootstrap Client
 *
 * Handles registration with the CF Workers bootstrap server
 * and discovery of peer VPS servers.
 */

import type { ServerConfig, ServerIdentity } from '../types.js';
import { base64Encode } from '../identity/server-identity.js';

export interface BootstrapServerEntry {
  serverId: string;
  endpoint: string;
  publicKey: string;
  region: string;
  registeredAt: number;
  lastSeen: number;
}

export interface BootstrapClient {
  register(): Promise<void>;
  unregister(): Promise<void>;
  getServers(): Promise<BootstrapServerEntry[]>;
  startHeartbeat(onPeersDiscovered?: (peers: BootstrapServerEntry[]) => void): void;
  stopHeartbeat(): void;
}

export interface BootstrapMetrics {
  connections: number;
  relayConnections: number;
  signalingConnections: number;
  activeCodes: number;
}

export function createBootstrapClient(
  config: ServerConfig,
  identity: ServerIdentity,
  getMetrics?: () => BootstrapMetrics
): BootstrapClient {
  let heartbeatTimer: NodeJS.Timeout | null = null;
  const baseUrl = config.bootstrap.serverUrl;

  async function register(): Promise<void> {
    const url = `${baseUrl}/servers`;

    const metrics = getMetrics?.();
    const body = {
      serverId: identity.serverId,
      endpoint: config.network.publicEndpoint,
      publicKey: base64Encode(identity.publicKey),
      region: config.network.region || 'unknown',
      connections: metrics?.connections ?? 0,
      relayConnections: metrics?.relayConnections ?? 0,
      signalingConnections: metrics?.signalingConnections ?? 0,
      activeCodes: metrics?.activeCodes ?? 0,
    };

    console.log(`[Bootstrap] Registering with ${baseUrl}...`);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Registration failed: ${response.status} - ${error}`);
      }

      const result = await response.json();
      console.log(`[Bootstrap] Registered successfully:`, result);
    } catch (error) {
      console.error(`[Bootstrap] Registration error:`, error);
      throw error;
    }
  }

  async function unregister(): Promise<void> {
    const url = `${baseUrl}/servers/${encodeURIComponent(identity.serverId)}`;

    console.log(`[Bootstrap] Unregistering from ${baseUrl}...`);

    try {
      const response = await fetch(url, { method: 'DELETE' });

      if (!response.ok && response.status !== 404) {
        console.warn(`[Bootstrap] Unregister returned ${response.status}`);
      } else {
        console.log(`[Bootstrap] Unregistered successfully`);
      }
    } catch (error) {
      console.error(`[Bootstrap] Unregister error:`, error);
    }
  }

  async function getServers(): Promise<BootstrapServerEntry[]> {
    const url = `${baseUrl}/servers`;

    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to get servers: ${response.status}`);
      }

      const result = await response.json() as { servers: BootstrapServerEntry[] };
      return result.servers.filter(s => s.serverId !== identity.serverId);
    } catch (error) {
      console.warn(`[Bootstrap] Get servers failed (returning empty - NOT the same as "no servers"):`, error);
      return [];
    }
  }

  async function heartbeat(): Promise<BootstrapServerEntry[]> {
    const url = `${baseUrl}/servers/heartbeat`;

    try {
      const metrics = getMetrics?.();
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: identity.serverId,
          connections: metrics?.connections ?? 0,
          relayConnections: metrics?.relayConnections ?? 0,
          signalingConnections: metrics?.signalingConnections ?? 0,
          activeCodes: metrics?.activeCodes ?? 0,
        }),
      });

      if (!response.ok) {
        if (response.status === 404) {
          // Server not registered, re-register
          console.log(`[Bootstrap] Not registered, re-registering...`);
          await register();
          return await getServers();
        }
        throw new Error(`Heartbeat failed: ${response.status}`);
      }

      const result = await response.json() as { success: boolean; peers: BootstrapServerEntry[] };
      return result.peers;
    } catch (error) {
      console.warn(`[Bootstrap] Heartbeat failed (returning empty - NOT the same as "no peers"):`, error);
      return [];
    }
  }

  function startHeartbeat(onPeersDiscovered?: (peers: BootstrapServerEntry[]) => void): void {
    if (heartbeatTimer) return;

    heartbeatTimer = setInterval(async () => {
      const peers = await heartbeat();
      if (peers.length > 0) {
        console.log(`[Bootstrap] Heartbeat: ${peers.length} peers known`);
      } else {
        console.debug(`[Bootstrap] Heartbeat returned 0 peers`);
      }
      if (onPeersDiscovered) {
        onPeersDiscovered(peers);
      }
    }, config.bootstrap.heartbeatInterval);

    console.log(`[Bootstrap] Heartbeat started (interval: ${config.bootstrap.heartbeatInterval}ms)`);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      console.log(`[Bootstrap] Heartbeat stopped`);
    }
  }

  return {
    register,
    unregister,
    getServers,
    startHeartbeat,
    stopHeartbeat,
  };
}
