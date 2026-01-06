/**
 * Hash Ring Implementation
 *
 * Consistent hashing with virtual nodes for distributing meeting points
 * across servers in the federation.
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import type { HashRingNode, HashRange, ServerStatus } from '../../types.js';

// 160-bit hash space (same as Kademlia)
const RING_BITS = 160;
const RING_SIZE = 2n ** BigInt(RING_BITS);

/**
 * Compute position on the ring from a string (meeting point hash or node ID)
 */
export function hashToPosition(input: string): bigint {
  const hash = sha256(utf8ToBytes(input));
  // Take first 20 bytes (160 bits)
  const hex = bytesToHex(hash.slice(0, 20));
  return BigInt('0x' + hex);
}

/**
 * Compute distance between two positions on the ring
 */
export function ringDistance(a: bigint, b: bigint): bigint {
  if (a <= b) {
    return b - a;
  }
  // Wrap around
  return RING_SIZE - a + b;
}

/**
 * Check if position c is between a and b on the ring (exclusive)
 */
export function isBetween(a: bigint, c: bigint, b: bigint): boolean {
  if (a < b) {
    return a < c && c < b;
  }
  // Wrap around case
  return a < c || c < b;
}

/**
 * Hash Ring for consistent hashing with virtual nodes
 */
export class HashRing {
  private nodes: Map<string, HashRingNode> = new Map();
  private sortedPositions: Array<{ position: bigint; serverId: string }> = [];
  private readonly virtualNodes: number;

  constructor(virtualNodes = 150) {
    this.virtualNodes = virtualNodes;
  }

  /**
   * Add a server to the ring
   */
  addNode(node: Omit<HashRingNode, 'position' | 'virtualPositions'>): void {
    // Compute virtual node positions
    const virtualPositions: bigint[] = [];
    for (let i = 0; i < this.virtualNodes; i++) {
      const virtualKey = `${node.serverId}:${i}`;
      const position = hashToPosition(virtualKey);
      virtualPositions.push(position);
    }

    // Primary position is the node's DHT position
    const position = hashToPosition(node.nodeId);

    const fullNode: HashRingNode = {
      ...node,
      position,
      virtualPositions,
    };

    this.nodes.set(node.serverId, fullNode);
    this.rebuildSortedPositions();
  }

  /**
   * Remove a server from the ring
   */
  removeNode(serverId: string): boolean {
    const removed = this.nodes.delete(serverId);
    if (removed) {
      this.rebuildSortedPositions();
    }
    return removed;
  }

  /**
   * Update a node's status
   */
  updateNodeStatus(serverId: string, status: ServerStatus): boolean {
    const node = this.nodes.get(serverId);
    if (!node) return false;
    node.status = status;
    return true;
  }

  /**
   * Get a node by server ID
   */
  getNode(serverId: string): HashRingNode | undefined {
    return this.nodes.get(serverId);
  }

  /**
   * Get all nodes in the ring
   */
  getAllNodes(): HashRingNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Get active nodes only
   */
  getActiveNodes(): HashRingNode[] {
    return Array.from(this.nodes.values()).filter(n => n.status === 'alive');
  }

  /**
   * Get N servers responsible for a hash
   * Returns nodes in order of responsibility (primary first)
   */
  getResponsibleNodes(hash: string, count = 3): HashRingNode[] {
    if (this.sortedPositions.length === 0) {
      return [];
    }

    const position = hashToPosition(hash);
    const result: HashRingNode[] = [];
    const seen = new Set<string>();

    // Find the first position >= our hash position
    let startIdx = this.binarySearch(position);

    // Collect unique servers
    let idx = startIdx;
    let iterations = 0;
    const maxIterations = this.sortedPositions.length;

    while (result.length < count && iterations < maxIterations) {
      const entry = this.sortedPositions[idx % this.sortedPositions.length];
      if (entry && !seen.has(entry.serverId)) {
        const node = this.nodes.get(entry.serverId);
        if (node && node.status === 'alive') {
          result.push(node);
          seen.add(entry.serverId);
        }
      }
      idx++;
      iterations++;
    }

    return result;
  }

  /**
   * Get the primary owner for a hash
   */
  getPrimaryOwner(hash: string): HashRingNode | undefined {
    const nodes = this.getResponsibleNodes(hash, 1);
    return nodes[0];
  }

