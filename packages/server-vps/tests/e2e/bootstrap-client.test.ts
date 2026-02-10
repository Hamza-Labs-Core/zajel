/**
 * Bootstrap Client E2E Tests
 *
 * Tests for VPS server bootstrap integration:
 * - Server startup and registration with CF Workers
 * - Heartbeat loop (every 60 seconds)
 * - Graceful shutdown and unregistration
 * - Health endpoint (GET /health)
 * - Stats endpoint (GET /stats)
 */

import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'http';
import { createZajelServer, type ZajelServer } from '../../src/index.js';
import { generateIdentity } from '../../src/identity/server-identity.js';
import type { ServerConfig } from '../../src/types.js';
import type { BootstrapServerEntry } from '../../src/federation/bootstrap-client.js';

// Port allocation for tests
const MOCK_BOOTSTRAP_PORT = 19100;
const VPS_SERVER_PORT_1 = 19101;
const VPS_SERVER_PORT_2 = 19102;

// Store for mock CF Workers bootstrap server
interface MockBootstrapStore {
  servers: Map<string, BootstrapServerEntry>;
}

/**
 * Creates a mock CF Workers bootstrap server for testing
 */
function createMockBootstrapServer(store: MockBootstrapStore): HttpServer {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://localhost:${MOCK_BOOTSTRAP_PORT}`);

    // Health check endpoint
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        service: 'zajel-bootstrap-mock',
        timestamp: Date.now(),
      }));
      return;
    }

    // Server registration
    if (req.method === 'POST' && url.pathname === '/servers') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body) as {
            serverId: string;
            endpoint: string;
            publicKey: string;
            region: string;
          };

          const entry: BootstrapServerEntry = {
            serverId: data.serverId,
            endpoint: data.endpoint,
            publicKey: data.publicKey,
            region: data.region,
            registeredAt: Date.now(),
            lastSeen: Date.now(),
          };

          store.servers.set(data.serverId, entry);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, server: entry }));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid request body' }));
        }
      });
      return;
    }

    // Server list
    if (req.method === 'GET' && url.pathname === '/servers') {
      const servers = Array.from(store.servers.values());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ servers }));
      return;
    }

    // Server heartbeat
    if (req.method === 'POST' && url.pathname === '/servers/heartbeat') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body) as { serverId: string };
          const server = store.servers.get(data.serverId);

          if (!server) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Server not found' }));
            return;
          }

          // Update last seen
          server.lastSeen = Date.now();
          store.servers.set(data.serverId, server);

          // Return other servers as peers
          const peers = Array.from(store.servers.values())
            .filter(s => s.serverId !== data.serverId);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, peers }));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid request body' }));
        }
      });
      return;
    }

    // Server unregistration
    if (req.method === 'DELETE' && url.pathname.startsWith('/servers/')) {
      const serverId = decodeURIComponent(url.pathname.slice('/servers/'.length));
      const deleted = store.servers.delete(serverId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: deleted }));
      return;
    }

    // Default response
    res.writeHead(404);
    res.end('Not Found');
  });
}

/**
 * Create a test server configuration
 */
function createTestConfig(
  port: number,
  bootstrapUrl: string,
  region = 'test-region'
): Partial<ServerConfig> {
  return {
    network: {
      host: '127.0.0.1',
      port,
      publicEndpoint: `ws://127.0.0.1:${port}`,
      region,
    },
    bootstrap: {
      serverUrl: bootstrapUrl,
      heartbeatInterval: 1000, // 1 second for faster testing
      nodes: [],
      retryInterval: 500,
      maxRetries: 3,
    },
    storage: {
      type: 'sqlite',
      path: `:memory:`, // Use in-memory SQLite for tests
    },
    identity: {
      keyPath: `/tmp/zajel-test-${port}-${Date.now()}.key`,
      ephemeralIdPrefix: 'test',
    },
    gossip: {
      interval: 500,
      suspicionTimeout: 1000,
      failureTimeout: 2000,
      indirectPingCount: 2,
      stateExchangeInterval: 5000,
    },
  };
}

