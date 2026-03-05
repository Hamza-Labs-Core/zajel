/**
 * Unit tests for metrics-push module (US-3.3)
 *
 * Tests the periodic push of server metrics to the diagnostics-cf worker.
 * Verifies payload structure, fetch calls, error handling, and start/stop lifecycle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startMetricsPush } from '../../src/admin/metrics-push.js';
import type { MetricsCollector } from '../../src/admin/metrics.js';
import type { MetricsSnapshot } from '../../src/admin/types.js';

// ─────────────────────────────────────────────
// Mock helpers
// ─────────────────────────────────────────────

function makeSnapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    timestamp: Date.now(),
    connections: { total: 42, relay: 30, signaling: 12, ...overrides.connections },
    entropy: {
      activeCodes: 50,
      peakActiveCodes: 100,
      collisionRisk: 'low',
      collisionAttempts: 0,
      ...overrides.entropy,
    },
    federation: {
      aliveMembers: 3,
      suspectMembers: 0,
      totalMembers: 4,
      regions: { 'us-east': 2, 'eu-west': 2 },
      ...overrides.federation,
    },
    messageRate: { perSecond: 5, perMinute: 300, ...overrides.messageRate },
    ...overrides,
  };
}

function makeMockCollector(snapshot?: MetricsSnapshot): MetricsCollector {
  return {
    takeSnapshot: vi.fn().mockReturnValue(snapshot ?? makeSnapshot()),
    recordMessage: vi.fn(),
    getMessageRate: vi.fn().mockReturnValue({ perSecond: 5, perMinute: 300 }),
    getHistory: vi.fn().mockReturnValue({ snapshots: [], startTime: Date.now(), endTime: Date.now() }),
    getFederationTopology: vi.fn().mockReturnValue({ nodes: [], edges: [] }),
    getScalingRecommendation: vi.fn().mockReturnValue({ level: 'normal', message: '', metrics: {}, recommendations: [] }),
  } as unknown as MetricsCollector;
}

const defaultConfig = {
  diagnosticsUrl: 'https://diagnostics.example.com',
  pushSecret: 'test-secret-123',
  serverId: 'srv-01',
  region: 'us-east',
};

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('startMetricsPush', () => {
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

  it('returns a handle with stop() and pushNow()', () => {
    const collector = makeMockCollector();
    const handle = startMetricsPush(collector, defaultConfig);

    expect(typeof handle.stop).toBe('function');
    expect(typeof handle.pushNow).toBe('function');

    handle.stop();
  });

  it('pushNow() calls fetch with correct URL and headers', async () => {
    const collector = makeMockCollector();
    const handle = startMetricsPush(collector, defaultConfig);

    await handle.pushNow();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://diagnostics.example.com/diagnostics/server-metrics');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['Authorization']).toBe('Bearer test-secret-123');

    handle.stop();
  });

  it('pushNow() sends correct payload structure', async () => {
    const collector = makeMockCollector();
    const handle = startMetricsPush(collector, defaultConfig);

    await handle.pushNow();

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const payload = JSON.parse(init.body);

    expect(payload.serverId).toBe('srv-01');
    expect(payload.region).toBe('us-east');
    expect(typeof payload.timestamp).toBe('number');

    // Verify metrics structure
    expect(payload.metrics.connections).toBeDefined();
    expect(payload.metrics.connections.total).toBe(42);
    expect(payload.metrics.connections.relay).toBe(30);
    expect(payload.metrics.connections.signaling).toBe(12);

    expect(payload.metrics.entropy).toBeDefined();
    expect(payload.metrics.entropy.activeCodes).toBe(50);
    expect(payload.metrics.entropy.collisionRisk).toBe('low');

    expect(payload.metrics.federation).toBeDefined();
    expect(payload.metrics.federation.aliveMembers).toBe(3);
    expect(payload.metrics.federation.totalMembers).toBe(4);

    expect(payload.metrics.messageRate).toBeDefined();
    expect(payload.metrics.messageRate.perSecond).toBe(5);
    expect(payload.metrics.messageRate.perMinute).toBe(300);

    expect(payload.metrics.system).toBeDefined();
    expect(typeof payload.metrics.system.cpuPercent).toBe('number');
    expect(typeof payload.metrics.system.memoryMb).toBe('number');
    expect(typeof payload.metrics.system.uptimeSeconds).toBe('number');

    handle.stop();
  });

  it('calls metricsCollector.takeSnapshot() on pushNow()', async () => {
    const collector = makeMockCollector();
    const handle = startMetricsPush(collector, defaultConfig);

    await handle.pushNow();

    expect(collector.takeSnapshot).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it('does not throw when fetch fails (fire-and-forget)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Network error'),
    );

    const collector = makeMockCollector();
    const handle = startMetricsPush(collector, defaultConfig);

    // Should not throw
    await expect(handle.pushNow()).resolves.toBeUndefined();

    handle.stop();
  });

  it('does not throw when fetch returns non-OK status', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('Server Error', { status: 500 }),
    );

    const collector = makeMockCollector();
    const handle = startMetricsPush(collector, defaultConfig);

    await expect(handle.pushNow()).resolves.toBeUndefined();

    handle.stop();
  });

  it('stop() clears the interval and prevents further pushes', async () => {
    const collector = makeMockCollector();
    const handle = startMetricsPush(collector, defaultConfig);

    handle.stop();

    // Advance time past the push interval
    vi.advanceTimersByTime(120_000);

    // fetch should not have been called (interval was cleared)
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('stop() can be called multiple times safely', () => {
    const collector = makeMockCollector();
    const handle = startMetricsPush(collector, defaultConfig);

    handle.stop();
    handle.stop(); // should not throw
  });

  it('periodic push fires after interval', async () => {
    const collector = makeMockCollector();
    const handle = startMetricsPush(collector, defaultConfig);

    // Advance 60 seconds (push interval)
    await vi.advanceTimersByTimeAsync(60_000);

    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Advance another 60 seconds
    await vi.advanceTimersByTimeAsync(60_000);

    expect(global.fetch).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it('system.cpuPercent is between 0 and 100', async () => {
    const collector = makeMockCollector();
    const handle = startMetricsPush(collector, defaultConfig);

    await handle.pushNow();

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const payload = JSON.parse(init.body);

    expect(payload.metrics.system.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(payload.metrics.system.cpuPercent).toBeLessThanOrEqual(100);

    handle.stop();
  });

  it('system.memoryMb is a positive number', async () => {
    const collector = makeMockCollector();
    const handle = startMetricsPush(collector, defaultConfig);

    await handle.pushNow();

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const payload = JSON.parse(init.body);

    expect(payload.metrics.system.memoryMb).toBeGreaterThan(0);

    handle.stop();
  });

  it('system.uptimeSeconds is a non-negative integer', async () => {
    const collector = makeMockCollector();
    const handle = startMetricsPush(collector, defaultConfig);

    await handle.pushNow();

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const payload = JSON.parse(init.body);

    expect(payload.metrics.system.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(payload.metrics.system.uptimeSeconds)).toBe(true);

    handle.stop();
  });

  // ─── Gossip latency (US-3.4) ─────────────────────────────

  it('includes gossipLatency when getGossipLatency is provided and pingCount > 0', async () => {
    const collector = makeMockCollector();
    const handle = startMetricsPush(collector, {
      ...defaultConfig,
      getGossipLatency: () => ({ p50Ms: 12, p95Ms: 45, p99Ms: 80, pingCount: 100 }),
    });

    await handle.pushNow();

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const payload = JSON.parse(init.body);

    expect(payload.metrics.gossipLatency).toBeDefined();
    expect(payload.metrics.gossipLatency.p50Ms).toBe(12);
    expect(payload.metrics.gossipLatency.p95Ms).toBe(45);
    expect(payload.metrics.gossipLatency.p99Ms).toBe(80);
    expect(payload.metrics.gossipLatency.pingCount).toBe(100);

    handle.stop();
  });

  it('omits gossipLatency when getGossipLatency returns pingCount 0', async () => {
    const collector = makeMockCollector();
    const handle = startMetricsPush(collector, {
      ...defaultConfig,
      getGossipLatency: () => ({ p50Ms: 0, p95Ms: 0, p99Ms: 0, pingCount: 0 }),
    });

    await handle.pushNow();

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const payload = JSON.parse(init.body);

    expect(payload.metrics.gossipLatency).toBeUndefined();

    handle.stop();
  });

  it('omits gossipLatency when getGossipLatency is not provided', async () => {
    const collector = makeMockCollector();
    const handle = startMetricsPush(collector, defaultConfig);

    await handle.pushNow();

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const payload = JSON.parse(init.body);

    expect(payload.metrics.gossipLatency).toBeUndefined();

    handle.stop();
  });
});
