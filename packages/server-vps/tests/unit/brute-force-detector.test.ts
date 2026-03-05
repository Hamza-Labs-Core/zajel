/**
 * Unit tests for BruteForceDetector (US-7.4)
 *
 * Tests the sliding window, threshold crossing, pattern classification,
 * alert generation, auto-quarantine integration, and cleanup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BruteForceDetector, type BruteForceAlert } from '../../src/security/brute-force-detector.js';
import { QuarantineManager } from '../../src/security/quarantine.js';

describe('BruteForceDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('recordFailure', () => {
    it('records a failure and does not alert below threshold', () => {
      const detector = new BruteForceDetector({ failureThreshold: 20 });

      const alert = detector.recordFailure('src1', 'code_hash_1');
      expect(alert).toBeUndefined();
    });

    it('increments failure count for a source', () => {
      const detector = new BruteForceDetector();

      detector.recordFailure('src1', 'hash1');
      detector.recordFailure('src1', 'hash2');
      detector.recordFailure('src1', 'hash3');

      expect(detector.getFailureCount('src1')).toBe(3);
    });

    it('tracks failures independently per source', () => {
      const detector = new BruteForceDetector();

      detector.recordFailure('src1', 'hash1');
      detector.recordFailure('src1', 'hash2');
      detector.recordFailure('src2', 'hash3');

      expect(detector.getFailureCount('src1')).toBe(2);
      expect(detector.getFailureCount('src2')).toBe(1);
    });

    it('alerts when threshold is reached', () => {
      const detector = new BruteForceDetector({ failureThreshold: 5, windowMs: 60_000 });
      const alerts: BruteForceAlert[] = [];
      detector.onAlert(alert => alerts.push(alert));

      for (let i = 0; i < 5; i++) {
        detector.recordFailure('src1', `hash${i}`);
      }

      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.sourceHash).toBe('src1');
      expect(alerts[0]!.failedAttempts).toBe(5);
    });

    it('does not alert again after first threshold crossing', () => {
      const detector = new BruteForceDetector({ failureThreshold: 5, windowMs: 60_000 });
      const alerts: BruteForceAlert[] = [];
      detector.onAlert(alert => alerts.push(alert));

      for (let i = 0; i < 10; i++) {
        detector.recordFailure('src1', `hash${i}`);
      }

      // Should only get one alert, not two
      expect(alerts).toHaveLength(1);
    });

    it('returns the alert object when threshold is crossed', () => {
      const detector = new BruteForceDetector({ failureThreshold: 3, windowMs: 60_000 });

      detector.recordFailure('src1', 'hash1');
      detector.recordFailure('src1', 'hash2');
      const alert = detector.recordFailure('src1', 'hash3');

      expect(alert).toBeDefined();
      expect(alert!.failedAttempts).toBe(3);
    });
  });

  describe('sliding window expiry', () => {
    it('expires old attempts outside the window', () => {
      const detector = new BruteForceDetector({ failureThreshold: 20, windowMs: 60_000 });

      // Record 5 failures
      for (let i = 0; i < 5; i++) {
        detector.recordFailure('src1', `hash${i}`);
      }

      // Advance past the window
      vi.advanceTimersByTime(61_000);

      // Record 1 more failure (old ones should be expired)
      detector.recordFailure('src1', 'new_hash');

      expect(detector.getFailureCount('src1')).toBe(1);
    });

    it('keeps attempts within the window', () => {
      const detector = new BruteForceDetector({ failureThreshold: 20, windowMs: 60_000 });

      for (let i = 0; i < 5; i++) {
        detector.recordFailure('src1', `hash${i}`);
      }

      // Advance partway through window
      vi.advanceTimersByTime(30_000);

      // Record more failures
      for (let i = 5; i < 8; i++) {
        detector.recordFailure('src1', `hash${i}`);
      }

      expect(detector.getFailureCount('src1')).toBe(8);
    });
  });

  describe('pattern classification', () => {
    it('classifies scanning pattern (high target diversity)', () => {
      const detector = new BruteForceDetector({ failureThreshold: 5, windowMs: 60_000 });

      // All different targets -> scanning
      const alert = (() => {
        for (let i = 0; i < 5; i++) {
          const a = detector.recordFailure('src1', `unique_hash_${i}`);
          if (a) return a;
        }
      })();

      expect(alert).toBeDefined();
      expect(alert!.pattern).toBe('scanning');
      expect(alert!.distinctTargets).toBe(5);
    });

    it('classifies targeted pattern (low target diversity)', () => {
      const detector = new BruteForceDetector({ failureThreshold: 10, windowMs: 60_000 });

      // All same target -> targeted (ratio = 1/10 = 0.1 < 0.2)
      const alert = (() => {
        for (let i = 0; i < 10; i++) {
          const a = detector.recordFailure('src1', 'same_hash');
          if (a) return a;
        }
      })();

      expect(alert).toBeDefined();
      expect(alert!.pattern).toBe('targeted');
      expect(alert!.distinctTargets).toBe(1);
    });

    it('classifies mixed pattern (moderate diversity)', () => {
      const detector = new BruteForceDetector({ failureThreshold: 10, windowMs: 60_000 });

      // 50% unique targets -> mixed (ratio = 0.5)
      const alert = (() => {
        for (let i = 0; i < 10; i++) {
          const target = i < 5 ? `hash_${i}` : 'repeated_hash';
          const a = detector.recordFailure('src1', target);
          if (a) return a;
        }
      })();

      expect(alert).toBeDefined();
      expect(alert!.pattern).toBe('mixed');
    });
  });

  describe('auto-quarantine integration', () => {
    it('quarantines source when enabled and threshold reached', () => {
      const qm = new QuarantineManager();
      const detector = new BruteForceDetector({
        failureThreshold: 5,
        windowMs: 60_000,
        autoQuarantineEnabled: true,
      });
      detector.setQuarantineManager(qm);

      for (let i = 0; i < 5; i++) {
        detector.recordFailure('src1', `hash${i}`);
      }

      expect(qm.isQuarantined('src1')).toBe(true);
    });

    it('does not quarantine when auto-quarantine disabled', () => {
      const qm = new QuarantineManager();
      const detector = new BruteForceDetector({
        failureThreshold: 5,
        windowMs: 60_000,
        autoQuarantineEnabled: false,
      });
      detector.setQuarantineManager(qm);

      for (let i = 0; i < 5; i++) {
        detector.recordFailure('src1', `hash${i}`);
      }

      expect(qm.isQuarantined('src1')).toBe(false);
    });
  });

  describe('security reporter integration', () => {
    it('records brute_force_attempt events', () => {
      const mockReporter = {
        record: vi.fn(),
      };

      const detector = new BruteForceDetector();
      detector.setSecurityReporter(mockReporter as any);

      detector.recordFailure('src1', 'hash1');

      expect(mockReporter.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'brute_force_attempt',
          sourceIp: 'src1',
        })
      );
    });
  });

  describe('getSummary', () => {
    it('returns summary of all tracked sources', () => {
      const detector = new BruteForceDetector({ failureThreshold: 100, windowMs: 60_000 });

      detector.recordFailure('src1', 'hash1');
      detector.recordFailure('src1', 'hash2');
      detector.recordFailure('src2', 'hash3');

      const summary = detector.getSummary();
      expect(summary).toHaveLength(2);
      expect(summary[0]!.failedAttempts).toBeGreaterThanOrEqual(summary[1]!.failedAttempts);
    });

    it('excludes sources with all expired attempts', () => {
      const detector = new BruteForceDetector({ failureThreshold: 100, windowMs: 60_000 });

      detector.recordFailure('src1', 'hash1');

      vi.advanceTimersByTime(61_000);

      detector.recordFailure('src2', 'hash2');

      const summary = detector.getSummary();
      expect(summary).toHaveLength(1);
      expect(summary[0]!.sourceHash).toBe('src2');
    });
  });

  describe('cleanupExpired', () => {
    it('removes sources with all expired attempts', () => {
      const detector = new BruteForceDetector({ failureThreshold: 100, windowMs: 60_000 });

      detector.recordFailure('src1', 'hash1');
      detector.recordFailure('src2', 'hash2');

      vi.advanceTimersByTime(61_000);

      const removed = detector.cleanupExpired();
      expect(removed).toBe(2);
    });

    it('resets alert flag when count drops below threshold', () => {
      const detector = new BruteForceDetector({ failureThreshold: 3, windowMs: 60_000 });
      const alerts: BruteForceAlert[] = [];
      detector.onAlert(alert => alerts.push(alert));

      for (let i = 0; i < 3; i++) {
        detector.recordFailure('src1', `hash${i}`);
      }
      expect(alerts).toHaveLength(1);

      // Expire the old attempts
      vi.advanceTimersByTime(61_000);
      detector.cleanupExpired();

      // Now the alert should be re-triggerable
      for (let i = 0; i < 3; i++) {
        detector.recordFailure('src1', `new_hash${i}`);
      }
      expect(alerts).toHaveLength(2);
    });
  });

  describe('getFailureCount', () => {
    it('returns 0 for unknown source', () => {
      const detector = new BruteForceDetector();
      expect(detector.getFailureCount('unknown')).toBe(0);
    });
  });

  describe('updateConfig', () => {
    it('updates configuration', () => {
      const detector = new BruteForceDetector();
      detector.updateConfig({ failureThreshold: 100 });

      const config = detector.getConfig();
      expect(config.failureThreshold).toBe(100);
    });
  });

  describe('shutdown', () => {
    it('clears all tracked sources', () => {
      const detector = new BruteForceDetector();

      detector.recordFailure('src1', 'hash1');
      detector.recordFailure('src2', 'hash2');

      detector.shutdown();

      expect(detector.getFailureCount('src1')).toBe(0);
      expect(detector.getFailureCount('src2')).toBe(0);
      expect(detector.getSummary()).toHaveLength(0);
    });
  });
});
