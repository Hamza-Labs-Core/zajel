/**
 * Unit tests for admin reputation override functionality.
 *
 * Covers:
 * - Admin reset score (false positive recovery)
 * - Admin set score to specific value
 * - Admin override logs an event in the audit trail
 * - Top offenders for admin dashboard
 * - getEntry returns full reputation data
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { SQLiteStorage } from '../../src/storage/sqlite.js';
import { VPSReputationManager } from '../../src/reputation/ip-reputation.js';

describe('Admin Reputation Overrides', () => {
  let storage: SQLiteStorage;
  let manager: VPSReputationManager;
  const testDbPath = './test-data/test-admin-reputation.db';

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

  describe('resetScore', () => {
    it('should reset an accumulated score to 0', async () => {
      // Build up reputation score
      await manager.recordEvent('10.0.0.1', 'invalid_request'); // +5
      await manager.recordEvent('10.0.0.1', 'rate_limit_hit');  // +2
      await manager.recordEvent('10.0.0.1', 'rate_limit_hit');  // +2

      let score = await manager.getScore('10.0.0.1');
      expect(score).toBe(9);

      // Admin resets score
      await manager.resetScore('10.0.0.1');

      score = await manager.getScore('10.0.0.1');
      expect(score).toBe(0);
    });

    it('should log an admin_override event in audit trail', async () => {
      await manager.recordEvent('10.0.0.1', 'invalid_request'); // +5
      await manager.resetScore('10.0.0.1');

      // Check that an admin_override event was logged
      const db = (storage as any).db;
      const events = db.prepare(
        "SELECT * FROM ip_reputation_events WHERE event_type = 'admin_override'"
      ).all();
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it('should be safe to call on non-existent IP', async () => {
      // Should not throw
      await manager.resetScore('255.255.255.255');

      const score = await manager.getScore('255.255.255.255');
      expect(score).toBe(0);
    });
  });

  describe('setScore', () => {
    it('should set score to a specific value', async () => {
      await manager.setScore('10.0.0.1', 15);

      const score = await manager.getScore('10.0.0.1');
      expect(score).toBe(15);
    });

    it('should override existing accumulated score', async () => {
      await manager.recordEvent('10.0.0.1', 'invalid_request'); // +5
      await manager.recordEvent('10.0.0.1', 'invalid_request'); // +5 = 10

      await manager.setScore('10.0.0.1', 3);

      const score = await manager.getScore('10.0.0.1');
      expect(score).toBe(3);
    });

    it('should clamp negative values to 0', async () => {
      await manager.setScore('10.0.0.1', -50);

      const score = await manager.getScore('10.0.0.1');
      expect(score).toBe(0);
    });

    it('should allow setting score to 0', async () => {
      await manager.recordEvent('10.0.0.1', 'invalid_request'); // +5
      await manager.setScore('10.0.0.1', 0);

      const score = await manager.getScore('10.0.0.1');
      expect(score).toBe(0);
    });

    it('should allow setting high scores for testing', async () => {
      await manager.setScore('10.0.0.1', 100);

      const score = await manager.getScore('10.0.0.1');
      expect(score).toBe(100);

      const blocked = await manager.isBlocked('10.0.0.1');
      expect(blocked).toBe(true);
    });
  });

  describe('getEntry for admin dashboard', () => {
    it('should return full reputation entry with counters', async () => {
      await manager.recordEvent('10.0.0.1', 'rate_limit_hit');
      await manager.recordEvent('10.0.0.1', 'rate_limit_hit');
      await manager.recordEvent('10.0.0.1', 'invalid_request');
      await manager.recordEvent('10.0.0.1', 'connection_rejected');

      const entry = await manager.getEntry('10.0.0.1');

      expect(entry).not.toBeNull();
      expect(entry!.ipAddress).toBe('10.0.0.1');
      expect(entry!.reputationScore).toBe(12); // 2+2+5+3
      expect(entry!.rateLimitHits).toBe(2);
      expect(entry!.invalidRequests).toBe(1);
      expect(entry!.connectionRejects).toBe(1);
      expect(entry!.totalEvents).toBe(4);
      expect(entry!.createdAt).toBeGreaterThan(0);
      expect(entry!.lastUpdated).toBeGreaterThan(0);
    });

    it('should return null for unknown IP', async () => {
      const entry = await manager.getEntry('10.0.0.1');
      expect(entry).toBeNull();
    });
  });

  describe('getTopOffenders for admin dashboard', () => {
    it('should return IPs sorted by highest score first', async () => {
      // Create different IPs with different scores
      await manager.recordEvent('10.0.0.1', 'rate_limit_hit');       // 2
      await manager.recordEvent('10.0.0.2', 'invalid_request');      // 5
      await manager.recordEvent('10.0.0.3', 'invalid_request');      // 5
      await manager.recordEvent('10.0.0.3', 'invalid_request');      // 10
      await manager.recordEvent('10.0.0.3', 'invalid_request');      // 15
      await manager.recordEvent('10.0.0.4', 'connection_rejected');  // 3

      const offenders = await manager.getTopOffenders(10);

      expect(offenders.length).toBe(4);
      expect(offenders[0].ipAddress).toBe('10.0.0.3');
      expect(offenders[0].reputationScore).toBe(15);
      expect(offenders[1].ipAddress).toBe('10.0.0.2');
      expect(offenders[1].reputationScore).toBe(5);
    });

    it('should return empty array when no IPs have reputation', async () => {
      const offenders = await manager.getTopOffenders(10);
      expect(offenders).toEqual([]);
    });
  });
});
