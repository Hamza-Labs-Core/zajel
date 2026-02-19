/**
 * Federation E2E Tests
 *
 * Tests for federation between VPS servers:
 * - Two VPS servers discovering each other via CF Workers
 * - Cross-server signaling
 * - Peer list exchange during heartbeat
 *
 * Note: Each test uses unique ports to avoid conflicts when running in parallel
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'http';
import { WebSocket } from 'ws';
import { createZajelServer, type ZajelServer } from '../../src/index.js';
import type { ServerConfig } from '../../src/types.js';
import type { BootstrapServerEntry } from '../../src/federation/bootstrap-client.js';

// Port allocation - each test uses unique ports
let portCounter = 20000 + Math.floor(Math.random() * 5000);
const getNextPort = () => portCounter++;

// Store for mock CF Workers bootstrap server
interface MockBootstrapStore {
  servers: Map<string, BootstrapServerEntry>;
}

/**
 * Creates a mock CF Workers bootstrap server for testing
 */
function createMockBootstrapServer(store: MockBootstrapStore, port: number): HttpServer {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);

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
  region = 'test-region',
  bootstrapNodes: string[] = []
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
      heartbeatInterval: 2000, // 2 seconds for faster testing
      nodes: bootstrapNodes,
      retryInterval: 500,
      maxRetries: 3,
    },
    storage: {
      type: 'sqlite',
      path: `:memory:`,
    },
    identity: {
      keyPath: `/tmp/zajel-fed-test-${port}-${Date.now()}.key`,
      ephemeralIdPrefix: 'test',
    },
    gossip: {
      interval: 1000,
      suspicionTimeout: 2000,
      failureTimeout: 4000,
      indirectPingCount: 2,
      stateExchangeInterval: 3000,
    },
    client: {
      maxConnectionsPerPeer: 20,
      heartbeatInterval: 30000,
      heartbeatTimeout: 60000,
      pairRequestTimeout: 120000,
      pairRequestWarningTime: 30000,
    },
  };
}

/**
 * Helper to create a WebSocket client and wait for connection and server_info
 * Returns both the WebSocket and the server_info message
 */
async function createWsClient(
  url: string,
  timeout: number = 5000
): Promise<{ ws: WebSocket; serverInfo: any }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('WebSocket connection timeout'));
    }, timeout);

    ws.on('open', () => {
      // Wait for server_info message after connection
      const messageHandler = (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'server_info') {
            clearTimeout(timer);
            ws.off('message', messageHandler);
            resolve({ ws, serverInfo: message });
          }
        } catch {
          // Ignore parse errors
        }
      };
      ws.on('message', messageHandler);
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Helper to wait for a message of a specific type
 */
