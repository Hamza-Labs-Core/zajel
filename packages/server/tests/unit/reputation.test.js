/**
 * Unit tests for IPReputationManager.
 *
 * Covers:
 * - Score accumulation (rate limit hits, invalid requests, successful attestation)
 * - Time-based decay (score halves every 24 hours)
 * - Progressive rate limits (normal, reduced, heavily restricted, blocked)
 * - Cache API persistence across instances
 * - Math.max(1,...) guard for 50% tier
 * - Local cache pruning
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IPReputationManager } from '../../src/reputation.js';

/**
 * Mock Cache API for testing.
 * Simulates Cloudflare's Cache API behavior.
 */
class MockCacheAPI {
  constructor() {
    this.store = new Map();
  }

  async match(request) {
    const key = request.url;
    const entry = this.store.get(key);
    if (!entry) return undefined;

    // Simulate max-age expiration
    const now = Date.now();
    if (entry.expiresAt && now > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    // Return a cloned Response (to simulate real Cache API behavior)
    return new Response(entry.body, {
      headers: entry.headers,
    });
  }

  async put(request, response) {
    const key = request.url;
    const body = await response.clone().text();
    const cacheControl = response.headers.get('Cache-Control');
    let expiresAt = null;

    if (cacheControl) {
      const match = cacheControl.match(/max-age=(\d+)/);
      if (match) {
        expiresAt = Date.now() + parseInt(match[1]) * 1000;
      }
    }

    this.store.set(key, {
      body,
      headers: new Headers(response.headers),
      expiresAt,
    });
  }
}

describe('IPReputationManager', () => {
  let cache;
  let manager;

  beforeEach(() => {
    cache = new MockCacheAPI();
    manager = new IPReputationManager(cache);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Score accumulation', () => {
    it('should start with score 0 for new IP', async () => {
      const score = await manager.getScore('1.2.3.4');
      expect(score).toBe(0);
    });

    it('should accumulate rate limit hits (+2 each)', async () => {
      for (let i = 0; i < 5; i++) {
        await manager.incrementScore('1.2.3.4', 2);
      }
      const score = await manager.getScore('1.2.3.4');
      expect(score).toBe(10);
    });

    it('should accumulate invalid requests (+5 each)', async () => {
      for (let i = 0; i < 3; i++) {
        await manager.incrementScore('1.2.3.4', 5);
      }
      const score = await manager.getScore('1.2.3.4');
      expect(score).toBe(15);
    });

    it('should decrease score for successful attestation (-1)', async () => {
      await manager.incrementScore('1.2.3.4', 10);
      await manager.incrementScore('1.2.3.4', -1);
      const score = await manager.getScore('1.2.3.4');
      expect(score).toBe(9);
    });

    it('should never go below 0', async () => {
      await manager.incrementScore('1.2.3.4', -5);
      const score = await manager.getScore('1.2.3.4');
      expect(score).toBe(0);
    });
  });

  describe('Time-based decay', () => {
    it('should halve score after 24 hours', async () => {
      await manager.incrementScore('1.2.3.4', 30);

      // Advance 24 hours
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);

      const score = await manager.getScore('1.2.3.4');
      expect(score).toBe(15);
    });

    it('should quarter score after 48 hours', async () => {
      await manager.incrementScore('1.2.3.4', 30);

      // Advance 48 hours
      vi.advanceTimersByTime(48 * 60 * 60 * 1000);

      const score = await manager.getScore('1.2.3.4');
      expect(score).toBe(7); // 30 * 0.25 = 7.5, floored to 7
    });

    it('should not decay within 24 hours', async () => {
      await manager.incrementScore('1.2.3.4', 20);

      // Advance 23 hours
      vi.advanceTimersByTime(23 * 60 * 60 * 1000);

      const score = await manager.getScore('1.2.3.4');
      expect(score).toBe(20);
    });
  });

  describe('Progressive rate limits', () => {
    it('should return normal limits for score 0', () => {
      const tier = manager.getRateLimit(0, { limit: 100, windowMs: 60000 });
      expect(tier.limit).toBe(100);
      expect(tier.windowMs).toBe(60000);
      expect(tier.blocked).toBe(false);
    });

    it('should return 50% limits for score 5', () => {
      const tier = manager.getRateLimit(5, { limit: 100, windowMs: 60000 });
      expect(tier.limit).toBe(50);
      expect(tier.blocked).toBe(false);
    });

    it('should return 10% limits for score 15', () => {
      const tier = manager.getRateLimit(15, { limit: 100, windowMs: 60000 });
      expect(tier.limit).toBe(10);
      expect(tier.blocked).toBe(false);
    });

    it('should block for score >= 30', () => {
      const tier = manager.getRateLimit(30, { limit: 100, windowMs: 60000 });
      expect(tier.limit).toBe(0);
      expect(tier.blocked).toBe(true);
      expect(tier.windowMs).toBe(300000); // 5 minutes
    });

    it('should use Math.max(1,...) to prevent zero-limit at 50% tier', () => {
      // limit=1 at 50% would be 0 without the guard
      const tier = manager.getRateLimit(5, { limit: 1, windowMs: 60000 });
      expect(tier.limit).toBe(1); // Math.max(1, floor(0.5)) = 1
      expect(tier.blocked).toBe(false);
    });

    it('should use Math.max(1,...) to prevent zero-limit at 10% tier', () => {
      // limit=5 at 10% would be 0 without the guard
      const tier = manager.getRateLimit(15, { limit: 5, windowMs: 60000 });
      expect(tier.limit).toBe(1); // Math.max(1, floor(0.5)) = 1
      expect(tier.blocked).toBe(false);
    });

    it('should maintain normal limits for score 4 (just below threshold)', () => {
      const tier = manager.getRateLimit(4, { limit: 100, windowMs: 60000 });
      expect(tier.limit).toBe(100);
      expect(tier.blocked).toBe(false);
    });
  });

  describe('Cache API persistence', () => {
    it('should persist score across manager instances', async () => {
      // Set score in first instance
      await manager.incrementScore('1.2.3.4', 15);

      // Create new manager with same cache (simulates new isolate)
      const manager2 = new IPReputationManager(cache);

      const score = await manager2.getScore('1.2.3.4');
      expect(score).toBe(15);
    });

    it('should update local cache on read from Cache API', async () => {
      await manager.incrementScore('1.2.3.4', 10);

      // New manager - no local cache
      const manager2 = new IPReputationManager(cache);

      // First read populates local cache
      await manager2.getScore('1.2.3.4');

      // Local cache should now have the entry
      expect(manager2.localScores.has('1.2.3.4')).toBe(true);
    });
  });

  describe('Local cache pruning', () => {
    it('should prune local cache when exceeding 1000 entries', () => {
      // Add 1050 entries
      for (let i = 0; i < 1050; i++) {
        manager.localScores.set(`ip-${i}`, {
          score: 1,
          updatedAt: Date.now() + i, // Different timestamps for sorting
        });
      }

      expect(manager.localScores.size).toBe(1050);

      manager.pruneLocalCache();

      expect(manager.localScores.size).toBe(1000);
    });

    it('should keep most recent entries when pruning', () => {
      // Add entries with different timestamps
      const now = Date.now();
      for (let i = 0; i < 1050; i++) {
        manager.localScores.set(`ip-${i}`, {
          score: 1,
          updatedAt: now + i,
        });
      }

      manager.pruneLocalCache();

      // Oldest entries (lowest timestamps) should be removed
      expect(manager.localScores.has('ip-0')).toBe(false);
      expect(manager.localScores.has('ip-49')).toBe(false);

      // Newest entries should remain
      expect(manager.localScores.has('ip-1049')).toBe(true);
      expect(manager.localScores.has('ip-50')).toBe(true);
    });

    it('should not prune when under 1000 entries', () => {
      for (let i = 0; i < 500; i++) {
        manager.localScores.set(`ip-${i}`, {
          score: 1,
          updatedAt: Date.now(),
        });
      }

      manager.pruneLocalCache();

      expect(manager.localScores.size).toBe(500);
    });
  });
});
