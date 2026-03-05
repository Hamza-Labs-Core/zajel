/**
 * Unit tests for QuarantineManager (US-7.2)
 *
 * Tests TTL-based quarantine, auto-quarantine threshold,
 * expiry cleanup, and configuration updates.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QuarantineManager } from '../../src/security/quarantine.js';

describe('QuarantineManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isQuarantined', () => {
    it('returns false for unknown source', () => {
      const qm = new QuarantineManager();
      expect(qm.isQuarantined('unknown')).toBe(false);
    });

    it('returns true for quarantined source', () => {
      const qm = new QuarantineManager();
      qm.quarantine('src1', 60_000);
      expect(qm.isQuarantined('src1')).toBe(true);
    });

    it('returns false after TTL expires', () => {
      const qm = new QuarantineManager();
      qm.quarantine('src1', 60_000); // 1 minute

      vi.advanceTimersByTime(60_001);
      expect(qm.isQuarantined('src1')).toBe(false);
    });

    it('returns true just before TTL expires', () => {
      const qm = new QuarantineManager();
      qm.quarantine('src1', 60_000);

      vi.advanceTimersByTime(59_999);
      expect(qm.isQuarantined('src1')).toBe(true);
    });
  });

  describe('quarantine', () => {
    it('creates an entry with correct fields', () => {
      const qm = new QuarantineManager();
      const now = Date.now();
      const entry = qm.quarantine('src1', 120_000, 'manual', 'admin-user');

      expect(entry.sourceHash).toBe('src1');
      expect(entry.reason).toBe('manual');
      expect(entry.quarantinedAt).toBe(now);
      expect(entry.expiresAt).toBe(now + 120_000);
      expect(entry.quarantinedBy).toBe('admin-user');
    });

    it('uses default duration from config when not specified', () => {
      const qm = new QuarantineManager({ quarantineDurationMs: 300_000 });
      const now = Date.now();
      const entry = qm.quarantine('src1');

      expect(entry.expiresAt).toBe(now + 300_000);
    });

    it('defaults reason to manual and quarantinedBy to system', () => {
      const qm = new QuarantineManager();
      const entry = qm.quarantine('src1', 60_000);

      expect(entry.reason).toBe('manual');
      expect(entry.quarantinedBy).toBe('system');
    });
  });

  describe('getEntry', () => {
    it('returns entry for quarantined source', () => {
      const qm = new QuarantineManager();
      qm.quarantine('src1', 60_000);

      const entry = qm.getEntry('src1');
      expect(entry).toBeDefined();
      expect(entry!.sourceHash).toBe('src1');
    });

    it('returns undefined for unknown source', () => {
      const qm = new QuarantineManager();
      expect(qm.getEntry('unknown')).toBeUndefined();
    });

    it('returns undefined and cleans up expired entry', () => {
      const qm = new QuarantineManager();
      qm.quarantine('src1', 60_000);

      vi.advanceTimersByTime(60_001);
      expect(qm.getEntry('src1')).toBeUndefined();
    });
  });

  describe('remove', () => {
    it('removes a quarantined source', () => {
      const qm = new QuarantineManager();
      qm.quarantine('src1', 60_000);

      expect(qm.remove('src1')).toBe(true);
      expect(qm.isQuarantined('src1')).toBe(false);
    });

    it('returns false when source not found', () => {
      const qm = new QuarantineManager();
      expect(qm.remove('unknown')).toBe(false);
    });
  });

  describe('getAll', () => {
    it('returns all active entries', () => {
      const qm = new QuarantineManager();
      qm.quarantine('src1', 60_000);
      qm.quarantine('src2', 60_000);
      qm.quarantine('src3', 60_000);

      const all = qm.getAll();
      expect(all).toHaveLength(3);
    });

    it('excludes expired entries', () => {
      const qm = new QuarantineManager();
      qm.quarantine('src1', 30_000);
      qm.quarantine('src2', 60_000);

      vi.advanceTimersByTime(35_000);
      const all = qm.getAll();
      expect(all).toHaveLength(1);
      expect(all[0]!.sourceHash).toBe('src2');
    });
  });

  describe('size', () => {
    it('returns 0 when empty', () => {
      const qm = new QuarantineManager();
      expect(qm.size).toBe(0);
    });

    it('returns correct count', () => {
      const qm = new QuarantineManager();
      qm.quarantine('src1', 60_000);
      qm.quarantine('src2', 60_000);
      expect(qm.size).toBe(2);
    });

    it('decreases after expiry', () => {
      const qm = new QuarantineManager();
      qm.quarantine('src1', 30_000);
      qm.quarantine('src2', 60_000);

      vi.advanceTimersByTime(35_000);
      expect(qm.size).toBe(1);
    });
  });

  describe('checkAutoQuarantine', () => {
    it('quarantines when violation count exceeds threshold', () => {
      const qm = new QuarantineManager({
        autoQuarantineEnabled: true,
        violationThreshold: 50,
      });

      const entry = qm.checkAutoQuarantine('src1', 50);
      expect(entry).toBeDefined();
      expect(entry!.reason).toBe('auto');
      expect(qm.isQuarantined('src1')).toBe(true);
    });

    it('does not quarantine when below threshold', () => {
      const qm = new QuarantineManager({
        autoQuarantineEnabled: true,
        violationThreshold: 50,
      });

      const entry = qm.checkAutoQuarantine('src1', 49);
      expect(entry).toBeUndefined();
      expect(qm.isQuarantined('src1')).toBe(false);
    });

    it('does not quarantine when auto-quarantine disabled', () => {
      const qm = new QuarantineManager({
        autoQuarantineEnabled: false,
        violationThreshold: 50,
      });

      const entry = qm.checkAutoQuarantine('src1', 100);
      expect(entry).toBeUndefined();
    });

    it('does not re-quarantine already quarantined source', () => {
      const qm = new QuarantineManager({
        autoQuarantineEnabled: true,
        violationThreshold: 50,
      });

      qm.quarantine('src1', 60_000);
      const entry = qm.checkAutoQuarantine('src1', 100);
      expect(entry).toBeUndefined(); // Already quarantined
    });
  });

  describe('cleanupExpired', () => {
    it('removes expired entries', () => {
      const qm = new QuarantineManager();
      qm.quarantine('src1', 30_000);
      qm.quarantine('src2', 60_000);
      qm.quarantine('src3', 30_000);

      vi.advanceTimersByTime(35_000);
      const removed = qm.cleanupExpired();
      expect(removed).toBe(2);
      expect(qm.isQuarantined('src2')).toBe(true);
    });

    it('returns 0 when nothing to clean up', () => {
      const qm = new QuarantineManager();
      qm.quarantine('src1', 60_000);
      const removed = qm.cleanupExpired();
      expect(removed).toBe(0);
    });
  });

  describe('updateConfig', () => {
    it('updates configuration fields', () => {
      const qm = new QuarantineManager();
      qm.updateConfig({ violationThreshold: 100 });

      const config = qm.getConfig();
      expect(config.violationThreshold).toBe(100);
      // Others should remain default
      expect(config.autoQuarantineEnabled).toBe(true);
    });
  });

  describe('shutdown', () => {
    it('clears all entries', () => {
      const qm = new QuarantineManager();
      qm.quarantine('src1', 60_000);
      qm.quarantine('src2', 60_000);

      qm.shutdown();
      expect(qm.size).toBe(0);
    });
  });
});
