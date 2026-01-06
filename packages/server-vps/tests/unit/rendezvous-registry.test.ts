/**
 * Rendezvous Registry Tests
 *
 * Tests for meeting point registration, dead drops, and live matching.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { RendezvousRegistry, type LiveMatchResult } from '../../src/registry/rendezvous-registry.js';
import { SQLiteStorage } from '../../src/storage/sqlite.js';

describe('RendezvousRegistry', () => {
  let storage: SQLiteStorage;
  let registry: RendezvousRegistry;
  const testDbPath = './test-data/test-rendezvous.db';

  beforeEach(async () => {
    // Clean up before each test
    if (!existsSync('./test-data')) {
      mkdirSync('./test-data', { recursive: true });
    }
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }

    storage = new SQLiteStorage(testDbPath);
    await storage.init();

    registry = new RendezvousRegistry(storage, {
      dailyTtl: 3600000,  // 1 hour for testing
      hourlyTtl: 300000,  // 5 minutes for testing
    });
  });

  afterEach(() => {
    storage.close();
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
  });

  describe('Daily Points (Dead Drops)', () => {
    it('should register daily points', async () => {
      const result = await registry.registerDailyPoints('peer-1', {
        points: ['point-a', 'point-b', 'point-c'],
        deadDrop: 'encrypted-deaddrop-1',
        relayId: 'relay-1',
      });

      expect(result.deadDrops).toHaveLength(0); // No existing entries
    });

    it('should find dead drops from other peers at same point', async () => {
      // Peer 1 registers first
      await registry.registerDailyPoints('peer-1', {
        points: ['meeting-point'],
        deadDrop: 'peer-1-deaddrop',
        relayId: 'relay-1',
      });

      // Peer 2 registers at the same point
      const result = await registry.registerDailyPoints('peer-2', {
        points: ['meeting-point'],
        deadDrop: 'peer-2-deaddrop',
        relayId: 'relay-2',
      });

      expect(result.deadDrops).toHaveLength(1);
      expect(result.deadDrops[0]).toEqual({
        peerId: 'peer-1',
        deadDrop: 'peer-1-deaddrop',
        relayId: 'relay-1',
      });
    });

    it('should not return own dead drops', async () => {
      await registry.registerDailyPoints('peer-1', {
        points: ['point-a'],
        deadDrop: 'deaddrop-1',
        relayId: 'relay-1',
      });

      // Register again as same peer
      const result = await registry.registerDailyPoints('peer-1', {
        points: ['point-a'],
        deadDrop: 'deaddrop-1-updated',
        relayId: 'relay-1',
      });

      expect(result.deadDrops).toHaveLength(0);
    });

    it('should get entries at a daily point', async () => {
      await registry.registerDailyPoints('peer-1', {
        points: ['shared-point', 'unique-point-1'],
        deadDrop: 'deaddrop-1',
        relayId: 'relay-1',
      });

      await registry.registerDailyPoints('peer-2', {
        points: ['shared-point', 'unique-point-2'],
        deadDrop: 'deaddrop-2',
        relayId: 'relay-2',
      });

      const entries = await registry.getDailyPoint('shared-point');

      expect(entries).toHaveLength(2);
      expect(entries.map(e => e.peerId).sort()).toEqual(['peer-1', 'peer-2']);
    });

    it('should return empty array for nonexistent point', async () => {
      const entries = await registry.getDailyPoint('nonexistent');
      expect(entries).toHaveLength(0);
    });

    it('should handle multiple points per peer', async () => {
      await registry.registerDailyPoints('peer-1', {
        points: ['point-1', 'point-2', 'point-3'],
        deadDrop: 'deaddrop-1',
        relayId: 'relay-1',
      });

      const point1 = await registry.getDailyPoint('point-1');
      const point2 = await registry.getDailyPoint('point-2');
      const point3 = await registry.getDailyPoint('point-3');

      expect(point1).toHaveLength(1);
      expect(point2).toHaveLength(1);
      expect(point3).toHaveLength(1);
    });
  });

  describe('Hourly Tokens (Live Matching)', () => {
    it('should register hourly tokens', async () => {
      const result = await registry.registerHourlyTokens('peer-1', {
        tokens: ['token-a', 'token-b'],
        relayId: 'relay-1',
      });

      expect(result.liveMatches).toHaveLength(0);
    });

    it('should match peers with same token', async () => {
      // Peer 1 registers first
      await registry.registerHourlyTokens('peer-1', {
        tokens: ['shared-token'],
        relayId: 'relay-1',
      });

      // Peer 2 registers with the same token
      const result = await registry.registerHourlyTokens('peer-2', {
        tokens: ['shared-token'],
        relayId: 'relay-2',
      });

      expect(result.liveMatches).toHaveLength(1);
      expect(result.liveMatches[0]).toEqual({
        peerId: 'peer-1',
        relayId: 'relay-1',
      });
    });

    it('should emit match event for first peer', async () => {
      const matchEvents: Array<{ peerId: string; match: LiveMatchResult }> = [];

      registry.on('match', (peerId, match) => {
        matchEvents.push({ peerId, match });
      });

      // Peer 1 registers
      await registry.registerHourlyTokens('peer-1', {
        tokens: ['matching-token'],
        relayId: 'relay-1',
      });

      // Peer 2 matches
      const result = await registry.registerHourlyTokens('peer-2', {
        tokens: ['matching-token'],
        relayId: 'relay-2',
      });

      // Peer 1 should receive event (peer 2 gets result directly)
      expect(matchEvents).toHaveLength(1);
      expect(matchEvents[0]?.peerId).toBe('peer-1');
      expect(matchEvents[0]?.match.peerId).toBe('peer-2');
      expect(matchEvents[0]?.match.relayId).toBe('relay-2');

      // Peer 2 gets result directly
      expect(result.liveMatches).toHaveLength(1);
    });

    it('should match multiple peers with overlapping tokens', async () => {
      await registry.registerHourlyTokens('peer-1', {
        tokens: ['token-a', 'token-b'],
        relayId: 'relay-1',
      });

      await registry.registerHourlyTokens('peer-2', {
        tokens: ['token-b', 'token-c'],
        relayId: 'relay-2',
      });

      const result = await registry.registerHourlyTokens('peer-3', {
        tokens: ['token-a', 'token-c'],
        relayId: 'relay-3',
      });

      // Peer 3 matches peer 1 (via token-a) and peer 2 (via token-c)
      expect(result.liveMatches).toHaveLength(2);
      const matchedPeers = result.liveMatches.map(m => m.peerId).sort();
      expect(matchedPeers).toEqual(['peer-1', 'peer-2']);
    });

    it('should not self-match', async () => {
      await registry.registerHourlyTokens('peer-1', {
        tokens: ['token-x'],
        relayId: 'relay-1',
      });

      // Register same peer again
      const result = await registry.registerHourlyTokens('peer-1', {
        tokens: ['token-x'],
        relayId: 'relay-1',
      });

      expect(result.liveMatches).toHaveLength(0);
    });
  });

  describe('Unregistration', () => {
    it('should unregister peer from all points and tokens', async () => {
      await registry.registerDailyPoints('peer-1', {
        points: ['point-1', 'point-2'],
        deadDrop: 'deaddrop-1',
        relayId: 'relay-1',
      });

      await registry.registerHourlyTokens('peer-1', {
        tokens: ['token-1', 'token-2'],
        relayId: 'relay-1',
      });

      await registry.unregisterPeer('peer-1');

      const point1 = await registry.getDailyPoint('point-1');
      const point2 = await registry.getDailyPoint('point-2');

      expect(point1).toHaveLength(0);
      expect(point2).toHaveLength(0);
    });

    it('should not affect other peers', async () => {
      await registry.registerDailyPoints('peer-1', {
        points: ['shared-point'],
        deadDrop: 'deaddrop-1',
        relayId: 'relay-1',
      });

      await registry.registerDailyPoints('peer-2', {
        points: ['shared-point'],
        deadDrop: 'deaddrop-2',
        relayId: 'relay-2',
      });

      await registry.unregisterPeer('peer-1');

      const entries = await registry.getDailyPoint('shared-point');
      expect(entries).toHaveLength(1);
      expect(entries[0]?.peerId).toBe('peer-2');
    });
  });

  describe('Cleanup', () => {
    it('should return stats', async () => {
      await registry.registerDailyPoints('peer-1', {
        points: ['point-1', 'point-2'],
        deadDrop: 'deaddrop-1',
        relayId: 'relay-1',
      });

      await registry.registerHourlyTokens('peer-1', {
        tokens: ['token-1', 'token-2', 'token-3'],
        relayId: 'relay-1',
      });

      const stats = await registry.getStats();

      expect(stats.dailyPoints).toBe(2);
      expect(stats.hourlyTokens).toBe(3);
    });

    it('should clean up expired entries', async () => {
      // Create registry with very short TTL
      const shortRegistry = new RendezvousRegistry(storage, {
        dailyTtl: 10, // 10ms
        hourlyTtl: 10, // 10ms
      });

      await shortRegistry.registerDailyPoints('peer-1', {
        points: ['expired-point'],
        deadDrop: 'deaddrop-1',
        relayId: 'relay-1',
      });

      await shortRegistry.registerHourlyTokens('peer-1', {
        tokens: ['expired-token'],
        relayId: 'relay-1',
      });

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 50));

      const result = await shortRegistry.cleanup();

      expect(result.dailyRemoved).toBe(1);
      expect(result.hourlyRemoved).toBe(1);

      // Verify they're gone
      const entries = await shortRegistry.getDailyPoint('expired-point');
      expect(entries).toHaveLength(0);
    });
  });

  describe('Concurrency', () => {
    it('should handle concurrent registrations', async () => {
      const promises: Promise<any>[] = [];

      // 10 peers registering simultaneously
      for (let i = 0; i < 10; i++) {
        promises.push(
          registry.registerDailyPoints(`peer-${i}`, {
            points: ['shared-point'],
            deadDrop: `deaddrop-${i}`,
            relayId: `relay-${i}`,
          })
        );
      }

      await Promise.all(promises);

      const entries = await registry.getDailyPoint('shared-point');
      expect(entries).toHaveLength(10);
    });
  });
});
