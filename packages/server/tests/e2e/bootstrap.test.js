/**
 * Bootstrap Service E2E Tests
 *
 * Tests for the Cloudflare Workers bootstrap service endpoints:
 * - GET /health - Health check
 * - POST /servers - Server registration
 * - GET /servers - Server list (only servers with lastSeen < 5 min)
 * - POST /servers/heartbeat - Server heartbeat (returns peers)
 * - DELETE /servers/:serverId - Server unregistration
 *
 * Uses Miniflare for local CF Workers environment simulation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServerRegistryDO } from '../../src/durable-objects/server-registry-do.js';
import worker from '../../src/index.js';

/**
 * Test helper: generate unique nonces for replay protection
 */
let testNonceCounter = 0;
function testNonce() {
  return `test-nonce-${++testNonceCounter}-${Date.now()}`;
}

/**
 * Mock Durable Object Storage for testing
 */
class MockStorage {
  constructor() {
    this.data = new Map();
    this._alarm = null;
  }

  async get(key) {
    return this.data.get(key);
  }

  async put(keyOrMap, value) {
    if (keyOrMap instanceof Map) {
      for (const [k, v] of keyOrMap) { this.data.set(k, v); }
    } else {
      this.data.set(keyOrMap, value);
    }
  }

  async delete(key) {
    if (Array.isArray(key)) {
      for (const k of key) this.data.delete(k);
    } else {
      this.data.delete(key);
    }
  }

  async list({ prefix, start, limit }) {
    const results = new Map();
    const sortedKeys = [...this.data.keys()].sort();
    for (const key of sortedKeys) {
      if (typeof key !== 'string') continue;
      if (start && key < start) continue;
      if (key.startsWith(prefix) && results.size < (limit || Infinity)) {
        results.set(key, this.data.get(key));
      }
    }
    return results;
  }

  async getAlarm() {
    return this._alarm;
  }

  async setAlarm(time) {
    this._alarm = time;
  }

  clear() {
    this.data.clear();
    this._alarm = null;
  }
}

/**
 * Mock Durable Object State
 */
class MockState {
  constructor() {
    this.storage = new MockStorage();
  }

