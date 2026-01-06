/**
 * Storage Layer Tests
 *
 * Tests for SQLite storage implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { SQLiteStorage } from '../../src/storage/sqlite.js';
import type { DailyPointEntry, HourlyTokenEntry, MembershipEntry } from '../../src/types.js';

describe('SQLiteStorage', () => {
  let storage: SQLiteStorage;
  const testDbPath = './test-data/test-storage.db';

  beforeEach(async () => {
    if (!existsSync('./test-data')) {
      mkdirSync('./test-data', { recursive: true });
    }
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }

    storage = new SQLiteStorage(testDbPath);
    await storage.init();
  });

  afterEach(() => {
    storage.close();
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
  });

  describe('Daily Points', () => {
    it('should insert and retrieve daily points', async () => {
      const entry: DailyPointEntry = {
        pointHash: 'test-point',
        peerId: 'peer-1',
        deadDrop: 'encrypted-data',
        relayId: 'relay-1',
        expiresAt: Date.now() + 3600000,
      };

      await storage.saveDailyPoint(entry);
      const results = await storage.getDailyPoints('test-point');

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        pointHash: 'test-point',
        peerId: 'peer-1',
        deadDrop: 'encrypted-data',
        relayId: 'relay-1',
      });
    });

    it('should upsert (update existing entry)', async () => {
      const entry1: DailyPointEntry = {
        pointHash: 'test-point',
        peerId: 'peer-1',
        deadDrop: 'original-data',
        relayId: 'relay-1',
        expiresAt: Date.now() + 3600000,
      };

      const entry2: DailyPointEntry = {
        pointHash: 'test-point',
        peerId: 'peer-1',
        deadDrop: 'updated-data',
        relayId: 'relay-2',
        expiresAt: Date.now() + 7200000,
      };

      await storage.saveDailyPoint(entry1);
      await storage.saveDailyPoint(entry2);

      const results = await storage.getDailyPoints('test-point');

      expect(results).toHaveLength(1);
      expect(results[0]?.deadDrop).toBe('updated-data');
      expect(results[0]?.relayId).toBe('relay-2');
    });

    it('should handle multiple peers at same point', async () => {
      const now = Date.now();

      await storage.saveDailyPoint({
        pointHash: 'shared-point',
        peerId: 'peer-1',
        deadDrop: 'data-1',
        relayId: 'relay-1',
        expiresAt: now + 3600000,
      });

      await storage.saveDailyPoint({
        pointHash: 'shared-point',
        peerId: 'peer-2',
        deadDrop: 'data-2',
        relayId: 'relay-2',
        expiresAt: now + 3600000,
      });

      const results = await storage.getDailyPoints('shared-point');

      expect(results).toHaveLength(2);
    });

    it('should delete by peer', async () => {
      await storage.saveDailyPoint({
        pointHash: 'point-1',
        peerId: 'peer-1',
        deadDrop: 'data',
        relayId: 'relay',
        expiresAt: Date.now() + 3600000,
      });

      await storage.saveDailyPoint({
        pointHash: 'point-2',
        peerId: 'peer-1',
        deadDrop: 'data',
        relayId: 'relay',
        expiresAt: Date.now() + 3600000,
      });

      const deleted = await storage.deleteDailyPointsByPeer('peer-1');

      expect(deleted).toBe(2);

      const results1 = await storage.getDailyPoints('point-1');
      const results2 = await storage.getDailyPoints('point-2');

      expect(results1).toHaveLength(0);
      expect(results2).toHaveLength(0);
    });

    it('should delete expired entries', async () => {
      const now = Date.now();

      await storage.saveDailyPoint({
        pointHash: 'expired',
        peerId: 'peer-1',
        deadDrop: 'data',
        relayId: 'relay',
        expiresAt: now - 1000, // Already expired
      });

      await storage.saveDailyPoint({
        pointHash: 'valid',
        peerId: 'peer-2',
        deadDrop: 'data',
        relayId: 'relay',
        expiresAt: now + 3600000,
      });

      const deleted = await storage.deleteExpiredDailyPoints(now);

      expect(deleted).toBe(1);

      const expired = await storage.getDailyPoints('expired');
      const valid = await storage.getDailyPoints('valid');

      expect(expired).toHaveLength(0);
      expect(valid).toHaveLength(1);
    });

    it('should get stats', async () => {
      await storage.saveDailyPoint({
        pointHash: 'point-a',
        peerId: 'peer-1',
        deadDrop: 'data',
        relayId: 'relay',
        expiresAt: Date.now() + 3600000,
      });

      await storage.saveDailyPoint({
        pointHash: 'point-a',
        peerId: 'peer-2',
        deadDrop: 'data',
        relayId: 'relay',
        expiresAt: Date.now() + 3600000,
      });

      await storage.saveDailyPoint({
        pointHash: 'point-b',
        peerId: 'peer-1',
        deadDrop: 'data',
        relayId: 'relay',
        expiresAt: Date.now() + 3600000,
      });

      const stats = await storage.getDailyPointStats();

      expect(stats.totalEntries).toBe(3);
      expect(stats.uniquePoints).toBe(2);
    });
  });

  describe('Hourly Tokens', () => {
    it('should insert and retrieve hourly tokens', async () => {
      const entry: HourlyTokenEntry = {
        tokenHash: 'test-token',
        peerId: 'peer-1',
        relayId: 'relay-1',
        expiresAt: Date.now() + 300000,
      };

      await storage.saveHourlyToken(entry);
      const results = await storage.getHourlyTokens('test-token');

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        tokenHash: 'test-token',
        peerId: 'peer-1',
        relayId: 'relay-1',
      });
    });

    it('should handle multiple peers with same token', async () => {
      const now = Date.now();

      await storage.saveHourlyToken({
        tokenHash: 'shared-token',
        peerId: 'peer-1',
        relayId: 'relay-1',
        expiresAt: now + 300000,
      });

      await storage.saveHourlyToken({
        tokenHash: 'shared-token',
        peerId: 'peer-2',
        relayId: 'relay-2',
        expiresAt: now + 300000,
      });

      const results = await storage.getHourlyTokens('shared-token');

      expect(results).toHaveLength(2);
    });

    it('should delete by peer', async () => {
      await storage.saveHourlyToken({
        tokenHash: 'token-1',
        peerId: 'peer-1',
        relayId: 'relay',
        expiresAt: Date.now() + 300000,
      });

      await storage.saveHourlyToken({
        tokenHash: 'token-2',
        peerId: 'peer-1',
        relayId: 'relay',
        expiresAt: Date.now() + 300000,
      });

      const deleted = await storage.deleteHourlyTokensByPeer('peer-1');

      expect(deleted).toBe(2);
    });

    it('should delete expired entries', async () => {
      const now = Date.now();

      await storage.saveHourlyToken({
        tokenHash: 'expired',
        peerId: 'peer-1',
        relayId: 'relay',
        expiresAt: now - 1000,
      });

      await storage.saveHourlyToken({
        tokenHash: 'valid',
        peerId: 'peer-2',
        relayId: 'relay',
        expiresAt: now + 300000,
      });

      const deleted = await storage.deleteExpiredHourlyTokens(now);

      expect(deleted).toBe(1);
    });

    it('should get stats', async () => {
      await storage.saveHourlyToken({
        tokenHash: 'token-a',
        peerId: 'peer-1',
        relayId: 'relay',
        expiresAt: Date.now() + 300000,
      });

      await storage.saveHourlyToken({
        tokenHash: 'token-a',
        peerId: 'peer-2',
        relayId: 'relay',
        expiresAt: Date.now() + 300000,
      });

      await storage.saveHourlyToken({
        tokenHash: 'token-b',
        peerId: 'peer-1',
        relayId: 'relay',
        expiresAt: Date.now() + 300000,
      });

      const stats = await storage.getHourlyTokenStats();

      expect(stats.totalEntries).toBe(3);
      expect(stats.uniqueTokens).toBe(2);
    });
  });

  describe('Membership', () => {
    it('should save and retrieve server entries', async () => {
      const entry: MembershipEntry = {
        serverId: 'ed25519:abc123',
        nodeId: '0'.repeat(40),
        endpoint: 'wss://server1.example.com',
        publicKey: new Uint8Array([1, 2, 3, 4]),
        status: 'alive',
        incarnation: 1,
        lastSeen: Date.now(),
        metadata: { region: 'us-east' },
      };

      await storage.saveServer(entry);
      const servers = await storage.getAllServers();

      expect(servers).toHaveLength(1);
      expect(servers[0]?.serverId).toBe('ed25519:abc123');
      expect(servers[0]?.status).toBe('alive');
    });

    it('should update existing server', async () => {
      const entry1: MembershipEntry = {
        serverId: 'ed25519:abc123',
        nodeId: '0'.repeat(40),
        endpoint: 'wss://server1.example.com',
        publicKey: new Uint8Array([1, 2, 3, 4]),
        status: 'alive',
        incarnation: 1,
        lastSeen: Date.now(),
        metadata: {},
      };

      const entry2: MembershipEntry = {
        ...entry1,
        status: 'suspect',
        incarnation: 2,
        lastSeen: Date.now() + 1000,
      };

      await storage.saveServer(entry1);
      await storage.saveServer(entry2);

      const servers = await storage.getAllServers();

      expect(servers).toHaveLength(1);
      expect(servers[0]?.status).toBe('suspect');
      expect(servers[0]?.incarnation).toBe(2);
    });

    it('should handle multiple servers', async () => {
      for (let i = 1; i <= 5; i++) {
        await storage.saveServer({
          serverId: `ed25519:server${i}`,
          nodeId: `${i}`.repeat(40),
          endpoint: `wss://server${i}.example.com`,
          publicKey: new Uint8Array([i]),
          status: 'alive',
          incarnation: 1,
          lastSeen: Date.now(),
          metadata: {},
        });
      }

      const servers = await storage.getAllServers();
      expect(servers).toHaveLength(5);
    });
  });

  describe('Database Operations', () => {
    it('should handle concurrent writes', async () => {
      const promises: Promise<void>[] = [];

      for (let i = 0; i < 100; i++) {
        promises.push(
          storage.saveDailyPoint({
            pointHash: `point-${i}`,
            peerId: `peer-${i}`,
            deadDrop: `data-${i}`,
            relayId: `relay-${i}`,
            expiresAt: Date.now() + 3600000,
          })
        );
      }

      await Promise.all(promises);

      const stats = await storage.getDailyPointStats();
      expect(stats.totalEntries).toBe(100);
    });

    it('should survive close and reopen', async () => {
      await storage.saveDailyPoint({
        pointHash: 'persistent',
        peerId: 'peer-1',
        deadDrop: 'important-data',
        relayId: 'relay',
        expiresAt: Date.now() + 3600000,
      });

      storage.close();

      // Reopen
      const storage2 = new SQLiteStorage(testDbPath);
      await storage2.init();

      const results = await storage2.getDailyPoints('persistent');
      expect(results).toHaveLength(1);
      expect(results[0]?.deadDrop).toBe('important-data');

      storage2.close();
    });
  });
});