  /**
   * Check if a server is responsible for a hash
   */
  isResponsible(hash: string, serverId: string, replicationFactor = 3): boolean {
    const responsible = this.getResponsibleNodes(hash, replicationFactor);
    return responsible.some(n => n.serverId === serverId);
  }

  /**
   * Get ranges that a server is responsible for
   * This is complex with virtual nodes - returns list of ranges
   */
  getOwnedRanges(serverId: string): HashRange[] {
    const node = this.nodes.get(serverId);
    if (!node) return [];

    const ranges: HashRange[] = [];

    // For each virtual node position, the server owns
    // from the previous position to this position
    for (const vpos of node.virtualPositions) {
      const prevIdx = this.binarySearchBefore(vpos);
      if (prevIdx >= 0) {
        const prevPos = this.sortedPositions[prevIdx]!.position;
        ranges.push({ start: prevPos + 1n, end: vpos });
      }
    }

    // Also include ranges where this is a replica
    // (This is more complex and depends on replication factor)

    return ranges;
  }

  /**
   * Get the number of nodes in the ring
   */
  get size(): number {
    return this.nodes.size;
  }

  /**
   * Get number of positions (including virtual nodes)
   */
  get positionCount(): number {
    return this.sortedPositions.length;
  }

  /**
   * Binary search for first position >= target
   */
  private binarySearch(target: bigint): number {
    let left = 0;
    let right = this.sortedPositions.length;

    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (this.sortedPositions[mid]!.position < target) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }

    return left % this.sortedPositions.length;
  }

  /**
   * Binary search for last position < target
   */
  private binarySearchBefore(target: bigint): number {
    const idx = this.binarySearch(target);
    return (idx - 1 + this.sortedPositions.length) % this.sortedPositions.length;
  }

  /**
   * Rebuild the sorted positions array after node changes
   */
  private rebuildSortedPositions(): void {
    this.sortedPositions = [];

    for (const node of this.nodes.values()) {
      // Add primary position
      this.sortedPositions.push({
        position: node.position,
        serverId: node.serverId,
      });

      // Add virtual node positions
      for (const vpos of node.virtualPositions) {
        this.sortedPositions.push({
          position: vpos,
          serverId: node.serverId,
        });
      }
    }

    // Sort by position
    this.sortedPositions.sort((a, b) => {
      if (a.position < b.position) return -1;
      if (a.position > b.position) return 1;
      return 0;
    });
  }

  /**
   * Export ring state for debugging/monitoring
   */
  toJSON(): object {
    return {
      nodeCount: this.nodes.size,
      positionCount: this.sortedPositions.length,
      virtualNodesPerServer: this.virtualNodes,
      nodes: Array.from(this.nodes.values()).map(n => ({
        serverId: n.serverId,
        nodeId: n.nodeId,
        endpoint: n.endpoint,
        status: n.status,
        position: n.position.toString(16),
      })),
    };
  }
}

/**
 * Utility to determine which server should handle a client request
 */
export class RoutingTable {
  constructor(
    private ring: HashRing,
    private localServerId: string,
    private replicationFactor: number
  ) {}

  /**
   * Check if we should handle this hash locally
   */
  shouldHandleLocally(hash: string): boolean {
    return this.ring.isResponsible(hash, this.localServerId, this.replicationFactor);
  }

  /**
   * Get servers that should handle a set of hashes
   * Returns a map of serverId -> hashes
   */
  routeHashes(hashes: string[]): Map<string, string[]> {
    const routing = new Map<string, string[]>();

    for (const hash of hashes) {
      const responsible = this.ring.getResponsibleNodes(hash, 1);
      if (responsible.length > 0) {
        const serverId = responsible[0]!.serverId;
        const existing = routing.get(serverId) || [];
        existing.push(hash);
        routing.set(serverId, existing);
      }
    }

    return routing;
  }

  /**
   * Determine redirect targets for hashes we don't own
   */
  getRedirectTargets(hashes: string[]): Array<{ serverId: string; endpoint: string; hashes: string[] }> {
    const routing = this.routeHashes(hashes);
    const result: Array<{ serverId: string; endpoint: string; hashes: string[] }> = [];

    for (const [serverId, serverHashes] of routing) {
      if (serverId !== this.localServerId) {
        const node = this.ring.getNode(serverId);
        if (node) {
          result.push({
            serverId,
            endpoint: node.endpoint,
            hashes: serverHashes,
          });
        }
      }
    }

    return result;
  }
}
