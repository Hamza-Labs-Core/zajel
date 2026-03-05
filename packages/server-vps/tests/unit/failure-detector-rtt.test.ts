/**
 * Unit tests for FailureDetector RTT tracking (US-3.4)
 *
 * Tests the sliding window RTT measurement, percentile calculations,
 * and getRttStats() aggregate method.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FailureDetector, type FailureDetectorConfig } from '../../src/federation/gossip/failure-detector.js';
import type { MembershipEntry } from '../../src/types.js';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function makeConfig(overrides: Partial<FailureDetectorConfig> = {}): FailureDetectorConfig {
  return {
    pingInterval: 1000,
    pingTimeout: 500,
    indirectPingCount: 3,
    suspicionTimeout: 5000,
    ...overrides,
  };
}

function makeMember(id: string): MembershipEntry {
  return {
    serverId: id,
    nodeId: id,
    endpoint: `ws://localhost:${3000 + parseInt(id.replace(/\D/g, '') || '0')}`,
    publicKey: new Uint8Array(32),
    status: 'alive',
    incarnation: 1,
    lastSeen: Date.now(),
    metadata: {},
  };
}

function createDetector(config?: Partial<FailureDetectorConfig>): FailureDetector {
  const members = [makeMember('s1'), makeMember('s2'), makeMember('s3')];
  return new FailureDetector(
    makeConfig(config),
    (count, exclude) =>
      members.filter((m) => !exclude.includes(m.serverId)).slice(0, count),
    () => members,
  );
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('FailureDetector RTT tracking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns zero stats when no pings have been acked', () => {
    const fd = createDetector();
    const stats = fd.getRttStats();

    expect(stats.p50Ms).toBe(0);
    expect(stats.p95Ms).toBe(0);
    expect(stats.p99Ms).toBe(0);
    expect(stats.pingCount).toBe(0);
  });

  it('getRttP50/P95/P99 return 0 when no samples', () => {
    const fd = createDetector();

    expect(fd.getRttP50()).toBe(0);
    expect(fd.getRttP95()).toBe(0);
    expect(fd.getRttP99()).toBe(0);
  });

  it('records RTT on direct ping ack', () => {
    const fd = createDetector();
    const member = makeMember('s1');

    // Send a ping
    fd.ping(member);

    // Advance time by 25ms
    vi.advanceTimersByTime(25);

    // Ack the ping
    fd.ack('s1', 1);

    const stats = fd.getRttStats();
    expect(stats.pingCount).toBe(1);
    expect(stats.p50Ms).toBe(25);
    expect(stats.p95Ms).toBe(25);
    expect(stats.p99Ms).toBe(25);
  });

  it('accumulates multiple RTT samples', () => {
    const fd = createDetector();

    // Simulate 5 pings with different RTTs
    const rtts = [10, 20, 30, 40, 50];
    for (const rtt of rtts) {
      const member = makeMember('s1');
      fd.ping(member);
      vi.advanceTimersByTime(rtt);
      fd.ack('s1', 1);
    }

    expect(fd.getPingCount()).toBe(5);

    // P50 of [10, 20, 30, 40, 50] = 30 (index 2 of sorted array)
    expect(fd.getRttP50()).toBe(30);
    // P95 of 5 elements: ceil(0.95 * 5) - 1 = 4 => 50
    expect(fd.getRttP95()).toBe(50);
  });

  it('computes correct percentiles for larger sample', () => {
    const fd = createDetector();

    // Create 100 samples: 1, 2, 3, ..., 100
    for (let i = 1; i <= 100; i++) {
      const member = makeMember('s1');
      fd.ping(member);
      vi.advanceTimersByTime(i);
      fd.ack('s1', 1);
    }

    const stats = fd.getRttStats();
    expect(stats.pingCount).toBe(100);

    // P50 of 1..100: ceil(50/100 * 100) - 1 = 49 => value 50
    expect(stats.p50Ms).toBe(50);
    // P95: ceil(95/100 * 100) - 1 = 94 => value 95
    expect(stats.p95Ms).toBe(95);
    // P99: ceil(99/100 * 100) - 1 = 98 => value 99
    expect(stats.p99Ms).toBe(99);
  });

  it('does not record RTT for indirect acks', () => {
    const fd = createDetector({ pingTimeout: 50 });
    const member = makeMember('s1');

    // Send a ping
    fd.ping(member);

    // Let the direct ping timeout (escalate to indirect)
    vi.advanceTimersByTime(50);

    // The ping is now indirect — ack via indirect path
    fd.indirectAck('s1', 's2', 1);

    // No direct RTT recorded
    expect(fd.getPingCount()).toBe(0);
    expect(fd.getRttStats().p50Ms).toBe(0);
  });

  it('sliding window caps at 200 samples', () => {
    const fd = createDetector();

    // Push 250 samples
    for (let i = 1; i <= 250; i++) {
      const member = makeMember('s1');
      fd.ping(member);
      vi.advanceTimersByTime(i);
      fd.ack('s1', 1);
    }

    // Total ping count includes all 250
    expect(fd.getPingCount()).toBe(250);

    // But the stats window only has the last 200 (samples 51-250)
    // P50 of [51..250] = ceil(50/100 * 200) - 1 = 99 => sample[99] = 51+99 = 150
    const stats = fd.getRttStats();
    expect(stats.p50Ms).toBe(150);
  });

  it('getRttStats returns consistent result with individual P50/P95/P99', () => {
    const fd = createDetector();

    for (let i = 1; i <= 20; i++) {
      const member = makeMember('s1');
      fd.ping(member);
      vi.advanceTimersByTime(i * 5);
      fd.ack('s1', 1);
    }

    const stats = fd.getRttStats();
    expect(stats.p50Ms).toBe(fd.getRttP50());
    expect(stats.p95Ms).toBe(fd.getRttP95());
    expect(stats.p99Ms).toBe(fd.getRttP99());
    expect(stats.pingCount).toBe(fd.getPingCount());
  });

  it('single sample gives same value for all percentiles', () => {
    const fd = createDetector();
    const member = makeMember('s1');

    fd.ping(member);
    vi.advanceTimersByTime(42);
    fd.ack('s1', 1);

    expect(fd.getRttP50()).toBe(42);
    expect(fd.getRttP95()).toBe(42);
    expect(fd.getRttP99()).toBe(42);
  });
});
