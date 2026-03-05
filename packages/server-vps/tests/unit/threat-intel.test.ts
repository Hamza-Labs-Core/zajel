/**
 * Unit tests for ThreatIntelManager.
 *
 * Covers:
 * - Payload generation (only shares IPs with score >= 20)
 * - Processing incoming threat data from other servers
 * - Self-report filtering (ignores own server's reports)
 * - Federated blocks tracking with expiration cleanup
 * - Reason inference from event counters
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { SQLiteStorage } from '../../src/storage/sqlite.js';
import { VPSReputationManager } from '../../src/reputation/ip-reputation.js';
import { ThreatIntelManager } from '../../src/federation/threat-intel.js';
import type { ThreatIntelPayload } from '../../src/federation/threat-intel.js';

describe('ThreatIntelManager', () => {
  let storage: SQLiteStorage;
  let reputationManager: VPSReputationManager;
  let threatIntel: ThreatIntelManager;
  const testDbPath = './test-data/test-threat-intel.db';
  const serverId = 'server-local-001';

  beforeEach(async () => {
    if (!existsSync('./test-data')) {
      mkdirSync('./test-data', { recursive: true });
    }
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }

    storage = new SQLiteStorage(testDbPath);
    await storage.init();
    reputationManager = new VPSReputationManager(storage);
    threatIntel = new ThreatIntelManager(reputationManager, serverId);
  });

  afterEach(() => {
    storage.close();
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
  });

  describe('generatePayload', () => {
    it('should include IPs with score >= 20', async () => {
      // Build up score to 20 (4 invalid_request events = 4*5 = 20)
      for (let i = 0; i < 4; i++) {
        await reputationManager.recordEvent('10.0.0.1', 'invalid_request');
      }

      const payload = await threatIntel.generatePayload();

      expect(payload.blockedIPs).toHaveLength(1);
      expect(payload.blockedIPs[0].ip).toBe('10.0.0.1');
      expect(payload.blockedIPs[0].score).toBe(20);
      expect(payload.blockedIPs[0].serverId).toBe(serverId);
      expect(payload.timestamp).toBeGreaterThan(0);
    });

    it('should exclude IPs with score < 20', async () => {
      // Score of 15 (3 invalid_request events = 3*5 = 15)
      for (let i = 0; i < 3; i++) {
        await reputationManager.recordEvent('10.0.0.1', 'invalid_request');
      }

      const payload = await threatIntel.generatePayload();

      expect(payload.blockedIPs).toHaveLength(0);
    });

    it('should include serverId and timestamp', async () => {
      const payload = await threatIntel.generatePayload();

      expect(payload.serverId).toBe(serverId);
      expect(payload.timestamp).toBeGreaterThan(0);
    });

    it('should set 24h expiration on blocked IPs', async () => {
      for (let i = 0; i < 4; i++) {
        await reputationManager.recordEvent('10.0.0.1', 'invalid_request');
      }

      const before = Date.now();
      const payload = await threatIntel.generatePayload();
      const after = Date.now();

      const expiresAt = payload.blockedIPs[0].expiresAt;
      const day = 24 * 60 * 60 * 1000;
      expect(expiresAt).toBeGreaterThanOrEqual(before + day);
      expect(expiresAt).toBeLessThanOrEqual(after + day);
    });
  });

  describe('processIncoming', () => {
    it('should boost local reputation for reported IPs', async () => {
      const payload: ThreatIntelPayload = {
        blockedIPs: [
          {
            ip: '10.0.0.99',
            score: 25,
            reason: 'rate_limit_abuse',
            expiresAt: Date.now() + 86400000,
            serverId: 'server-remote-001',
          },
        ],
        attackPatterns: [],
        timestamp: Date.now(),
        serverId: 'server-remote-001',
      };

      await threatIntel.processIncoming(payload);

      // The IP should now have a reputation score > 0
      const score = await reputationManager.getScore('10.0.0.99');
      expect(score).toBeGreaterThan(0);
    });

    it('should not process own reports (self-filtering)', async () => {
      const payload: ThreatIntelPayload = {
        blockedIPs: [
          {
            ip: '10.0.0.99',
            score: 25,
            reason: 'rate_limit_abuse',
            expiresAt: Date.now() + 86400000,
            serverId: serverId, // Same as local server
          },
        ],
        attackPatterns: [],
        timestamp: Date.now(),
        serverId: serverId,
      };

      await threatIntel.processIncoming(payload);

      // Score should remain 0 since we skip our own reports
      const score = await reputationManager.getScore('10.0.0.99');
      expect(score).toBe(0);
    });

    it('should not boost IPs that already have high local scores', async () => {
      // Build up local score to 20 (above the threshold of 15)
      for (let i = 0; i < 4; i++) {
        await reputationManager.recordEvent('10.0.0.99', 'invalid_request'); // 4*5 = 20
      }

      const scoreBefore = await reputationManager.getScore('10.0.0.99');

      const payload: ThreatIntelPayload = {
        blockedIPs: [
          {
            ip: '10.0.0.99',
            score: 30,
            reason: 'rate_limit_abuse',
            expiresAt: Date.now() + 86400000,
            serverId: 'server-remote-001',
          },
        ],
        attackPatterns: [],
        timestamp: Date.now(),
        serverId: 'server-remote-001',
      };

      await threatIntel.processIncoming(payload);

      // Score should not have increased (local score 20 >= threshold 15)
      const scoreAfter = await reputationManager.getScore('10.0.0.99');
      expect(scoreAfter).toBe(scoreBefore);
    });

    it('should track federated blocks', async () => {
      const payload: ThreatIntelPayload = {
        blockedIPs: [
          {
            ip: '10.0.0.99',
            score: 25,
            reason: 'rate_limit_abuse',
            expiresAt: Date.now() + 86400000,
            serverId: 'server-remote-001',
          },
        ],
        attackPatterns: [],
        timestamp: Date.now(),
        serverId: 'server-remote-001',
      };

      await threatIntel.processIncoming(payload);

      const blocks = threatIntel.getFederatedBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].ip).toBe('10.0.0.99');
    });
  });

  describe('getFederatedBlocks', () => {
    it('should exclude expired blocks', async () => {
      const payload: ThreatIntelPayload = {
        blockedIPs: [
          {
            ip: '10.0.0.1',
            score: 25,
            reason: 'rate_limit_abuse',
            expiresAt: Date.now() - 1000, // Already expired
            serverId: 'server-remote-001',
          },
          {
            ip: '10.0.0.2',
            score: 30,
            reason: 'connection_spam',
            expiresAt: Date.now() + 86400000, // Still active
            serverId: 'server-remote-001',
          },
        ],
        attackPatterns: [],
        timestamp: Date.now(),
        serverId: 'server-remote-001',
      };

      await threatIntel.processIncoming(payload);

      const blocks = threatIntel.getFederatedBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].ip).toBe('10.0.0.2');
    });
  });

  describe('Reason inference', () => {
    it('should infer invalid_request_spam for high invalid request counts', async () => {
      // Record 11 invalid_request events to trigger the reason threshold
      for (let i = 0; i < 11; i++) {
        await reputationManager.recordEvent('10.0.0.1', 'invalid_request');
      }

      const payload = await threatIntel.generatePayload();

      // Score = 55 (11*5), which is >= 20 so it should be included
      expect(payload.blockedIPs).toHaveLength(1);
      expect(payload.blockedIPs[0].reason).toBe('invalid_request_spam');
    });
  });
});