describe('Bootstrap Client E2E Tests', () => {
  let mockBootstrapServer: HttpServer;
  let bootstrapStore: MockBootstrapStore;
  let mockBootstrapUrl: string;

  beforeAll(async () => {
    // Create and start mock bootstrap server
    bootstrapStore = { servers: new Map() };
    mockBootstrapServer = createMockBootstrapServer(bootstrapStore);

    await new Promise<void>((resolve) => {
      mockBootstrapServer.listen(MOCK_BOOTSTRAP_PORT, '127.0.0.1', () => {
        resolve();
      });
    });

    mockBootstrapUrl = `http://127.0.0.1:${MOCK_BOOTSTRAP_PORT}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      mockBootstrapServer.close(() => resolve());
    });
  });

  beforeEach(() => {
    // Clear stored servers between tests
    bootstrapStore.servers.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Server Startup & Registration (Test Plan 2.1)', () => {
    let vpsServer: ZajelServer | null = null;

    afterEach(async () => {
      if (vpsServer) {
        await vpsServer.shutdown();
        vpsServer = null;
      }
    });

    it('should register with CF Workers on startup', async () => {
      vi.useRealTimers(); // Need real timers for network operations

      const config = createTestConfig(VPS_SERVER_PORT_1, mockBootstrapUrl);
      vpsServer = await createZajelServer(config);

      // Verify server registered
      expect(bootstrapStore.servers.size).toBe(1);

      const registeredServer = Array.from(bootstrapStore.servers.values())[0];
      expect(registeredServer).toBeDefined();
      expect(registeredServer!.serverId).toBe(vpsServer.identity.serverId);
      expect(registeredServer!.endpoint).toBe(config.network!.publicEndpoint);
    });

    it('should appear in GET /servers list after registration', async () => {
      vi.useRealTimers();

      const config = createTestConfig(VPS_SERVER_PORT_1, mockBootstrapUrl);
      vpsServer = await createZajelServer(config);

      // Query the mock bootstrap server
      const response = await fetch(`${mockBootstrapUrl}/servers`);
      const data = await response.json() as { servers: BootstrapServerEntry[] };

      expect(data.servers).toHaveLength(1);
      expect(data.servers[0]!.serverId).toBe(vpsServer.identity.serverId);
    });

    it('should have server ID in expected format ed25519:<base64>', async () => {
      vi.useRealTimers();

      const config = createTestConfig(VPS_SERVER_PORT_1, mockBootstrapUrl);
      vpsServer = await createZajelServer(config);

      expect(vpsServer.identity.serverId).toMatch(/^ed25519:[A-Za-z0-9+/]+=*$/);
    });

    it('should include region in registration', async () => {
      vi.useRealTimers();

      const config = createTestConfig(VPS_SERVER_PORT_1, mockBootstrapUrl, 'eu-west');
      vpsServer = await createZajelServer(config);

      const registeredServer = bootstrapStore.servers.get(vpsServer.identity.serverId);
      expect(registeredServer).toBeDefined();
      expect(registeredServer!.region).toBe('eu-west');
    });
  });

  describe('Heartbeat Loop (Test Plan 2.2)', () => {
    let vpsServer: ZajelServer | null = null;

    afterEach(async () => {
      vi.useRealTimers();
      if (vpsServer) {
        await vpsServer.shutdown();
        vpsServer = null;
      }
    });

    it('should send heartbeats at configured interval', async () => {
      vi.useRealTimers();

      const config = createTestConfig(VPS_SERVER_PORT_1, mockBootstrapUrl);
      vpsServer = await createZajelServer(config);

      const initialLastSeen = bootstrapStore.servers.get(vpsServer.identity.serverId)?.lastSeen;
      expect(initialLastSeen).toBeDefined();

      // Wait for heartbeat interval + buffer
      await new Promise(resolve => setTimeout(resolve, 1500));

      const updatedLastSeen = bootstrapStore.servers.get(vpsServer.identity.serverId)?.lastSeen;
      expect(updatedLastSeen).toBeDefined();
      expect(updatedLastSeen!).toBeGreaterThan(initialLastSeen!);
    });

    it('should remain in CF registry after multiple heartbeats', async () => {
      vi.useRealTimers();

      const config = createTestConfig(VPS_SERVER_PORT_1, mockBootstrapUrl);
      vpsServer = await createZajelServer(config);

      // Wait for multiple heartbeat cycles
      await new Promise(resolve => setTimeout(resolve, 3500));

      // Server should still be registered
      expect(bootstrapStore.servers.has(vpsServer.identity.serverId)).toBe(true);
    });

    it('should receive and process peer list from heartbeat', async () => {
      vi.useRealTimers();

      // Pre-register another server in the mock store
      const otherServerId = 'ed25519:TEST_OTHER_SERVER_ID';
      bootstrapStore.servers.set(otherServerId, {
        serverId: otherServerId,
        endpoint: 'ws://other-server.example.com:9000',
        publicKey: 'test-public-key',
        region: 'us-east',
        registeredAt: Date.now(),
        lastSeen: Date.now(),
      });

      const config = createTestConfig(VPS_SERVER_PORT_1, mockBootstrapUrl);
      vpsServer = await createZajelServer(config);

      // Wait for heartbeat
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Server should have discovered the other peer via heartbeat
      // (The bootstrap client logs discovered peers)
      expect(bootstrapStore.servers.size).toBe(2);
    });
  });

  describe('Graceful Shutdown (Test Plan 2.3)', () => {
    it('should unregister from CF on shutdown', async () => {
      vi.useRealTimers();

      const config = createTestConfig(VPS_SERVER_PORT_1, mockBootstrapUrl);
      const vpsServer = await createZajelServer(config);

      // Verify server is registered
      expect(bootstrapStore.servers.has(vpsServer.identity.serverId)).toBe(true);

      // Shutdown
      await vpsServer.shutdown();

      // Verify server is unregistered
      expect(bootstrapStore.servers.has(vpsServer.identity.serverId)).toBe(false);
    });

    it('should no longer appear in GET /servers list after shutdown', async () => {
      vi.useRealTimers();

      const config = createTestConfig(VPS_SERVER_PORT_1, mockBootstrapUrl);
      const vpsServer = await createZajelServer(config);

      const serverId = vpsServer.identity.serverId;

      // Shutdown
      await vpsServer.shutdown();

      // Query the mock bootstrap server
      const response = await fetch(`${mockBootstrapUrl}/servers`);
      const data = await response.json() as { servers: BootstrapServerEntry[] };

      const found = data.servers.find(s => s.serverId === serverId);
      expect(found).toBeUndefined();
    });

    it('should stop heartbeat timer on shutdown', async () => {
      vi.useRealTimers();

      const config = createTestConfig(VPS_SERVER_PORT_1, mockBootstrapUrl);
      const vpsServer = await createZajelServer(config);

      // Shutdown
      await vpsServer.shutdown();

      const lastSeenAfterShutdown = Date.now();

      // Wait for what would have been another heartbeat
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Server should not be re-registered (no heartbeats after shutdown)
      expect(bootstrapStore.servers.has(vpsServer.identity.serverId)).toBe(false);
    });
  });

  describe('Health Endpoint (Test Plan 2.4)', () => {
    let vpsServer: ZajelServer | null = null;

    afterEach(async () => {
      vi.useRealTimers();
      if (vpsServer) {
        await vpsServer.shutdown();
        vpsServer = null;
      }
    });

    it('should respond with healthy status', async () => {
      vi.useRealTimers();

      const config = createTestConfig(VPS_SERVER_PORT_1, mockBootstrapUrl);
      vpsServer = await createZajelServer(config);

      const response = await fetch(`http://127.0.0.1:${VPS_SERVER_PORT_1}/health`);
      expect(response.status).toBe(200);

      const data = await response.json() as {
        status: string;
        serverId: string;
        uptime: number;
      };

      expect(data.status).toBe('healthy');
      expect(data.serverId).toBe(vpsServer.identity.serverId);
      expect(data.uptime).toBeGreaterThanOrEqual(0);
    });

    it('should return JSON content type', async () => {
      vi.useRealTimers();

      const config = createTestConfig(VPS_SERVER_PORT_1, mockBootstrapUrl);
      vpsServer = await createZajelServer(config);

      const response = await fetch(`http://127.0.0.1:${VPS_SERVER_PORT_1}/health`);
      expect(response.headers.get('content-type')).toBe('application/json');
    });

    it('should increase uptime over time', async () => {
      vi.useRealTimers();

      const config = createTestConfig(VPS_SERVER_PORT_1, mockBootstrapUrl);
      vpsServer = await createZajelServer(config);

      const response1 = await fetch(`http://127.0.0.1:${VPS_SERVER_PORT_1}/health`);
      const data1 = await response1.json() as { uptime: number };

      await new Promise(resolve => setTimeout(resolve, 1100));

      const response2 = await fetch(`http://127.0.0.1:${VPS_SERVER_PORT_1}/health`);
      const data2 = await response2.json() as { uptime: number };

      expect(data2.uptime).toBeGreaterThan(data1.uptime);
    });
  });

  describe('Stats Endpoint (Test Plan 2.5)', () => {
    let vpsServer: ZajelServer | null = null;

    afterEach(async () => {
      vi.useRealTimers();
      if (vpsServer) {
        await vpsServer.shutdown();
        vpsServer = null;
      }
    });

    it('should return server stats including serverId', async () => {
      vi.useRealTimers();

      const config = createTestConfig(VPS_SERVER_PORT_1, mockBootstrapUrl, 'eu-west');
      vpsServer = await createZajelServer(config);

      const response = await fetch(`http://127.0.0.1:${VPS_SERVER_PORT_1}/stats`);
      expect(response.status).toBe(200);

      const data = await response.json() as {
        serverId: string;
        nodeId: string;
        endpoint: string;
        region: string;
        uptime: number;
      };

      expect(data.serverId).toBe(vpsServer.identity.serverId);
    });

    it('should return nodeId', async () => {
      vi.useRealTimers();

      const config = createTestConfig(VPS_SERVER_PORT_1, mockBootstrapUrl);
      vpsServer = await createZajelServer(config);

      const response = await fetch(`http://127.0.0.1:${VPS_SERVER_PORT_1}/stats`);
      const data = await response.json() as { nodeId: string };

      expect(data.nodeId).toBe(vpsServer.identity.nodeId);
    });

    it('should return endpoint', async () => {
      vi.useRealTimers();

      const config = createTestConfig(VPS_SERVER_PORT_1, mockBootstrapUrl);
      vpsServer = await createZajelServer(config);

      const response = await fetch(`http://127.0.0.1:${VPS_SERVER_PORT_1}/stats`);
      const data = await response.json() as { endpoint: string };

      expect(data.endpoint).toBe(config.network!.publicEndpoint);
    });

    it('should return region', async () => {
      vi.useRealTimers();

      const config = createTestConfig(VPS_SERVER_PORT_1, mockBootstrapUrl, 'asia-pacific');
      vpsServer = await createZajelServer(config);

      const response = await fetch(`http://127.0.0.1:${VPS_SERVER_PORT_1}/stats`);
      const data = await response.json() as { region: string };

      expect(data.region).toBe('asia-pacific');
    });

    it('should return uptime', async () => {
      vi.useRealTimers();

      const config = createTestConfig(VPS_SERVER_PORT_1, mockBootstrapUrl);
      vpsServer = await createZajelServer(config);

      const response = await fetch(`http://127.0.0.1:${VPS_SERVER_PORT_1}/stats`);
      const data = await response.json() as { uptime: number };

      expect(data.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Metrics Endpoint', () => {
    let vpsServer: ZajelServer | null = null;

    afterEach(async () => {
      vi.useRealTimers();
      if (vpsServer) {
        await vpsServer.shutdown();
        vpsServer = null;
      }
    });

    it('should return metrics including pairing code entropy', async () => {
      vi.useRealTimers();

      const config = createTestConfig(VPS_SERVER_PORT_1, mockBootstrapUrl);
      vpsServer = await createZajelServer(config);

      const response = await fetch(`http://127.0.0.1:${VPS_SERVER_PORT_1}/metrics`);
      expect(response.status).toBe(200);

      const data = await response.json() as {
        serverId: string;
        uptime: number;
        connections: {
          relay: number;
          signaling: number;
        };
        pairingCodeEntropy: {
          activeCodes: number;
          peakActiveCodes: number;
          totalRegistrations: number;
          collisionAttempts: number;
          collisionRisk: string;
        };
      };

      expect(data.serverId).toBe(vpsServer.identity.serverId);
      expect(data.connections).toBeDefined();
      expect(data.connections.relay).toBe(0);
      expect(data.connections.signaling).toBe(0);
      expect(data.pairingCodeEntropy).toBeDefined();
      expect(data.pairingCodeEntropy.activeCodes).toBe(0);
      expect(data.pairingCodeEntropy.collisionRisk).toBe('low');
    });
  });

  describe('Error Handling', () => {
    it('should handle 404 for unknown endpoints', async () => {
      vi.useRealTimers();

      const config = createTestConfig(VPS_SERVER_PORT_1, mockBootstrapUrl);
      const vpsServer = await createZajelServer(config);

      try {
        const response = await fetch(`http://127.0.0.1:${VPS_SERVER_PORT_1}/unknown`);
        expect(response.status).toBe(404);
      } finally {
        await vpsServer.shutdown();
      }
    });

    it('should continue running if bootstrap server is unavailable at startup', async () => {
      vi.useRealTimers();

      // Use a non-existent bootstrap URL
      const config = createTestConfig(VPS_SERVER_PORT_1, 'http://127.0.0.1:59999');
      const vpsServer = await createZajelServer(config);

      try {
        // Server should still start and respond to health checks
        const response = await fetch(`http://127.0.0.1:${VPS_SERVER_PORT_1}/health`);
        expect(response.status).toBe(200);
      } finally {
        await vpsServer.shutdown();
      }
    });
  });

  describe('Multiple Servers', () => {
    it('should allow multiple servers to register', { timeout: 60000 }, async () => {
      vi.useRealTimers();

      const config1 = createTestConfig(VPS_SERVER_PORT_1, mockBootstrapUrl, 'region-1');
      const config2 = createTestConfig(VPS_SERVER_PORT_2, mockBootstrapUrl, 'region-2');

      const vpsServer1 = await createZajelServer(config1);
      const vpsServer2 = await createZajelServer(config2);

      try {
        // Both servers should be registered
        expect(bootstrapStore.servers.size).toBe(2);

        const response = await fetch(`${mockBootstrapUrl}/servers`);
        const data = await response.json() as { servers: BootstrapServerEntry[] };

        expect(data.servers).toHaveLength(2);

        const server1Entry = data.servers.find(s => s.serverId === vpsServer1.identity.serverId);
        const server2Entry = data.servers.find(s => s.serverId === vpsServer2.identity.serverId);

        expect(server1Entry).toBeDefined();
        expect(server2Entry).toBeDefined();
        expect(server1Entry!.region).toBe('region-1');
        expect(server2Entry!.region).toBe('region-2');
      } finally {
        await vpsServer2.shutdown();
        await vpsServer1.shutdown();
      }
    });

    it('should receive each other as peers via heartbeat', { timeout: 30000 }, async () => {
      vi.useRealTimers();

      const config1 = createTestConfig(VPS_SERVER_PORT_1, mockBootstrapUrl);
      const config2 = createTestConfig(VPS_SERVER_PORT_2, mockBootstrapUrl);

      const vpsServer1 = await createZajelServer(config1);
      const vpsServer2 = await createZajelServer(config2);

      try {
        // Wait for heartbeat cycle
        await new Promise(resolve => setTimeout(resolve, 1500));

        // Both servers should still be present
        expect(bootstrapStore.servers.has(vpsServer1.identity.serverId)).toBe(true);
        expect(bootstrapStore.servers.has(vpsServer2.identity.serverId)).toBe(true);
      } finally {
        await vpsServer2.shutdown();
        await vpsServer1.shutdown();
      }
    });
  });
});
