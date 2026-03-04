/**
 * Unit tests for timing-safe string comparison.
 *
 * Tests the HMAC-based constant-time comparison that prevents
 * timing side-channel attacks on secret comparison.
 */

import { describe, it, expect } from 'vitest';
import { timingSafeEqual } from '../../src/crypto/timing-safe.js';

describe('timingSafeEqual', () => {
  it('returns true for equal strings', async () => {
    expect(await timingSafeEqual('hello', 'hello')).toBe(true);
    expect(await timingSafeEqual('', '')).toBe(true);
    expect(await timingSafeEqual('Bearer secret123', 'Bearer secret123')).toBe(true);
  });

  it('returns false for different strings of equal length', async () => {
    expect(await timingSafeEqual('hello', 'world')).toBe(false);
    expect(await timingSafeEqual('secret123', 'secret124')).toBe(false);
    expect(await timingSafeEqual('Bearer abc', 'Bearer xyz')).toBe(false);
  });

  it('returns false for different strings of different lengths', async () => {
    expect(await timingSafeEqual('short', 'much longer string')).toBe(false);
    expect(await timingSafeEqual('much longer string', 'short')).toBe(false);
    expect(await timingSafeEqual('', 'non-empty')).toBe(false);
    expect(await timingSafeEqual('non-empty', '')).toBe(false);
  });

  it('handles empty strings correctly', async () => {
    expect(await timingSafeEqual('', '')).toBe(true);
    expect(await timingSafeEqual('', 'a')).toBe(false);
    expect(await timingSafeEqual('a', '')).toBe(false);
  });

  it('handles special characters and unicode', async () => {
    expect(await timingSafeEqual('hello\nworld', 'hello\nworld')).toBe(true);
    expect(await timingSafeEqual('emoji \u{1F680}', 'emoji \u{1F680}')).toBe(true);
    expect(await timingSafeEqual('emoji \u{1F680}', 'emoji \u{1F6F8}')).toBe(false);
  });

  it('handles Bearer token format (real-world usage)', async () => {
    const secret = 'my-super-secret-token-123';
    const validAuth = `Bearer ${secret}`;
    const invalidAuth = 'Bearer wrong-token';
    const invalidFormat = `Basic ${secret}`;

    expect(await timingSafeEqual(validAuth, validAuth)).toBe(true);
    expect(await timingSafeEqual(validAuth, invalidAuth)).toBe(false);
    expect(await timingSafeEqual(validAuth, invalidFormat)).toBe(false);
  });

  describe('timing properties', () => {
    /**
     * Statistical timing test to verify constant-time behavior.
     *
     * This test compares timing distributions for:
     * 1. Equal-length strings (matching)
     * 2. Equal-length strings (different)
     * 3. Different-length strings
     *
     * All three should have similar timing distributions. If length information
     * leaks through timing, different-length comparisons would be statistically
     * distinguishable from equal-length comparisons.
     *
     * Note: This test may be flaky on heavily loaded systems, but should pass
     * under normal conditions. We use a large sample size (1000) and check
     * that mean timings overlap within 2 standard deviations.
     */
    it('takes similar time for same-length vs different-length inputs', { retry: 3 }, async () => {
      const iterations = 1000;
      const secret = 'x'.repeat(50); // 50-char secret

      // Test case 1: Same length, equal
      const sameEqualTimings = [];
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await timingSafeEqual(secret, secret);
        sameEqualTimings.push(performance.now() - start);
      }

      // Test case 2: Same length, different
      const sameDiffTimings = [];
      const differentSameLength = 'y'.repeat(50);
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await timingSafeEqual(secret, differentSameLength);
        sameDiffTimings.push(performance.now() - start);
      }

      // Test case 3: Different length
      const diffLengthTimings = [];
      const differentLength = 'z'.repeat(30);
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await timingSafeEqual(secret, differentLength);
        diffLengthTimings.push(performance.now() - start);
      }

      // Calculate statistics
      const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
      const stdDev = (arr) => {
        const avg = mean(arr);
        const squareDiffs = arr.map((value) => Math.pow(value - avg, 2));
        return Math.sqrt(mean(squareDiffs));
      };

      const meanSameEqual = mean(sameEqualTimings);
      const meanSameDiff = mean(sameDiffTimings);
      const meanDiffLength = mean(diffLengthTimings);

      const stdDevSameEqual = stdDev(sameEqualTimings);
      const stdDevSameDiff = stdDev(sameDiffTimings);
      const stdDevDiffLength = stdDev(diffLengthTimings);

      // Check that distributions overlap within 2 standard deviations.
      // If timing leaks length info, different-length would be statistically
      // distinguishable (e.g., consistently faster or slower).
      const maxStdDev = Math.max(stdDevSameEqual, stdDevSameDiff, stdDevDiffLength);
      const timingDiff1 = Math.abs(meanSameEqual - meanDiffLength);
      const timingDiff2 = Math.abs(meanSameDiff - meanDiffLength);

      // Allow up to 2 standard deviations difference (95% confidence)
      expect(timingDiff1).toBeLessThan(2 * maxStdDev);
      expect(timingDiff2).toBeLessThan(2 * maxStdDev);
    }, 30000); // 30 second timeout for this test
  });
});
