/**
 * Relay Registry Tests
 *
 * Tests for local relay tracking and selection.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RelayRegistry } from '../../src/registry/relay-registry.js';

describe('RelayRegistry', () => {
  let registry: RelayRegistry;

  beforeEach(() => {
    registry = new RelayRegistry();
  });

  describe('Registration', () => {
    it('should register a relay', () => {
      registry.register('peer-1', {
        maxConnections: 5,
        publicKey: 'pubkey-1',
      });

      const relay = registry.getPeer('peer-1');
      expect(relay).not.toBeUndefined();
      expect(relay?.maxConnections).toBe(5);
      expect(relay?.publicKey).toBe('pubkey-1');
    });

    it('should use default max connections', () => {
      registry.register('peer-1', { publicKey: 'pubkey-1' });

      const relay = registry.getPeer('peer-1');
      expect(relay?.maxConnections).toBe(20); // Default is 20
    });

    it('should update existing relay', () => {
      registry.register('peer-1', { maxConnections: 5, publicKey: 'pubkey-1' });
      registry.register('peer-1', { maxConnections: 10, publicKey: 'pubkey-1' });

      const relay = registry.getPeer('peer-1');
      expect(relay?.maxConnections).toBe(10);
    });
  });

  describe('Unregistration', () => {
    it('should unregister a relay', () => {
      registry.register('peer-1', { publicKey: 'pubkey-1' });
      registry.unregister('peer-1');

      expect(registry.getPeer('peer-1')).toBeUndefined();
    });

    it('should return false when unregistering non-existent relay', () => {
      const result = registry.unregister('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('Load Management', () => {
    it('should update connection load', () => {
      registry.register('peer-1', { maxConnections: 5, publicKey: 'pubkey-1' });

      registry.updateLoad('peer-1', 3);

      const relay = registry.getPeer('peer-1');
      expect(relay?.connectedCount).toBe(3);
    });

    it('should track capacity correctly', () => {
      registry.register('peer-1', { maxConnections: 10, publicKey: 'pubkey-1' });

      registry.updateLoad('peer-1', 4); // 40% capacity

      const relays = registry.getAvailableRelays('other', 10);
      expect(relays).toHaveLength(1);
      expect(relays[0]?.capacity).toBeCloseTo(0.4, 2);
    });
  });

  describe('Availability', () => {
    it('should report available relays', () => {
      registry.register('peer-1', { maxConnections: 5, publicKey: 'pubkey-1' });

      const relays = registry.getAvailableRelays('exclude-none', 10);

      expect(relays).toHaveLength(1);
      expect(relays[0]?.peerId).toBe('peer-1');
    });

    it('should exclude specified peer', () => {
      registry.register('peer-1', { maxConnections: 5, publicKey: 'pubkey-1' });
      registry.register('peer-2', { maxConnections: 5, publicKey: 'pubkey-2' });

      const relays = registry.getAvailableRelays('peer-1', 10);

      expect(relays).toHaveLength(1);
      expect(relays[0]?.peerId).toBe('peer-2');
    });

    it('should exclude relays over 50% capacity', () => {
      registry.register('peer-1', { maxConnections: 10, publicKey: 'pubkey-1' });

      // Set to 60% capacity
      registry.updateLoad('peer-1', 6);

      const relays = registry.getAvailableRelays('other', 10);

      expect(relays).toHaveLength(0);
    });

    it('should limit results', () => {
      for (let i = 1; i <= 10; i++) {
        registry.register(`peer-${i}`, { maxConnections: 20, publicKey: `pubkey-${i}` });
      }

      const relays = registry.getAvailableRelays('other', 3);

      expect(relays).toHaveLength(3);
    });
  });

  describe('Statistics', () => {
    it('should return correct stats', () => {
      registry.register('peer-1', { maxConnections: 10, publicKey: 'pubkey-1' });
      registry.register('peer-2', { maxConnections: 10, publicKey: 'pubkey-2' });
      registry.register('peer-3', { maxConnections: 10, publicKey: 'pubkey-3' });

      // Use some connections
      registry.updateLoad('peer-1', 2); // 20%
      registry.updateLoad('peer-3', 6); // 60% - unavailable

      const stats = registry.getStats();

      expect(stats.totalPeers).toBe(3);
      expect(stats.availableRelays).toBe(2); // peer-3 is over 50%
      expect(stats.totalConnected).toBe(8);
      expect(stats.totalCapacity).toBe(30);
    });
  });

  describe('Events', () => {
    it('should emit relay-registered event', () => {
      let eventInfo: any = null;

      registry.on('relay-registered', (info) => {
        eventInfo = info;
      });

      registry.register('peer-1', { publicKey: 'pubkey-1' });

      expect(eventInfo).not.toBeNull();
      expect(eventInfo.peerId).toBe('peer-1');
    });

    it('should emit relay-unregistered event', () => {
      let eventPeerId: string | null = null;

      registry.on('relay-unregistered', (peerId) => {
        eventPeerId = peerId;
      });

      registry.register('peer-1', { publicKey: 'pubkey-1' });
      registry.unregister('peer-1');

      expect(eventPeerId).toBe('peer-1');
    });

    it('should emit relay-updated event on re-register', () => {
      let updateCount = 0;

      registry.on('relay-updated', () => {
        updateCount++;
      });

      registry.register('peer-1', { publicKey: 'pubkey-1' });
      registry.register('peer-1', { maxConnections: 30, publicKey: 'pubkey-1' });

      expect(updateCount).toBe(1);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty registry', () => {
      const relays = registry.getAvailableRelays('any', 10);
      expect(relays).toHaveLength(0);

      const stats = registry.getStats();
      expect(stats.totalPeers).toBe(0);
      expect(stats.totalConnected).toBe(0);
    });

    it('should return false when updating non-existent peer load', () => {
      const result = registry.updateLoad('non-existent', 5);
      expect(result).toBe(false);
    });

    it('should return undefined for non-existent peer', () => {
      expect(registry.getPeer('non-existent')).toBeUndefined();
    });

    it('should clear all entries', () => {
      registry.register('peer-1', { publicKey: 'pubkey-1' });
      registry.register('peer-2', { publicKey: 'pubkey-2' });

      registry.clear();

      expect(registry.getAllPeers()).toHaveLength(0);
    });
  });
});
