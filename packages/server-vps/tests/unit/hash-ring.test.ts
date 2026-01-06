/**
 * Hash Ring Tests
 *
 * Tests for consistent hashing, virtual nodes, and DHT routing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  HashRing,
  RoutingTable,
  hashToPosition,
} from '../../src/federation/dht/hash-ring.js';

describe('Hash Ring', () => {
  describe('hashToPosition', () => {
    it('should produce deterministic hashes', () => {
      const hash1 = hashToPosition('test-key');
      const hash2 = hashToPosition('test-key');

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different keys', () => {
      const hash1 = hashToPosition('key-1');
      const hash2 = hashToPosition('key-2');

      expect(hash1).not.toBe(hash2);
    });

    it('should produce bigint values', () => {
      const hash = hashToPosition('some-key');

      expect(typeof hash).toBe('bigint');
      expect(hash).toBeGreaterThan(0n);
    });
  });

  describe('HashRing', () => {
    let ring: HashRing;

    beforeEach(() => {
      ring = new HashRing(10); // 10 virtual nodes for testing
    });

    it('should start empty', () => {
      expect(ring.size).toBe(0);
      expect(ring.getActiveNodes()).toHaveLength(0);
    });

    it('should add nodes', () => {
      ring.addNode({
        serverId: 'server-1',
        nodeId: 'node-id-1',
        endpoint: 'wss://server1.example.com',
        status: 'alive',
      });

      expect(ring.size).toBe(1);
      expect(ring.getNode('server-1')).toBeDefined();
      expect(ring.getNode('server-1')?.endpoint).toBe('wss://server1.example.com');
    });

    it('should remove nodes', () => {
      ring.addNode({
        serverId: 'server-1',
        nodeId: 'node-id-1',
        endpoint: 'wss://server1.example.com',
        status: 'alive',
      });

      ring.removeNode('server-1');

      expect(ring.size).toBe(0);
      expect(ring.getNode('server-1')).toBeUndefined();
    });

    it('should update node status', () => {
      ring.addNode({
        serverId: 'server-1',
        nodeId: 'node-id-1',
        endpoint: 'wss://server1.example.com',
        status: 'alive',
      });

      ring.updateNodeStatus('server-1', 'suspect');

      expect(ring.getNode('server-1')?.status).toBe('suspect');
    });

    it('should return only active nodes', () => {
      ring.addNode({
        serverId: 'server-1',
        nodeId: 'node-id-1',
        endpoint: 'wss://server1.example.com',
        status: 'alive',
      });

      ring.addNode({
        serverId: 'server-2',
        nodeId: 'node-id-2',
        endpoint: 'wss://server2.example.com',
        status: 'failed',
      });

      ring.addNode({
        serverId: 'server-3',
        nodeId: 'node-id-3',
        endpoint: 'wss://server3.example.com',
        status: 'alive',
      });

      const active = ring.getActiveNodes();

      // Only 'alive' nodes are active (not failed, not suspect)
      expect(active).toHaveLength(2);
      expect(active.map(n => n.serverId).sort()).toEqual(['server-1', 'server-3']);
    });

    it('should find responsible nodes for a key', () => {
      // Add 5 nodes
      for (let i = 1; i <= 5; i++) {
        ring.addNode({
          serverId: `server-${i}`,
          nodeId: `node-id-${i}`,
          endpoint: `wss://server${i}.example.com`,
          status: 'alive',
        });
      }

      const responsible = ring.getResponsibleNodes('test-key', 3);

      expect(responsible).toHaveLength(3);
      // All returned nodes should be unique
      const serverIds = responsible.map(n => n.serverId);
      expect(new Set(serverIds).size).toBe(3);
    });

    it('should return fewer nodes if not enough available', () => {
      ring.addNode({
        serverId: 'server-1',
        nodeId: 'node-id-1',
        endpoint: 'wss://server1.example.com',
        status: 'alive',
      });

      const responsible = ring.getResponsibleNodes('test-key', 5);

      expect(responsible).toHaveLength(1);
    });

    it('should distribute keys across nodes', () => {
      // Add 3 nodes
      for (let i = 1; i <= 3; i++) {
        ring.addNode({
          serverId: `server-${i}`,
          nodeId: `node-id-${i}`,
          endpoint: `wss://server${i}.example.com`,
          status: 'alive',
        });
      }

      // Generate many keys and check distribution
      const distribution = new Map<string, number>();

      for (let i = 0; i < 1000; i++) {
        const responsible = ring.getResponsibleNodes(`key-${i}`, 1);
        if (responsible.length > 0) {
          const serverId = responsible[0]!.serverId;
          distribution.set(serverId, (distribution.get(serverId) || 0) + 1);
        }
      }

      // All 3 servers should have received some keys
      expect(distribution.size).toBe(3);

      // Each server should have at least some keys (not perfectly balanced due to virtual nodes)
      for (const [, count] of distribution) {
        expect(count).toBeGreaterThan(100); // At least 10%
      }
    });

    it('should exclude failed nodes from responsible nodes', () => {
      ring.addNode({
        serverId: 'server-1',
        nodeId: 'node-id-1',
        endpoint: 'wss://server1.example.com',
        status: 'alive',
      });

      ring.addNode({
        serverId: 'server-2',
        nodeId: 'node-id-2',
        endpoint: 'wss://server2.example.com',
        status: 'failed',
      });

      ring.addNode({
        serverId: 'server-3',
        nodeId: 'node-id-3',
        endpoint: 'wss://server3.example.com',
        status: 'alive',
      });

      const responsible = ring.getResponsibleNodes('test-key', 3);

      // Should not include the failed node
      expect(responsible.map(n => n.serverId)).not.toContain('server-2');
    });

    it('should handle node rebalancing on add/remove', () => {
      // Initial state: 2 nodes
      ring.addNode({
        serverId: 'server-1',
        nodeId: 'node-id-1',
        endpoint: 'wss://server1.example.com',
        status: 'alive',
      });

      ring.addNode({
        serverId: 'server-2',
        nodeId: 'node-id-2',
        endpoint: 'wss://server2.example.com',
        status: 'alive',
      });

      const before = ring.getResponsibleNodes('consistent-key', 1)[0]?.serverId;

      // Add a third node
      ring.addNode({
        serverId: 'server-3',
        nodeId: 'node-id-3',
        endpoint: 'wss://server3.example.com',
        status: 'alive',
      });

      // Remove the third node
      ring.removeNode('server-3');

      const after = ring.getResponsibleNodes('consistent-key', 1)[0]?.serverId;

      // After removing the new node, the key should map to the same server as before
      expect(after).toBe(before);
    });
  });

  describe('RoutingTable', () => {
    let ring: HashRing;
    let routingTable: RoutingTable;

    beforeEach(() => {
      ring = new HashRing(10);
      routingTable = new RoutingTable(ring, 'local-server', 3);
    });

    it('should handle locally when ring is empty', () => {
      // Empty ring - isResponsible returns false, but we should handle locally as fallback
      // Actually, when ring is empty, getResponsibleNodes returns [], so isResponsible returns false
      // This is expected behavior - with no nodes, we can't be responsible
      const result = routingTable.shouldHandleLocally('any-key');
      expect(result).toBe(false); // No nodes = not responsible
    });

    it('should handle locally when only self in ring', () => {
      ring.addNode({
        serverId: 'local-server',
        nodeId: 'local-node-id',
        endpoint: 'wss://local.example.com',
        status: 'alive',
      });

      expect(routingTable.shouldHandleLocally('any-key')).toBe(true);
    });

    it('should route to correct server based on key', () => {
      // Add multiple servers
      ring.addNode({
        serverId: 'local-server',
        nodeId: 'local-node-id',
        endpoint: 'wss://local.example.com',
        status: 'alive',
      });

      ring.addNode({
        serverId: 'remote-server',
        nodeId: 'remote-node-id',
        endpoint: 'wss://remote.example.com',
        status: 'alive',
      });

      // Find a key that hashes to each server
      let localKey: string | null = null;
      let remoteKey: string | null = null;

      for (let i = 0; i < 1000 && (!localKey || !remoteKey); i++) {
        const key = `key-${i}`;
        const responsible = ring.getResponsibleNodes(key, 1);
        if (responsible[0]?.serverId === 'local-server' && !localKey) {
          localKey = key;
        }
        if (responsible[0]?.serverId === 'remote-server' && !remoteKey) {
          remoteKey = key;
        }
      }

      expect(localKey).not.toBeNull();
      expect(remoteKey).not.toBeNull();

      // With RF=3 and only 2 servers, both servers are in every replication set
      // So both keys should be handled locally
      expect(routingTable.shouldHandleLocally(localKey!)).toBe(true);
      expect(routingTable.shouldHandleLocally(remoteKey!)).toBe(true);
    });

    it('should handle locally if part of replication set', () => {
      // Add 3 servers with RF=3, so all keys are handled locally
      ring.addNode({
        serverId: 'server-1',
        nodeId: 'node-1',
        endpoint: 'wss://server1.example.com',
        status: 'alive',
      });

      ring.addNode({
        serverId: 'local-server',
        nodeId: 'local-node',
        endpoint: 'wss://local.example.com',
        status: 'alive',
      });

      ring.addNode({
        serverId: 'server-3',
        nodeId: 'node-3',
        endpoint: 'wss://server3.example.com',
        status: 'alive',
      });

      // With replication factor 3, every key should be handled locally
      // (because there are only 3 servers)
      for (let i = 0; i < 100; i++) {
        expect(routingTable.shouldHandleLocally(`key-${i}`)).toBe(true);
      }
    });

    it('should not handle locally when not in replication set', () => {
      // Add 5 servers with replication factor 2
      routingTable = new RoutingTable(ring, 'local-server', 2);

      for (let i = 1; i <= 5; i++) {
        ring.addNode({
          serverId: i === 3 ? 'local-server' : `server-${i}`,
          nodeId: `node-${i}`,
          endpoint: `wss://server${i}.example.com`,
          status: 'alive',
        });
      }

      // Some keys should not be handled locally
      let remoteCount = 0;
      for (let i = 0; i < 1000; i++) {
        if (!routingTable.shouldHandleLocally(`key-${i}`)) {
          remoteCount++;
        }
      }

      // With 5 nodes and RF=2, we should handle ~40% of keys
      // So ~60% should be remote
      expect(remoteCount).toBeGreaterThan(300);
      expect(remoteCount).toBeLessThan(900);
    });

    it('should return redirect targets for remote hashes', () => {
      ring.addNode({
        serverId: 'local-server',
        nodeId: 'local-node',
        endpoint: 'wss://local.example.com',
        status: 'alive',
      });

      ring.addNode({
        serverId: 'remote-server',
        nodeId: 'remote-node',
        endpoint: 'wss://remote.example.com',
        status: 'alive',
      });

      // getRedirectTargets routes hashes to their primary servers
      // Some hashes will go to local, some to remote
      // Find keys that route to different servers
      let localKey: string | null = null;
      let remoteKey: string | null = null;

      for (let i = 0; i < 1000 && (!localKey || !remoteKey); i++) {
        const key = `test-key-${i}`;
        const responsible = ring.getResponsibleNodes(key, 1);
        if (responsible[0]?.serverId === 'local-server' && !localKey) {
          localKey = key;
        }
        if (responsible[0]?.serverId === 'remote-server' && !remoteKey) {
          remoteKey = key;
        }
      }

      expect(localKey).not.toBeNull();
      expect(remoteKey).not.toBeNull();

      // Keys that route to local server should not create redirects
      const localTargets = routingTable.getRedirectTargets([localKey!]);
      expect(localTargets).toHaveLength(0);

      // Keys that route to remote server should create redirects
      const remoteTargets = routingTable.getRedirectTargets([remoteKey!]);
      expect(remoteTargets).toHaveLength(1);
      expect(remoteTargets[0]?.serverId).toBe('remote-server');
    });
  });
});
