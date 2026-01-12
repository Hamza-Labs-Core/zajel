/**
 * Bootstrap Service Integration Tests
 *
 * Integration tests for the Cloudflare Workers bootstrap service:
 * - Stale server cleanup (register, wait, verify removed)
 * - Multiple server registration and discovery
 * - Server heartbeat loop simulation
 * - Federation peer discovery scenarios
 *
 * These tests simulate real-world scenarios with multiple servers
 * interacting with the bootstrap service over time.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServerRegistryDO } from '../../src/durable-objects/server-registry-do.js';
import worker from '../../src/index.js';

/**
 * Mock Durable Object Storage for testing
 */
class MockStorage {
  constructor() {
    this.data = new Map();
  }

  async get(key) {
    return this.data.get(key);
  }

  async put(key, value) {
    this.data.set(key, value);
  }

  async delete(key) {
    this.data.delete(key);
  }

  async list({ prefix }) {
    const results = new Map();
    for (const [key, value] of this.data) {
      if (key.startsWith(prefix)) {
        results.set(key, value);
      }
    }
    return results;
  }

  clear() {
    this.data.clear();
  }
}

/**
 * Mock Durable Object State
 */
class MockState {
  constructor() {
    this.storage = new MockStorage();
  }
}

/**
 * Mock Durable Object Stub for env binding
 */
class MockDurableObjectStub {
  constructor(doInstance) {
    this.doInstance = doInstance;
  }

  async fetch(request) {
    return this.doInstance.fetch(request);
  }
}

/**
 * Create a mock environment for CF Workers
 */
function createMockEnv(doInstance) {
  return {
    SERVER_REGISTRY: {
      idFromName: () => 'mock-id',
      get: () => new MockDurableObjectStub(doInstance),
    },
  };
}

/**
 * Helper to create a JSON request
 */
function createRequest(method, path, body = null, baseUrl = 'https://test.workers.dev') {
  const url = `${baseUrl}${path}`;
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  return new Request(url, options);
}

/**
 * Helper to register a server
 */
async function registerServer(registry, serverData) {
  const response = await registry.fetch(createRequest('POST', '/servers', serverData));
  return response.json();
}

/**
 * Helper to send heartbeat
 */
async function sendHeartbeat(registry, serverId) {
  const response = await registry.fetch(
    createRequest('POST', '/servers/heartbeat', { serverId })
  );
  return response.json();
}

/**
 * Helper to list servers
 */
async function listServers(registry) {
  const response = await registry.fetch(createRequest('GET', '/servers'));
  return response.json();
}

/**
 * Helper to unregister a server
 */
async function unregisterServer(registry, serverId) {
  const response = await registry.fetch(createRequest('DELETE', `/servers/${serverId}`));
  return response.json();
}