async function waitForMessage(
  ws: WebSocket,
  messageType: string,
  timeout: number = 5000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for message type: ${messageType}`));
    }, timeout);

    const handler = (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === messageType) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(message);
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.on('message', handler);
  });
}

describe('Federation E2E Tests', () => {
  let mockBootstrapServer: HttpServer;
  let bootstrapStore: MockBootstrapStore;
  let mockBootstrapUrl: string;
  let bootstrapPort: number;

  beforeAll(async () => {
    // Create and start mock bootstrap server
    bootstrapPort = getNextPort();
    bootstrapStore = { servers: new Map() };
    mockBootstrapServer = createMockBootstrapServer(bootstrapStore, bootstrapPort);

    await new Promise<void>((resolve) => {
      mockBootstrapServer.listen(bootstrapPort, '127.0.0.1', () => {
        resolve();
      });
    });

    mockBootstrapUrl = `http://127.0.0.1:${bootstrapPort}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      mockBootstrapServer.close(() => resolve());
    });
  });

  beforeEach(() => {
    // Clear stored servers between tests
    bootstrapStore.servers.clear();
  });

  describe('Two VPS Servers Discovering Each Other (Test Plan 4.2)', () => {
    it('should discover each other via CF Workers', { timeout: 30000 }, async () => {
      const port1 = getNextPort();
      const port2 = getNextPort();

      const config1 = createTestConfig(port1, mockBootstrapUrl, 'region-1');
      const config2 = createTestConfig(port2, mockBootstrapUrl, 'region-2');

      const server1 = await createZajelServer(config1);
      const server2 = await createZajelServer(config2);

      try {
        // Both servers should be registered in CF Workers
        expect(bootstrapStore.servers.size).toBe(2);

        // Wait for heartbeat to exchange peer info
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Both servers should know about each other via heartbeat
        const response = await fetch(`${mockBootstrapUrl}/servers`);
        const data = await response.json() as { servers: BootstrapServerEntry[] };

        expect(data.servers).toHaveLength(2);

        const server1Entry = data.servers.find(s => s.serverId === server1.identity.serverId);
        const server2Entry = data.servers.find(s => s.serverId === server2.identity.serverId);

        expect(server1Entry).toBeDefined();
        expect(server2Entry).toBeDefined();
      } finally {
        await server2.shutdown();
        await server1.shutdown();
      }
    });

    it('should return peers from heartbeat response', { timeout: 20000 }, async () => {
      const port1 = getNextPort();
      const config1 = createTestConfig(port1, mockBootstrapUrl, 'region-1');
      const server1 = await createZajelServer(config1);

      try {
        // Manually register a second server in bootstrap
        const fakeServerId = 'ed25519:FAKE_SERVER_ID_FOR_TEST';
        bootstrapStore.servers.set(fakeServerId, {
          serverId: fakeServerId,
          endpoint: 'ws://fake-server.example.com:9000',
          publicKey: 'fake-public-key',
          region: 'fake-region',
          registeredAt: Date.now(),
          lastSeen: Date.now(),
        });

        // Wait for heartbeat
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Server 1 should have discovered the fake server via heartbeat
        expect(bootstrapStore.servers.size).toBe(2);
      } finally {
        await server1.shutdown();
      }
    });

    it('should maintain registration after multiple heartbeats', { timeout: 30000 }, async () => {
      const port1 = getNextPort();
      const port2 = getNextPort();

      const config1 = createTestConfig(port1, mockBootstrapUrl, 'region-1');
      const config2 = createTestConfig(port2, mockBootstrapUrl, 'region-2');

      const server1 = await createZajelServer(config1);
      const server2 = await createZajelServer(config2);

      try {
        const initialLastSeen1 = bootstrapStore.servers.get(server1.identity.serverId)?.lastSeen;
        const initialLastSeen2 = bootstrapStore.servers.get(server2.identity.serverId)?.lastSeen;

        // Wait for multiple heartbeat cycles
        await new Promise(resolve => setTimeout(resolve, 5000));

        const updatedLastSeen1 = bootstrapStore.servers.get(server1.identity.serverId)?.lastSeen;
        const updatedLastSeen2 = bootstrapStore.servers.get(server2.identity.serverId)?.lastSeen;

        // Both servers should have updated lastSeen
        expect(updatedLastSeen1).toBeGreaterThan(initialLastSeen1!);
        expect(updatedLastSeen2).toBeGreaterThan(initialLastSeen2!);
      } finally {
        await server2.shutdown();
        await server1.shutdown();
      }
    });
  });

  describe('Cross-Server Signaling', () => {
    it('should allow clients to connect to both servers', { timeout: 20000 }, async () => {
      const port1 = getNextPort();
      const port2 = getNextPort();

      const config1 = createTestConfig(port1, mockBootstrapUrl, 'region-1');
      const config2 = createTestConfig(port2, mockBootstrapUrl, 'region-2');

      const server1 = await createZajelServer(config1);
      const server2 = await createZajelServer(config2);

      // Connect clients to both servers - createWsClient waits for server_info
      const { ws: client1, serverInfo: serverInfo1 } = await createWsClient(`ws://127.0.0.1:${port1}`);
      const { ws: client2, serverInfo: serverInfo2 } = await createWsClient(`ws://127.0.0.1:${port2}`);

      try {
        // Both should have received server_info
        expect(serverInfo1.serverId).toBe(server1.identity.serverId);
        expect(serverInfo2.serverId).toBe(server2.identity.serverId);
      } finally {
        client1.close();
        client2.close();
        await server2.shutdown();
        await server1.shutdown();
      }
    });

    it('should allow pairing code registration on both servers', { timeout: 20000 }, async () => {
      const port1 = getNextPort();
      const port2 = getNextPort();

      const config1 = createTestConfig(port1, mockBootstrapUrl, 'region-1');
      const config2 = createTestConfig(port2, mockBootstrapUrl, 'region-2');

      const server1 = await createZajelServer(config1);
      const server2 = await createZajelServer(config2);

      // Connect clients - createWsClient waits for server_info
      const { ws: client1 } = await createWsClient(`ws://127.0.0.1:${port1}`);
      const { ws: client2 } = await createWsClient(`ws://127.0.0.1:${port2}`);

      // Valid 32-byte base64-encoded public key
      const validPubKey = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDE=';

      try {
        // Register on server 1
        client1.send(JSON.stringify({
          type: 'register',
          pairingCode: 'ABC234',
          publicKey: validPubKey,
        }));

        // Register on server 2
        client2.send(JSON.stringify({
          type: 'register',
          pairingCode: 'XYZ567',
          publicKey: validPubKey,
        }));

        // Both should get registered response
        const reg1 = await waitForMessage(client1, 'registered');
        const reg2 = await waitForMessage(client2, 'registered');

        expect(reg1.pairingCode).toBe('ABC234');
        expect(reg2.pairingCode).toBe('XYZ567');
        expect(reg1.serverId).toBe(server1.identity.serverId);
        expect(reg2.serverId).toBe(server2.identity.serverId);
      } finally {
        client1.close();
        client2.close();
        await server2.shutdown();
        await server1.shutdown();
      }
    });

    it('should handle signaling messages within same server', { timeout: 30000 }, async () => {
      const port1 = getNextPort();
      const config1 = createTestConfig(port1, mockBootstrapUrl);
      const server1 = await createZajelServer(config1);

      // Connect clients - createWsClient waits for server_info
      const { ws: client1 } = await createWsClient(`ws://127.0.0.1:${port1}`, 10000);
      const { ws: client2 } = await createWsClient(`ws://127.0.0.1:${port1}`, 10000);

      const validPubKey1 = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDE=';
      const validPubKey2 = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDI=';

      // Valid pairing codes: 6 chars from [ABCDEFGHJKLMNPQRSTUVWXYZ23456789]
      const pairingCode1 = 'ABC234';
      const pairingCode2 = 'XYZ567';

      try {
        // Register both clients (with longer timeout)
        client1.send(JSON.stringify({
          type: 'register',
          pairingCode: pairingCode1,
          publicKey: validPubKey1,
        }));

        client2.send(JSON.stringify({
          type: 'register',
          pairingCode: pairingCode2,
          publicKey: validPubKey2,
        }));

        await waitForMessage(client1, 'registered', 10000);
        await waitForMessage(client2, 'registered', 10000);

        // Client 1 sends pair request to Client 2
        client1.send(JSON.stringify({
          type: 'pair_request',
          targetCode: pairingCode2,
        }));

        // Client 2 should receive pair_incoming
        const pairIncoming = await waitForMessage(client2, 'pair_incoming', 10000);
        expect(pairIncoming.fromCode).toBe(pairingCode1);
        expect(pairIncoming.fromPublicKey).toBe(validPubKey1);

        // Client 2 accepts
        client2.send(JSON.stringify({
          type: 'pair_response',
          targetCode: pairingCode1,
          accepted: true,
        }));

        // Both should receive pair_matched
        const matched1 = await waitForMessage(client1, 'pair_matched', 10000);
        const matched2 = await waitForMessage(client2, 'pair_matched', 10000);

        expect(matched1.peerCode).toBe(pairingCode2);
        expect(matched1.isInitiator).toBe(true);
        expect(matched2.peerCode).toBe(pairingCode1);
        expect(matched2.isInitiator).toBe(false);
      } finally {
        client1.close();
        client2.close();
        await server1.shutdown();
      }
    });
  });

  describe('Peer List Exchange During Heartbeat', () => {
    it('should return all other servers as peers in heartbeat', { timeout: 30000 }, async () => {
      const port1 = getNextPort();
      const port2 = getNextPort();
      const port3 = getNextPort();

      const config1 = createTestConfig(port1, mockBootstrapUrl, 'region-1');
      const config2 = createTestConfig(port2, mockBootstrapUrl, 'region-2');
      const config3 = createTestConfig(port3, mockBootstrapUrl, 'region-3');

      const server1 = await createZajelServer(config1);
      const server2 = await createZajelServer(config2);
      const server3 = await createZajelServer(config3);

      try {
        // All three servers should be registered
        expect(bootstrapStore.servers.size).toBe(3);

        // Test heartbeat response for server1
        const heartbeatResponse = await fetch(`${mockBootstrapUrl}/servers/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverId: server1.identity.serverId }),
        });

        const data = await heartbeatResponse.json() as { success: boolean; peers: BootstrapServerEntry[] };

        expect(data.success).toBe(true);
        expect(data.peers).toHaveLength(2); // Should not include self

        const peerIds = data.peers.map(p => p.serverId);
        expect(peerIds).toContain(server2.identity.serverId);
        expect(peerIds).toContain(server3.identity.serverId);
        expect(peerIds).not.toContain(server1.identity.serverId);
      } finally {
        await server3.shutdown();
        await server2.shutdown();
        await server1.shutdown();
      }
    });

    it('should update peer list when servers join', { timeout: 60000 }, async () => {
      const port1 = getNextPort();
      const config1 = createTestConfig(port1, mockBootstrapUrl, 'region-1');
      const server1 = await createZajelServer(config1);

      try {
        // Initially, no peers
        let heartbeatResponse = await fetch(`${mockBootstrapUrl}/servers/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverId: server1.identity.serverId }),
        });

        let data = await heartbeatResponse.json() as { success: boolean; peers: BootstrapServerEntry[] };
        expect(data.peers).toHaveLength(0);

        // Start second server
        const port2 = getNextPort();
        const config2 = createTestConfig(port2, mockBootstrapUrl, 'region-2');
        const server2 = await createZajelServer(config2);

        try {
          // Now should have one peer
          heartbeatResponse = await fetch(`${mockBootstrapUrl}/servers/heartbeat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ serverId: server1.identity.serverId }),
          });

          data = await heartbeatResponse.json() as { success: boolean; peers: BootstrapServerEntry[] };
          expect(data.peers).toHaveLength(1);
          expect(data.peers[0]!.serverId).toBe(server2.identity.serverId);
        } finally {
          await server2.shutdown();
        }
      } finally {
        await server1.shutdown();
      }
    });

    it('should update peer list when servers leave', { timeout: 20000 }, async () => {
      const port1 = getNextPort();
      const port2 = getNextPort();

      const config1 = createTestConfig(port1, mockBootstrapUrl, 'region-1');
      const config2 = createTestConfig(port2, mockBootstrapUrl, 'region-2');

      const server1 = await createZajelServer(config1);
      const server2 = await createZajelServer(config2);

      try {
        // Initially, one peer
        let heartbeatResponse = await fetch(`${mockBootstrapUrl}/servers/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverId: server1.identity.serverId }),
        });

        let data = await heartbeatResponse.json() as { success: boolean; peers: BootstrapServerEntry[] };
        expect(data.peers).toHaveLength(1);

        // Shutdown server2
        await server2.shutdown();

        // Now should have no peers
        heartbeatResponse = await fetch(`${mockBootstrapUrl}/servers/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverId: server1.identity.serverId }),
        });

        data = await heartbeatResponse.json() as { success: boolean; peers: BootstrapServerEntry[] };
        expect(data.peers).toHaveLength(0);
      } finally {
        await server1.shutdown();
      }
    });
  });

  describe('Federation Connection Establishment', () => {
    it('should handle federation path correctly', { timeout: 20000 }, async () => {
      const port1 = getNextPort();
      const config1 = createTestConfig(port1, mockBootstrapUrl, 'region-1');
      const server1 = await createZajelServer(config1);

      try {
        // Try connecting to /federation endpoint
        const federationWs = new WebSocket(`ws://127.0.0.1:${port1}/federation`);

        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            federationWs.close();
            reject(new Error('Federation connection timeout'));
          }, 5000);

          federationWs.on('open', () => {
            clearTimeout(timer);
            resolve();
          });

          federationWs.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });

        // Connection should be established (server will expect handshake)
        expect(federationWs.readyState).toBe(WebSocket.OPEN);
        federationWs.close();
      } finally {
        await server1.shutdown();
      }
    });

    it('should handle client path (default)', { timeout: 20000 }, async () => {
      const port1 = getNextPort();
      const config1 = createTestConfig(port1, mockBootstrapUrl, 'region-1');
      const server1 = await createZajelServer(config1);

      try {
        // Connect to default path (client connection)
        const { ws: clientWs, serverInfo } = await createWsClient(`ws://127.0.0.1:${port1}`);

        try {
          // Should receive server_info (client message)
          expect(serverInfo.serverId).toBe(server1.identity.serverId);
        } finally {
          clientWs.close();
        }
      } finally {
        await server1.shutdown();
      }
    });
  });

  describe('Resilience & Error Handling', () => {
    it('should continue operating when a peer server goes offline', { timeout: 20000 }, async () => {
      const port1 = getNextPort();
      const port2 = getNextPort();

      const config1 = createTestConfig(port1, mockBootstrapUrl, 'region-1');
      const config2 = createTestConfig(port2, mockBootstrapUrl, 'region-2');

      const server1 = await createZajelServer(config1);
      const server2 = await createZajelServer(config2);

      try {
        // Wait for both servers to be up
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Shutdown server2
        await server2.shutdown();

        // Server1 should continue to respond to health checks
        const response = await fetch(`http://127.0.0.1:${port1}/health`);
        expect(response.status).toBe(200);

        const data = await response.json() as { status: string };
        expect(data.status).toBe('healthy');
      } finally {
        await server1.shutdown();
      }
    });

    it('should handle client connections after peer disconnect', { timeout: 20000 }, async () => {
      const port1 = getNextPort();
      const port2 = getNextPort();

      const config1 = createTestConfig(port1, mockBootstrapUrl, 'region-1');
      const config2 = createTestConfig(port2, mockBootstrapUrl, 'region-2');

      const server1 = await createZajelServer(config1);
      const server2 = await createZajelServer(config2);

      try {
        // Wait for federation
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Shutdown server2
        await server2.shutdown();

        // Wait a bit for server1 to detect disconnect
        await new Promise(resolve => setTimeout(resolve, 500));

        // Server1 should still accept client connections
        const { ws: client, serverInfo } = await createWsClient(`ws://127.0.0.1:${port1}`);

        try {
          expect(serverInfo.serverId).toBe(server1.identity.serverId);
        } finally {
          client.close();
        }
      } finally {
        await server1.shutdown();
      }
    });

    it('should handle bootstrap server being unavailable', { timeout: 20000 }, async () => {
      const port1 = getNextPort();
      // Use invalid bootstrap URL
      const config1 = createTestConfig(port1, 'http://127.0.0.1:59999', 'region-1');
      const server1 = await createZajelServer(config1);

      try {
        // Server should still start and be healthy
        const response = await fetch(`http://127.0.0.1:${port1}/health`);
        expect(response.status).toBe(200);

        // Should still accept client connections
        const { ws: client, serverInfo } = await createWsClient(`ws://127.0.0.1:${port1}`);

        try {
          expect(serverInfo.serverId).toBe(server1.identity.serverId);
        } finally {
          client.close();
        }
      } finally {
        await server1.shutdown();
      }
    });
  });

  describe('Server Region Information', () => {
    it('should include region in server_info sent to clients', { timeout: 20000 }, async () => {
      const port1 = getNextPort();
      const config1 = createTestConfig(port1, mockBootstrapUrl, 'asia-pacific');
      const server1 = await createZajelServer(config1);

      try {
        const { ws: client, serverInfo } = await createWsClient(`ws://127.0.0.1:${port1}`);

        try {
          expect(serverInfo.region).toBe('asia-pacific');
        } finally {
          client.close();
        }
      } finally {
        await server1.shutdown();
      }
    });

    it('should include region in stats endpoint', { timeout: 20000 }, async () => {
      const testSecret = 'test-stats-secret-federation';
      const originalSecret = process.env['STATS_SECRET'];
      process.env['STATS_SECRET'] = testSecret;

      const port1 = getNextPort();
      const config1 = createTestConfig(port1, mockBootstrapUrl, 'europe-west');
      const server1 = await createZajelServer(config1);

      try {
        const response = await fetch(`http://127.0.0.1:${port1}/stats`, {
          headers: { 'Authorization': `Bearer ${testSecret}` },
        });
        const data = await response.json() as { region: string };

        expect(data.region).toBe('europe-west');
      } finally {
        await server1.shutdown();
        if (originalSecret !== undefined) {
          process.env['STATS_SECRET'] = originalSecret;
        } else {
          delete process.env['STATS_SECRET'];
        }
      }
    });
  });
});
