/**
 * Real Server Integration Tests
 *
 * Tests that start actual VPS server instances and perform real WebSocket
 * communication to verify end-to-end functionality.
 *
 * Tests covered:
 * - Server startup and health checks
 * - WebSocket client connection and server_info
 * - Pairing code registration
 * - Full pairing flow between two WebSocket clients
 * - WebRTC signaling message relay
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import {
  TestServerHarness,
  MockBootstrapServer,
  createMockBootstrap,
} from '../harness/index.js';

// Valid 32-byte base64-encoded public keys for testing
const VALID_PUBKEY_1 = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDE=';
const VALID_PUBKEY_2 = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDI=';

// Valid pairing codes (6 chars from [ABCDEFGHJKLMNPQRSTUVWXYZ23456789])
const CODE_ALICE = 'ABC234';
const CODE_BOB = 'XYZ567';

/**
 * Helper to create a WebSocket client and wait for connection + server_info
 */
async function createWsClient(
  url: string,
  timeout = 5000
): Promise<{ ws: WebSocket; serverInfo: Record<string, unknown> }> {
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
 * Helper to wait for a specific message type
 */
async function waitForMessage(
  ws: WebSocket,
  messageType: string,
  timeout = 5000
): Promise<Record<string, unknown>> {
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

/**
 * Helper to send a JSON message
 */
function sendMessage(ws: WebSocket, message: Record<string, unknown>): void {
  ws.send(JSON.stringify(message));
}

describe('Real Server Integration Tests', () => {
  describe('Server Startup and Health', () => {
    let mockBootstrap: MockBootstrapServer;

    beforeAll(async () => {
      mockBootstrap = await createMockBootstrap({ port: 0 });
    });

    afterAll(async () => {
      await mockBootstrap.stop();
    });

    it('should start a real server instance', { timeout: 15000 }, async () => {
      const serverHarness = new TestServerHarness({
        bootstrapUrl: mockBootstrap.getUrl(),
        region: 'test-region-1',
      });

      await serverHarness.start();

      try {
        expect(serverHarness.isRunning).toBe(true);
        expect(serverHarness.port).toBeGreaterThan(0);
      } finally {
        await serverHarness.stop();
      }
    });

    it('should respond to health check endpoint', { timeout: 15000 }, async () => {
      const serverHarness = new TestServerHarness({
        bootstrapUrl: mockBootstrap.getUrl(),
      });

      await serverHarness.start();

      try {
        const healthy = await serverHarness.waitForHealthy();
        expect(healthy).toBe(true);

        const response = await fetch(`${serverHarness.getUrl()}/health`);
        expect(response.status).toBe(200);

        const data = await response.json() as { status: string; serverId: string };
        expect(data.status).toBe('healthy');
        expect(data.serverId).toBe(serverHarness.identity.serverId);
      } finally {
        await serverHarness.stop();
      }
    });

    it('should reject stats endpoint without auth', { timeout: 15000 }, async () => {
      const serverHarness = new TestServerHarness({
        bootstrapUrl: mockBootstrap.getUrl(),
        region: 'asia-pacific',
      });

      await serverHarness.start();

      try {
        const response = await fetch(`${serverHarness.getUrl()}/stats`);
        expect(response.status).toBe(401);

        const data = await response.json() as { error: string };
        expect(data.error).toBe('Unauthorized');
      } finally {
        await serverHarness.stop();
      }
    });

    it('should respond to stats endpoint with valid auth', { timeout: 15000 }, async () => {
      const testSecret = 'test-stats-secret-12345';
      const originalSecret = process.env['STATS_SECRET'];
      process.env['STATS_SECRET'] = testSecret;

      const serverHarness = new TestServerHarness({
        bootstrapUrl: mockBootstrap.getUrl(),
        region: 'asia-pacific',
      });

      await serverHarness.start();

      try {
        // Without auth header should still be rejected
        const noAuthResponse = await fetch(`${serverHarness.getUrl()}/stats`);
        expect(noAuthResponse.status).toBe(401);

        // With wrong secret should be rejected
        const wrongAuthResponse = await fetch(`${serverHarness.getUrl()}/stats`, {
          headers: { 'Authorization': 'Bearer wrong-secret' },
        });
        expect(wrongAuthResponse.status).toBe(401);

        // With correct secret should succeed
        const response = await fetch(`${serverHarness.getUrl()}/stats`, {
          headers: { 'Authorization': `Bearer ${testSecret}` },
        });
        expect(response.status).toBe(200);

        const data = await response.json() as { serverId: string; region: string };
        expect(data.serverId).toBe(serverHarness.identity.serverId);
        expect(data.region).toBe('asia-pacific');
      } finally {
        await serverHarness.stop();
        if (originalSecret !== undefined) {
          process.env['STATS_SECRET'] = originalSecret;
        } else {
          delete process.env['STATS_SECRET'];
        }
      }
    });

    it('should register with mock bootstrap on startup', { timeout: 15000 }, async () => {
      mockBootstrap.clear();

      const serverHarness = new TestServerHarness({
        bootstrapUrl: mockBootstrap.getUrl(),
        region: 'eu-west',
      });

      await serverHarness.start();

      try {
        // Give server time to register
        await new Promise((resolve) => setTimeout(resolve, 500));

        expect(mockBootstrap.serverCount).toBe(1);
        const server = mockBootstrap.getServer(serverHarness.identity.serverId);
        expect(server).toBeDefined();
        expect(server!.region).toBe('eu-west');
      } finally {
        await serverHarness.stop();
      }
    });
  });

  describe('WebSocket Client Connection', () => {
    let mockBootstrap: MockBootstrapServer;
    let serverHarness: TestServerHarness;

    beforeAll(async () => {
      mockBootstrap = await createMockBootstrap({ port: 0 });
      serverHarness = new TestServerHarness({
        bootstrapUrl: mockBootstrap.getUrl(),
        region: 'ws-test-region',
      });
      await serverHarness.start();
    });

    afterAll(async () => {
      await serverHarness.stop();
      await mockBootstrap.stop();
    });

    it('should accept WebSocket connections', { timeout: 10000 }, async () => {
      const { ws, serverInfo } = await createWsClient(serverHarness.getWsUrl());

      try {
        expect(ws.readyState).toBe(WebSocket.OPEN);
        expect(serverInfo.type).toBe('server_info');
        expect(serverInfo.serverId).toBe(serverHarness.identity.serverId);
      } finally {
        ws.close();
      }
    });

    it('should send server_info with serverId and region', { timeout: 10000 }, async () => {
      const { ws, serverInfo } = await createWsClient(serverHarness.getWsUrl());

      try {
        expect(serverInfo.serverId).toBeDefined();
        expect(serverInfo.endpoint).toBeDefined();
        expect(serverInfo.region).toBe('ws-test-region');
      } finally {
        ws.close();
      }
    });

    it('should handle multiple concurrent connections', { timeout: 10000 }, async () => {
      const clients = await Promise.all([
        createWsClient(serverHarness.getWsUrl()),
        createWsClient(serverHarness.getWsUrl()),
        createWsClient(serverHarness.getWsUrl()),
      ]);

      try {
        for (const { ws, serverInfo } of clients) {
          expect(ws.readyState).toBe(WebSocket.OPEN);
          expect(serverInfo.serverId).toBe(serverHarness.identity.serverId);
        }
      } finally {
        clients.forEach(({ ws }) => ws.close());
      }
    });
  });

  describe('Pairing Code Registration', () => {
    let mockBootstrap: MockBootstrapServer;
    let serverHarness: TestServerHarness;

    beforeAll(async () => {
      mockBootstrap = await createMockBootstrap({ port: 0 });
      serverHarness = new TestServerHarness({
        bootstrapUrl: mockBootstrap.getUrl(),
      });
      await serverHarness.start();
    });

    afterAll(async () => {
      await serverHarness.stop();
      await mockBootstrap.stop();
    });

    it('should register with a pairing code', { timeout: 10000 }, async () => {
      const { ws } = await createWsClient(serverHarness.getWsUrl());

      try {
        sendMessage(ws, {
          type: 'register',
          pairingCode: CODE_ALICE,
          publicKey: VALID_PUBKEY_1,
        });

        const registered = await waitForMessage(ws, 'registered');
        expect(registered.pairingCode).toBe(CODE_ALICE);
        expect(registered.serverId).toBe(serverHarness.identity.serverId);
      } finally {
        ws.close();
      }
    });

    it('should reject invalid pairing code format', { timeout: 10000 }, async () => {
      const { ws } = await createWsClient(serverHarness.getWsUrl());

      try {
        sendMessage(ws, {
          type: 'register',
          pairingCode: 'INVALID!', // Contains invalid character
          publicKey: VALID_PUBKEY_1,
        });

        const error = await waitForMessage(ws, 'error');
        expect(error.message).toContain('Invalid pairing code format');
      } finally {
        ws.close();
      }
    });

    it('should reject registration without publicKey', { timeout: 10000 }, async () => {
      const { ws } = await createWsClient(serverHarness.getWsUrl());

      try {
        sendMessage(ws, {
          type: 'register',
          pairingCode: CODE_ALICE,
          // Missing publicKey
        });

        const error = await waitForMessage(ws, 'error');
        expect(error.message).toContain('Missing required field: publicKey');
      } finally {
        ws.close();
      }
    });
  });

  describe('Full Pairing Flow', () => {
    let mockBootstrap: MockBootstrapServer;
    let serverHarness: TestServerHarness;

    beforeAll(async () => {
      mockBootstrap = await createMockBootstrap({ port: 0 });
      serverHarness = new TestServerHarness({
        bootstrapUrl: mockBootstrap.getUrl(),
      });
      await serverHarness.start();
    });

    afterAll(async () => {
      await serverHarness.stop();
      await mockBootstrap.stop();
    });

    it('should complete pairing between two clients', { timeout: 15000 }, async () => {
      // Connect Alice and Bob
      const { ws: aliceWs } = await createWsClient(serverHarness.getWsUrl());
      const { ws: bobWs } = await createWsClient(serverHarness.getWsUrl());

      try {
        // Register both clients
        sendMessage(aliceWs, {
          type: 'register',
          pairingCode: CODE_ALICE,
          publicKey: VALID_PUBKEY_1,
        });
        sendMessage(bobWs, {
          type: 'register',
          pairingCode: CODE_BOB,
          publicKey: VALID_PUBKEY_2,
        });

        await waitForMessage(aliceWs, 'registered');
        await waitForMessage(bobWs, 'registered');

        // Alice initiates pairing with Bob
        sendMessage(aliceWs, {
          type: 'pair_request',
          targetCode: CODE_BOB,
        });

        // Bob receives pair_incoming
        const pairIncoming = await waitForMessage(bobWs, 'pair_incoming');
        expect(pairIncoming.fromCode).toBe(CODE_ALICE);
        expect(pairIncoming.fromPublicKey).toBe(VALID_PUBKEY_1);
        expect(pairIncoming.expiresIn).toBe(120000); // 2 minutes

        // Bob accepts the pairing
        sendMessage(bobWs, {
          type: 'pair_response',
          targetCode: CODE_ALICE,
          accepted: true,
        });

        // Both receive pair_matched
        const aliceMatched = await waitForMessage(aliceWs, 'pair_matched');
        const bobMatched = await waitForMessage(bobWs, 'pair_matched');

        expect(aliceMatched.peerCode).toBe(CODE_BOB);
        expect(aliceMatched.peerPublicKey).toBe(VALID_PUBKEY_2);
        expect(aliceMatched.isInitiator).toBe(true);

        expect(bobMatched.peerCode).toBe(CODE_ALICE);
        expect(bobMatched.peerPublicKey).toBe(VALID_PUBKEY_1);
        expect(bobMatched.isInitiator).toBe(false);
      } finally {
        aliceWs.close();
        bobWs.close();
      }
    });

    it('should handle pair rejection', { timeout: 15000 }, async () => {
      const { ws: aliceWs } = await createWsClient(serverHarness.getWsUrl());
      const { ws: bobWs } = await createWsClient(serverHarness.getWsUrl());

      try {
        // Register with unique codes for this test
        const codeAlice = 'REJ234';
        const codeBob = 'REJ567';

        sendMessage(aliceWs, {
          type: 'register',
          pairingCode: codeAlice,
          publicKey: VALID_PUBKEY_1,
        });
        sendMessage(bobWs, {
          type: 'register',
          pairingCode: codeBob,
          publicKey: VALID_PUBKEY_2,
        });

        await waitForMessage(aliceWs, 'registered');
        await waitForMessage(bobWs, 'registered');

        // Alice initiates pairing
        sendMessage(aliceWs, {
          type: 'pair_request',
          targetCode: codeBob,
        });

        await waitForMessage(bobWs, 'pair_incoming');

        // Bob rejects
        sendMessage(bobWs, {
          type: 'pair_response',
          targetCode: codeAlice,
          accepted: false,
        });

        // Alice receives rejection
        const rejected = await waitForMessage(aliceWs, 'pair_rejected');
        expect(rejected.peerCode).toBe(codeBob);
      } finally {
        aliceWs.close();
        bobWs.close();
      }
    });

    it('should error when pairing with non-existent code', { timeout: 10000 }, async () => {
      const { ws: aliceWs } = await createWsClient(serverHarness.getWsUrl());

      try {
        sendMessage(aliceWs, {
          type: 'register',
          pairingCode: 'ERR234',
          publicKey: VALID_PUBKEY_1,
        });

        await waitForMessage(aliceWs, 'registered');

        // Try to pair with non-existent code
        sendMessage(aliceWs, {
          type: 'pair_request',
          targetCode: 'ZZZZZ9', // Valid format but not registered
        });

        const error = await waitForMessage(aliceWs, 'pair_error');
        expect(error.error).toBe('Pair request could not be processed');
      } finally {
        aliceWs.close();
      }
    });
  });

  describe('WebRTC Signaling Relay', { sequential: true }, () => {
    let mockBootstrap: MockBootstrapServer;
    let serverHarness: TestServerHarness;

    beforeAll(async () => {
      mockBootstrap = await createMockBootstrap({ port: 0 });
      serverHarness = new TestServerHarness({
        bootstrapUrl: mockBootstrap.getUrl(),
      });
      await serverHarness.start();
    });

    afterAll(async () => {
      await serverHarness.stop();
      await mockBootstrap.stop();
    });

    it('should relay signaling messages after pairing', { timeout: 30000 }, async () => {
      const { ws: aliceWs } = await createWsClient(serverHarness.getWsUrl(), 10000);
      const { ws: bobWs } = await createWsClient(serverHarness.getWsUrl(), 10000);

      try {
        // Note: I and O are excluded from valid pairing codes
        const codeAlice = 'SGN234';
        const codeBob = 'SGN567';

        // Register and pair
        sendMessage(aliceWs, {
          type: 'register',
          pairingCode: codeAlice,
          publicKey: VALID_PUBKEY_1,
        });
        sendMessage(bobWs, {
          type: 'register',
          pairingCode: codeBob,
          publicKey: VALID_PUBKEY_2,
        });

        await waitForMessage(aliceWs, 'registered', 10000);
        await waitForMessage(bobWs, 'registered', 10000);

        sendMessage(aliceWs, {
          type: 'pair_request',
          targetCode: codeBob,
        });

        await waitForMessage(bobWs, 'pair_incoming');

        sendMessage(bobWs, {
          type: 'pair_response',
          targetCode: codeAlice,
          accepted: true,
        });

        await waitForMessage(aliceWs, 'pair_matched');
        await waitForMessage(bobWs, 'pair_matched');

        // Alice sends an offer to Bob
        // Note: server expects 'target' not 'targetCode', and 'payload' for the data
        sendMessage(aliceWs, {
          type: 'offer',
          target: codeBob,
          payload: {
            sdp: 'v=0\r\no=- 1234567890 1234567890 IN IP4 0.0.0.0\r\n',
          },
        });

        // Bob should receive the offer
        const offer = await waitForMessage(bobWs, 'offer');
        expect(offer.from).toBe(codeAlice);
        expect(offer.payload).toBeDefined();

        // Bob sends answer back
        sendMessage(bobWs, {
          type: 'answer',
          target: codeAlice,
          payload: {
            sdp: 'v=0\r\no=- 1234567890 1234567890 IN IP4 0.0.0.0\r\n',
          },
        });

        // Alice receives the answer
        const answer = await waitForMessage(aliceWs, 'answer');
        expect(answer.from).toBe(codeBob);
        expect(answer.payload).toBeDefined();
      } finally {
        aliceWs.close();
        bobWs.close();
      }
    });

    it('should relay ICE candidates', { timeout: 30000 }, async () => {
      const { ws: aliceWs } = await createWsClient(serverHarness.getWsUrl(), 10000);
      const { ws: bobWs } = await createWsClient(serverHarness.getWsUrl(), 10000);

      try {
        // Note: I and O are excluded from valid pairing codes
        const codeAlice = 'CND234';
        const codeBob = 'CND567';

        // Register and pair
        sendMessage(aliceWs, {
          type: 'register',
          pairingCode: codeAlice,
          publicKey: VALID_PUBKEY_1,
        });
        sendMessage(bobWs, {
          type: 'register',
          pairingCode: codeBob,
          publicKey: VALID_PUBKEY_2,
        });

        await waitForMessage(aliceWs, 'registered', 10000);
        await waitForMessage(bobWs, 'registered', 10000);

        sendMessage(aliceWs, {
          type: 'pair_request',
          targetCode: codeBob,
        });

        await waitForMessage(bobWs, 'pair_incoming');

        sendMessage(bobWs, {
          type: 'pair_response',
          targetCode: codeAlice,
          accepted: true,
        });

        await waitForMessage(aliceWs, 'pair_matched');
        await waitForMessage(bobWs, 'pair_matched');

        // Alice sends ICE candidate
        // Note: server expects 'target' not 'targetCode', and 'payload' for the data
        sendMessage(aliceWs, {
          type: 'ice_candidate',
          target: codeBob,
          payload: {
            candidate: 'candidate:1234 1 udp 2122194687 192.168.1.1 12345 typ host',
            sdpMid: '0',
            sdpMLineIndex: 0,
          },
        });

        // Bob receives ICE candidate
        const candidate = await waitForMessage(bobWs, 'ice_candidate');
        expect(candidate.from).toBe(codeAlice);
        expect(candidate.payload).toBeDefined();
      } finally {
        aliceWs.close();
        bobWs.close();
      }
    });
  });

  describe('Server Cleanup and Shutdown', () => {
    it('should clean up client state on disconnect', { timeout: 15000 }, async () => {
      const mockBootstrap = await createMockBootstrap({ port: 0 });
      const serverHarness = new TestServerHarness({
        bootstrapUrl: mockBootstrap.getUrl(),
      });
      await serverHarness.start();

      try {
        // Connect and register
        const { ws: aliceWs } = await createWsClient(serverHarness.getWsUrl());

        sendMessage(aliceWs, {
          type: 'register',
          pairingCode: 'CLN234',
          publicKey: VALID_PUBKEY_1,
        });

        await waitForMessage(aliceWs, 'registered');

        // Disconnect
        aliceWs.close();

        // Wait a bit for cleanup
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Try to pair with disconnected client
        const { ws: bobWs } = await createWsClient(serverHarness.getWsUrl());

        sendMessage(bobWs, {
          type: 'register',
          pairingCode: 'CLN567',
          publicKey: VALID_PUBKEY_2,
        });

        await waitForMessage(bobWs, 'registered');

        sendMessage(bobWs, {
          type: 'pair_request',
          targetCode: 'CLN234',
        });

        const error = await waitForMessage(bobWs, 'pair_error');
        expect(error.error).toBe('Pair request could not be processed');

        bobWs.close();
      } finally {
        await serverHarness.stop();
        await mockBootstrap.stop();
      }
    });

    it('should unregister from bootstrap on shutdown', { timeout: 15000 }, async () => {
      const mockBootstrap = await createMockBootstrap({ port: 0 });
      const serverHarness = new TestServerHarness({
        bootstrapUrl: mockBootstrap.getUrl(),
      });

      await serverHarness.start();

      // Give time to register
      await new Promise((resolve) => setTimeout(resolve, 500));

      const serverId = serverHarness.identity.serverId;
      expect(mockBootstrap.getServer(serverId)).toBeDefined();

      await serverHarness.stop();

      // Should be unregistered
      expect(mockBootstrap.getServer(serverId)).toBeUndefined();

      await mockBootstrap.stop();
    });

    it('should handle graceful shutdown with active connections', { timeout: 15000 }, async () => {
      const mockBootstrap = await createMockBootstrap({ port: 0 });
      const serverHarness = new TestServerHarness({
        bootstrapUrl: mockBootstrap.getUrl(),
        shutdownTimeout: 5000,
      });

      await serverHarness.start();

      // Connect clients
      const clients = await Promise.all([
        createWsClient(serverHarness.getWsUrl()),
        createWsClient(serverHarness.getWsUrl()),
      ]);

      // Shutdown should complete without error
      await serverHarness.stop();

      expect(serverHarness.isRunning).toBe(false);

      // Clean up clients
      clients.forEach(({ ws }) => ws.close());

      await mockBootstrap.stop();
    });
  });

  describe('Multiple Server Federation', () => {
    let mockBootstrap: MockBootstrapServer;
    let server1: TestServerHarness;
    let server2: TestServerHarness;

    beforeAll(async () => {
      mockBootstrap = await createMockBootstrap({ port: 0 });

      server1 = new TestServerHarness({
        bootstrapUrl: mockBootstrap.getUrl(),
        region: 'region-1',
      });
      server2 = new TestServerHarness({
        bootstrapUrl: mockBootstrap.getUrl(),
        region: 'region-2',
      });

      await Promise.all([server1.start(), server2.start()]);

      // Wait for both to register
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    afterAll(async () => {
      await Promise.all([server1.stop(), server2.stop()]);
      await mockBootstrap.stop();
    }, 30000); // Allow more time for multiple server shutdown

    it('should have both servers registered in bootstrap', () => {
      expect(mockBootstrap.serverCount).toBe(2);
      expect(mockBootstrap.getServer(server1.identity.serverId)).toBeDefined();
      expect(mockBootstrap.getServer(server2.identity.serverId)).toBeDefined();
    });

    it('should allow clients to connect to both servers', { timeout: 10000 }, async () => {
      const { ws: ws1, serverInfo: info1 } = await createWsClient(server1.getWsUrl());
      const { ws: ws2, serverInfo: info2 } = await createWsClient(server2.getWsUrl());

      try {
        expect(info1.serverId).toBe(server1.identity.serverId);
        expect(info2.serverId).toBe(server2.identity.serverId);
        expect(info1.serverId).not.toBe(info2.serverId);
      } finally {
        ws1.close();
        ws2.close();
      }
    });

    it('should have different regions for each server', { timeout: 10000 }, async () => {
      const testSecret = 'test-stats-secret-federation';
      const originalSecret = process.env['STATS_SECRET'];
      process.env['STATS_SECRET'] = testSecret;

      try {
        const headers = { 'Authorization': `Bearer ${testSecret}` };
        const [stats1, stats2] = await Promise.all([
          fetch(`${server1.getUrl()}/stats`, { headers }).then(r => r.json()),
          fetch(`${server2.getUrl()}/stats`, { headers }).then(r => r.json()),
        ]) as [{ region: string }, { region: string }];

        expect(stats1.region).toBe('region-1');
        expect(stats2.region).toBe('region-2');
      } finally {
        if (originalSecret !== undefined) {
          process.env['STATS_SECRET'] = originalSecret;
        } else {
          delete process.env['STATS_SECRET'];
        }
      }
    });
  });
});