describe('Bootstrap Service Integration Tests', () => {
  let mockState;
  let serverRegistry;
  let env;

  beforeEach(() => {
    mockState = new MockState();
    serverRegistry = new ServerRegistryDO(mockState, {});
    env = createMockEnv(serverRegistry);
    vi.useFakeTimers();
  });

  afterEach(() => {
    mockState.storage.clear();
    vi.useRealTimers();
  });

  describe('Stale Server Cleanup', () => {
    it('should automatically remove stale servers after 5 minutes', async () => {
      // Register a server
      await registerServer(serverRegistry, {
        serverId: 'ed25519:stale-test-server',
        endpoint: 'wss://stale.example.com',
        publicKey: 'stale-public-key',
        region: 'eu-west',
      });

      // Verify server is registered
      let result = await listServers(serverRegistry);
      expect(result.servers).toHaveLength(1);

      // Advance time by 4 minutes - should still be present
      vi.advanceTimersByTime(4 * 60 * 1000);
      result = await listServers(serverRegistry);
      expect(result.servers).toHaveLength(1);

      // Advance time by 2 more minutes (total 6 minutes) - should be removed
      vi.advanceTimersByTime(2 * 60 * 1000);
      result = await listServers(serverRegistry);
      expect(result.servers).toHaveLength(0);
    });

    it('should clean up stale servers from storage when listing', async () => {
      await registerServer(serverRegistry, {
        serverId: 'ed25519:storage-cleanup-test',
        endpoint: 'wss://cleanup.example.com',
        publicKey: 'cleanup-key',
      });

      // Advance past TTL
      vi.advanceTimersByTime(6 * 60 * 1000);

      // List servers triggers cleanup
      await listServers(serverRegistry);

      // Verify storage entry is deleted
      const stored = await mockState.storage.get('server:ed25519:storage-cleanup-test');
      expect(stored).toBeUndefined();
    });

    it('should only remove stale servers, keeping fresh ones', async () => {
      // Register first server
      await registerServer(serverRegistry, {
        serverId: 'ed25519:old-server',
        endpoint: 'wss://old.example.com',
        publicKey: 'old-key',
      });

      // Advance time by 4 minutes
      vi.advanceTimersByTime(4 * 60 * 1000);

      // Register second server (fresh)
      await registerServer(serverRegistry, {
        serverId: 'ed25519:new-server',
        endpoint: 'wss://new.example.com',
        publicKey: 'new-key',
      });

      // Advance time by 2 more minutes (old server now 6 min, new server 2 min)
      vi.advanceTimersByTime(2 * 60 * 1000);

      const result = await listServers(serverRegistry);
      expect(result.servers).toHaveLength(1);
      expect(result.servers[0].serverId).toBe('ed25519:new-server');
    });
  });

  describe('Multiple Server Registration and Discovery', () => {
    it('should handle registration of multiple VPS servers from different regions', async () => {
      const servers = [
        {
          serverId: 'ed25519:us-east-server',
          endpoint: 'wss://us-east.zajel.io',
          publicKey: 'us-east-pubkey',
          region: 'us-east',
        },
        {
          serverId: 'ed25519:eu-west-server',
          endpoint: 'wss://eu-west.zajel.io',
          publicKey: 'eu-west-pubkey',
          region: 'eu-west',
        },
        {
          serverId: 'ed25519:ap-south-server',
          endpoint: 'wss://ap-south.zajel.io',
          publicKey: 'ap-south-pubkey',
          region: 'ap-south',
        },
        {
          serverId: 'ed25519:sa-east-server',
          endpoint: 'wss://sa-east.zajel.io',
          publicKey: 'sa-east-pubkey',
          region: 'sa-east',
        },
      ];

      // Register all servers
      for (const server of servers) {
        await registerServer(serverRegistry, server);
      }

      // Verify all servers are discoverable
      const result = await listServers(serverRegistry);
      expect(result.servers).toHaveLength(4);

      // Verify each region is represented
      const regions = result.servers.map(s => s.region);
      expect(regions).toContain('us-east');
      expect(regions).toContain('eu-west');
      expect(regions).toContain('ap-south');
      expect(regions).toContain('sa-east');
    });

    it('should allow servers to discover each other for federation', async () => {
      // Register server A
      await registerServer(serverRegistry, {
        serverId: 'ed25519:server-a',
        endpoint: 'wss://server-a.zajel.io',
        publicKey: 'pubkey-a',
        region: 'us-east',
      });

      // Register server B
      await registerServer(serverRegistry, {
        serverId: 'ed25519:server-b',
        endpoint: 'wss://server-b.zajel.io',
        publicKey: 'pubkey-b',
        region: 'eu-west',
      });

      // Server A sends heartbeat and discovers server B
      const heartbeatResultA = await sendHeartbeat(serverRegistry, 'ed25519:server-a');
      expect(heartbeatResultA.peers).toHaveLength(1);
      expect(heartbeatResultA.peers[0].serverId).toBe('ed25519:server-b');

      // Server B sends heartbeat and discovers server A
      const heartbeatResultB = await sendHeartbeat(serverRegistry, 'ed25519:server-b');
      expect(heartbeatResultB.peers).toHaveLength(1);
      expect(heartbeatResultB.peers[0].serverId).toBe('ed25519:server-a');
    });

    it('should handle server re-registration with updated endpoint', async () => {
      // Initial registration
      await registerServer(serverRegistry, {
        serverId: 'ed25519:migrating-server',
        endpoint: 'wss://old-endpoint.zajel.io',
        publicKey: 'migrate-key',
        region: 'us-east',
      });

      // Re-register with new endpoint (e.g., IP changed)
      await registerServer(serverRegistry, {
        serverId: 'ed25519:migrating-server',
        endpoint: 'wss://new-endpoint.zajel.io',
        publicKey: 'migrate-key',
        region: 'us-west', // Also moved region
      });

      const result = await listServers(serverRegistry);
      expect(result.servers).toHaveLength(1);
      expect(result.servers[0].endpoint).toBe('wss://new-endpoint.zajel.io');
      expect(result.servers[0].region).toBe('us-west');
    });

    it('should handle mass server registration (load test simulation)', async () => {
      const serverCount = 50;

      // Register many servers
      for (let i = 0; i < serverCount; i++) {
        await registerServer(serverRegistry, {
          serverId: `ed25519:load-test-server-${i}`,
          endpoint: `wss://load${i}.zajel.io`,
          publicKey: `load-key-${i}`,
          region: `region-${i % 5}`, // 5 different regions
        });
      }

      const result = await listServers(serverRegistry);
      expect(result.servers).toHaveLength(serverCount);
    });
  });

  describe('Server Heartbeat Loop Simulation', () => {
    it('should keep server alive with regular heartbeats', async () => {
      await registerServer(serverRegistry, {
        serverId: 'ed25519:heartbeat-loop-server',
        endpoint: 'wss://heartbeat.zajel.io',
        publicKey: 'heartbeat-key',
        region: 'us-east',
      });

      // Simulate heartbeat loop: every 60 seconds for 10 minutes
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(60 * 1000); // 60 seconds
        await sendHeartbeat(serverRegistry, 'ed25519:heartbeat-loop-server');
      }

      // Server should still be present after 10 minutes
      const result = await listServers(serverRegistry);
      expect(result.servers).toHaveLength(1);
    });

    it('should remove server when heartbeat stops', async () => {
      await registerServer(serverRegistry, {
        serverId: 'ed25519:dying-server',
        endpoint: 'wss://dying.zajel.io',
        publicKey: 'dying-key',
        region: 'eu-west',
      });

      // Send a few heartbeats
      for (let i = 0; i < 3; i++) {
        vi.advanceTimersByTime(60 * 1000);
        await sendHeartbeat(serverRegistry, 'ed25519:dying-server');
      }

      // Stop sending heartbeats and wait past TTL
      vi.advanceTimersByTime(6 * 60 * 1000);

      const result = await listServers(serverRegistry);
      expect(result.servers).toHaveLength(0);
    });

    it('should track peer changes in heartbeat responses', async () => {
      // Register first server
      await registerServer(serverRegistry, {
        serverId: 'ed25519:observer-server',
        endpoint: 'wss://observer.zajel.io',
        publicKey: 'observer-key',
        region: 'us-east',
      });

      // Initially no peers
      let heartbeatResult = await sendHeartbeat(serverRegistry, 'ed25519:observer-server');
      expect(heartbeatResult.peers).toHaveLength(0);

      // Add a peer
      await registerServer(serverRegistry, {
        serverId: 'ed25519:peer-1',
        endpoint: 'wss://peer1.zajel.io',
        publicKey: 'peer1-key',
        region: 'eu-west',
      });

      heartbeatResult = await sendHeartbeat(serverRegistry, 'ed25519:observer-server');
      expect(heartbeatResult.peers).toHaveLength(1);

      // Add another peer
      await registerServer(serverRegistry, {
        serverId: 'ed25519:peer-2',
        endpoint: 'wss://peer2.zajel.io',
        publicKey: 'peer2-key',
        region: 'ap-south',
      });

      heartbeatResult = await sendHeartbeat(serverRegistry, 'ed25519:observer-server');
      expect(heartbeatResult.peers).toHaveLength(2);

      // Remove a peer
      await unregisterServer(serverRegistry, 'ed25519:peer-1');

      heartbeatResult = await sendHeartbeat(serverRegistry, 'ed25519:observer-server');
      expect(heartbeatResult.peers).toHaveLength(1);
      expect(heartbeatResult.peers[0].serverId).toBe('ed25519:peer-2');
    });

    it('should handle concurrent heartbeats from multiple servers', async () => {
      const serverCount = 10;

      // Register multiple servers
      for (let i = 0; i < serverCount; i++) {
        await registerServer(serverRegistry, {
          serverId: `ed25519:concurrent-server-${i}`,
          endpoint: `wss://concurrent${i}.zajel.io`,
          publicKey: `concurrent-key-${i}`,
          region: 'us-east',
        });
      }

      // Simulate heartbeat cycle
      vi.advanceTimersByTime(60 * 1000);

      // All servers send heartbeat at roughly the same time
      const heartbeatPromises = [];
      for (let i = 0; i < serverCount; i++) {
        heartbeatPromises.push(
          sendHeartbeat(serverRegistry, `ed25519:concurrent-server-${i}`)
        );
      }

      const results = await Promise.all(heartbeatPromises);

      // Each server should see (serverCount - 1) peers
      for (const result of results) {
        expect(result.success).toBe(true);
        expect(result.peers).toHaveLength(serverCount - 1);
      }
    });
  });

  describe('Graceful Shutdown Scenarios', () => {
    it('should handle graceful server shutdown (unregister before going offline)', async () => {
      await registerServer(serverRegistry, {
        serverId: 'ed25519:graceful-server',
        endpoint: 'wss://graceful.zajel.io',
        publicKey: 'graceful-key',
        region: 'us-east',
      });

      // Register an observer server
      await registerServer(serverRegistry, {
        serverId: 'ed25519:observer',
        endpoint: 'wss://observer.zajel.io',
        publicKey: 'observer-key',
        region: 'eu-west',
      });

      // Observer sees the graceful server
      let heartbeatResult = await sendHeartbeat(serverRegistry, 'ed25519:observer');
      expect(heartbeatResult.peers).toHaveLength(1);
      expect(heartbeatResult.peers[0].serverId).toBe('ed25519:graceful-server');

      // Graceful server shuts down and unregisters
      await unregisterServer(serverRegistry, 'ed25519:graceful-server');

      // Observer immediately sees the server is gone
      heartbeatResult = await sendHeartbeat(serverRegistry, 'ed25519:observer');
      expect(heartbeatResult.peers).toHaveLength(0);
    });

    it('should handle ungraceful server shutdown (no unregister, relies on TTL)', async () => {
      await registerServer(serverRegistry, {
        serverId: 'ed25519:crashed-server',
        endpoint: 'wss://crashed.zajel.io',
        publicKey: 'crashed-key',
        region: 'us-east',
      });

      await registerServer(serverRegistry, {
        serverId: 'ed25519:observer',
        endpoint: 'wss://observer.zajel.io',
        publicKey: 'observer-key',
        region: 'eu-west',
      });

      // Observer sees the crashed server
      let heartbeatResult = await sendHeartbeat(serverRegistry, 'ed25519:observer');
      expect(heartbeatResult.peers).toHaveLength(1);

      // Crashed server doesn't send heartbeats
      // Advance time past TTL
      vi.advanceTimersByTime(6 * 60 * 1000);

      // Observer keeps sending heartbeats
      heartbeatResult = await sendHeartbeat(serverRegistry, 'ed25519:observer');

      // Crashed server should be gone now
      expect(heartbeatResult.peers).toHaveLength(0);
    });
  });

  describe('Client Discovery Flow', () => {
    it('should support client fetching server list via main worker', async () => {
      // Register some servers
      await registerServer(serverRegistry, {
        serverId: 'ed25519:client-visible-1',
        endpoint: 'wss://visible1.zajel.io',
        publicKey: 'visible1-key',
        region: 'us-east',
      });

      await registerServer(serverRegistry, {
        serverId: 'ed25519:client-visible-2',
        endpoint: 'wss://visible2.zajel.io',
        publicKey: 'visible2-key',
        region: 'eu-west',
      });

      // Client fetches through main worker
      const request = createRequest('GET', '/servers');
      const response = await worker.fetch(request, env);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.servers).toHaveLength(2);

      // Client can see all server details for connection
      const server1 = data.servers.find(s => s.serverId === 'ed25519:client-visible-1');
      expect(server1).toBeDefined();
      expect(server1.endpoint).toBe('wss://visible1.zajel.io');
      expect(server1.publicKey).toBe('visible1-key');
    });

    it('should only return fresh servers to clients', async () => {
      // Register a server
      await registerServer(serverRegistry, {
        serverId: 'ed25519:soon-stale',
        endpoint: 'wss://stale.zajel.io',
        publicKey: 'stale-key',
        region: 'us-east',
      });

      // Client sees it
      let response = await worker.fetch(createRequest('GET', '/servers'), env);
      let data = await response.json();
      expect(data.servers).toHaveLength(1);

      // Server stops heartbeating, becomes stale
      vi.advanceTimersByTime(6 * 60 * 1000);

      // Client no longer sees stale server
      response = await worker.fetch(createRequest('GET', '/servers'), env);
      data = await response.json();
      expect(data.servers).toHaveLength(0);
    });
  });

  describe('Federation Bootstrap Scenarios', () => {
    it('should support initial federation setup between two servers', async () => {
      // Server A starts up and registers
      await registerServer(serverRegistry, {
        serverId: 'ed25519:federation-server-a',
        endpoint: 'wss://fed-a.zajel.io',
        publicKey: 'fed-a-pubkey',
        region: 'us-east',
      });

      // Server A checks for peers - none yet
      let peersA = await sendHeartbeat(serverRegistry, 'ed25519:federation-server-a');
      expect(peersA.peers).toHaveLength(0);

      // Server B starts up and registers
      await registerServer(serverRegistry, {
        serverId: 'ed25519:federation-server-b',
        endpoint: 'wss://fed-b.zajel.io',
        publicKey: 'fed-b-pubkey',
        region: 'eu-west',
      });

      // Server B immediately discovers Server A
      let peersB = await sendHeartbeat(serverRegistry, 'ed25519:federation-server-b');
      expect(peersB.peers).toHaveLength(1);
      expect(peersB.peers[0].serverId).toBe('ed25519:federation-server-a');
      expect(peersB.peers[0].publicKey).toBe('fed-a-pubkey');

      // Server A discovers Server B on next heartbeat
      peersA = await sendHeartbeat(serverRegistry, 'ed25519:federation-server-a');
      expect(peersA.peers).toHaveLength(1);
      expect(peersA.peers[0].serverId).toBe('ed25519:federation-server-b');
    });

    it('should handle network partition recovery (server reconnects)', async () => {
      // Two servers establish federation
      await registerServer(serverRegistry, {
        serverId: 'ed25519:stable-server',
        endpoint: 'wss://stable.zajel.io',
        publicKey: 'stable-key',
        region: 'us-east',
      });

      await registerServer(serverRegistry, {
        serverId: 'ed25519:unstable-server',
        endpoint: 'wss://unstable.zajel.io',
        publicKey: 'unstable-key',
        region: 'eu-west',
      });

      // Both see each other
      let stablePeers = await sendHeartbeat(serverRegistry, 'ed25519:stable-server');
      expect(stablePeers.peers).toHaveLength(1);

      // Unstable server has network partition (stops heartbeating)
      // Stable server keeps heartbeating
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(60 * 1000);
        await sendHeartbeat(serverRegistry, 'ed25519:stable-server');
      }

      // Unstable server is now stale
      stablePeers = await sendHeartbeat(serverRegistry, 'ed25519:stable-server');
      expect(stablePeers.peers).toHaveLength(0);

      // Unstable server recovers and re-registers
      await registerServer(serverRegistry, {
        serverId: 'ed25519:unstable-server',
        endpoint: 'wss://unstable-new.zajel.io', // Maybe new IP
        publicKey: 'unstable-key',
        region: 'eu-west',
      });

      // Federation restored
      stablePeers = await sendHeartbeat(serverRegistry, 'ed25519:stable-server');
      expect(stablePeers.peers).toHaveLength(1);
      expect(stablePeers.peers[0].endpoint).toBe('wss://unstable-new.zajel.io');
    });
  });

  describe('Error Resilience', () => {
    it('should handle malformed JSON gracefully', async () => {
      const request = new Request('https://test.workers.dev/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json',
      });

      const response = await serverRegistry.fetch(request);
      expect(response.status).toBe(500);
    });

    it('should handle empty request body', async () => {
      const request = new Request('https://test.workers.dev/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '',
      });

      const response = await serverRegistry.fetch(request);
      expect(response.status).toBe(500);
    });

    it('should handle null values in registration', async () => {
      const response = await serverRegistry.fetch(
        createRequest('POST', '/servers', {
          serverId: null,
          endpoint: 'wss://test.zajel.io',
          publicKey: 'test-key',
        })
      );

      expect(response.status).toBe(400);
    });

    it('should handle very rapid server churn', async () => {
      // Simulate rapid server churn (servers joining and leaving quickly)
      for (let cycle = 0; cycle < 5; cycle++) {
        // Register batch
        for (let i = 0; i < 10; i++) {
          await registerServer(serverRegistry, {
            serverId: `ed25519:churn-${cycle}-${i}`,
            endpoint: `wss://churn${cycle}${i}.zajel.io`,
            publicKey: `churn-key-${cycle}-${i}`,
          });
        }

        // Unregister some
        for (let i = 0; i < 5; i++) {
          await unregisterServer(serverRegistry, `ed25519:churn-${cycle}-${i}`);
        }

        // Advance time a bit
        vi.advanceTimersByTime(30 * 1000);
      }

      // System should still be operational
      const result = await listServers(serverRegistry);
      expect(result.servers.length).toBeGreaterThan(0);
    });
  });
});
