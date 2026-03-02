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

  async put(key, value) {
    this.data.set(key, value);
  }

  async delete(key) {
    if (Array.isArray(key)) {
      for (const k of key) this.data.delete(k);
    } else {
      this.data.delete(key);
    }
  }

  async list({ prefix, limit }) {
    const results = new Map();
    for (const [key, value] of this.data) {
      if (key.startsWith(prefix)) {
        results.set(key, value);
        if (limit && results.size >= limit) break;
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

describe('Bootstrap Service E2E Tests', () => {
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

    it('should filter out stale servers (lastSeen > 5 minutes)', async () => {
      const serverData = {
        serverId: 'ed25519:stale-server',
        endpoint: 'wss://stale.example.com',
        publicKey: 'stale-key',
        region: 'eu-west',
      };

      await serverRegistry.fetch(createRequest('POST', '/servers', serverData));

      // Advance time by 6 minutes (past 5 minute TTL)
      vi.advanceTimersByTime(6 * 60 * 1000);

      const request = createRequest('GET', '/servers');
      const response = await serverRegistry.fetch(request);
      const data = await response.json();

      expect(data.servers).toHaveLength(0);
    });

    it('should keep servers with lastSeen < 5 minutes', async () => {
      const serverData = {
        serverId: 'ed25519:fresh-server',
        endpoint: 'wss://fresh.example.com',
        publicKey: 'fresh-key',
        region: 'eu-west',
      };

      await serverRegistry.fetch(createRequest('POST', '/servers', serverData));

      // Advance time by 4 minutes (within 5 minute TTL)
      vi.advanceTimersByTime(4 * 60 * 1000);

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

      // Advance time by 2 minutes
      vi.advanceTimersByTime(2 * 60 * 1000);

      // Send heartbeat
      const heartbeatRequest = createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:heartbeat-server',
      });
      const response = await serverRegistry.fetch(heartbeatRequest);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Advance another 4 minutes - should still be fresh because of heartbeat
      vi.advanceTimersByTime(4 * 60 * 1000);

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
});
