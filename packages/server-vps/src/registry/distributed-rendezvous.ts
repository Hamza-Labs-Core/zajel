/**
 * Distributed Rendezvous
 *
 * DHT-aware wrapper around RendezvousRegistry that handles routing.
 * Determines which points/tokens we own locally vs need to redirect.
 *
 * Key insight: Meeting point hashes are deterministic, so both peers
 * compute the same hash and will be directed to the same server(s).
 */

import { EventEmitter } from 'events';
import type { RoutingTable, HashRing } from '../federation/dht/hash-ring.js';
import { RendezvousRegistry, type DeadDropResult, type LiveMatchResult } from './rendezvous-registry.js';

export interface DistributedRendezvousConfig {
  replicationFactor: number;  // How many servers should store each point
}

export interface PartialResult<T> {
  local: T;
  redirects: Array<{
    serverId: string;
    endpoint: string;
    items: string[];  // point hashes or token hashes
  }>;
}

export interface DistributedRendezvousEvents {
  'match': (peerId: string, match: LiveMatchResult) => void;
}

export class DistributedRendezvous extends EventEmitter {
  private registry: RendezvousRegistry;
  private routingTable: RoutingTable;
  private ring: HashRing;
  private config: DistributedRendezvousConfig;

  constructor(
    registry: RendezvousRegistry,
    routingTable: RoutingTable,
    ring: HashRing,
    config: DistributedRendezvousConfig
  ) {
    super();
    this.registry = registry;
    this.routingTable = routingTable;
    this.ring = ring;
    this.config = config;

    // Forward match events
    this.registry.on('match', (peerId, match) => {
      this.emit('match', peerId, match);
    });
  }

  /**
   * Register daily meeting points with routing awareness
   *
   * Separates points into:
   * - Local: points we own (or are replica for)
   * - Redirects: points owned by other servers
   */
  async registerDailyPoints(
    peerId: string,
    options: { points: string[]; deadDrop: string; relayId: string }
  ): Promise<PartialResult<{ deadDrops: DeadDropResult[] }>> {
    const { points, deadDrop, relayId } = options;

    // Separate local vs remote points
    const localPoints: string[] = [];
    const remotePoints = new Map<string, string[]>(); // serverId -> points

    // If ring has no active nodes, handle everything locally (solo mode)
    const soloMode = this.ring.getActiveNodes().length <= 1;

    for (const point of points) {
      if (soloMode || this.routingTable.shouldHandleLocally(point)) {
        localPoints.push(point);
      } else {
        // Find who should handle this point
        const responsible = this.ring.getResponsibleNodes(point, 1);
        if (responsible.length > 0) {
          const server = responsible[0]!;
          if (!remotePoints.has(server.serverId)) {
            remotePoints.set(server.serverId, []);
          }
          remotePoints.get(server.serverId)!.push(point);
        } else {
          // No responsible node found — handle locally as fallback
          localPoints.push(point);
        }
      }
    }

    // Process local points
    let localResult: { deadDrops: DeadDropResult[] } = { deadDrops: [] };
    if (localPoints.length > 0) {
      localResult = await this.registry.registerDailyPoints(peerId, {
        points: localPoints,
        deadDrop,
        relayId,
      });
    }

    // Build redirect list
    const redirects: Array<{ serverId: string; endpoint: string; items: string[] }> = [];
    for (const [serverId, serverPoints] of remotePoints) {
      const node = this.ring.getNode(serverId);
      if (node) {
        redirects.push({
          serverId,
          endpoint: node.endpoint,
          items: serverPoints,
        });
      }
    }

    return {
      local: localResult,
      redirects,
    };
  }

  /**
   * Register hourly tokens with routing awareness
   */
  async registerHourlyTokens(
    peerId: string,
    options: { tokens: string[]; relayId: string }
  ): Promise<PartialResult<{ liveMatches: LiveMatchResult[] }>> {
    const { tokens, relayId } = options;

    // Separate local vs remote tokens
    const localTokens: string[] = [];
    const remoteTokens = new Map<string, string[]>();

    // If ring has no active nodes, handle everything locally (solo mode)
    const soloMode = this.ring.getActiveNodes().length <= 1;

    for (const token of tokens) {
      if (soloMode || this.routingTable.shouldHandleLocally(token)) {
        localTokens.push(token);
      } else {
        const responsible = this.ring.getResponsibleNodes(token, 1);
        if (responsible.length > 0) {
          const server = responsible[0]!;
          if (!remoteTokens.has(server.serverId)) {
            remoteTokens.set(server.serverId, []);
          }
          remoteTokens.get(server.serverId)!.push(token);
        } else {
          // No responsible node found — handle locally as fallback
          localTokens.push(token);
        }
      }
    }

    // Process local tokens
    let localResult: { liveMatches: LiveMatchResult[] } = { liveMatches: [] };
    if (localTokens.length > 0) {
      localResult = await this.registry.registerHourlyTokens(peerId, {
        tokens: localTokens,
        relayId,
      });
    }

    // Build redirect list
    const redirects: Array<{ serverId: string; endpoint: string; items: string[] }> = [];
    for (const [serverId, serverTokens] of remoteTokens) {
      const node = this.ring.getNode(serverId);
      if (node) {
        redirects.push({
          serverId,
          endpoint: node.endpoint,
          items: serverTokens,
        });
      }
    }

    return {
      local: localResult,
      redirects,
    };
  }

  /**
   * Get entries at a daily meeting point
   * Returns local entries or redirect info
   */
  async getDailyPoint(point: string): Promise<{
    local: DeadDropResult[] | null;
    redirect: { serverId: string; endpoint: string } | null;
  }> {
    const soloMode = this.ring.getActiveNodes().length <= 1;
    if (soloMode || this.routingTable.shouldHandleLocally(point)) {
      const entries = await this.registry.getDailyPoint(point);
      return {
        local: entries
          .filter(e => e.deadDrop !== null)
          .map(e => ({
            peerId: e.peerId,
            deadDrop: e.deadDrop!,
            relayId: e.relayId || '',
          })),
        redirect: null,
      };
    }

    // Find who should handle this
    const responsible = this.ring.getResponsibleNodes(point, 1);
    if (responsible.length > 0) {
      const server = responsible[0]!;
      return {
        local: null,
        redirect: {
          serverId: server.serverId,
          endpoint: server.endpoint,
        },
      };
    }

    // No one available
    return { local: null, redirect: null };
  }

  /**
   * Unregister a peer from all local meeting points and tokens
   */
  async unregisterPeer(peerId: string): Promise<void> {
    await this.registry.unregisterPeer(peerId);
  }

  /**
   * Get the underlying registry for direct access
   */
  getRegistry(): RendezvousRegistry {
    return this.registry;
  }

  /**
   * Check if we should handle a hash locally
   */
  shouldHandleLocally(hash: string): boolean {
    return this.routingTable.shouldHandleLocally(hash);
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<{
    localDailyPoints: number;
    localHourlyTokens: number;
    ringNodeCount: number;
    activeNodes: number;
  }> {
    const registryStats = await this.registry.getStats();

    return {
      localDailyPoints: registryStats.dailyPoints,
      localHourlyTokens: registryStats.hourlyTokens,
      ringNodeCount: this.ring.size,
      activeNodes: this.ring.getActiveNodes().length,
    };
  }
}
