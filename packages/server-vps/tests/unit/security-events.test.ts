/**
 * Unit tests for SecurityEventReporter (US-7.1)
 *
 * Tests the ring buffer, event recording, filtering,
 * counting, and flush lifecycle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SecurityEventReporter, type SecurityEvent } from '../../src/security/security-events.js';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function makeEvent(overrides: Partial<SecurityEvent> = {}): Omit<SecurityEvent, 'timestamp' | 'count'> & { timestamp?: number; count?: number } {
  return {
    eventType: 'rate_limit_violation',
    severity: 'medium',
    sourceIp: 'a1b2c3d4',
    endpoint: '/ws',
    ...overrides,
  };
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('SecurityEventReporter', () => {
  describe('record and size', () => {
    it('starts empty', () => {
      const reporter = new SecurityEventReporter();
      expect(reporter.size).toBe(0);
    });

    it('tracks size as events are recorded', () => {
      const reporter = new SecurityEventReporter();
      reporter.record(makeEvent());
      expect(reporter.size).toBe(1);
      reporter.record(makeEvent());
      expect(reporter.size).toBe(2);
    });

    it('caps at 10,000 events (circular eviction)', () => {
      const reporter = new SecurityEventReporter();
      for (let i = 0; i < 10_500; i++) {
        reporter.record(makeEvent());
      }
      expect(reporter.size).toBe(10_000);
    });

    it('auto-generates timestamp when not provided', () => {
      const reporter = new SecurityEventReporter();
      const before = Date.now();
      reporter.record(makeEvent());
      const after = Date.now();

      const events = reporter.getUnflushedEvents();
      expect(events[0]!.timestamp).toBeGreaterThanOrEqual(before);
      expect(events[0]!.timestamp).toBeLessThanOrEqual(after);
    });

    it('uses provided timestamp', () => {
      const reporter = new SecurityEventReporter();
      reporter.record(makeEvent({ timestamp: 12345 }));

      const events = reporter.getUnflushedEvents();
      expect(events[0]!.timestamp).toBe(12345);
    });

    it('defaults count to 1', () => {
      const reporter = new SecurityEventReporter();
      reporter.record(makeEvent());

      const events = reporter.getUnflushedEvents();
      expect(events[0]!.count).toBe(1);
    });

    it('uses provided count', () => {
      const reporter = new SecurityEventReporter();
      reporter.record(makeEvent({ count: 5 }));

      const events = reporter.getUnflushedEvents();
      expect(events[0]!.count).toBe(5);
    });
  });

  describe('getRecentByType', () => {
    it('filters by event type', () => {
      const reporter = new SecurityEventReporter();
      reporter.record(makeEvent({ eventType: 'rate_limit_violation', timestamp: Date.now() }));
      reporter.record(makeEvent({ eventType: 'connection_spike', timestamp: Date.now() }));
      reporter.record(makeEvent({ eventType: 'rate_limit_violation', timestamp: Date.now() }));

      const result = reporter.getRecentByType('rate_limit_violation');
      expect(result).toHaveLength(2);
    });

    it('respects maxAge parameter', () => {
      const reporter = new SecurityEventReporter();
      const now = Date.now();
      reporter.record(makeEvent({ timestamp: now - 7200_000 })); // 2 hours ago
      reporter.record(makeEvent({ timestamp: now - 1800_000 })); // 30 min ago
      reporter.record(makeEvent({ timestamp: now }));

      const result = reporter.getRecentByType('rate_limit_violation', 3600_000); // 1 hour
      expect(result).toHaveLength(2); // Only the recent two
    });
  });

  describe('countEvents', () => {
    it('counts events by type', () => {
      const reporter = new SecurityEventReporter();
      reporter.record(makeEvent({ eventType: 'rate_limit_violation', count: 3, timestamp: Date.now() }));
      reporter.record(makeEvent({ eventType: 'rate_limit_violation', count: 2, timestamp: Date.now() }));
      reporter.record(makeEvent({ eventType: 'connection_spike', count: 1, timestamp: Date.now() }));

      expect(reporter.countEvents('rate_limit_violation')).toBe(5);
      expect(reporter.countEvents('connection_spike')).toBe(1);
      expect(reporter.countEvents('bad_client')).toBe(0);
    });

    it('filters by sourceIp', () => {
      const reporter = new SecurityEventReporter();
      reporter.record(makeEvent({ sourceIp: 'ip1', count: 3, timestamp: Date.now() }));
      reporter.record(makeEvent({ sourceIp: 'ip2', count: 2, timestamp: Date.now() }));

      expect(reporter.countEvents('rate_limit_violation', 'ip1')).toBe(3);
      expect(reporter.countEvents('rate_limit_violation', 'ip2')).toBe(2);
    });

    it('respects window parameter', () => {
      const reporter = new SecurityEventReporter();
      const now = Date.now();
      reporter.record(makeEvent({ timestamp: now - 7200_000, count: 10 })); // 2 hours ago
      reporter.record(makeEvent({ timestamp: now, count: 5 })); // now

      expect(reporter.countEvents('rate_limit_violation', undefined, 3600_000)).toBe(5);
    });
  });

  describe('flush lifecycle', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
      vi.useFakeTimers();
      originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true }), { status: 200 }),
      );
    });

    afterEach(() => {
      vi.useRealTimers();
      global.fetch = originalFetch;
    });

    it('getUnflushedEvents returns all events before first flush', () => {
      const reporter = new SecurityEventReporter();
      reporter.record(makeEvent());
      reporter.record(makeEvent());
      const unflushed = reporter.getUnflushedEvents();
      expect(unflushed).toHaveLength(2);
    });

    it('markFlushed clears unflushed events', () => {
      const reporter = new SecurityEventReporter();
      reporter.record(makeEvent());
      reporter.markFlushed();
      const unflushed = reporter.getUnflushedEvents();
      expect(unflushed).toHaveLength(0);
    });

    it('new events after markFlushed appear in unflushed', () => {
      const reporter = new SecurityEventReporter();
      reporter.record(makeEvent());
      reporter.markFlushed();
      reporter.record(makeEvent());
      reporter.record(makeEvent());
      const unflushed = reporter.getUnflushedEvents();
      expect(unflushed).toHaveLength(2);
    });

    it('flush calls fetch with correct URL and payload', async () => {
      const reporter = new SecurityEventReporter();
      reporter.record(makeEvent({ eventType: 'rate_limit_violation' }));

      reporter.start({
        diagnosticsUrl: 'https://diagnostics.example.com',
        pushSecret: 'secret-123',
        serverId: 'srv-01',
        region: 'us-east',
      });

      await reporter.flush();

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(url).toBe('https://diagnostics.example.com/diagnostics/security-events');
      expect(init.headers['Authorization']).toBe('Bearer secret-123');

      const body = JSON.parse(init.body);
      expect(body.serverId).toBe('srv-01');
      expect(body.events).toHaveLength(1);
      expect(body.events[0].eventType).toBe('rate_limit_violation');
      expect(body.events[0].region).toBe('us-east');

      reporter.stop();
    });

    it('flush does nothing when no unflushed events', async () => {
      const reporter = new SecurityEventReporter();
      reporter.start({
        diagnosticsUrl: 'https://diagnostics.example.com',
        pushSecret: 'secret-123',
        serverId: 'srv-01',
        region: 'us-east',
      });

      await reporter.flush();
      expect(global.fetch).not.toHaveBeenCalled();

      reporter.stop();
    });

    it('flush does not throw on network error', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Network error'),
      );

      const reporter = new SecurityEventReporter();
      reporter.record(makeEvent());
      reporter.start({
        diagnosticsUrl: 'https://diagnostics.example.com',
        pushSecret: 'secret-123',
        serverId: 'srv-01',
        region: 'us-east',
      });

      await expect(reporter.flush()).resolves.toBeUndefined();
      reporter.stop();
    });

    it('stop prevents further automatic flushes', () => {
      const reporter = new SecurityEventReporter();
      reporter.start({
        diagnosticsUrl: 'https://diagnostics.example.com',
        pushSecret: 'secret-123',
        serverId: 'srv-01',
        region: 'us-east',
      });
      reporter.stop();
      reporter.record(makeEvent());

      vi.advanceTimersByTime(120_000);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