  blockConcurrencyWhile(fn) {
    return fn();
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
  const emptyStub = {
    fetch: (r) => {
      const url = new URL(r.url);
      if (url.pathname === '/servers/lookup') {
        return Promise.resolve(new Response(JSON.stringify({ found: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify({ servers: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    },
  };
  return {
    SERVER_REGISTRY: {
      idFromName: (name) => name,
      get: (id) => {
        if (id === 'region:default' || id === 'admin') {
          return new MockDurableObjectStub(doInstance);
        }
        return emptyStub;
      },
    },
  };
}

const TEST_BOOTSTRAP_SECRET = 'test-bootstrap-secret';

/**
 * Helper to create a JSON request
 */
function createRequest(method, path, body = null, baseUrl = 'https://test.workers.dev') {
  const url = `${baseUrl}${path}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TEST_BOOTSTRAP_SECRET}`,
      'CF-Connecting-IP': '127.0.0.1',
    },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  return new Request(url, options);
}

describe('Bootstrap Service E2E Tests', () => {
  let mockState;
  let serverRegistry;
  let env;

  beforeEach(() => {
    mockState = new MockState();
    serverRegistry = new ServerRegistryDO(mockState, {
      SERVER_REGISTRY_SECRET: TEST_BOOTSTRAP_SECRET,
      REPLAY_GRACE_MODE: 'true',
    });
    env = createMockEnv(serverRegistry);
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    mockState.storage.clear();
    vi.useRealTimers();
  });

  describe('GET /health', () => {
    it('should return health status with service info', async () => {
      const request = createRequest('GET', '/health');
      const response = await worker.fetch(request, env);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe('ok');
      expect(data.service).toBe('zajel-bootstrap');
      expect(data.timestamp).toBeDefined();
    });

    it('should return CORS headers', async () => {
      const request = createRequest('GET', '/health');
      const response = await worker.fetch(request, env);

      // CORS origin is only set when a matching Origin header is present
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
      expect(response.headers.get('Content-Type')).toBe('application/json');
    });

    it('should handle CORS preflight', async () => {
      const request = createRequest('OPTIONS', '/health');
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    });
  });

  describe('POST /servers - Server Registration', () => {
    it('should register a new server successfully', async () => {
      const serverData = {
        serverId: 'ed25519:test-server-1',
        endpoint: 'wss://test.example.com',
        publicKey: 'base64-public-key-data',
        region: 'eu-west',
      };

      const request = createRequest('POST', '/servers', serverData);
      const response = await serverRegistry.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.server.serverId).toBe(serverData.serverId);
      expect(data.server.endpoint).toBe(serverData.endpoint);
      expect(data.server.publicKey).toBe(serverData.publicKey);
      expect(data.server.region).toBe(serverData.region);
      expect(data.server.registeredAt).toBeDefined();
      expect(data.server.lastSeen).toBeDefined();
    });

    it('should use default region when not provided', async () => {
      const serverData = {
        serverId: 'ed25519:test-server-2',
        endpoint: 'wss://test2.example.com',
        publicKey: 'base64-public-key-data-2',
      };

      const request = createRequest('POST', '/servers', serverData);
      const response = await serverRegistry.fetch(request);
      const data = await response.json();

      expect(data.server.region).toBe('unknown');
    });

    it('should reject registration without serverId', async () => {
      const serverData = {
        endpoint: 'wss://test.example.com',
        publicKey: 'base64-public-key-data',
      };

      const request = createRequest('POST', '/servers', serverData);
      const response = await serverRegistry.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Missing required fields');
    });

    it('should reject registration without endpoint', async () => {
      const serverData = {
        serverId: 'ed25519:test-server',
        publicKey: 'base64-public-key-data',
      };

      const request = createRequest('POST', '/servers', serverData);
      const response = await serverRegistry.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Missing required fields');
    });

    it('should reject registration without publicKey', async () => {
      const serverData = {
        serverId: 'ed25519:test-server',
        endpoint: 'wss://test.example.com',
      };

      const request = createRequest('POST', '/servers', serverData);
      const response = await serverRegistry.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Missing required fields');
    });

    it('should overwrite existing server with same ID', async () => {
      const serverData1 = {
        serverId: 'ed25519:test-server',
        endpoint: 'wss://old.example.com',
        publicKey: 'old-key',
        region: 'us-east',
      };
      const serverData2 = {
        serverId: 'ed25519:test-server',
        endpoint: 'wss://new.example.com',
        publicKey: 'new-key',
        region: 'eu-west',
      };

      await serverRegistry.fetch(createRequest('POST', '/servers', serverData1));
      const response = await serverRegistry.fetch(createRequest('POST', '/servers', serverData2));
      const data = await response.json();

      expect(data.server.endpoint).toBe('wss://new.example.com');
      expect(data.server.publicKey).toBe('new-key');
      expect(data.server.region).toBe('eu-west');
    });
  });

  describe('GET /servers - Server List', () => {
    it('should return empty list when no servers registered', async () => {
      const request = createRequest('GET', '/servers');
      const response = await serverRegistry.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.servers).toEqual([]);
    });

    it('should return registered servers', async () => {
      // Register a server first
      const serverData = {
        serverId: 'ed25519:test-server',
        endpoint: 'wss://test.example.com',
        publicKey: 'base64-public-key-data',
        region: 'eu-west',
      };

      await serverRegistry.fetch(createRequest('POST', '/servers', serverData));

      const request = createRequest('GET', '/servers');
      const response = await serverRegistry.fetch(request);
      const data = await response.json();

      expect(data.servers).toHaveLength(1);
      expect(data.servers[0].serverId).toBe(serverData.serverId);
    });

    it('should return multiple registered servers', async () => {
      const servers = [
        {
          serverId: 'ed25519:server-1',
          endpoint: 'wss://server1.example.com',
          publicKey: 'key-1',
          region: 'us-east',
        },
        {
          serverId: 'ed25519:server-2',
          endpoint: 'wss://server2.example.com',
          publicKey: 'key-2',
          region: 'eu-west',
        },
        {
          serverId: 'ed25519:server-3',
          endpoint: 'wss://server3.example.com',
          publicKey: 'key-3',
          region: 'ap-south',
        },
      ];

      for (const server of servers) {
        await serverRegistry.fetch(createRequest('POST', '/servers', server));
      }

      const request = createRequest('GET', '/servers');
      const response = await serverRegistry.fetch(request);
      const data = await response.json();

      expect(data.servers).toHaveLength(3);
      const serverIds = data.servers.map(s => s.serverId);
      expect(serverIds).toContain('ed25519:server-1');
      expect(serverIds).toContain('ed25519:server-2');
      expect(serverIds).toContain('ed25519:server-3');
    });

    it('should filter out stale servers (lastSeen past TTL)', async () => {
      const serverData = {
        serverId: 'ed25519:stale-server',
        endpoint: 'wss://stale.example.com',
        publicKey: 'stale-key',
        region: 'eu-west',
      };

      await serverRegistry.fetch(createRequest('POST', '/servers', serverData));

      // Advance past the 2-minute heartbeat TTL
      vi.advanceTimersByTime(3 * 60 * 1000);

      const request = createRequest('GET', '/servers');
      const response = await serverRegistry.fetch(request);
      const data = await response.json();

      expect(data.servers).toHaveLength(0);
    });

    it('should keep servers with lastSeen within TTL', async () => {
      const serverData = {
        serverId: 'ed25519:fresh-server',
        endpoint: 'wss://fresh.example.com',
        publicKey: 'fresh-key',
        region: 'eu-west',
      };

      await serverRegistry.fetch(createRequest('POST', '/servers', serverData));

      // Within the 2-minute heartbeat TTL
      vi.advanceTimersByTime(1 * 60 * 1000);

      const request = createRequest('GET', '/servers');
      const response = await serverRegistry.fetch(request);
      const data = await response.json();

      expect(data.servers).toHaveLength(1);
    });

    it('should delete stale servers during listing', async () => {
      const serverData = {
        serverId: 'ed25519:cleanup-server',
        endpoint: 'wss://cleanup.example.com',
        publicKey: 'cleanup-key',
        region: 'eu-west',
      };

      await serverRegistry.fetch(createRequest('POST', '/servers', serverData));

      // Advance time past TTL
      vi.advanceTimersByTime(6 * 60 * 1000);

      // First call should clean up
      await serverRegistry.fetch(createRequest('GET', '/servers'));

      // Verify storage is empty
      const stored = await mockState.storage.get('server:ed25519:cleanup-server');
      expect(stored).toBeUndefined();
    });
  });

  describe('POST /servers/heartbeat - Server Heartbeat', () => {
    it('should update lastSeen timestamp for registered server', async () => {
      const serverData = {
        serverId: 'ed25519:heartbeat-server',
        endpoint: 'wss://heartbeat.example.com',
        publicKey: 'heartbeat-key',
        region: 'eu-west',
      };

      await serverRegistry.fetch(createRequest('POST', '/servers', serverData));

      // Advance 1 minute (within the 2-min TTL)
      vi.advanceTimersByTime(1 * 60 * 1000);

      // Send heartbeat — resets lastSeen
      const heartbeatRequest = createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:heartbeat-server',
      });
      const response = await serverRegistry.fetch(heartbeatRequest);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Advance another 1 minute — should still be fresh thanks to the heartbeat
      vi.advanceTimersByTime(1 * 60 * 1000);

      const listResponse = await serverRegistry.fetch(createRequest('GET', '/servers'));
      const listData = await listResponse.json();

      expect(listData.servers).toHaveLength(1);
    });

    it('should update connections count via heartbeat', async () => {
      const serverData = {
        serverId: 'ed25519:metrics-server',
        endpoint: 'wss://metrics.example.com',
        publicKey: 'metrics-key',
        region: 'eu-west',
      };

      await serverRegistry.fetch(createRequest('POST', '/servers', serverData));

      // Send heartbeat with connections count
      const heartbeatRequest = createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:metrics-server',
        connections: 42,
      });
      const response = await serverRegistry.fetch(heartbeatRequest);
      expect(response.status).toBe(200);

      // Verify connections appears in server list
      const listResponse = await serverRegistry.fetch(createRequest('GET', '/servers'));
      const listData = await listResponse.json();

      expect(listData.servers).toHaveLength(1);
      expect(listData.servers[0].connections).toBe(42);
    });

    it('should include connections from registration in server list', async () => {
      const serverData = {
        serverId: 'ed25519:conn-server',
        endpoint: 'wss://conn.example.com',
        publicKey: 'conn-key',
        region: 'eu-west',
        connections: 10,
      };

      await serverRegistry.fetch(createRequest('POST', '/servers', serverData));

      const listResponse = await serverRegistry.fetch(createRequest('GET', '/servers'));
      const listData = await listResponse.json();

      expect(listData.servers).toHaveLength(1);
      expect(listData.servers[0].connections).toBe(10);
    });

    it('should default connections to 0 when not provided', async () => {
      const serverData = {
        serverId: 'ed25519:no-conn-server',
        endpoint: 'wss://no-conn.example.com',
        publicKey: 'no-conn-key',
        region: 'eu-west',
      };

      await serverRegistry.fetch(createRequest('POST', '/servers', serverData));

      const listResponse = await serverRegistry.fetch(createRequest('GET', '/servers'));
      const listData = await listResponse.json();

      expect(listData.servers).toHaveLength(1);
      expect(listData.servers[0].connections).toBe(0);
    });

    it('should return peers list with heartbeat response', async () => {
      // Register multiple servers
      const servers = [
        {
          serverId: 'ed25519:server-a',
          endpoint: 'wss://a.example.com',
          publicKey: 'key-a',
          region: 'us-east',
        },
        {
          serverId: 'ed25519:server-b',
          endpoint: 'wss://b.example.com',
          publicKey: 'key-b',
          region: 'eu-west',
        },
        {
          serverId: 'ed25519:server-c',
          endpoint: 'wss://c.example.com',
          publicKey: 'key-c',
          region: 'ap-south',
        },
      ];

      for (const server of servers) {
        await serverRegistry.fetch(createRequest('POST', '/servers', server));
      }

      // Send heartbeat from server-a
      const heartbeatRequest = createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:server-a',
      });
      const response = await serverRegistry.fetch(heartbeatRequest);
      const data = await response.json();

      expect(data.peers).toBeDefined();
      expect(data.peers).toHaveLength(2);

      const peerIds = data.peers.map(p => p.serverId);
      expect(peerIds).toContain('ed25519:server-b');
      expect(peerIds).toContain('ed25519:server-c');
      expect(peerIds).not.toContain('ed25519:server-a'); // Should not include self
    });

    it('should return 404 for unregistered server', async () => {
      const heartbeatRequest = createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:nonexistent-server',
      });
      const response = await serverRegistry.fetch(heartbeatRequest);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toBe('Server not registered');
    });

