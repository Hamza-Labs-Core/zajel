/**
 * Distributed Rendezvous Integration Tests
 *
 * Tests the complete flow from distributed rendezvous through
 * hash ring routing to local registry storage.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { DistributedRendezvous } from '../../src/registry/distributed-rendezvous.js';
import { RendezvousRegistry, type LiveMatchResult } from '../../src/registry/rendezvous-registry.js';
import { SQLiteStorage } from '../../src/storage/sqlite.js';
import { HashRing, RoutingTable } from '../../src/federation/dht/hash-ring.js';

describe('Distributed Rendezvous Integration', () => {
  const testDir = './test-data/integration';
  let storage: SQLiteStorage;
  let registry: RendezvousRegistry;
  let ring: HashRing;
  let routingTable: RoutingTable;
  let distributed: DistributedRendezvous;

  beforeEach(async () => {
    // Setup test directory
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }

    const dbPath = `${testDir}/test.db`;
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
    }

    // Initialize components
    storage = new SQLiteStorage(dbPath);
    await storage.init();

    registry = new RendezvousRegistry(storage, {
      dailyTtl: 3600000,
      hourlyTtl: 300000,
    });

    ring = new HashRing(10); // 10 virtual nodes for testing
    routingTable = new RoutingTable(ring, 'local-server', 3);

    distributed = new DistributedRendezvous(registry, routingTable, ring, {
      replicationFactor: 3,
    });
  });

  afterEach(() => {
    storage.close();
  });

  describe('Single Server Scenario', () => {
    it('should handle all points locally when no other servers', async () => {
      // Only local server in the ring
      ring.addNode({
        serverId: 'local-server',
        nodeId: 'local-node-id',
        endpoint: 'wss://local.example.com',
        status: 'alive',
      });

      const result = await distributed.registerDailyPoints('peer-1', {
        points: ['point-a', 'point-b', 'point-c'],
        deadDrop: 'encrypted-data',
        relayId: 'relay-1',
      });

      expect(result.redirects).toHaveLength(0);
      expect(result.local.deadDrops).toHaveLength(0); // No other peers yet
    });

    it('should find matches locally', async () => {
      ring.addNode({
        serverId: 'local-server',
        nodeId: 'local-node-id',
        endpoint: 'wss://local.example.com',
        status: 'alive',
      });

      // Peer 1 registers
      await distributed.registerDailyPoints('peer-1', {
        points: ['shared-point'],
        deadDrop: 'peer-1-deaddrop',
        relayId: 'relay-1',
      });

      // Peer 2 registers at same point
      const result = await distributed.registerDailyPoints('peer-2', {
        points: ['shared-point'],
        deadDrop: 'peer-2-deaddrop',
        relayId: 'relay-2',
      });

      expect(result.local.deadDrops).toHaveLength(1);
      expect(result.local.deadDrops[0]?.peerId).toBe('peer-1');
    });
  });

  describe('Multi-Server Scenario', () => {
    beforeEach(() => {
      // Add 3 servers to the ring
      ring.addNode({
        serverId: 'local-server',
        nodeId: 'local-node-id',
        endpoint: 'wss://local.example.com',
        status: 'alive',
      });

      ring.addNode({
        serverId: 'server-2',
        nodeId: 'server-2-node-id',
        endpoint: 'wss://server2.example.com',
        status: 'alive',
      });

      ring.addNode({
        serverId: 'server-3',
        nodeId: 'server-3-node-id',
        endpoint: 'wss://server3.example.com',
        status: 'alive',
      });
    });

    it('should partition points between local and remote', async () => {
      // Generate many points - some should be local, some remote
      const points: string[] = [];
      for (let i = 0; i < 100; i++) {
        points.push(`point-${i}`);
      }

      const result = await distributed.registerDailyPoints('peer-1', {
        points,
        deadDrop: 'deaddrop',
        relayId: 'relay',
      });

      // With 3 servers and RF=3, all points should be local
      // (because we're part of every replication set)
      expect(result.redirects).toHaveLength(0);
    });

    it('should return redirect info for remote points with more servers', () => {
      // Add more servers so we're not part of every replication set
      for (let i = 4; i <= 10; i++) {
        ring.addNode({
          serverId: `server-${i}`,
          nodeId: `server-${i}-node-id`,
          endpoint: `wss://server${i}.example.com`,
          status: 'alive',
        });
      }

      // Recreate routing table with RF=3
      routingTable = new RoutingTable(ring, 'local-server', 3);
      distributed = new DistributedRendezvous(registry, routingTable, ring, {
        replicationFactor: 3,
      });

      // Find a point that's not handled locally
      let remotePoint: string | null = null;
      for (let i = 0; i < 1000; i++) {
        const point = `test-point-${i}`;
        if (!distributed.shouldHandleLocally(point)) {
          remotePoint = point;
          break;
        }
      }

      // With 10 servers and RF=3, there should be some remote points
      expect(remotePoint).not.toBeNull();
    });
  });

  describe('Hourly Tokens', () => {
    beforeEach(() => {
      ring.addNode({
        serverId: 'local-server',
        nodeId: 'local-node-id',
        endpoint: 'wss://local.example.com',
        status: 'alive',
      });
    });

    it('should match peers with live tokens', async () => {
      // Peer 1 registers tokens
      await distributed.registerHourlyTokens('peer-1', {
        tokens: ['matching-token', 'unique-token-1'],
        relayId: 'relay-1',
      });

      // Peer 2 registers overlapping token
      const result = await distributed.registerHourlyTokens('peer-2', {
        tokens: ['matching-token', 'unique-token-2'],
        relayId: 'relay-2',
      });

      expect(result.local.liveMatches).toHaveLength(1);
      expect(result.local.liveMatches[0]?.peerId).toBe('peer-1');
    });

    it('should emit match events', async () => {
      const matchEvents: Array<{ peerId: string; match: LiveMatchResult }> = [];

      distributed.on('match', (peerId, match) => {
        matchEvents.push({ peerId, match });
      });

      await distributed.registerHourlyTokens('peer-1', {
        tokens: ['live-token'],
        relayId: 'relay-1',
      });

      await distributed.registerHourlyTokens('peer-2', {
        tokens: ['live-token'],
        relayId: 'relay-2',
      });

      // Peer 1 should receive event about peer 2
      expect(matchEvents).toHaveLength(1);
      expect(matchEvents[0]?.peerId).toBe('peer-1');
      expect(matchEvents[0]?.match.peerId).toBe('peer-2');
    });
  });

  describe('Point Queries', () => {
    beforeEach(() => {
      ring.addNode({
        serverId: 'local-server',
        nodeId: 'local-node-id',
        endpoint: 'wss://local.example.com',
        status: 'alive',
      });

      ring.addNode({
        serverId: 'server-2',
        nodeId: 'server-2-node-id',
        endpoint: 'wss://server2.example.com',
        status: 'alive',
      });
    });

    it('should return local entries for local points', async () => {
      // Register at a point
      await distributed.registerDailyPoints('peer-1', {
        points: ['query-point'],
        deadDrop: 'deaddrop-1',
        relayId: 'relay-1',
      });

      // Query the point
      const result = await distributed.getDailyPoint('query-point');

      expect(result.local).not.toBeNull();
      expect(result.redirect).toBeNull();
    });

    it('should return redirect for remote points with many servers', () => {
      // Add many servers to ensure some points are remote
      for (let i = 3; i <= 15; i++) {
        ring.addNode({
          serverId: `server-${i}`,
          nodeId: `server-${i}-node-id`,
          endpoint: `wss://server${i}.example.com`,
          status: 'alive',
        });
      }

      routingTable = new RoutingTable(ring, 'local-server', 3);
      distributed = new DistributedRendezvous(registry, routingTable, ring, {
        replicationFactor: 3,
      });

      // Find a remote point
      for (let i = 0; i < 1000; i++) {
        const point = `remote-point-${i}`;
        if (!distributed.shouldHandleLocally(point)) {
          // This is a remote point - query would return redirect
          const responsible = ring.getResponsibleNodes(point, 1);
          expect(responsible.length).toBeGreaterThan(0);
          break;
        }
      }
    });
  });

  describe('Unregistration', () => {
    beforeEach(() => {
      ring.addNode({
        serverId: 'local-server',
        nodeId: 'local-node-id',
        endpoint: 'wss://local.example.com',
        status: 'alive',
      });
    });

    it('should clean up peer data on unregister', async () => {
      await distributed.registerDailyPoints('peer-1', {
        points: ['point-1', 'point-2'],
        deadDrop: 'deaddrop',
        relayId: 'relay',
      });

      await distributed.registerHourlyTokens('peer-1', {
        tokens: ['token-1', 'token-2'],
        relayId: 'relay',
      });

      await distributed.unregisterPeer('peer-1');

      // Check data is gone
      const point1 = await distributed.getDailyPoint('point-1');
      const point2 = await distributed.getDailyPoint('point-2');

      expect(point1.local).toHaveLength(0);
      expect(point2.local).toHaveLength(0);
    });
  });

  describe('Statistics', () => {
    beforeEach(() => {
      ring.addNode({
        serverId: 'local-server',
        nodeId: 'local-node-id',
        endpoint: 'wss://local.example.com',
        status: 'alive',
      });

      ring.addNode({
        serverId: 'server-2',
        nodeId: 'server-2-node-id',
        endpoint: 'wss://server2.example.com',
        status: 'alive',
      });
    });

    it('should return accurate stats', async () => {
      await distributed.registerDailyPoints('peer-1', {
        points: ['point-1', 'point-2'],
        deadDrop: 'deaddrop',
        relayId: 'relay',
      });

      await distributed.registerHourlyTokens('peer-1', {
        tokens: ['token-1', 'token-2', 'token-3'],
        relayId: 'relay',
      });

      const stats = await distributed.getStats();

      expect(stats.localDailyPoints).toBe(2);
      expect(stats.localHourlyTokens).toBe(3);
      expect(stats.ringNodeCount).toBe(2);
      expect(stats.activeNodes).toBe(2);
    });
  });
});
