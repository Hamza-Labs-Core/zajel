/**
 * Dead-peer eviction tests.
 *
 * The bootstrap registry must actively prune servers whose public endpoint
 * stops responding, not just wait for the heartbeat TTL. A crash-looping
 * container can heartbeat briefly between restarts, keeping itself in the
 * registry indefinitely while being unreachable from clients.
 *
 * Approach: on each alarm tick, probe every registered server's
 * `${endpoint}/health` with a short timeout. After N consecutive probe
 * failures the server is evicted. A successful heartbeat or probe resets
 * the counter.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServerRegistryDO } from '../../src/durable-objects/server-registry-do.js';
import { MockState, createRequest } from '../helpers/mock-do.js';

describe('Dead-Peer Eviction', () => {
  let mockState;
  let registry;
  const authHeaders = { Authorization: 'Bearer test-secret' };

  beforeEach(() => {
    mockState = new MockState();
    registry = new ServerRegistryDO(mockState, {
      SERVER_REGISTRY_SECRET: 'test-secret',
      REPLAY_GRACE_MODE: 'true',
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    mockState.storage.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function registerServer(serverId, endpoint) {
    await registry.fetch(
      createRequest('POST', '/servers', {
        serverId,
        endpoint,
        publicKey: 'key-' + serverId,
        connections: 0,
      }, authHeaders)
    );
  }

  async function listServers() {
    const res = await registry.fetch(createRequest('GET', '/servers'));
    const body = await res.json();
    return body.servers;
  }

  /**
   * Stub global fetch so probe calls return the configured status per host.
   * Any endpoint in `deadHosts` returns network error; others return 200.
   */
  function stubProbeResponses(deadHosts) {
    const mockFetch = vi.fn(async (url) => {
      const u = new URL(url);
      const hostPort = u.host; // e.g. "dead1.example.com"
      if (deadHosts.some((h) => hostPort.includes(h))) {
        throw new Error('fetch failed (network)');
      }
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', mockFetch);
    return mockFetch;
  }

  it('evicts a server after 2 consecutive failed probes', async () => {
    await registerServer('ed25519:dead', 'wss://dead-host.example.com');

    // Baseline: server is listed
    expect(await listServers()).toHaveLength(1);

    stubProbeResponses(['dead-host']);

    // First alarm: probe fails once — server still listed (1 failure < threshold)
    await registry.alarm();
    expect(await listServers()).toHaveLength(1);

    // Second alarm: probe fails again — server evicted (2 failures >= threshold)
    await registry.alarm();
    expect(await listServers()).toHaveLength(0);
  });

  it('does not evict live servers even after many alarm cycles', async () => {
    await registerServer('ed25519:live', 'wss://live-host.example.com');

    stubProbeResponses([]); // nothing is dead

    for (let i = 0; i < 5; i++) {
      await registry.alarm();
    }

    const servers = await listServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].serverId).toBe('ed25519:live');
  });

  it('filters dead servers from a mixed registry', async () => {
    await registerServer('ed25519:live-a', 'wss://live-a.example.com');
    await registerServer('ed25519:dead-b', 'wss://dead-b.example.com');
    await registerServer('ed25519:live-c', 'wss://live-c.example.com');

    stubProbeResponses(['dead-b']);

    await registry.alarm(); // 1 failure on dead-b
    await registry.alarm(); // 2 failures → evict

    const servers = await listServers();
    expect(servers.map((s) => s.serverId).sort()).toEqual([
      'ed25519:live-a',
      'ed25519:live-c',
    ]);
  });

  it('resets probe-failure count on a successful heartbeat', async () => {
    await registerServer('ed25519:flaky', 'wss://flaky-host.example.com');

    stubProbeResponses(['flaky-host']);

    // 1 probe failure accrued
    await registry.alarm();

    // Simulate server recovery: successful heartbeat (not a probe)
    vi.advanceTimersByTime(60_000);
    await registry.fetch(
      createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:flaky',
        connections: 1,
        relayConnections: 0,
        signalingConnections: 1,
        activeCodes: 0,
      }, authHeaders)
    );

    // Probe stays dead but heartbeat reset probe-failure counter to 0.
    // Next alarm bumps to 1 again — still below threshold of 2.
    await registry.alarm();
    expect(await listServers()).toHaveLength(1);
  });

  it('treats non-2xx probe responses as failures', async () => {
    await registerServer('ed25519:bad-status', 'wss://bad-status.example.com');

    // Respond 500 on all probes
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 500 })));

    await registry.alarm();
    await registry.alarm();

    expect(await listServers()).toHaveLength(0);
  });

  it('evicts servers whose lastSeen exceeds the shortened TTL (2 min)', async () => {
    await registerServer('ed25519:stale', 'wss://never-probed.example.com');

    // Don't stub fetch — probe should not matter here because TTL hits first.
    // Just advance past the 2-minute TTL.
    vi.advanceTimersByTime(2 * 60 * 1000 + 1000);

    // With no probe stub, real fetch would throw; we short-circuit with stub.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await registry.alarm();
    expect(await listServers()).toHaveLength(0);
  });
});
