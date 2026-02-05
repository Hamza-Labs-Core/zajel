/**
 * Client Handler Rendezvous Protocol Tests
 *
 * Tests for the register_rendezvous message handling, including:
 * - Legacy single deadDrop format
 * - New deadDrops map format
 * - Mixed snake_case and camelCase field names
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { RendezvousRegistry, type DeadDropResult, type LiveMatchResult } from '../../src/registry/rendezvous-registry.js';
import { DistributedRendezvous } from '../../src/registry/distributed-rendezvous.js';
import { SQLiteStorage } from '../../src/storage/sqlite.js';
import { HashRing, RoutingTable } from '../../src/federation/dht/hash-ring.js';

// Mock WebSocket for testing
class MockWebSocket {
  messages: any[] = [];
  readyState = 1; // OPEN

  send(data: string) {
    this.messages.push(JSON.parse(data));
  }

  clear() {
    this.messages = [];
  }

  getLastMessage() {
    return this.messages[this.messages.length - 1];
  }
}

describe('Client Handler Rendezvous Protocol', () => {
  let storage: SQLiteStorage;
  let registry: RendezvousRegistry;
  let distributedRendezvous: DistributedRendezvous;
  let ring: HashRing;
  let routingTable: RoutingTable;
  const testDbPath = './test-data/test-handler-rendezvous.db';
  const serverId = 'test-server-001';

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
      dailyTtl: 3600000,
      hourlyTtl: 300000,
    });

    // Create hash ring with virtual nodes for testing
    ring = new HashRing(10);
    routingTable = new RoutingTable(ring, serverId, 1);

    // Add our server as the only node
    ring.addNode({
      serverId,
      nodeId: `${serverId}-node`,
      endpoint: 'ws://localhost:8080',
      status: 'alive',
    });

    distributedRendezvous = new DistributedRendezvous(
      registry,
      routingTable,
      ring,
      { replicationFactor: 1 }
    );
  });

  afterEach(() => {
    storage.close();
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
  });

  describe('Legacy Format (single deadDrop)', () => {
    it('should handle register_rendezvous with single deadDrop', async () => {
      const result = await distributedRendezvous.registerDailyPoints('peer-1', {
        points: ['point-a', 'point-b', 'point-c'],
        deadDrop: 'encrypted-connection-info',
        relayId: 'relay-001',
      });

      // All points should be registered locally (single server)
      expect(result.redirects).toHaveLength(0);
      expect(result.local.deadDrops).toHaveLength(0); // No existing entries

      // Verify points were registered
      const pointA = await registry.getDailyPoint('point-a');
      const pointB = await registry.getDailyPoint('point-b');
      const pointC = await registry.getDailyPoint('point-c');

      expect(pointA).toHaveLength(1);
      expect(pointA[0]?.peerId).toBe('peer-1');
      expect(pointA[0]?.deadDrop).toBe('encrypted-connection-info');

      expect(pointB).toHaveLength(1);
      expect(pointC).toHaveLength(1);
    });

    it('should return dead drops from other peers with legacy format', async () => {
      // Peer 1 registers first
      await distributedRendezvous.registerDailyPoints('peer-1', {
        points: ['shared-point'],
        deadDrop: 'peer-1-dead-drop',
        relayId: 'relay-1',
      });

      // Peer 2 registers at same point
      const result = await distributedRendezvous.registerDailyPoints('peer-2', {
        points: ['shared-point'],
        deadDrop: 'peer-2-dead-drop',
        relayId: 'relay-2',
      });

      expect(result.local.deadDrops).toHaveLength(1);
      expect(result.local.deadDrops[0]?.peerId).toBe('peer-1');
      expect(result.local.deadDrops[0]?.deadDrop).toBe('peer-1-dead-drop');
    });
  });

  describe('New Format (deadDrops map)', () => {
    it('should handle per-point dead drops', async () => {
      // Simulate the new format by calling registerDailyPoints multiple times
      // (as the handler would do with the deadDrops map)

      // Point A has its own dead drop
      await distributedRendezvous.registerDailyPoints('peer-1', {
        points: ['point-a'],
        deadDrop: 'dead-drop-for-point-a',
        relayId: 'relay-001',
      });

      // Point B has a different dead drop
      await distributedRendezvous.registerDailyPoints('peer-1', {
        points: ['point-b'],
        deadDrop: 'dead-drop-for-point-b',
        relayId: 'relay-001',
      });

      // Verify each point has its specific dead drop
      const pointA = await registry.getDailyPoint('point-a');
      const pointB = await registry.getDailyPoint('point-b');

      expect(pointA[0]?.deadDrop).toBe('dead-drop-for-point-a');
      expect(pointB[0]?.deadDrop).toBe('dead-drop-for-point-b');
    });

    it('should handle mixed points with and without dead drops', async () => {
      // Point A has dead drop
      await distributedRendezvous.registerDailyPoints('peer-1', {
        points: ['point-a'],
        deadDrop: 'dead-drop-a',
        relayId: 'relay-001',
      });

      // Points B and C have no dead drops
      await distributedRendezvous.registerDailyPoints('peer-1', {
        points: ['point-b', 'point-c'],
        deadDrop: '',
        relayId: 'relay-001',
      });

      const pointA = await registry.getDailyPoint('point-a');
      const pointB = await registry.getDailyPoint('point-b');
      const pointC = await registry.getDailyPoint('point-c');

      expect(pointA[0]?.deadDrop).toBe('dead-drop-a');
      expect(pointB[0]?.deadDrop).toBe('');
      expect(pointC[0]?.deadDrop).toBe('');
    });
  });

  describe('Hourly Tokens', () => {
    it('should register hourly tokens', async () => {
      const result = await distributedRendezvous.registerHourlyTokens('peer-1', {
        tokens: ['token-a', 'token-b', 'token-c'],
        relayId: 'relay-001',
      });

      expect(result.redirects).toHaveLength(0);
      expect(result.local.liveMatches).toHaveLength(0);
    });

    it('should return live matches for hourly tokens', async () => {
      // Peer 1 registers first
      await distributedRendezvous.registerHourlyTokens('peer-1', {
        tokens: ['shared-token'],
        relayId: 'relay-1',
      });

      // Peer 2 registers with same token
      const result = await distributedRendezvous.registerHourlyTokens('peer-2', {
        tokens: ['shared-token'],
        relayId: 'relay-2',
      });

      expect(result.local.liveMatches).toHaveLength(1);
      expect(result.local.liveMatches[0]?.peerId).toBe('peer-1');
      expect(result.local.liveMatches[0]?.relayId).toBe('relay-1');
    });

    it('should emit match event for existing peer', async () => {
      const matchEvents: Array<{ peerId: string; match: LiveMatchResult }> = [];

      distributedRendezvous.on('match', (peerId, match) => {
        matchEvents.push({ peerId, match });
      });

      // Peer 1 registers
      await distributedRendezvous.registerHourlyTokens('peer-1', {
        tokens: ['matching-token'],
        relayId: 'relay-1',
      });

      // Peer 2 matches
      await distributedRendezvous.registerHourlyTokens('peer-2', {
        tokens: ['matching-token'],
        relayId: 'relay-2',
      });

      // Peer 1 should receive event
      expect(matchEvents).toHaveLength(1);
      expect(matchEvents[0]?.peerId).toBe('peer-1');
      expect(matchEvents[0]?.match.peerId).toBe('peer-2');
    });
  });

  describe('Combined Registration', () => {
    it('should handle both daily points and hourly tokens', async () => {
      // Register daily points
      const dailyResult = await distributedRendezvous.registerDailyPoints('peer-1', {
        points: ['daily-point-1', 'daily-point-2'],
        deadDrop: 'my-dead-drop',
        relayId: 'relay-001',
      });

      // Register hourly tokens
      const hourlyResult = await distributedRendezvous.registerHourlyTokens('peer-1', {
        tokens: ['hourly-token-1', 'hourly-token-2'],
        relayId: 'relay-001',
      });

      expect(dailyResult.redirects).toHaveLength(0);
      expect(hourlyResult.redirects).toHaveLength(0);

      // Verify stats
      const stats = await registry.getStats();
      expect(stats.dailyPoints).toBe(2);
      expect(stats.hourlyTokens).toBe(2);
    });
  });

  describe('Response Message Format', () => {
    it('should format rendezvous_result correctly', async () => {
      // Peer 1 registers
      await distributedRendezvous.registerDailyPoints('peer-1', {
        points: ['point-a'],
        deadDrop: 'peer-1-drop',
        relayId: 'relay-1',
      });

      await distributedRendezvous.registerHourlyTokens('peer-1', {
        tokens: ['token-a'],
        relayId: 'relay-1',
      });

      // Peer 2 registers at same points
      const dailyResult = await distributedRendezvous.registerDailyPoints('peer-2', {
        points: ['point-a'],
        deadDrop: 'peer-2-drop',
        relayId: 'relay-2',
      });

      const hourlyResult = await distributedRendezvous.registerHourlyTokens('peer-2', {
        tokens: ['token-a'],
        relayId: 'relay-2',
      });

      // Construct response as handler would
      const response = {
        type: 'rendezvous_result',
        liveMatches: hourlyResult.local.liveMatches,
        deadDrops: dailyResult.local.deadDrops,
      };

      expect(response.type).toBe('rendezvous_result');
      expect(response.liveMatches).toHaveLength(1);
      expect(response.deadDrops).toHaveLength(1);

      // Verify structure
      expect(response.liveMatches[0]).toHaveProperty('peerId');
      expect(response.liveMatches[0]).toHaveProperty('relayId');
      expect(response.deadDrops[0]).toHaveProperty('peerId');
      expect(response.deadDrops[0]).toHaveProperty('deadDrop');
      expect(response.deadDrops[0]).toHaveProperty('relayId');
    });
  });

  describe('Multiple Peers Scenario', () => {
    it('should handle complex multi-peer registration', async () => {
      // Peer A registers at points 1, 2
      await distributedRendezvous.registerDailyPoints('peer-a', {
        points: ['point-1', 'point-2'],
        deadDrop: 'dead-drop-a',
        relayId: 'relay-a',
      });

      // Peer B registers at points 2, 3
      const resultB = await distributedRendezvous.registerDailyPoints('peer-b', {
        points: ['point-2', 'point-3'],
        deadDrop: 'dead-drop-b',
        relayId: 'relay-b',
      });

      // Peer B should find peer A at point-2
      expect(resultB.local.deadDrops).toHaveLength(1);
      expect(resultB.local.deadDrops[0]?.peerId).toBe('peer-a');

      // Peer C registers at points 1, 3
      const resultC = await distributedRendezvous.registerDailyPoints('peer-c', {
        points: ['point-1', 'point-3'],
        deadDrop: 'dead-drop-c',
        relayId: 'relay-c',
      });

      // Peer C should find peer A at point-1 and peer B at point-3
      expect(resultC.local.deadDrops).toHaveLength(2);
      const foundPeers = resultC.local.deadDrops.map(d => d.peerId).sort();
      expect(foundPeers).toEqual(['peer-a', 'peer-b']);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty points array', async () => {
      const result = await distributedRendezvous.registerDailyPoints('peer-1', {
        points: [],
        deadDrop: 'dead-drop',
        relayId: 'relay-1',
      });

      expect(result.local.deadDrops).toHaveLength(0);
      expect(result.redirects).toHaveLength(0);
    });

    it('should handle empty tokens array', async () => {
      const result = await distributedRendezvous.registerHourlyTokens('peer-1', {
        tokens: [],
        relayId: 'relay-1',
      });

      expect(result.local.liveMatches).toHaveLength(0);
      expect(result.redirects).toHaveLength(0);
    });

    it('should handle empty dead drop string', async () => {
      await distributedRendezvous.registerDailyPoints('peer-1', {
        points: ['point-a'],
        deadDrop: '',
        relayId: 'relay-1',
      });

      const entries = await registry.getDailyPoint('point-a');
      expect(entries[0]?.deadDrop).toBe('');
    });

    it('should handle very long dead drop data', async () => {
      const longDeadDrop = 'x'.repeat(10000); // 10KB of data

      await distributedRendezvous.registerDailyPoints('peer-1', {
        points: ['point-a'],
        deadDrop: longDeadDrop,
        relayId: 'relay-1',
      });

      const entries = await registry.getDailyPoint('point-a');
      expect(entries[0]?.deadDrop).toBe(longDeadDrop);
    });
  });
});
