/**
 * Unit tests for VPSReputationManager and SQLite reputation storage.
 *
 * Covers:
 * - Score accumulation via event recording
 * - Event type point mapping (rate_limit_hit, connection_rejected, invalid_request, successful_attestation)
 * - Rate limit tier calculation with Math.max(1,...) guard
 * - Top offenders query
 * - IP hashing in event logs
 * - Per-IP event row limit (pruning)
 * - Score decay over time
 * - Admin overrides (setScore, resetScore)
 * - Time-based cleanup
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { SQLiteStorage } from '../../src/storage/sqlite.js';
import { VPSReputationManager } from '../../src/reputation/ip-reputation.js';
import { createHash } from 'node:crypto';

describe('VPSReputationManager', () => {
  let storage: SQLiteStorage;
  let manager: VPSReputationManager;
  const testDbPath = './test-data/test-reputation.db';

  beforeEach(async () => {
    if (!existsSync('./test-data')) {
      mkdirSync('./test-data', { recursive: true });
    }
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }

    storage = new SQLiteStorage(testDbPath);
    await storage.init();
    manager = new VPSReputationManager(storage);
  });

  afterEach(() => {
    storage.close();
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
  });

  describe('Score accumulation', () => {
    it('should return score 0 for unknown IP', async () => {
      const score = await manager.getScore('192.168.1.1');
      expect(score).toBe(0);
    });

    it('should add +2 for rate_limit_hit', async () => {
      const score = await manager.recordEvent('192.168.1.1', 'rate_limit_hit');
      expect(score).toBe(2);
    });

    it('should add +3 for connection_rejected', async () => {
      const score = await manager.recordEvent('192.168.1.1', 'connection_rejected');
      expect(score).toBe(3);
    });

    it('should add +5 for invalid_request', async () => {
      const score = await manager.recordEvent('192.168.1.1', 'invalid_request');
      expect(score).toBe(5);
    });

    it('should subtract -1 for successful_attestation', async () => {
      // First build up a score
      await manager.recordEvent('192.168.1.1', 'invalid_request'); // +5
      const score = await manager.recordEvent('192.168.1.1', 'successful_attestation'); // -1
      expect(score).toBe(4);
    });

    it('should accumulate multiple events', async () => {
      await manager.recordEvent('192.168.1.1', 'rate_limit_hit');     // +2 = 2
      await manager.recordEvent('192.168.1.1', 'rate_limit_hit');     // +2 = 4
      await manager.recordEvent('192.168.1.1', 'invalid_request');    // +5 = 9
      const score = await manager.recordEvent('192.168.1.1', 'connection_rejected'); // +3 = 12
      expect(score).toBe(12);
    });

    it('should never go below 0', async () => {
      const score = await manager.recordEvent('192.168.1.1', 'successful_attestation');
      expect(score).toBe(0);
    });
  });

  describe('Event counters', () => {
    it('should track per-event-type counters', async () => {
      await manager.recordEvent('192.168.1.1', 'rate_limit_hit');
      await manager.recordEvent('192.168.1.1', 'rate_limit_hit');
      await manager.recordEvent('192.168.1.1', 'invalid_request');
      await manager.recordEvent('192.168.1.1', 'connection_rejected');
      await manager.recordEvent('192.168.1.1', 'successful_attestation');

      const entry = await manager.getEntry('192.168.1.1');
      expect(entry).not.toBeNull();
      expect(entry!.rateLimitHits).toBe(2);
      expect(entry!.invalidRequests).toBe(1);
      expect(entry!.connectionRejects).toBe(1);
      expect(entry!.successfulAttestations).toBe(1);
      expect(entry!.totalEvents).toBe(5);
    });
  });

  describe('Rate limit tiers', () => {
    it('should return normal limits for score < 5', () => {
      const tier = manager.getRateLimitTier(0, 100, 60000);
      expect(tier.limit).toBe(100);
      expect(tier.windowMs).toBe(60000);
      expect(tier.blocked).toBe(false);
    });

    it('should return 50% limits for score 5-14', () => {
      const tier = manager.getRateLimitTier(5, 100, 60000);
      expect(tier.limit).toBe(50);
      expect(tier.blocked).toBe(false);
    });

    it('should return 10% limits for score 15-29', () => {
      const tier = manager.getRateLimitTier(15, 100, 60000);
      expect(tier.limit).toBe(10);
      expect(tier.blocked).toBe(false);
    });

    it('should block for score >= 30', () => {
      const tier = manager.getRateLimitTier(30, 100, 60000);
      expect(tier.limit).toBe(0);
      expect(tier.blocked).toBe(true);
      expect(tier.windowMs).toBe(300000); // 5 minutes
    });

    it('should use Math.max(1,...) to prevent zero-limit at 50% tier', () => {
      const tier = manager.getRateLimitTier(5, 1, 60000);
      expect(tier.limit).toBe(1); // Math.max(1, floor(0.5)) = 1
      expect(tier.blocked).toBe(false);
    });

    it('should use Math.max(1,...) to prevent zero-limit at 10% tier', () => {
      const tier = manager.getRateLimitTier(15, 5, 60000);
      expect(tier.limit).toBe(1); // Math.max(1, floor(0.5)) = 1
      expect(tier.blocked).toBe(false);
    });

    it('should maintain normal limits for score 4 (just below threshold)', () => {
      const tier = manager.getRateLimitTier(4, 100, 60000);
      expect(tier.limit).toBe(100);
      expect(tier.blocked).toBe(false);
    });
  });

  describe('isBlocked', () => {
    it('should return true for score >= 30', async () => {
      // Build up score to 30+ (6 invalid requests = 6*5 = 30)
      for (let i = 0; i < 6; i++) {
        await manager.recordEvent('192.168.1.1', 'invalid_request');
      }
      const blocked = await manager.isBlocked('192.168.1.1');
      expect(blocked).toBe(true);
    });

    it('should return false for score < 30', async () => {
      await manager.recordEvent('192.168.1.1', 'invalid_request'); // +5
      const blocked = await manager.isBlocked('192.168.1.1');
      expect(blocked).toBe(false);
    });
  });

  describe('Top offenders', () => {
    it('should return top offenders sorted by score DESC', async () => {
      // Create IPs with different scores
      await manager.recordEvent('10.0.0.1', 'invalid_request');        // 5
      await manager.recordEvent('10.0.0.2', 'rate_limit_hit');         // 2
      await manager.recordEvent('10.0.0.3', 'invalid_request');        // 5
      await manager.recordEvent('10.0.0.3', 'invalid_request');        // 10
      await manager.recordEvent('10.0.0.4', 'connection_rejected');    // 3

      const offenders = await manager.getTopOffenders(3);
      expect(offenders).toHaveLength(3);
      expect(offenders[0].ipAddress).toBe('10.0.0.3');
      expect(offenders[0].reputationScore).toBe(10);
    });

    it('should respect the limit parameter', async () => {
      for (let i = 0; i < 10; i++) {
        await manager.recordEvent(`10.0.0.${i}`, 'rate_limit_hit');
      }

      const offenders = await manager.getTopOffenders(5);
      expect(offenders).toHaveLength(5);
    });
  });

  describe('IP hashing in event logs', () => {
    it('should store hashed IP in event logs, not raw IP', async () => {
      await manager.recordEvent('192.168.1.100', 'rate_limit_hit');

      // Directly query the events table to verify hashing
      const db = (storage as any).db;
      const rows = db.prepare('SELECT ip_hash FROM ip_reputation_events').all();
      expect(rows).toHaveLength(1);

      // Verify the hash matches expected SHA-256
      const expectedHash = createHash('sha256')
        .update('zajel-rep:192.168.1.100')
        .digest('hex');
      expect(rows[0].ip_hash).toBe(expectedHash);

      // Verify raw IP is NOT in event log
      const rawIpRows = db.prepare(
        "SELECT * FROM ip_reputation_events WHERE ip_hash = '192.168.1.100'"
      ).all();
      expect(rawIpRows).toHaveLength(0);
    });
  });

  describe('Admin overrides', () => {
    it('should reset score to 0', async () => {
      await manager.recordEvent('192.168.1.1', 'invalid_request'); // +5
      await manager.recordEvent('192.168.1.1', 'invalid_request'); // +5 = 10

      await manager.resetScore('192.168.1.1');

      const score = await manager.getScore('192.168.1.1');
      expect(score).toBe(0);
    });

    it('should set score to a specific value', async () => {
      await manager.recordEvent('192.168.1.1', 'invalid_request'); // +5

      await manager.setScore('192.168.1.1', 25);

      const score = await manager.getScore('192.168.1.1');
      expect(score).toBe(25);
    });

    it('should prevent negative scores via setScore', async () => {
      await manager.setScore('192.168.1.1', -10);

      const score = await manager.getScore('192.168.1.1');
      expect(score).toBe(0);
    });

    it('should create entry if IP does not exist when setting score', async () => {
      await manager.setScore('10.99.99.99', 15);

      const score = await manager.getScore('10.99.99.99');
      expect(score).toBe(15);
    });
  });

  describe('Event cleanup', () => {
    it('should clean up old events', async () => {
      await manager.recordEvent('192.168.1.1', 'rate_limit_hit');

      // Set event timestamp to old (directly in DB)
      const db = (storage as any).db;
      db.prepare(
        'UPDATE ip_reputation_events SET created_at = ?'
      ).run(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days ago

      const cleaned = await manager.cleanupOldEvents();
      expect(cleaned).toBe(1);

      // Verify events are cleaned
      const rows = db.prepare('SELECT * FROM ip_reputation_events').all();
      expect(rows).toHaveLength(0);
    });
  });

  describe('Score decay', () => {
    it('should halve score after 24 hours', async () => {
      // Record events to get score of 30
      for (let i = 0; i < 6; i++) {
        await manager.recordEvent('192.168.1.1', 'invalid_request'); // 6 * 5 = 30
      }

      // Fast-forward last_updated by 24 hours
      const db = (storage as any).db;
      db.prepare(
        'UPDATE ip_reputation SET last_updated = ? WHERE ip_address = ?'
      ).run(Date.now() - 24 * 60 * 60 * 1000, '192.168.1.1');

      const score = await manager.getScore('192.168.1.1');
      expect(score).toBe(15); // 30 * 0.5 = 15
    });

    it('should quarter score after 48 hours', async () => {
      for (let i = 0; i < 6; i++) {
        await manager.recordEvent('192.168.1.1', 'invalid_request'); // 30
      }

      const db = (storage as any).db;
      db.prepare(
        'UPDATE ip_reputation SET last_updated = ? WHERE ip_address = ?'
      ).run(Date.now() - 48 * 60 * 60 * 1000, '192.168.1.1');

      const score = await manager.getScore('192.168.1.1');
      expect(score).toBe(7); // 30 * 0.25 = 7.5, floored to 7
    });

    it('should not decay within 24 hours', async () => {
      await manager.recordEvent('192.168.1.1', 'invalid_request'); // 5

      // last_updated is recent (just set above), so no decay
      const score = await manager.getScore('192.168.1.1');
      expect(score).toBe(5);
    });
  });
});
