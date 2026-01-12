/**
 * Pairing Flow Integration Tests
 *
 * Tests the complete pairing flow from VPS server perspective,
 * combining browser-based web client with direct WebSocket connections
 * to simulate various client scenarios.
 *
 * Test Scenarios:
 * - VPS server accepting pairing registrations
 * - Browser client pairing with WebSocket client
 * - Pairing timeout and error handling
 * - Multi-client scenarios
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import { TestOrchestrator, delay, waitFor, getNextPort } from '../orchestrator';

describe('Pairing Flow Integration Tests', () => {
  let orchestrator: TestOrchestrator;

  beforeAll(async () => {
    orchestrator = new TestOrchestrator({
      headless: true,
      verbose: false,
      startupTimeout: 30000,
    });

    await orchestrator.startMockBootstrap();
    await orchestrator.startVpsServer();
  }, 45000);

  afterAll(async () => {
    await orchestrator.cleanup();
  }, 30000);

  describe('VPS Server Pairing Registration', () => {
    it('should accept client registration with valid pairing code', async () => {
      const { ws, serverInfo } = await orchestrator.createWsClient();

      try {
        expect(serverInfo).toBeDefined();
        expect((serverInfo as { type: string }).type).toBe('server_info');
        expect((serverInfo as { serverId: string }).serverId).toBeDefined();

        // Register with a valid pairing code
        const pairingCode = 'ABC234';
        const publicKey = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDE='; // Valid base64 32-byte key

        ws.send(JSON.stringify({
          type: 'register',
          pairingCode,
          publicKey,
        }));

        // Wait for registered response
        const registered = await orchestrator.waitForMessage(ws, 'registered') as {
          type: string;
          pairingCode: string;
          serverId: string;
        };

        expect(registered.type).toBe('registered');
        expect(registered.pairingCode).toBe(pairingCode);
        expect(registered.serverId).toBeDefined();
      } finally {
        ws.close();
      }
    }, 15000);

    it('should reject registration with invalid pairing code format', async () => {
      const { ws } = await orchestrator.createWsClient();

      try {
        // Register with invalid pairing code (contains invalid characters)
        ws.send(JSON.stringify({
          type: 'register',
          pairingCode: 'ABC123', // '1' is not in allowed character set
          publicKey: 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDE=',
        }));

        // Should receive an error
        const response = await orchestrator.waitForMessage(ws, 'error') as { message: string };
        expect(response.message).toBeDefined();
      } finally {
        ws.close();
      }
    }, 15000);

    it('should reject registration with invalid public key', async () => {
      const { ws } = await orchestrator.createWsClient();

      try {
        // Register with invalid public key (not valid base64 or wrong length)
        ws.send(JSON.stringify({
          type: 'register',
          pairingCode: 'XYZ567',
          publicKey: 'invalid-key',
        }));

        // Should receive an error
        const response = await orchestrator.waitForMessage(ws, 'error') as { message: string };
        expect(response.message).toBeDefined();
      } finally {
        ws.close();
      }
    }, 15000);
  });

  describe('Pairing Between Two WebSocket Clients', () => {
    it('should complete pairing between two clients', async () => {
      const { ws: ws1 } = await orchestrator.createWsClient();
      const { ws: ws2 } = await orchestrator.createWsClient();

      const code1 = 'PEER22';
      const code2 = 'PEER33';
      const pubKey1 = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDE=';
      const pubKey2 = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDI=';

      try {
        // Register both clients
        ws1.send(JSON.stringify({ type: 'register', pairingCode: code1, publicKey: pubKey1 }));
        ws2.send(JSON.stringify({ type: 'register', pairingCode: code2, publicKey: pubKey2 }));

        await orchestrator.waitForMessage(ws1, 'registered');
        await orchestrator.waitForMessage(ws2, 'registered');

        // Client 1 initiates pairing with Client 2
        ws1.send(JSON.stringify({ type: 'pair_request', targetCode: code2 }));

        // Client 2 should receive pair_incoming
        const incoming = await orchestrator.waitForMessage(ws2, 'pair_incoming') as {
          fromCode: string;
          fromPublicKey: string;
        };
        expect(incoming.fromCode).toBe(code1);
        expect(incoming.fromPublicKey).toBe(pubKey1);

        // Client 2 accepts
        ws2.send(JSON.stringify({ type: 'pair_response', targetCode: code1, accepted: true }));

        // Both should receive pair_matched
        const matched1 = await orchestrator.waitForMessage(ws1, 'pair_matched') as {
          peerCode: string;
          peerPublicKey: string;
          isInitiator: boolean;
        };
        const matched2 = await orchestrator.waitForMessage(ws2, 'pair_matched') as {
          peerCode: string;
          peerPublicKey: string;
          isInitiator: boolean;
        };

        expect(matched1.peerCode).toBe(code2);
        expect(matched1.peerPublicKey).toBe(pubKey2);
        expect(matched1.isInitiator).toBe(true);

        expect(matched2.peerCode).toBe(code1);
        expect(matched2.peerPublicKey).toBe(pubKey1);
        expect(matched2.isInitiator).toBe(false);
      } finally {
        ws1.close();
        ws2.close();
      }
    }, 20000);

    it('should handle pairing rejection', async () => {
      const { ws: ws1 } = await orchestrator.createWsClient();
      const { ws: ws2 } = await orchestrator.createWsClient();

      const code1 = 'REJ222';
      const code2 = 'REJ333';
      const pubKey = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDE=';

      try {
        // Register both
        ws1.send(JSON.stringify({ type: 'register', pairingCode: code1, publicKey: pubKey }));
        ws2.send(JSON.stringify({ type: 'register', pairingCode: code2, publicKey: pubKey }));

        await orchestrator.waitForMessage(ws1, 'registered');
        await orchestrator.waitForMessage(ws2, 'registered');

        // Client 1 requests pairing
        ws1.send(JSON.stringify({ type: 'pair_request', targetCode: code2 }));

        // Client 2 receives and rejects
        await orchestrator.waitForMessage(ws2, 'pair_incoming');
        ws2.send(JSON.stringify({ type: 'pair_response', targetCode: code1, accepted: false }));

        // Client 1 should receive pair_rejected
        const rejected = await orchestrator.waitForMessage(ws1, 'pair_rejected') as { peerCode: string };
        expect(rejected.peerCode).toBe(code2);
      } finally {
        ws1.close();
        ws2.close();
      }
    }, 20000);

    it('should handle pairing to non-existent code', async () => {
      const { ws } = await orchestrator.createWsClient();

      try {
        // Register
        ws.send(JSON.stringify({
          type: 'register',
          pairingCode: 'EXIST2',
          publicKey: 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDE=',
        }));

        await orchestrator.waitForMessage(ws, 'registered');

        // Request pairing with non-existent code
        ws.send(JSON.stringify({ type: 'pair_request', targetCode: 'NOCODE' }));

        // Should receive pair_error
        const error = await orchestrator.waitForMessage(ws, 'pair_error') as { error: string };
        expect(error.error).toBeDefined();
      } finally {
        ws.close();
      }
    }, 15000);
  });

  describe('WebRTC Signaling Exchange', () => {
    it('should relay offer/answer between paired clients', async () => {
      const { ws: ws1 } = await orchestrator.createWsClient();
      const { ws: ws2 } = await orchestrator.createWsClient();

      const code1 = 'SIG222';
      const code2 = 'SIG333';
      const pubKey = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDE=';

      try {
        // Register and pair
        ws1.send(JSON.stringify({ type: 'register', pairingCode: code1, publicKey: pubKey }));
        ws2.send(JSON.stringify({ type: 'register', pairingCode: code2, publicKey: pubKey }));

        await orchestrator.waitForMessage(ws1, 'registered');
        await orchestrator.waitForMessage(ws2, 'registered');

        ws1.send(JSON.stringify({ type: 'pair_request', targetCode: code2 }));
        await orchestrator.waitForMessage(ws2, 'pair_incoming');
        ws2.send(JSON.stringify({ type: 'pair_response', targetCode: code1, accepted: true }));

        await orchestrator.waitForMessage(ws1, 'pair_matched');
        await orchestrator.waitForMessage(ws2, 'pair_matched');

        // Client 1 sends offer
        const mockOffer = { type: 'offer', sdp: 'mock-sdp-offer' };
        ws1.send(JSON.stringify({
          type: 'offer',
          target: code2,
          payload: mockOffer,
        }));

        // Client 2 should receive the offer
        const receivedOffer = await orchestrator.waitForMessage(ws2, 'offer') as {
          from: string;
          payload: { type: string; sdp: string };
        };
        expect(receivedOffer.from).toBe(code1);
        expect(receivedOffer.payload.sdp).toBe('mock-sdp-offer');

        // Client 2 sends answer
        const mockAnswer = { type: 'answer', sdp: 'mock-sdp-answer' };
        ws2.send(JSON.stringify({
          type: 'answer',
          target: code1,
          payload: mockAnswer,
        }));

        // Client 1 should receive the answer
        const receivedAnswer = await orchestrator.waitForMessage(ws1, 'answer') as {
          from: string;
          payload: { type: string; sdp: string };
        };
        expect(receivedAnswer.from).toBe(code2);
        expect(receivedAnswer.payload.sdp).toBe('mock-sdp-answer');
      } finally {
        ws1.close();
        ws2.close();
      }
    }, 25000);

    it('should relay ICE candidates between paired clients', async () => {
      const { ws: ws1 } = await orchestrator.createWsClient();
      const { ws: ws2 } = await orchestrator.createWsClient();

      const code1 = 'ICE222';
      const code2 = 'ICE333';
      const pubKey = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDE=';

      try {
        // Register and pair
        ws1.send(JSON.stringify({ type: 'register', pairingCode: code1, publicKey: pubKey }));
        ws2.send(JSON.stringify({ type: 'register', pairingCode: code2, publicKey: pubKey }));

        await orchestrator.waitForMessage(ws1, 'registered');
        await orchestrator.waitForMessage(ws2, 'registered');

        ws1.send(JSON.stringify({ type: 'pair_request', targetCode: code2 }));
        await orchestrator.waitForMessage(ws2, 'pair_incoming');
        ws2.send(JSON.stringify({ type: 'pair_response', targetCode: code1, accepted: true }));

        await orchestrator.waitForMessage(ws1, 'pair_matched');
        await orchestrator.waitForMessage(ws2, 'pair_matched');

        // Client 1 sends ICE candidate
        const mockCandidate = {
          candidate: 'candidate:mock-ice-candidate',
          sdpMLineIndex: 0,
          sdpMid: 'audio',
        };
        ws1.send(JSON.stringify({
          type: 'ice_candidate',
          target: code2,
          payload: mockCandidate,
        }));

        // Client 2 should receive the ICE candidate
        const receivedCandidate = await orchestrator.waitForMessage(ws2, 'ice_candidate') as {
          from: string;
          payload: { candidate: string };
        };
        expect(receivedCandidate.from).toBe(code1);
        expect(receivedCandidate.payload.candidate).toBe('candidate:mock-ice-candidate');
      } finally {
        ws1.close();
        ws2.close();
      }
    }, 25000);
  });

  describe('Browser to WebSocket Client Pairing', () => {
    it('should pair browser client with WebSocket client', async () => {
      // Start web client for browser test
      await orchestrator.startWebClient();
      const browser = await orchestrator.connectWebBrowser();

      // Create WebSocket client
      const { ws } = await orchestrator.createWsClient();
      const wsCode = 'BRWS22';
      const wsPubKey = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDE=';

      try {
        // Register WebSocket client
        ws.send(JSON.stringify({
          type: 'register',
          pairingCode: wsCode,
          publicKey: wsPubKey,
        }));

        await orchestrator.waitForMessage(ws, 'registered');

        // Wait for browser to be ready and get its code
        await browser.page.waitForSelector('[data-testid="my-code"], .my-code, .code-display', {
          timeout: 30000,
          state: 'visible',
        }).catch(() => {
          // Fallback
          return browser.page.waitForFunction(
            () => /[A-HJ-NP-Z2-9]{6}/.test(document.body.innerText),
            { timeout: 30000 }
          );
        });

        // Get browser's pairing code
        const content = await browser.page.content();
        const browserCodeMatch = content.match(/[A-HJ-NP-Z2-9]{6}/);
        expect(browserCodeMatch).toBeTruthy();
        const browserCode = browserCodeMatch![0];

        // WebSocket client requests pairing with browser
        ws.send(JSON.stringify({ type: 'pair_request', targetCode: browserCode }));

        // Browser should show incoming request
        await browser.page.waitForSelector(
          '[data-testid="approval-request"], .approval-request, button:has-text("Accept")',
          { timeout: 15000, state: 'visible' }
        );

        // Accept in browser
        const acceptButton = await browser.page.waitForSelector(
          'button:has-text("Accept"), button:has-text("Approve")',
          { timeout: 5000 }
        );
        await acceptButton.click();

        // WebSocket client should receive pair_matched
        const matched = await orchestrator.waitForMessage(ws, 'pair_matched', 15000) as {
          peerCode: string;
          isInitiator: boolean;
        };

        expect(matched.peerCode).toBe(browserCode);
        expect(matched.isInitiator).toBe(true);
      } finally {
        ws.close();
        await browser.browser.close();
      }
    }, 60000);
  });

  describe('Multi-Client Scenarios', () => {
    it('should handle multiple simultaneous registrations', async () => {
      const clients: { ws: WebSocket; code: string }[] = [];
      const numClients = 5;

      try {
        // Create multiple clients
        for (let i = 0; i < numClients; i++) {
          const { ws } = await orchestrator.createWsClient();
          const code = `MULT${String(i).padStart(2, '2')}`;
          clients.push({ ws, code });
        }

        // Register all clients
        const registrationPromises = clients.map(async ({ ws, code }) => {
          ws.send(JSON.stringify({
            type: 'register',
            pairingCode: code,
            publicKey: 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDE=',
          }));

          return orchestrator.waitForMessage(ws, 'registered');
        });

        const results = await Promise.all(registrationPromises);

        // All should be registered
        results.forEach((result, i) => {
          expect((result as { type: string }).type).toBe('registered');
          expect((result as { pairingCode: string }).pairingCode).toBe(clients[i].code);
        });
      } finally {
        clients.forEach(({ ws }) => ws.close());
      }
    }, 30000);

    it('should handle client disconnection during pairing', async () => {
      const { ws: ws1 } = await orchestrator.createWsClient();
      const { ws: ws2 } = await orchestrator.createWsClient();

      const code1 = 'DISC22';
      const code2 = 'DISC33';
      const pubKey = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDE=';

      try {
        // Register both
        ws1.send(JSON.stringify({ type: 'register', pairingCode: code1, publicKey: pubKey }));
        ws2.send(JSON.stringify({ type: 'register', pairingCode: code2, publicKey: pubKey }));

        await orchestrator.waitForMessage(ws1, 'registered');
        await orchestrator.waitForMessage(ws2, 'registered');

        // Client 1 requests pairing
        ws1.send(JSON.stringify({ type: 'pair_request', targetCode: code2 }));

        // Wait for pair_incoming on client 2
        await orchestrator.waitForMessage(ws2, 'pair_incoming');

        // Client 2 disconnects before responding
        ws2.close();

        // Wait a bit for server to detect disconnection
        await delay(2000);

        // Try to pair with same code should fail (client disconnected)
        const { ws: ws3 } = await orchestrator.createWsClient();
        ws3.send(JSON.stringify({ type: 'register', pairingCode: 'NEW333', publicKey: pubKey }));
        await orchestrator.waitForMessage(ws3, 'registered');

        ws3.send(JSON.stringify({ type: 'pair_request', targetCode: code2 }));

        // Should get an error (peer not found)
        const error = await orchestrator.waitForMessage(ws3, 'pair_error') as { error: string };
        expect(error.error).toBeDefined();

        ws3.close();
      } finally {
        ws1.close();
      }
    }, 25000);
  });

  describe('Ping/Pong Keep-Alive', () => {
    it('should respond to ping with pong', async () => {
      const { ws } = await orchestrator.createWsClient();

      try {
        // Send ping
        ws.send(JSON.stringify({ type: 'ping' }));

        // Should receive pong
        const pong = await orchestrator.waitForMessage(ws, 'pong');
        expect((pong as { type: string }).type).toBe('pong');
      } finally {
        ws.close();
      }
    }, 10000);
  });
});
