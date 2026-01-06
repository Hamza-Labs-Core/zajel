/**
 * RelayRegistry Tests
 *
 * Tests for the relay peer tracking system that manages:
 * - Peer registration with capacity info
 * - Load tracking and updates
 * - Available relay selection with load balancing
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RelayRegistry } from '../relay-registry.js';

describe('RelayRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new RelayRegistry();
  });

  describe('register', () => {
    it('should register a peer with capacity info', () => {
      registry.register('peer1', { maxConnections: 20, publicKey: 'pk1' });

      const peer = registry.getPeer('peer1');
      expect(peer).toEqual({
        peerId: 'peer1',
        maxConnections: 20,
        connectedCount: 0,
        publicKey: 'pk1',
        registeredAt: expect.any(Number),
        lastUpdate: expect.any(Number),
      });
    });

    it('should use default maxConnections if not provided', () => {
      registry.register('peer1', {});

      expect(registry.getPeer('peer1').maxConnections).toBe(20);
    });

    it('should update existing peer on re-register', () => {
      registry.register('peer1', { maxConnections: 20 });
      registry.register('peer1', { maxConnections: 30 });

      expect(registry.getPeer('peer1').maxConnections).toBe(30);
    });

    it('should preserve connected count on re-register', () => {
      registry.register('peer1', { maxConnections: 20 });
      registry.updateLoad('peer1', 10);
      registry.register('peer1', { maxConnections: 30 });

      // Re-registration should keep the connected count
      expect(registry.getPeer('peer1').connectedCount).toBe(10);
    });
  });

  describe('getPeer', () => {
    it('should return undefined for non-existent peer', () => {
      expect(registry.getPeer('nonexistent')).toBeUndefined();
    });

    it('should return peer data for existing peer', () => {
      registry.register('peer1', { maxConnections: 20, publicKey: 'pk1' });

      const peer = registry.getPeer('peer1');
      expect(peer.peerId).toBe('peer1');
      expect(peer.publicKey).toBe('pk1');
    });
  });

  describe('updateLoad', () => {
    it('should update connected count', () => {
      registry.register('peer1', { maxConnections: 20 });
      registry.updateLoad('peer1', 10);

      expect(registry.getPeer('peer1').connectedCount).toBe(10);
    });

    it('should update lastUpdate timestamp', () => {
      registry.register('peer1', { maxConnections: 20 });
      const beforeUpdate = registry.getPeer('peer1').lastUpdate;

      // Small delay to ensure timestamp difference
      registry.updateLoad('peer1', 5);

      expect(registry.getPeer('peer1').lastUpdate).toBeGreaterThanOrEqual(beforeUpdate);
    });

    it('should do nothing for non-existent peer', () => {
      // Should not throw
      registry.updateLoad('nonexistent', 10);
      expect(registry.getPeer('nonexistent')).toBeUndefined();
    });
  });

  describe('getAvailableRelays', () => {
    it('should return peers with less than 50% capacity', () => {
      registry.register('peer1', { maxConnections: 20 });
      registry.register('peer2', { maxConnections: 20 });
      registry.updateLoad('peer1', 5);  // 25% - available
      registry.updateLoad('peer2', 15); // 75% - not available

      const available = registry.getAvailableRelays('exclude1', 10);

      expect(available).toHaveLength(1);
      expect(available[0].peerId).toBe('peer1');
    });

    it('should exclude the requesting peer', () => {
      registry.register('peer1', { maxConnections: 20 });
      registry.register('peer2', { maxConnections: 20 });

      const available = registry.getAvailableRelays('peer1', 10);

      expect(available.find(p => p.peerId === 'peer1')).toBeUndefined();
      expect(available.find(p => p.peerId === 'peer2')).toBeDefined();
    });

    it('should return at most N peers', () => {
      for (let i = 0; i < 20; i++) {
        registry.register(`peer${i}`, { maxConnections: 20 });
      }

      const available = registry.getAvailableRelays('exclude', 5);

      expect(available).toHaveLength(5);
    });

    it('should return fewer peers if not enough available', () => {
      registry.register('peer1', { maxConnections: 20 });
      registry.register('peer2', { maxConnections: 20 });

      const available = registry.getAvailableRelays('exclude', 10);

      expect(available).toHaveLength(2);
    });

    it('should include peer publicKey in results', () => {
      registry.register('peer1', { maxConnections: 20, publicKey: 'pk1' });

      const available = registry.getAvailableRelays('exclude', 10);

      expect(available[0].publicKey).toBe('pk1');
    });

    it('should include capacity ratio in results', () => {
      registry.register('peer1', { maxConnections: 20 });
      registry.updateLoad('peer1', 5); // 25%

      const available = registry.getAvailableRelays('exclude', 10);

      expect(available[0].capacity).toBe(0.25);
    });

    it('should exclude peers at exactly 50% capacity', () => {
      registry.register('peer1', { maxConnections: 20 });
      registry.updateLoad('peer1', 10); // exactly 50%

      const available = registry.getAvailableRelays('exclude', 10);

      expect(available).toHaveLength(0);
    });

    it('should shuffle results for load distribution', () => {
      // Register many peers to increase likelihood of different orders
      for (let i = 0; i < 50; i++) {
        registry.register(`peer${i}`, { maxConnections: 20 });
      }

      // Run multiple times to ensure at least one shuffle occurs
      const allResults = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        allResults.push(registry.getAvailableRelays('x', 50).map(p => p.peerId).join(','));
      }

      // Check that we have the same elements each time
      const firstSorted = allResults[0].split(',').sort().join(',');
      for (const result of allResults) {
        expect(result.split(',').sort().join(',')).toBe(firstSorted);
      }

      // At least one result should be different from the first (high probability with 10 attempts)
      const uniqueOrders = new Set(allResults);
      expect(uniqueOrders.size).toBeGreaterThan(1);
    });
  });

  describe('unregister', () => {
    it('should remove peer from registry', () => {
      registry.register('peer1', { maxConnections: 20 });
      registry.unregister('peer1');

      expect(registry.getPeer('peer1')).toBeUndefined();
    });

    it('should do nothing for non-existent peer', () => {
      // Should not throw
      registry.unregister('nonexistent');
    });
  });

  describe('getAllPeers', () => {
    it('should return all registered peers', () => {
      registry.register('peer1', { maxConnections: 20 });
      registry.register('peer2', { maxConnections: 30 });

      const peers = registry.getAllPeers();

      expect(peers).toHaveLength(2);
      expect(peers.map(p => p.peerId).sort()).toEqual(['peer1', 'peer2']);
    });

    it('should return empty array when no peers registered', () => {
      const peers = registry.getAllPeers();

      expect(peers).toEqual([]);
    });
  });

  describe('getStats', () => {
    it('should return registry statistics', () => {
      registry.register('peer1', { maxConnections: 20 });
      registry.register('peer2', { maxConnections: 20 });
      registry.updateLoad('peer1', 5);
      registry.updateLoad('peer2', 15);

      const stats = registry.getStats();

      expect(stats.totalPeers).toBe(2);
      expect(stats.totalCapacity).toBe(40);
      expect(stats.totalConnected).toBe(20);
      expect(stats.availableRelays).toBe(1); // Only peer1 is <50%
    });
  });
});
