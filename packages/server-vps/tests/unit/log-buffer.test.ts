/**
 * Unit tests for LogBuffer (US-5.2)
 *
 * Tests the circular buffer, querying, filtering, pagination,
 * and flush lifecycle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LogBuffer, type LogEntry, type LogSeverity } from '../../src/admin/log-buffer.js';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: Date.now(),
    severity: 'info',
    category: 'Test',
    message: 'test message',
    ...overrides,
  };
}

function fillBuffer(buffer: LogBuffer, count: number, baseTimestamp = Date.now()): void {
  for (let i = 0; i < count; i++) {
    buffer.add(makeEntry({
      timestamp: baseTimestamp + i,
      severity: ['debug', 'info', 'warn', 'error'][i % 4] as LogSeverity,
      category: `Module${i % 3}`,
      message: `log entry ${i}`,
    }));
  }
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('LogBuffer', () => {
  describe('add and size', () => {
    it('starts empty', () => {
      const buffer = new LogBuffer();
      expect(buffer.size).toBe(0);
    });

    it('tracks size as entries are added', () => {
      const buffer = new LogBuffer();
      buffer.add(makeEntry());
      expect(buffer.size).toBe(1);
      buffer.add(makeEntry());
      expect(buffer.size).toBe(2);
    });

    it('caps at 10,000 entries (circular eviction)', () => {
      const buffer = new LogBuffer();
      fillBuffer(buffer, 10_500);
      expect(buffer.size).toBe(10_000);
    });
  });

  describe('query - basic', () => {
    it('returns all entries when no filters applied', () => {
      const buffer = new LogBuffer();
      fillBuffer(buffer, 5);
      const result = buffer.query();
      expect(result.entries).toHaveLength(5);
      expect(result.total).toBe(5);
      expect(result.hasMore).toBe(false);
    });

    it('returns entries newest-first', () => {
      const buffer = new LogBuffer();
      const base = 1000000;
      fillBuffer(buffer, 3, base);
      const result = buffer.query();
      expect(result.entries[0]!.timestamp).toBeGreaterThan(result.entries[1]!.timestamp);
      expect(result.entries[1]!.timestamp).toBeGreaterThan(result.entries[2]!.timestamp);
    });

    it('returns empty result for empty buffer', () => {
      const buffer = new LogBuffer();
      const result = buffer.query();
      expect(result.entries).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
      expect(result.bufferSize).toBe(0);
      expect(result.oldestTimestamp).toBe(0);
    });
  });

  describe('query - severity filter', () => {
    it('filters by minimum severity level', () => {
      const buffer = new LogBuffer();
      buffer.add(makeEntry({ severity: 'debug', message: 'debug msg' }));
      buffer.add(makeEntry({ severity: 'info', message: 'info msg' }));
      buffer.add(makeEntry({ severity: 'warn', message: 'warn msg' }));
      buffer.add(makeEntry({ severity: 'error', message: 'error msg' }));
      buffer.add(makeEntry({ severity: 'critical', message: 'critical msg' }));

      const result = buffer.query({ severity: 'warn' });
      expect(result.total).toBe(3); // warn, error, critical
      expect(result.entries.every(e =>
        ['warn', 'error', 'critical'].includes(e.severity)
      )).toBe(true);
    });

    it('severity=debug returns all entries', () => {
      const buffer = new LogBuffer();
      fillBuffer(buffer, 8);
      const result = buffer.query({ severity: 'debug' });
      expect(result.total).toBe(8);
    });
  });

  describe('query - time range filter', () => {
    it('filters by since timestamp', () => {
      const buffer = new LogBuffer();
      const base = 1000000;
      fillBuffer(buffer, 10, base);

      const result = buffer.query({ since: base + 5 });
      expect(result.entries.every(e => e.timestamp >= base + 5)).toBe(true);
    });

    it('filters by until timestamp', () => {
      const buffer = new LogBuffer();
      const base = 1000000;
      fillBuffer(buffer, 10, base);

      const result = buffer.query({ until: base + 5 });
      expect(result.entries.every(e => e.timestamp <= base + 5)).toBe(true);
    });

    it('filters by both since and until', () => {
      const buffer = new LogBuffer();
      const base = 1000000;
      fillBuffer(buffer, 10, base);

      const result = buffer.query({ since: base + 3, until: base + 7 });
      expect(result.entries.every(e =>
        e.timestamp >= base + 3 && e.timestamp <= base + 7
      )).toBe(true);
      expect(result.total).toBe(5);
    });
  });

  describe('query - keyword filter', () => {
    it('performs case-insensitive substring match', () => {
      const buffer = new LogBuffer();
      buffer.add(makeEntry({ message: 'Federation peer joined' }));
      buffer.add(makeEntry({ message: 'Client connected' }));
      buffer.add(makeEntry({ message: 'FEDERATION state update' }));

      const result = buffer.query({ keyword: 'federation' });
      expect(result.total).toBe(2);
    });

    it('returns empty when keyword not found', () => {
      const buffer = new LogBuffer();
      buffer.add(makeEntry({ message: 'hello world' }));

      const result = buffer.query({ keyword: 'nonexistent' });
      expect(result.total).toBe(0);
    });
  });

  describe('query - category filter', () => {
    it('filters by exact category match', () => {
      const buffer = new LogBuffer();
      buffer.add(makeEntry({ category: 'Federation', message: 'a' }));
      buffer.add(makeEntry({ category: 'Client', message: 'b' }));
      buffer.add(makeEntry({ category: 'Federation', message: 'c' }));

      const result = buffer.query({ category: 'Federation' });
      expect(result.total).toBe(2);
      expect(result.entries.every(e => e.category === 'Federation')).toBe(true);
    });
  });

  describe('query - pagination', () => {
    it('limits results to the specified limit', () => {
      const buffer = new LogBuffer();
      fillBuffer(buffer, 50);

      const result = buffer.query({ limit: 10 });
      expect(result.entries).toHaveLength(10);
      expect(result.total).toBe(50);
      expect(result.hasMore).toBe(true);
    });

    it('applies offset correctly', () => {
      const buffer = new LogBuffer();
      fillBuffer(buffer, 20);

      const page1 = buffer.query({ limit: 10, offset: 0 });
      const page2 = buffer.query({ limit: 10, offset: 10 });

      expect(page1.entries).toHaveLength(10);
      expect(page2.entries).toHaveLength(10);
      expect(page1.hasMore).toBe(true);
      expect(page2.hasMore).toBe(false);

      // Pages should not overlap
      const page1Timestamps = page1.entries.map(e => e.timestamp);
      const page2Timestamps = page2.entries.map(e => e.timestamp);
      for (const ts of page2Timestamps) {
        expect(page1Timestamps).not.toContain(ts);
      }
    });

    it('caps limit at 500', () => {
      const buffer = new LogBuffer();
      fillBuffer(buffer, 600);

      const result = buffer.query({ limit: 1000 });
      expect(result.entries).toHaveLength(500);
    });

    it('clamps limit minimum to 1', () => {
      const buffer = new LogBuffer();
      fillBuffer(buffer, 5);

      const result = buffer.query({ limit: 0 });
      expect(result.entries).toHaveLength(1);
    });

    it('clamps offset minimum to 0', () => {
      const buffer = new LogBuffer();
      fillBuffer(buffer, 5);

      const result = buffer.query({ offset: -5 });
      expect(result.entries).toHaveLength(5);
    });
  });

  describe('query - bufferSize and oldestTimestamp', () => {
    it('reports correct buffer size', () => {
      const buffer = new LogBuffer();
      fillBuffer(buffer, 42);
      const result = buffer.query();
      expect(result.bufferSize).toBe(42);
    });

    it('reports correct oldest timestamp', () => {
      const buffer = new LogBuffer();
      buffer.add(makeEntry({ timestamp: 5000 }));
      buffer.add(makeEntry({ timestamp: 3000 }));
      buffer.add(makeEntry({ timestamp: 7000 }));

      const result = buffer.query();
      expect(result.oldestTimestamp).toBe(3000);
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

    it('getUnflushedEntries returns all entries before first flush', () => {
      const buffer = new LogBuffer();
      fillBuffer(buffer, 5);
      const unflushed = buffer.getUnflushedEntries();
      expect(unflushed).toHaveLength(5);
    });

    it('markFlushed clears unflushed entries', () => {
      const buffer = new LogBuffer();
      fillBuffer(buffer, 5);
      buffer.markFlushed();
      const unflushed = buffer.getUnflushedEntries();
      expect(unflushed).toHaveLength(0);
    });

    it('new entries after markFlushed appear in unflushed', () => {
      const buffer = new LogBuffer();
      fillBuffer(buffer, 5);
      buffer.markFlushed();
      fillBuffer(buffer, 3);
      const unflushed = buffer.getUnflushedEntries();
      expect(unflushed).toHaveLength(3);
    });

    it('flush calls fetch with correct URL and payload', async () => {
      const buffer = new LogBuffer();
      buffer.add(makeEntry({ message: 'test log' }));

      buffer.startFlush({
        diagnosticsUrl: 'https://diagnostics.example.com',
        pushSecret: 'secret-123',
        serverId: 'srv-01',
      });

      await buffer.flush();

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(url).toBe('https://diagnostics.example.com/diagnostics/server-logs');
      expect(init.headers['Authorization']).toBe('Bearer secret-123');

      const body = JSON.parse(init.body);
      expect(body.serverId).toBe('srv-01');
      expect(body.entries).toHaveLength(1);

      buffer.stopFlush();
    });

    it('flush does nothing when no unflushed entries', async () => {
      const buffer = new LogBuffer();
      buffer.startFlush({
        diagnosticsUrl: 'https://diagnostics.example.com',
        pushSecret: 'secret-123',
        serverId: 'srv-01',
      });

      await buffer.flush();
      expect(global.fetch).not.toHaveBeenCalled();

      buffer.stopFlush();
    });

    it('flush does not throw on network error (fire-and-forget)', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Network error'),
      );

      const buffer = new LogBuffer();
      buffer.add(makeEntry());
      buffer.startFlush({
        diagnosticsUrl: 'https://diagnostics.example.com',
        pushSecret: 'secret-123',
        serverId: 'srv-01',
      });

      await expect(buffer.flush()).resolves.toBeUndefined();
      buffer.stopFlush();
    });

    it('stopFlush prevents further automatic flushes', () => {
      const buffer = new LogBuffer();
      buffer.startFlush({
        diagnosticsUrl: 'https://diagnostics.example.com',
        pushSecret: 'secret-123',
        serverId: 'srv-01',
      });
      buffer.stopFlush();
      buffer.add(makeEntry());

      vi.advanceTimersByTime(120_000);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
