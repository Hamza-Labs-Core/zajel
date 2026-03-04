/**
 * Unit tests for RateLimiter class.
 *
 * Covers:
 * - Composite key support (different keys have independent counters)
 * - Same IP different tiers don't interfere
 * - Sliding window behavior
 * - Window reset after expiry
 * - retryAfter calculation
 * - Deterministic pruning every 100 requests
 * - Remaining count decrement
 * - getCounters() test helper
 * - Edge cases (boundary conditions, limit of 1, etc.)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimiter } from '../../src/rate-limiter.js';

describe('RateLimiter', () => {
  let limiter;

  beforeEach(() => {
    limiter = new RateLimiter();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('check()', () => {
    it('should allow first request within limit', () => {
      const result = limiter.check('192.168.1.1:read', 10, 60000);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);
    });

    it('should allow subsequent requests up to limit', () => {
      const key = '192.168.1.1:read';
      for (let i = 0; i < 10; i++) {
        const result = limiter.check(key, 10, 60000);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(9 - i);
      }
    });

    it('should reject requests exceeding limit', () => {
      const key = '192.168.1.1:write';
      // Use up the limit
      for (let i = 0; i < 10; i++) {
        limiter.check(key, 10, 60000);
      }
      // Next request should be rejected
      const result = limiter.check(key, 10, 60000);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should reset counter after window expires', () => {
      const key = '192.168.1.1:attest';
      limiter.check(key, 10, 60000); // count = 1

      // Advance time past window
      vi.advanceTimersByTime(61000);

      const result = limiter.check(key, 10, 60000);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9); // Fresh window
    });

    it('should track different keys independently', () => {
      const key1 = '192.168.1.1:read';
      const key2 = '192.168.1.2:read';

      limiter.check(key1, 5, 60000); // key1: count = 1
      limiter.check(key1, 5, 60000); // key1: count = 2
      limiter.check(key2, 5, 60000); // key2: count = 1

      expect(limiter.getCounters().get(key1).count).toBe(2);
      expect(limiter.getCounters().get(key2).count).toBe(1);
    });

    it('should handle boundary case at exact limit', () => {
      const key = '192.168.1.1:admin';
      for (let i = 0; i < 9; i++) {
        limiter.check(key, 10, 60000);
      }
      // 10th request should be allowed (at limit)
      const result = limiter.check(key, 10, 60000);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);

      // 11th request should be rejected
      const rejected = limiter.check(key, 10, 60000);
      expect(rejected.allowed).toBe(false);
    });

    it('should handle limit of 1', () => {
      const key = '192.168.1.1:admin';
      const first = limiter.check(key, 1, 60000);
      expect(first.allowed).toBe(true);
      expect(first.remaining).toBe(0);

      const second = limiter.check(key, 1, 60000);
      expect(second.allowed).toBe(false);
      expect(second.remaining).toBe(0);
    });

    it('should handle very short windows', () => {
      const key = '192.168.1.1:write';
      limiter.check(key, 5, 1000); // 1 second window

      vi.advanceTimersByTime(1001);

      const result = limiter.check(key, 5, 1000);
      expect(result.allowed).toBe(true); // Window reset
    });
  });

  describe('retryAfter', () => {
    it('should return retryAfter as 0 for first request in new window', () => {
      const result = limiter.check('192.168.1.1:read', 10, 60000);
      expect(result.retryAfter).toBe(0);
    });

    it('should return positive retryAfter when limit exceeded', () => {
      const key = '192.168.1.1:attest';
      for (let i = 0; i < 10; i++) {
        limiter.check(key, 10, 60000);
      }
      const result = limiter.check(key, 10, 60000);
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
      expect(result.retryAfter).toBeLessThanOrEqual(60);
    });

    it('should return positive retryAfter for allowed requests within window', () => {
      const key = '10.0.0.1:write';
      limiter.check(key, 10, 60000); // First request - retryAfter is 0

      vi.advanceTimersByTime(5000); // 5 seconds later

      const result = limiter.check(key, 10, 60000);
      expect(result.allowed).toBe(true);
      expect(result.retryAfter).toBeGreaterThan(0); // We're in an active window
      expect(result.retryAfter).toBeLessThanOrEqual(60);
    });
  });

  describe('composite keys', () => {
    it('should have independent counters for different keys', () => {
      for (let i = 0; i < 10; i++) {
        limiter.check('192.168.1.1:read', 10, 60000);
      }
      for (let i = 0; i < 10; i++) {
        limiter.check('192.168.1.1:write', 10, 60000);
      }
      // Both should fail - 11th request on each
      const result1 = limiter.check('192.168.1.1:read', 10, 60000);
      const result2 = limiter.check('192.168.1.1:write', 10, 60000);
      expect(result1.allowed).toBe(false);
      expect(result2.allowed).toBe(false);
    });

    it('should not interfere between same IP different tiers', () => {
      // Exhaust read tier
      for (let i = 0; i < 200; i++) {
        limiter.check('10.0.0.5:read', 200, 60000);
      }
      // Write tier should still be available
      const writeResult = limiter.check('10.0.0.5:write', 30, 60000);
      expect(writeResult.allowed).toBe(true);
      expect(writeResult.remaining).toBe(29);
    });

    it('should give different IPs independent limits on same tier', () => {
      // IP1 exhausts admin tier
      for (let i = 0; i < 10; i++) {
        limiter.check('10.0.0.1:admin', 10, 60000);
      }
      const ip1Result = limiter.check('10.0.0.1:admin', 10, 60000);
      expect(ip1Result.allowed).toBe(false);

      // IP2 should still have full quota
      const ip2Result = limiter.check('10.0.0.2:admin', 10, 60000);
      expect(ip2Result.allowed).toBe(true);
      expect(ip2Result.remaining).toBe(9);
    });
  });

  describe('deterministic pruning', () => {
    it('should trigger prune every 100 requests', () => {
      const pruneSpy = vi.spyOn(limiter, 'prune');

      // Make 99 requests -- no prune yet
      for (let i = 0; i < 99; i++) {
        limiter.check(`ip-${i}:read`, 100, 60000);
      }
      expect(pruneSpy).not.toHaveBeenCalled();

      // 100th request triggers prune
      limiter.check('ip-99:read', 100, 60000);
      expect(pruneSpy).toHaveBeenCalledTimes(1);
    });

    it('should actually remove expired entries during prune', () => {
      // Create an expired entry
      limiter.check('old-ip:read', 10, 1); // 1ms window

      vi.advanceTimersByTime(10);

      expect(limiter.getCounters().has('old-ip:read')).toBe(true);

      // Make 98 more requests (already made 1 above, so total 99)
      for (let i = 0; i < 98; i++) {
        limiter.check(`ip-${i}:read`, 100, 60000);
      }
      expect(limiter.getCounters().has('old-ip:read')).toBe(true); // Not pruned yet

      // 100th request triggers prune
      limiter.check('ip-100:read', 100, 60000);
      expect(limiter.getCounters().has('old-ip:read')).toBe(false); // Pruned
    });
  });

  describe('remaining count', () => {
    it('should decrement remaining correctly', () => {
      const r1 = limiter.check('10.0.0.3:write', 5, 60000);
      expect(r1.remaining).toBe(4);
      const r2 = limiter.check('10.0.0.3:write', 5, 60000);
      expect(r2.remaining).toBe(3);
      const r3 = limiter.check('10.0.0.3:write', 5, 60000);
      expect(r3.remaining).toBe(2);
      const r4 = limiter.check('10.0.0.3:write', 5, 60000);
      expect(r4.remaining).toBe(1);
      const r5 = limiter.check('10.0.0.3:write', 5, 60000);
      expect(r5.remaining).toBe(0);
      expect(r5.allowed).toBe(true); // 5th request is still allowed

      const r6 = limiter.check('10.0.0.3:write', 5, 60000);
      expect(r6.allowed).toBe(false);
      expect(r6.remaining).toBe(0);
    });
  });

  describe('prune()', () => {
    it('should remove expired entries', () => {
      limiter.check('192.168.1.1:read', 10, 60000);
      limiter.check('192.168.1.2:write', 10, 60000);
      limiter.check('192.168.1.3:admin', 10, 60000);

      expect(limiter.getCounters().size).toBe(3);

      // Advance time past window
      vi.advanceTimersByTime(61000);

      limiter.prune();

      expect(limiter.getCounters().size).toBe(0);
    });

    it('should keep non-expired entries', () => {
      limiter.check('192.168.1.1:read', 10, 60000); // t=0

      vi.advanceTimersByTime(30000); // t=30s

      limiter.check('192.168.1.2:read', 10, 60000); // t=30s

      vi.advanceTimersByTime(35000); // t=65s (ip1 expired, ip2 still valid)

      limiter.prune();

      expect(limiter.getCounters().size).toBe(1);
      expect(limiter.getCounters().has('192.168.1.2:read')).toBe(true);
    });

    it('should handle empty counters map', () => {
      expect(() => limiter.prune()).not.toThrow();
    });
  });

  describe('getCounters()', () => {
    it('should return the internal counters map', () => {
      limiter.check('10.0.0.1:read', 100, 60000);
      const counters = limiter.getCounters();
      expect(counters).toBeInstanceOf(Map);
      expect(counters.size).toBe(1);
      expect(counters.get('10.0.0.1:read').count).toBe(1);
    });
  });
});
