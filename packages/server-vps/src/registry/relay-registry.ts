/**
 * Relay Registry
 *
 * Manages peer relay registration and tracking.
 * Tracks online peers, their connection capacity, and provides load-balanced
 * relay selection for peer-to-peer connections.
 *
 * This is a local-only registry - relays only matter for clients connected
 * to this specific server.
 */

import { EventEmitter } from 'events';
import { secureShuffleArray } from '../crypto/secure-random.js';

export interface RelayInfo {
  peerId: string;
  maxConnections: number;
  connectedCount: number;
  publicKey: string | null;
  registeredAt: number;
  lastUpdate: number;
}

export interface RelayResult {
  peerId: string;
  publicKey: string | null;
  capacity: number;
}

export interface RelayRegistryEvents {
  'relay-registered': (info: RelayInfo) => void;
  'relay-updated': (info: RelayInfo) => void;
  'relay-unregistered': (peerId: string) => void;
}

export class RelayRegistry extends EventEmitter {
  private peers: Map<string, RelayInfo> = new Map();

  /**
   * Register a peer as an available relay
   */
  register(
    peerId: string,
    options: { maxConnections?: number; publicKey?: string | null } = {}
  ): void {
    const { maxConnections = 20, publicKey = null } = options;
    // Defense-in-depth: clamp maxConnections to valid range
    const maxConn = Math.max(1, Math.min(1000, Number(maxConnections) || 20));
    const existing = this.peers.get(peerId);
    const now = Date.now();

    const info: RelayInfo = {
      peerId,
      maxConnections: maxConn,
      connectedCount: existing?.connectedCount ?? 0,
      publicKey,
      registeredAt: existing?.registeredAt ?? now,
      lastUpdate: now,
    };

    this.peers.set(peerId, info);

    if (existing) {
      this.emit('relay-updated', info);
    } else {
      this.emit('relay-registered', info);
    }
  }

  /**
   * Get peer information by ID
   */
  getPeer(peerId: string): RelayInfo | undefined {
    return this.peers.get(peerId);
  }

  /**
   * Update the connection load for a peer
   */
  updateLoad(peerId: string, connectedCount: number): boolean {
    const peer = this.peers.get(peerId);
    if (!peer) return false;

    peer.connectedCount = connectedCount;
    peer.lastUpdate = Date.now();
    this.emit('relay-updated', peer);
    return true;
  }

  /**
   * Get available relays with less than 50% capacity
   * Results are shuffled for load distribution
   */
  getAvailableRelays(excludePeerId: string, count = 10): RelayResult[] {
    const available: RelayResult[] = [];

    for (const [id, peer] of this.peers) {
      if (id === excludePeerId) continue;

      const capacity = peer.connectedCount / peer.maxConnections;
      if (capacity < 0.5) {
        available.push({
          peerId: id,
          publicKey: peer.publicKey,
          capacity,
        });
      }
    }

    // Cryptographically secure shuffle for random distribution
    secureShuffleArray(available);

    return available.slice(0, count);
  }

  /**
   * Unregister a peer from the relay registry
   */
  unregister(peerId: string): boolean {
    const existed = this.peers.delete(peerId);
    if (existed) {
      this.emit('relay-unregistered', peerId);
    }
    return existed;
  }

  /**
   * Get all registered peers
   */
  getAllPeers(): RelayInfo[] {
    return Array.from(this.peers.values());
  }

  /**
   * Get registry statistics
   */
  getStats(): {
    totalPeers: number;
    totalCapacity: number;
    totalConnected: number;
    availableRelays: number;
  } {
    let totalCapacity = 0;
    let totalConnected = 0;
    let availableRelays = 0;

    for (const peer of this.peers.values()) {
      totalCapacity += peer.maxConnections;
      totalConnected += peer.connectedCount;

      const capacity = peer.connectedCount / peer.maxConnections;
      if (capacity < 0.5) {
        availableRelays++;
      }
    }

    return {
      totalPeers: this.peers.size,
      totalCapacity,
      totalConnected,
      availableRelays,
    };
  }

  /**
   * Clear all entries (for shutdown)
   */
  clear(): void {
    this.peers.clear();
  }
}