    it('should return 400 when serverId is missing', async () => {
      const heartbeatRequest = createRequest('POST', '/servers/heartbeat', {});
      const response = await serverRegistry.fetch(heartbeatRequest);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Missing serverId');
    });

    it('should exclude stale peers from heartbeat response', async () => {
      // Register two servers
      const serverA = {
        serverId: 'ed25519:server-a',
        endpoint: 'wss://a.example.com',
        publicKey: 'key-a',
        region: 'us-east',
      };
      const serverB = {
        serverId: 'ed25519:server-b',
        endpoint: 'wss://b.example.com',
        publicKey: 'key-b',
        region: 'eu-west',
      };

      await serverRegistry.fetch(createRequest('POST', '/servers', serverA));
      await serverRegistry.fetch(createRequest('POST', '/servers', serverB));

      // Advance time by 6 minutes (server-b becomes stale)
      vi.advanceTimersByTime(6 * 60 * 1000);

      // Server-a sends heartbeat (refreshes its own timestamp)
      const heartbeatRequest = createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:server-a',
      });
      const response = await serverRegistry.fetch(heartbeatRequest);
      const data = await response.json();

      // Server-b should not be in peers list since it's stale
      expect(data.peers).toHaveLength(0);
    });
  });

  describe('DELETE /servers/:serverId - Server Unregistration', () => {
    it('should unregister an existing server', async () => {
      const serverData = {
        serverId: 'ed25519:to-delete',
        endpoint: 'wss://delete.example.com',
        publicKey: 'delete-key',
        region: 'eu-west',
      };

      await serverRegistry.fetch(createRequest('POST', '/servers', serverData));

      const deleteRequest = createRequest('DELETE', '/servers/ed25519:to-delete');
      const response = await serverRegistry.fetch(deleteRequest);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Verify server is removed
      const listResponse = await serverRegistry.fetch(createRequest('GET', '/servers'));
      const listData = await listResponse.json();
      expect(listData.servers).toHaveLength(0);
    });

    it('should succeed even if server does not exist', async () => {
      const deleteRequest = createRequest('DELETE', '/servers/ed25519:nonexistent');
      const response = await serverRegistry.fetch(deleteRequest);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should only remove the specified server', async () => {
      const servers = [
        {
          serverId: 'ed25519:server-1',
          endpoint: 'wss://s1.example.com',
          publicKey: 'key-1',
        },
        {
          serverId: 'ed25519:server-2',
          endpoint: 'wss://s2.example.com',
          publicKey: 'key-2',
        },
      ];

      for (const server of servers) {
        await serverRegistry.fetch(createRequest('POST', '/servers', server));
      }

      // Delete only server-1
      await serverRegistry.fetch(createRequest('DELETE', '/servers/ed25519:server-1'));

      const listResponse = await serverRegistry.fetch(createRequest('GET', '/servers'));
      const listData = await listResponse.json();

      expect(listData.servers).toHaveLength(1);
      expect(listData.servers[0].serverId).toBe('ed25519:server-2');
    });
  });

  describe('API Info and Error Handling', () => {
    it('should return API info at root path', async () => {
      const request = createRequest('GET', '/');
      const response = await worker.fetch(request, env);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.name).toBe('Zajel Bootstrap Server');
      expect(data.version).toBeDefined();
      expect(data.endpoints).toBeDefined();
      expect(data.endpoints.health).toBe('GET /health');
    });

    it('should return API info at /api/info', async () => {
      const request = createRequest('GET', '/api/info');
      const response = await worker.fetch(request, env);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.name).toBe('Zajel Bootstrap Server');
    });

    it('should return 404 for unknown paths', async () => {
      const request = createRequest('GET', '/unknown/path');
      const response = await worker.fetch(request, env);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toBe('Not Found');
    });

    it('should handle CORS preflight for /servers', async () => {
      const request = createRequest('OPTIONS', '/servers');
      const response = await serverRegistry.fetch(request);

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    });
  });

  describe('Edge Cases', () => {
    it('should handle server IDs with allowed special characters (colons, dots, hyphens)', async () => {
      const serverData = {
        serverId: 'ed25519:abc123.def-456',
        endpoint: 'wss://special.example.com',
        publicKey: 'special-key',
      };

      const registerResponse = await serverRegistry.fetch(
        createRequest('POST', '/servers', serverData)
      );
      expect(registerResponse.status).toBe(200);

      const listResponse = await serverRegistry.fetch(createRequest('GET', '/servers'));
      const listData = await listResponse.json();
      expect(listData.servers[0].serverId).toBe(serverData.serverId);
    });

    it('should accept server IDs with base64 characters', async () => {
      const serverData = {
        serverId: 'ed25519:abc123/def+456==',
        endpoint: 'wss://special.example.com',
        publicKey: 'special-key',
      };

      const registerResponse = await serverRegistry.fetch(
        createRequest('POST', '/servers', serverData)
      );
      expect(registerResponse.status).toBe(200);
      const data = await registerResponse.json();
      expect(data.success).toBe(true);
    });

    it('should reject server IDs with invalid characters', async () => {
      const serverData = {
        serverId: 'ed25519:abc 123;def',
        endpoint: 'wss://special.example.com',
        publicKey: 'special-key',
      };

      const registerResponse = await serverRegistry.fetch(
        createRequest('POST', '/servers', serverData)
      );
      expect(registerResponse.status).toBe(400);
      const data = await registerResponse.json();
      expect(data.error).toContain('Invalid serverId');
    });

    it('should handle very long endpoint URLs', async () => {
      const serverData = {
        serverId: 'ed25519:long-url-server',
        endpoint: 'wss://' + 'a'.repeat(500) + '.example.com',
        publicKey: 'long-url-key',
      };

      const response = await serverRegistry.fetch(
        createRequest('POST', '/servers', serverData)
      );
      expect(response.status).toBe(200);
    });

    it('should handle rapid registration and unregistration', async () => {
      for (let i = 0; i < 10; i++) {
        const serverData = {
          serverId: `ed25519:rapid-server-${i}`,
          endpoint: `wss://rapid${i}.example.com`,
          publicKey: `rapid-key-${i}`,
        };

        await serverRegistry.fetch(createRequest('POST', '/servers', serverData));
        await serverRegistry.fetch(createRequest('DELETE', `/servers/ed25519:rapid-server-${i}`));
      }

      const listResponse = await serverRegistry.fetch(createRequest('GET', '/servers'));
      const listData = await listResponse.json();
      expect(listData.servers).toHaveLength(0);
    });

    it('should handle concurrent heartbeats', async () => {
      const servers = Array.from({ length: 5 }, (_, i) => ({
        serverId: `ed25519:concurrent-${i}`,
        endpoint: `wss://concurrent${i}.example.com`,
        publicKey: `concurrent-key-${i}`,
      }));

      // Register all servers
      await Promise.all(
        servers.map(s => serverRegistry.fetch(createRequest('POST', '/servers', s)))
      );

      // Send concurrent heartbeats
      const heartbeatResponses = await Promise.all(
        servers.map(s =>
          serverRegistry.fetch(
            createRequest('POST', '/servers/heartbeat', { serverId: s.serverId })
          )
        )
      );

      // All should succeed
      for (const response of heartbeatResponses) {
        expect(response.status).toBe(200);
      }
    });
  });


  describe('Heartbeat Replay Protection', () => {
    /**
     * Helper to register a test server with a strict (non-grace) registry.
     * Returns the registry instance.
     */
    async function registerOnStrict(strictRegistry) {
      const regData = {
        serverId: 'ed25519:replay-test-server',
        endpoint: 'wss://replay.example.com',
        publicKey: 'replay-test-key',
        timestamp: Date.now(),
        nonce: testNonce(),
      };
      const resp = await strictRegistry.fetch(createRequest('POST', '/servers', regData));
      expect(resp.status).toBe(200);
      return strictRegistry;
    }

    it('should accept heartbeat with timestamp at 2-minute boundary', async () => {
      const strictState = new MockState();
      const strictRegistry = new ServerRegistryDO(strictState, { SERVER_REGISTRY_SECRET: TEST_BOOTSTRAP_SECRET });
      await registerOnStrict(strictRegistry);

      // Set timestamp slightly under 2 minutes ago (within window, with buffer for processing time)
      const ts = Date.now() - (2 * 60 * 1000 - 1000);
      const resp = await strictRegistry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:replay-test-server',
        timestamp: ts,
        nonce: testNonce(),
        sequenceNumber: 1,
      }));
      expect(resp.status).toBe(200);
    });

    it('should reject heartbeat with timestamp older than 2 minutes', async () => {
      const strictState = new MockState();
      const strictRegistry = new ServerRegistryDO(strictState, { SERVER_REGISTRY_SECRET: TEST_BOOTSTRAP_SECRET });
      await registerOnStrict(strictRegistry);

      // Set timestamp 2 minutes + 1 second ago
      const ts = Date.now() - (2 * 60 * 1000 + 1000);
      const resp = await strictRegistry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:replay-test-server',
        timestamp: ts,
        nonce: testNonce(),
        sequenceNumber: 1,
      }));
      const data = await resp.json();
      expect(resp.status).toBe(400);
      expect(data.error).toContain('timestamp too old');
    });

    it('should accept heartbeat with timestamp 30 seconds in future', async () => {
      const strictState = new MockState();
      const strictRegistry = new ServerRegistryDO(strictState, { SERVER_REGISTRY_SECRET: TEST_BOOTSTRAP_SECRET });
      await registerOnStrict(strictRegistry);

      // Slightly under 30 seconds in the future to allow for processing time
      const ts = Date.now() + (29 * 1000);
      const resp = await strictRegistry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:replay-test-server',
        timestamp: ts,
        nonce: testNonce(),
        sequenceNumber: 1,
      }));
      expect(resp.status).toBe(200);
    });

    it('should reject heartbeat with timestamp more than 30 seconds in future', async () => {
      const strictState = new MockState();
      const strictRegistry = new ServerRegistryDO(strictState, { SERVER_REGISTRY_SECRET: TEST_BOOTSTRAP_SECRET });
      await registerOnStrict(strictRegistry);

      const ts = Date.now() + (31 * 1000);
      const resp = await strictRegistry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:replay-test-server',
        timestamp: ts,
        nonce: testNonce(),
        sequenceNumber: 1,
      }));
      const data = await resp.json();
      expect(resp.status).toBe(400);
      expect(data.error).toContain('timestamp too far in future');
    });

    it('should reject heartbeat with duplicate nonce', async () => {
      const strictState = new MockState();
      const strictRegistry = new ServerRegistryDO(strictState, { SERVER_REGISTRY_SECRET: TEST_BOOTSTRAP_SECRET });
      await registerOnStrict(strictRegistry);

      const sharedNonce = testNonce();
      // First heartbeat with nonce - should succeed
      const resp1 = await strictRegistry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:replay-test-server',
        timestamp: Date.now(),
        nonce: sharedNonce,
        sequenceNumber: 1,
      }));
      expect(resp1.status).toBe(200);

      // Second heartbeat with same nonce - should be rejected
      const resp2 = await strictRegistry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:replay-test-server',
        timestamp: Date.now(),
        nonce: sharedNonce,
        sequenceNumber: 2,
      }));
      const data = await resp2.json();
      expect(resp2.status).toBe(409);
      expect(data.error).toContain('duplicate nonce');
    });

    it('should accept heartbeats with different nonces', async () => {
      const strictState = new MockState();
      const strictRegistry = new ServerRegistryDO(strictState, { SERVER_REGISTRY_SECRET: TEST_BOOTSTRAP_SECRET });
      await registerOnStrict(strictRegistry);

      const resp1 = await strictRegistry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:replay-test-server',
        timestamp: Date.now(),
        nonce: testNonce(),
        sequenceNumber: 1,
      }));
      expect(resp1.status).toBe(200);

      // Advance past 30s min heartbeat interval
      vi.advanceTimersByTime(31000);

      const resp2 = await strictRegistry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:replay-test-server',
        timestamp: Date.now(),
        nonce: testNonce(),
        sequenceNumber: 2,
      }));
      expect(resp2.status).toBe(200);
    });

    it('should enforce monotonic sequence numbers', async () => {
      const strictState = new MockState();
      const strictRegistry = new ServerRegistryDO(strictState, { SERVER_REGISTRY_SECRET: TEST_BOOTSTRAP_SECRET });
      await registerOnStrict(strictRegistry);

      // Sequence 1
      const resp1 = await strictRegistry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:replay-test-server',
        timestamp: Date.now(),
        nonce: testNonce(),
        sequenceNumber: 1,
      }));
      expect(resp1.status).toBe(200);

      // Advance past 30s min heartbeat interval
      vi.advanceTimersByTime(31000);

      // Sequence 5 (jump allowed)
      const resp2 = await strictRegistry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:replay-test-server',
        timestamp: Date.now(),
        nonce: testNonce(),
        sequenceNumber: 5,
      }));
      expect(resp2.status).toBe(200);

      // Advance time to reset per-serverId heartbeat rate limit window
      vi.advanceTimersByTime(61000);

      // Sequence 3 (less than 5 - rejected)
      const resp3 = await strictRegistry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:replay-test-server',
        timestamp: Date.now(),
        nonce: testNonce(),
        sequenceNumber: 3,
      }));
      const data = await resp3.json();
      expect(resp3.status).toBe(409);
      expect(data.error).toContain('sequence number');
    });

    it('should reject equal sequence numbers', async () => {
      const strictState = new MockState();
      const strictRegistry = new ServerRegistryDO(strictState, { SERVER_REGISTRY_SECRET: TEST_BOOTSTRAP_SECRET });
      await registerOnStrict(strictRegistry);

      const resp1 = await strictRegistry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:replay-test-server',
        timestamp: Date.now(),
        nonce: testNonce(),
        sequenceNumber: 10,
      }));
      expect(resp1.status).toBe(200);

      // Advance past 30s min heartbeat interval so the rate limiter doesn't block this
      vi.advanceTimersByTime(31000);

      const resp2 = await strictRegistry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:replay-test-server',
        timestamp: Date.now(),
        nonce: testNonce(),
        sequenceNumber: 10,
      }));
      const data = await resp2.json();
      expect(resp2.status).toBe(409);
      expect(data.error).toContain('sequence number');
    });

    it('should reject heartbeat without timestamp field', async () => {
      const strictState = new MockState();
      const strictRegistry = new ServerRegistryDO(strictState, { SERVER_REGISTRY_SECRET: TEST_BOOTSTRAP_SECRET });
      await registerOnStrict(strictRegistry);

      const resp = await strictRegistry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:replay-test-server',
        nonce: testNonce(),
        sequenceNumber: 1,
      }));
      const data = await resp.json();
      expect(resp.status).toBe(400);
      expect(data.error).toContain('Missing or invalid timestamp');
    });

    it('should reject heartbeat with non-numeric timestamp', async () => {
      const strictState = new MockState();
      const strictRegistry = new ServerRegistryDO(strictState, { SERVER_REGISTRY_SECRET: TEST_BOOTSTRAP_SECRET });
      await registerOnStrict(strictRegistry);

      const resp = await strictRegistry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:replay-test-server',
        timestamp: 'not-a-number',
        nonce: testNonce(),
        sequenceNumber: 1,
      }));
      const data = await resp.json();
      expect(resp.status).toBe(400);
      expect(data.error).toContain('Missing or invalid timestamp');
    });

    it('should reject heartbeat without nonce field', async () => {
      const strictState = new MockState();
      const strictRegistry = new ServerRegistryDO(strictState, { SERVER_REGISTRY_SECRET: TEST_BOOTSTRAP_SECRET });
      await registerOnStrict(strictRegistry);

      const resp = await strictRegistry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:replay-test-server',
        timestamp: Date.now(),
        sequenceNumber: 1,
      }));
      const data = await resp.json();
      expect(resp.status).toBe(400);
      expect(data.error).toContain('Missing or invalid nonce');
    });

    it('should reject heartbeat with short nonce', async () => {
      const strictState = new MockState();
      const strictRegistry = new ServerRegistryDO(strictState, { SERVER_REGISTRY_SECRET: TEST_BOOTSTRAP_SECRET });
      await registerOnStrict(strictRegistry);

      const resp = await strictRegistry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:replay-test-server',
        timestamp: Date.now(),
        nonce: 'short',
        sequenceNumber: 1,
      }));
      const data = await resp.json();
      expect(resp.status).toBe(400);
      expect(data.error).toContain('Missing or invalid nonce');
    });

    it('should reject registration with duplicate nonce (replay)', async () => {
      const strictState = new MockState();
      const strictRegistry = new ServerRegistryDO(strictState, { SERVER_REGISTRY_SECRET: TEST_BOOTSTRAP_SECRET });

      const sharedNonce = testNonce();
      const regData = {
        serverId: 'ed25519:replay-reg-server',
        endpoint: 'wss://replay-reg.example.com',
        publicKey: 'replay-reg-key',
        timestamp: Date.now(),
        nonce: sharedNonce,
      };

      // First registration
      const resp1 = await strictRegistry.fetch(createRequest('POST', '/servers', regData));
      expect(resp1.status).toBe(200);

      // Replay same registration
      const resp2 = await strictRegistry.fetch(createRequest('POST', '/servers', {
        ...regData,
        timestamp: Date.now(),
      }));
      const data = await resp2.json();
      expect(resp2.status).toBe(409);
      expect(data.error).toContain('duplicate nonce');
    });

    it('should not store nonce for non-existent server heartbeat', async () => {
      const strictState = new MockState();
      const strictRegistry = new ServerRegistryDO(strictState, { SERVER_REGISTRY_SECRET: TEST_BOOTSTRAP_SECRET });

      const nonceValue = testNonce();
      const resp = await strictRegistry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:nonexistent-server',
        timestamp: Date.now(),
        nonce: nonceValue,
        sequenceNumber: 1,
      }));
      expect(resp.status).toBe(404);

      // Nonce should NOT have been persisted (storage pollution prevention)
      // The nonce key is scoped per serverId
      const storedNonce = await strictState.storage.get('nonce:ed25519:nonexistent-server:' + nonceValue);
      expect(storedNonce).toBeUndefined();
    });

    it('should reset lastSequenceNumber on re-registration', async () => {
      const strictState = new MockState();
      const strictRegistry = new ServerRegistryDO(strictState, { SERVER_REGISTRY_SECRET: TEST_BOOTSTRAP_SECRET });

      // Register
      await strictRegistry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:seq-reset-server',
        endpoint: 'wss://seq-reset.example.com',
        publicKey: 'seq-reset-key',
        timestamp: Date.now(),
        nonce: testNonce(),
      }));

      // Send heartbeat with high sequence
      await strictRegistry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:seq-reset-server',
        timestamp: Date.now(),
        nonce: testNonce(),
        sequenceNumber: 100,
      }));

      // Re-register (simulates VPS restart) - also resets heartbeat rate limit
      await strictRegistry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:seq-reset-server',
        endpoint: 'wss://seq-reset.example.com',
        publicKey: 'seq-reset-key-new',
        timestamp: Date.now(),
        nonce: testNonce(),
      }));

      // Advance past 30s min heartbeat interval
      vi.advanceTimersByTime(31000);

      // Heartbeat with sequence 1 should now work (was reset)
      const resp = await strictRegistry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:seq-reset-server',
        timestamp: Date.now(),
        nonce: testNonce(),
        sequenceNumber: 1,
      }));
      expect(resp.status).toBe(200);
    });

    it('should clean up expired nonces via alarm', async () => {
      const strictState = new MockState();
      const strictRegistry = new ServerRegistryDO(strictState, { SERVER_REGISTRY_SECRET: TEST_BOOTSTRAP_SECRET });

      // Register with a known nonce
      const knownNonce = testNonce();
      await strictRegistry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:nonce-expiry-server',
        endpoint: 'wss://nonce-expiry.example.com',
        publicKey: 'nonce-expiry-key',
        timestamp: Date.now(),
        nonce: knownNonce,
      }));

      // Verify nonce is stored
      const storedNonce = await strictState.storage.get('nonce:' + knownNonce);
      expect(storedNonce).toBeDefined();

      // Advance time by 6 minutes (past 5 minute expiry)
      vi.advanceTimersByTime(6 * 60 * 1000);

      // Trigger alarm cleanup
      await strictRegistry.alarm();

      // Nonce should be cleaned up
      const expiredNonce = await strictState.storage.get('nonce:' + knownNonce);
      expect(expiredNonce).toBeUndefined();
    });

    it('should preserve fresh nonces during alarm cleanup', async () => {
      const strictState = new MockState();
      const strictRegistry = new ServerRegistryDO(strictState, { SERVER_REGISTRY_SECRET: TEST_BOOTSTRAP_SECRET });

      // Register with a known nonce
      const knownNonce = testNonce();
      await strictRegistry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:fresh-nonce-server',
        endpoint: 'wss://fresh-nonce.example.com',
        publicKey: 'fresh-nonce-key',
        timestamp: Date.now(),
        nonce: knownNonce,
      }));

      // Advance time by only 4 minutes (within 5 minute window)
      vi.advanceTimersByTime(4 * 60 * 1000);

      // Trigger alarm cleanup
      await strictRegistry.alarm();

      // Nonce should still exist
      const freshNonce = await strictState.storage.get('nonce:' + knownNonce);
      expect(freshNonce).toBeDefined();
    });
  });

  describe('Grace Period / Migration', () => {
    it('should accept heartbeats without replay fields when REPLAY_GRACE_MODE=true', async () => {
      // The default serverRegistry has REPLAY_GRACE_MODE: 'true'
      const regData = {
        serverId: 'ed25519:grace-test-server',
        endpoint: 'wss://grace.example.com',
        publicKey: 'grace-key',
      };
      await serverRegistry.fetch(createRequest('POST', '/servers', regData));

      // Heartbeat without timestamp/nonce/sequenceNumber
      const resp = await serverRegistry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:grace-test-server',
      }));
      expect(resp.status).toBe(200);
    });

    it('should reject heartbeats without replay fields when REPLAY_GRACE_MODE is not set', async () => {
      const strictState = new MockState();
      const strictRegistry = new ServerRegistryDO(strictState, { SERVER_REGISTRY_SECRET: TEST_BOOTSTRAP_SECRET });

      // Register with replay fields
      await strictRegistry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:strict-test-server',
        endpoint: 'wss://strict.example.com',
        publicKey: 'strict-key',
        timestamp: Date.now(),
        nonce: testNonce(),
      }));

      // Heartbeat WITHOUT replay fields should be rejected
      const resp = await strictRegistry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:strict-test-server',
      }));
      const data = await resp.json();
      expect(resp.status).toBe(400);
      expect(data.error).toContain('Missing or invalid timestamp');
    });

    it('should accept registrations without replay fields when REPLAY_GRACE_MODE=true', async () => {
      // The default serverRegistry has REPLAY_GRACE_MODE: 'true'
      const resp = await serverRegistry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:grace-reg-server',
        endpoint: 'wss://grace-reg.example.com',
        publicKey: 'grace-reg-key',
      }));
      expect(resp.status).toBe(200);
    });

    it('should reject registrations without replay fields when REPLAY_GRACE_MODE is not set', async () => {
      const strictState = new MockState();
      const strictRegistry = new ServerRegistryDO(strictState, { SERVER_REGISTRY_SECRET: TEST_BOOTSTRAP_SECRET });

      const resp = await strictRegistry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:strict-reg-server',
        endpoint: 'wss://strict-reg.example.com',
        publicKey: 'strict-reg-key',
      }));
      const data = await resp.json();
      expect(resp.status).toBe(400);
      expect(data.error).toContain('Missing or invalid timestamp');
    });
  });

  describe('Per-serverId Heartbeat Rate Limiting', () => {
    it('should enforce minimum 30s interval between heartbeats', async () => {
      const server1 = {
        serverId: 'ed25519:rl-server-1',
        endpoint: 'wss://rl1.example.com',
        publicKey: 'rl-key-1',
      };

      await serverRegistry.fetch(createRequest('POST', '/servers', server1));

      // First heartbeat: allowed
      const hb1 = await serverRegistry.fetch(
        createRequest('POST', '/servers/heartbeat', { serverId: server1.serverId })
      );
      expect(hb1.status).toBe(200);

      // Immediate second heartbeat: rejected (< 30s interval)
      const hb2 = await serverRegistry.fetch(
        createRequest('POST', '/servers/heartbeat', { serverId: server1.serverId })
      );
      expect(hb2.status).toBe(429);
      const data = await hb2.json();
      expect(data.error).toContain('min 30s interval');
      expect(hb2.headers.get('Retry-After')).toBeTruthy();
    });

    it('should rate limit 3rd heartbeat within 1 minute (max 2/min)', async () => {
      const server1 = {
        serverId: 'ed25519:rl-server-3min',
        endpoint: 'wss://rl3.example.com',
        publicKey: 'rl-key-3',
      };

      await serverRegistry.fetch(createRequest('POST', '/servers', server1));

      // First heartbeat
      const hb1 = await serverRegistry.fetch(
        createRequest('POST', '/servers/heartbeat', { serverId: server1.serverId })
      );
      expect(hb1.status).toBe(200);

      // Advance 31s, second heartbeat
      vi.advanceTimersByTime(31000);
      const hb2 = await serverRegistry.fetch(
        createRequest('POST', '/servers/heartbeat', { serverId: server1.serverId })
      );
      expect(hb2.status).toBe(200);

      // Simulate that we're still within the window but past the 30s interval
      // by directly setting the rate limit entry (count=2, lastRequest 31s ago,
      // but window still active)
      const hbKey = 'heartbeat-rl:ed25519:rl-server-3min';
      const entry = await mockState.storage.get(hbKey);
      await mockState.storage.put(hbKey, {
        count: entry.count,
        windowStart: entry.windowStart,
        lastRequestAt: Date.now() - 31000, // 31s ago (past min interval)
      });

      // Third heartbeat: rate limited (count >= 2 within window)
      const hb3 = await serverRegistry.fetch(
        createRequest('POST', '/servers/heartbeat', { serverId: server1.serverId })
      );
      expect(hb3.status).toBe(429);
      const data = await hb3.json();
      expect(data.error).toContain('Heartbeat rate limit exceeded');
    });

    it('should have independent heartbeat limits per serverId', async () => {
      const server1 = {
        serverId: 'ed25519:indep-server-1',
        endpoint: 'wss://indep1.example.com',
        publicKey: 'indep-key-1',
      };
      const server2 = {
        serverId: 'ed25519:indep-server-2',
        endpoint: 'wss://indep2.example.com',
        publicKey: 'indep-key-2',
      };

      await serverRegistry.fetch(createRequest('POST', '/servers', server1));
      await serverRegistry.fetch(createRequest('POST', '/servers', server2));

      // Server1: first heartbeat
      const hb1_1 = await serverRegistry.fetch(
        createRequest('POST', '/servers/heartbeat', { serverId: server1.serverId })
      );
      expect(hb1_1.status).toBe(200);

      // Server1: immediate second is rate limited (< 30s)
      const hb1_2 = await serverRegistry.fetch(
        createRequest('POST', '/servers/heartbeat', { serverId: server1.serverId })
      );
      expect(hb1_2.status).toBe(429);

      // Server2 first heartbeat: should succeed (independent limit)
      const hb2_1 = await serverRegistry.fetch(
        createRequest('POST', '/servers/heartbeat', { serverId: server2.serverId })
      );
      expect(hb2_1.status).toBe(200);
    });

    it('should reset heartbeat rate limit after 1 minute', async () => {
      const serverData = {
        serverId: 'ed25519:reset-test',
        endpoint: 'wss://reset.example.com',
        publicKey: 'reset-key',
      };

      await serverRegistry.fetch(createRequest('POST', '/servers', serverData));

      // Send first heartbeat
      await serverRegistry.fetch(
        createRequest('POST', '/servers/heartbeat', { serverId: serverData.serverId })
      );

      // Advance 31s, send second heartbeat
      vi.advanceTimersByTime(31000);
      await serverRegistry.fetch(
        createRequest('POST', '/servers/heartbeat', { serverId: serverData.serverId })
      );

      // Simulate rate limit hit by setting count to 2 within a recent window
      // and lastRequestAt > 30s ago (so the 30s interval check passes)
      const hbKey = `heartbeat-rl:${serverData.serverId}`;
      const entry = await mockState.storage.get(hbKey);
      await mockState.storage.put(hbKey, {
        count: entry.count,
        windowStart: entry.windowStart,
        lastRequestAt: Date.now() - 31000,
      });

      // Third heartbeat: rate limited (count >= 2 within window)
      const hb3 = await serverRegistry.fetch(
        createRequest('POST', '/servers/heartbeat', { serverId: serverData.serverId })
      );
      expect(hb3.status).toBe(429);

      // Advance enough time to pass the 60s window entirely
      vi.advanceTimersByTime(61000);

      // Should now succeed (new window)
      const hb4 = await serverRegistry.fetch(
        createRequest('POST', '/servers/heartbeat', { serverId: serverData.serverId })
      );
      expect(hb4.status).toBe(200);
    });

    it('should clean up rate limit counters when server expires', async () => {
      const serverData = {
        serverId: 'ed25519:cleanup-test',
        endpoint: 'wss://cleanup.example.com',
        publicKey: 'cleanup-key',
      };

      await serverRegistry.fetch(createRequest('POST', '/servers', serverData));

      // Send heartbeat to create rate limit entry
      await serverRegistry.fetch(
        createRequest('POST', '/servers/heartbeat', { serverId: serverData.serverId })
      );

      // Verify rate limit entry exists in storage
      const rlKey = `heartbeat-rl:${serverData.serverId}`;
      const rlEntry = await mockState.storage.get(rlKey);
      expect(rlEntry).toBeTruthy();

      // Advance time past server TTL (5 minutes)
      vi.advanceTimersByTime(6 * 60 * 1000);

      // Trigger cleanup (call alarm handler)
      await serverRegistry.alarm();

      // Verify rate limit entry was cleaned up
      const rlEntryAfter = await mockState.storage.get(rlKey);
      expect(rlEntryAfter).toBeUndefined();
    });
  });

  describe('Security Headers', () => {
    it('should include Referrer-Policy on health check response', async () => {
      const request = createRequest('GET', '/health');
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    });

    it('should include Content-Security-Policy on API responses', async () => {
      const request = createRequest('GET', '/health');
      const response = await worker.fetch(request, env);

      expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'");
    });

    it('should include Permissions-Policy on API responses', async () => {
      const request = createRequest('GET', '/health');
      const response = await worker.fetch(request, env);

      const permissionsPolicy = response.headers.get('Permissions-Policy');
      expect(permissionsPolicy).toBeTruthy();
      expect(permissionsPolicy).toContain('camera=()');
      expect(permissionsPolicy).toContain('microphone=()');
      expect(permissionsPolicy).toContain('geolocation=()');
      expect(permissionsPolicy).toContain('payment=()');
    });

    it('should include X-Content-Type-Options on API responses', async () => {
      const request = createRequest('GET', '/health');
      const response = await worker.fetch(request, env);

      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    });

    it('should include X-Frame-Options on API responses', async () => {
      const request = createRequest('GET', '/health');
      const response = await worker.fetch(request, env);

      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    });

    it('should include Strict-Transport-Security on API responses', async () => {
      const request = createRequest('GET', '/health');
      const response = await worker.fetch(request, env);

      expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
      expect(response.headers.get('Strict-Transport-Security')).toContain('includeSubDomains');
    });

    it('should include Cache-Control no-store on API responses', async () => {
      const request = createRequest('GET', '/health');
      const response = await worker.fetch(request, env);

      expect(response.headers.get('Cache-Control')).toBe('no-store');
    });

    it('should include all security headers on CORS preflight response', async () => {
      const request = new Request('https://test.workers.dev/servers', {
        method: 'OPTIONS',
        headers: {
          'Origin': 'https://zajel.hamzalabs.dev',
          'Access-Control-Request-Method': 'POST',
          'CF-Connecting-IP': '127.0.0.1',
        },
      });
      const response = await worker.fetch(request, env);

      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
      expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'");
      expect(response.headers.get('Permissions-Policy')).toContain('camera=()');
    });

    it('should include all security headers on server registration response', async () => {
      const serverData = {
        serverId: 'ed25519:test-server-headers',
        endpoint: 'wss://test-headers.example.com',
        publicKey: 'base64-public-key-data',
        region: 'us-east',
        nonce: testNonce(),
      };

      const request = createRequest('POST', '/servers', serverData);
      const response = await worker.fetch(request, env);

      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'");
      expect(response.headers.get('Permissions-Policy')).toBeTruthy();
    });

    it('should include all security headers on GET /servers response', async () => {
      const request = createRequest('GET', '/servers');
      const response = await worker.fetch(request, env);

      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'");
      expect(response.headers.get('Permissions-Policy')).toBeTruthy();
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    });

    it('should include all security headers on 404 response', async () => {
      const request = createRequest('GET', '/nonexistent');
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(404);
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
      expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'");
      expect(response.headers.get('Permissions-Policy')).toBeTruthy();
    });

    it('should include all security headers on rate-limited response', async () => {
      // Create requests with unique IPs to avoid affecting other tests
      const rateLimitIp = '10.99.99.99';

      // Exhaust the rate limit (read tier: 200/min)
      // Use admin tier which has lower limit (10/min)
      for (let i = 0; i <= 10; i++) {
        const request = new Request('https://test.workers.dev/servers/trusted-keys', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': rateLimitIp,
          },
          body: JSON.stringify({}),
        });
        await worker.fetch(request, env);
      }

      // Next request should be rate-limited
      const request = new Request('https://test.workers.dev/servers/trusted-keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': rateLimitIp,
        },
        body: JSON.stringify({}),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(429);
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
      expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'");
    });
  });
});
