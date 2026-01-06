/**
 * RendezvousRegistry Tests
 *
 * Tests for the meeting point system that enables peer discovery:
 * - Daily meeting points with dead drop storage
 * - Hourly tokens for live matching
 * - Expiration and cleanup
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RendezvousRegistry } from '../rendezvous-registry.js';

describe('RendezvousRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new RendezvousRegistry();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('registerDailyPoints', () => {
    it('should register daily meeting points with dead drop', () => {
      registry.registerDailyPoints('peer1', {
        points: ['day_abc123', 'day_def456', 'day_ghi789'],
        deadDrop: 'encrypted_payload',
        relayId: 'relay1',
      });

      const entries = registry.getDailyPoint('day_abc123');
      expect(entries).toHaveLength(1);
      expect(entries[0].peerId).toBe('peer1');
      expect(entries[0].deadDrop).toBe('encrypted_payload');
      expect(entries[0].relayId).toBe('relay1');
    });

    it('should register multiple points at once', () => {
      registry.registerDailyPoints('peer1', {
        points: ['day_abc123', 'day_def456'],
        deadDrop: 'encrypted',
        relayId: 'relay1',
      });

      expect(registry.getDailyPoint('day_abc123')).toHaveLength(1);
      expect(registry.getDailyPoint('day_def456')).toHaveLength(1);
    });

    it('should find existing dead drops when registering', () => {
      // Alice registers first
      registry.registerDailyPoints('alice', {
        points: ['day_abc123'],
        deadDrop: 'alice_encrypted',
        relayId: 'relay1',
      });

      // Bob registers same point
      const result = registry.registerDailyPoints('bob', {
        points: ['day_abc123'],
        deadDrop: 'bob_encrypted',
        relayId: 'relay2',
      });

      expect(result.deadDrops).toHaveLength(1);
      expect(result.deadDrops[0].peerId).toBe('alice');
      expect(result.deadDrops[0].deadDrop).toBe('alice_encrypted');
      expect(result.deadDrops[0].relayId).toBe('relay1');
    });

    it('should return multiple dead drops from same point', () => {
      // Alice registers
      registry.registerDailyPoints('alice', {
        points: ['day_abc123'],
        deadDrop: 'alice_encrypted',
        relayId: 'relay1',
      });

      // Bob registers
      registry.registerDailyPoints('bob', {
        points: ['day_abc123'],
        deadDrop: 'bob_encrypted',
        relayId: 'relay2',
      });

      // Charlie registers - should see both Alice and Bob
      const result = registry.registerDailyPoints('charlie', {
        points: ['day_abc123'],
        deadDrop: 'charlie_encrypted',
        relayId: 'relay3',
      });

      expect(result.deadDrops).toHaveLength(2);
      expect(result.deadDrops.map(d => d.peerId).sort()).toEqual(['alice', 'bob']);
    });

    it('should not return own dead drop', () => {
      registry.registerDailyPoints('alice', {
        points: ['day_abc123'],
        deadDrop: 'alice_encrypted',
        relayId: 'relay1',
      });

      // Alice re-registers
      const result = registry.registerDailyPoints('alice', {
        points: ['day_abc123'],
        deadDrop: 'alice_encrypted_new',
        relayId: 'relay1',
      });

      expect(result.deadDrops).toHaveLength(0);
    });

    it('should update dead drop when same peer re-registers', () => {
      registry.registerDailyPoints('alice', {
        points: ['day_abc123'],
        deadDrop: 'old_drop',
        relayId: 'relay1',
      });

      registry.registerDailyPoints('alice', {
        points: ['day_abc123'],
        deadDrop: 'new_drop',
        relayId: 'relay2',
      });

      const entries = registry.getDailyPoint('day_abc123');
      expect(entries).toHaveLength(1);
      expect(entries[0].deadDrop).toBe('new_drop');
      expect(entries[0].relayId).toBe('relay2');
    });

    it('should aggregate dead drops from multiple points', () => {
      // Alice at point A
      registry.registerDailyPoints('alice', {
        points: ['day_pointA'],
        deadDrop: 'alice_drop',
        relayId: 'relay1',
      });

      // Bob at point B
      registry.registerDailyPoints('bob', {
        points: ['day_pointB'],
        deadDrop: 'bob_drop',
        relayId: 'relay2',
      });

      // Charlie registers at both points
      const result = registry.registerDailyPoints('charlie', {
        points: ['day_pointA', 'day_pointB'],
        deadDrop: 'charlie_drop',
        relayId: 'relay3',
      });

      expect(result.deadDrops).toHaveLength(2);
      expect(result.deadDrops.map(d => d.peerId).sort()).toEqual(['alice', 'bob']);
    });
  });

  describe('registerHourlyTokens', () => {
    it('should register hourly tokens', () => {
      registry.registerHourlyTokens('alice', {
        tokens: ['hr_abc123'],
        relayId: 'relay1',
      });

      const result = registry.registerHourlyTokens('bob', {
        tokens: ['hr_xyz789'],
        relayId: 'relay2',
      });

      // No match because different tokens
      expect(result.liveMatches).toHaveLength(0);
    });

    it('should find live matches for hourly tokens', () => {
      // Alice registers
      registry.registerHourlyTokens('alice', {
        tokens: ['hr_abc123'],
        relayId: 'relay1',
      });

      // Bob registers same token
      const result = registry.registerHourlyTokens('bob', {
        tokens: ['hr_abc123'],
        relayId: 'relay2',
      });

      expect(result.liveMatches).toHaveLength(1);
      expect(result.liveMatches[0].peerId).toBe('alice');
      expect(result.liveMatches[0].relayId).toBe('relay1');
    });

    it('should return multiple matches from same token', () => {
      registry.registerHourlyTokens('alice', {
        tokens: ['hr_abc123'],
        relayId: 'relay1',
      });

      registry.registerHourlyTokens('bob', {
        tokens: ['hr_abc123'],
        relayId: 'relay2',
      });

      // Charlie should see both Alice and Bob
      const result = registry.registerHourlyTokens('charlie', {
        tokens: ['hr_abc123'],
        relayId: 'relay3',
      });

      expect(result.liveMatches).toHaveLength(2);
      expect(result.liveMatches.map(m => m.peerId).sort()).toEqual(['alice', 'bob']);
    });

    it('should not return self as match', () => {
      registry.registerHourlyTokens('alice', {
        tokens: ['hr_abc123'],
        relayId: 'relay1',
      });

      // Alice re-registers
      const result = registry.registerHourlyTokens('alice', {
        tokens: ['hr_abc123'],
        relayId: 'relay1',
      });

      expect(result.liveMatches).toHaveLength(0);
    });

    it('should notify original peer of new match via callback', () => {
      const notifications = [];
      registry.onMatch = (peerId, match) => notifications.push({ peerId, match });

      registry.registerHourlyTokens('alice', { tokens: ['hr_abc123'], relayId: 'r1' });
      registry.registerHourlyTokens('bob', { tokens: ['hr_abc123'], relayId: 'r2' });

      expect(notifications).toHaveLength(1);
      expect(notifications[0].peerId).toBe('alice');
      expect(notifications[0].match.peerId).toBe('bob');
      expect(notifications[0].match.relayId).toBe('r2');
    });

    it('should notify all matching peers when new peer joins', () => {
      const notifications = [];
      registry.onMatch = (peerId, match) => notifications.push({ peerId, match });

      registry.registerHourlyTokens('alice', { tokens: ['hr_abc123'], relayId: 'r1' });
      registry.registerHourlyTokens('bob', { tokens: ['hr_abc123'], relayId: 'r2' });
      registry.registerHourlyTokens('charlie', { tokens: ['hr_abc123'], relayId: 'r3' });

      // Alice notified about Bob, then Alice and Bob notified about Charlie
      expect(notifications).toHaveLength(3);
    });

    it('should aggregate matches from multiple tokens', () => {
      registry.registerHourlyTokens('alice', {
        tokens: ['hr_tokenA'],
        relayId: 'relay1',
      });

      registry.registerHourlyTokens('bob', {
        tokens: ['hr_tokenB'],
        relayId: 'relay2',
      });

      // Charlie registers both tokens
      const result = registry.registerHourlyTokens('charlie', {
        tokens: ['hr_tokenA', 'hr_tokenB'],
        relayId: 'relay3',
      });

      expect(result.liveMatches).toHaveLength(2);
      expect(result.liveMatches.map(m => m.peerId).sort()).toEqual(['alice', 'bob']);
    });
  });

  describe('getDailyPoint', () => {
    it('should return empty array for non-existent point', () => {
      const entries = registry.getDailyPoint('nonexistent');
      expect(entries).toEqual([]);
    });

    it('should filter out expired entries', () => {
      registry.registerDailyPoints('alice', {
        points: ['day_abc123'],
        deadDrop: 'encrypted',
        relayId: 'relay1',
      });

      // Advance past expiration (48 hours)
      vi.advanceTimersByTime(49 * 60 * 60 * 1000);

      const entries = registry.getDailyPoint('day_abc123');
      expect(entries).toHaveLength(0);
    });
  });

  describe('expiration', () => {
    it('should expire daily points after 48 hours', () => {
      registry.registerDailyPoints('alice', {
        points: ['day_abc123'],
        deadDrop: 'encrypted',
        relayId: 'relay1',
      });

      // Advance 49 hours
      vi.advanceTimersByTime(49 * 60 * 60 * 1000);
      registry.cleanup();

      const entries = registry.getDailyPoint('day_abc123');
      expect(entries).toHaveLength(0);
    });

    it('should not expire daily points before 48 hours', () => {
      registry.registerDailyPoints('alice', {
        points: ['day_abc123'],
        deadDrop: 'encrypted',
        relayId: 'relay1',
      });

      // Advance 47 hours
      vi.advanceTimersByTime(47 * 60 * 60 * 1000);
      registry.cleanup();

      const entries = registry.getDailyPoint('day_abc123');
      expect(entries).toHaveLength(1);
    });

    it('should expire hourly tokens after 3 hours', () => {
      registry.registerHourlyTokens('alice', {
        tokens: ['hr_abc123'],
        relayId: 'relay1',
      });

      // Advance 4 hours
      vi.advanceTimersByTime(4 * 60 * 60 * 1000);
      registry.cleanup();

      const result = registry.registerHourlyTokens('bob', {
        tokens: ['hr_abc123'],
        relayId: 'relay2',
      });

      expect(result.liveMatches).toHaveLength(0);
    });

    it('should not expire hourly tokens before 3 hours', () => {
      registry.registerHourlyTokens('alice', {
        tokens: ['hr_abc123'],
        relayId: 'relay1',
      });

      // Advance 2 hours
      vi.advanceTimersByTime(2 * 60 * 60 * 1000);
      registry.cleanup();

      const result = registry.registerHourlyTokens('bob', {
        tokens: ['hr_abc123'],
        relayId: 'relay2',
      });

      expect(result.liveMatches).toHaveLength(1);
    });

    it('should cleanup empty point/token maps', () => {
      registry.registerDailyPoints('alice', {
        points: ['day_abc123'],
        deadDrop: 'encrypted',
        relayId: 'relay1',
      });

      // Advance past expiration
      vi.advanceTimersByTime(49 * 60 * 60 * 1000);
      registry.cleanup();

      // Internal check - the point map should be cleaned up
      const stats = registry.getStats();
      expect(stats.dailyPoints).toBe(0);
    });
  });

  describe('unregisterPeer', () => {
    it('should remove peer from all daily points', () => {
      registry.registerDailyPoints('alice', {
        points: ['day_abc123', 'day_def456'],
        deadDrop: 'encrypted',
        relayId: 'relay1',
      });

      registry.unregisterPeer('alice');

      expect(registry.getDailyPoint('day_abc123')).toHaveLength(0);
      expect(registry.getDailyPoint('day_def456')).toHaveLength(0);
    });

    it('should remove peer from all hourly tokens', () => {
      registry.registerHourlyTokens('alice', {
        tokens: ['hr_abc123'],
        relayId: 'relay1',
      });

      registry.unregisterPeer('alice');

      const result = registry.registerHourlyTokens('bob', {
        tokens: ['hr_abc123'],
        relayId: 'relay2',
      });

      expect(result.liveMatches).toHaveLength(0);
    });

    it('should not affect other peers', () => {
      registry.registerDailyPoints('alice', {
        points: ['day_abc123'],
        deadDrop: 'alice_drop',
        relayId: 'relay1',
      });

      registry.registerDailyPoints('bob', {
        points: ['day_abc123'],
        deadDrop: 'bob_drop',
        relayId: 'relay2',
      });

      registry.unregisterPeer('alice');

      const entries = registry.getDailyPoint('day_abc123');
      expect(entries).toHaveLength(1);
      expect(entries[0].peerId).toBe('bob');
    });
  });

  describe('getStats', () => {
    it('should return registry statistics', () => {
      registry.registerDailyPoints('alice', {
        points: ['day_abc123', 'day_def456'],
        deadDrop: 'encrypted',
        relayId: 'relay1',
      });

      registry.registerHourlyTokens('bob', {
        tokens: ['hr_abc123'],
        relayId: 'relay2',
      });

      const stats = registry.getStats();

      expect(stats.dailyPoints).toBe(2);
      expect(stats.hourlyTokens).toBe(1);
      expect(stats.totalEntries).toBeGreaterThanOrEqual(2);
    });
  });
});
