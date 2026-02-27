/**
 * Client Handler Pairing Logic Tests
 *
 * Tests for pairing code-based WebRTC signaling:
 * - Pair request handling
 * - Pair response handling
 * - Timeout handling
 * - Rate limiting
 * - Cleanup on disconnect
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { ClientHandler, type ClientHandlerConfig } from '../../src/client/handler.js';
import { RelayRegistry } from '../../src/registry/relay-registry.js';
import { DistributedRendezvous } from '../../src/registry/distributed-rendezvous.js';
import type { ServerIdentity } from '../../src/types.js';

// Valid 32-byte base64-encoded public keys for testing
// The handler now validates that public keys are valid base64-encoded 32-byte values
const VALID_PUBKEY_1 = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDE='; // 32 bytes of '0' + '1'
const VALID_PUBKEY_2 = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDI='; // 32 bytes of '0' + '2'
const VALID_PUBKEY_3 = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDM='; // 32 bytes of '0' + '3'

// Valid pairing codes for testing (Issue #17: 6-char alphanumeric, excluding I, O, 0, 1)
// Format: [ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}
const VALID_CODE_REQ = 'REQ234'; // requester
const VALID_CODE_TGT = 'TGT567'; // target
const VALID_CODE_CLI = 'CLT789'; // client (use T not I)
const VALID_CODE_OTH = 'XTH234'; // other (use X not O)
const VALID_CODE_EXT = 'EXT567'; // extra
const VALID_CODE_SLF = 'SLF789'; // self
const VALID_CODE_DSC = 'DSC234'; // disconnect-test
const VALID_CODE_C1 = 'CCC222'; // client-1 (use 2 not 1)
const VALID_CODE_C2 = 'CCC333'; // client-2

// Array of valid pairing codes for loop-based testing (indices 0-9)
const VALID_CODES: string[] = [
  'REQ222', 'REQ333', 'REQ444', 'REQ555', 'REQ666',
  'REQ777', 'REQ888', 'REQ999', 'REQ223', 'REQ224',
];

// Array of valid public keys for loop-based testing (indices 0-9)
const VALID_PUBKEYS: string[] = [
  'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMTA=', // index 0: '...10'
  'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMTE=', // index 1: '...11'
  'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMTI=', // index 2: '...12'
  'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMTM=', // index 3: '...13'
  'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMTQ=', // index 4: '...14'
  'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMTU=', // index 5: '...15'
  'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMTY=', // index 6: '...16'
  'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMTc=', // index 7: '...17'
  'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMTg=', // index 8: '...18'
  'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMTk=', // index 9: '...19'
];

// Mock WebSocket implementation
class MockWebSocket extends EventEmitter {
  readyState: number = 1; // OPEN
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  sentMessages: any[] = [];

  send(data: string): void {
    if (this.readyState === MockWebSocket.OPEN) {
      this.sentMessages.push(JSON.parse(data));
    }
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  get OPEN(): number {
    return MockWebSocket.OPEN;
  }

  getLastMessage(): any {
    return this.sentMessages[this.sentMessages.length - 1];
  }

  clearMessages(): void {
    this.sentMessages = [];
  }
}

// Mock DistributedRendezvous
class MockDistributedRendezvous extends EventEmitter {
  async registerDailyPoints() {
    return { local: { deadDrops: [] }, redirects: [] };
  }

  async registerHourlyTokens() {
    return { local: { liveMatches: [] }, redirects: [] };
  }

  async unregisterPeer() {}
}

describe('ClientHandler Pairing Logic', () => {
  let handler: ClientHandler;
  let relayRegistry: RelayRegistry;
  let distributedRendezvous: MockDistributedRendezvous;
  let identity: ServerIdentity;
  let config: ClientHandlerConfig;

  beforeEach(() => {
    vi.useFakeTimers();

    identity = {
      serverId: 'test-server-1',
      nodeId: 'test-node-1',
      ephemeralId: 'srv-test-1',
      publicKey: new Uint8Array(32).fill(1),
      privateKey: new Uint8Array(64).fill(2),
    };

    config = {
      heartbeatInterval: 30000,
      heartbeatTimeout: 90000,
      maxConnectionsPerPeer: 20,
      pairRequestTimeout: 120000, // 2 minutes (Issue #35)
      pairRequestWarningTime: 30000, // 30 seconds before timeout
    };

    relayRegistry = new RelayRegistry();
    distributedRendezvous = new MockDistributedRendezvous();

    handler = new ClientHandler(
      identity,
      'ws://localhost:8080',
      config,
      relayRegistry,
      distributedRendezvous as unknown as DistributedRendezvous
    );
  });

  afterEach(async () => {
    await handler.shutdown();
    vi.useRealTimers();
  });

  /**
   * Helper to create and register a mock WebSocket client with a pairing code
   */
  async function createAndRegisterClient(pairingCode: string, publicKey: string): Promise<MockWebSocket> {
    const ws = new MockWebSocket();
    handler.handleConnection(ws as any);
    ws.clearMessages(); // Clear server_info message

    await handler.handleMessage(ws as any, JSON.stringify({
      type: 'register',
      pairingCode,
      publicKey,
    }));

    ws.clearMessages(); // Clear registered message
    return ws;
  }

  describe('Pair Request Handling', () => {
    it('should store pending request correctly', async () => {
      const requesterWs = await createAndRegisterClient(VALID_CODE_REQ, VALID_PUBKEY_1);
      const targetWs = await createAndRegisterClient(VALID_CODE_TGT, VALID_PUBKEY_2);

      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: VALID_CODE_TGT,
      }));

      // Target should receive pair_incoming with expiresIn field
      const targetMsg = targetWs.getLastMessage();
      expect(targetMsg).toEqual({
        type: 'pair_incoming',
        fromCode: VALID_CODE_REQ,
        fromPublicKey: VALID_PUBKEY_1,
        expiresIn: 120000, // 2 minutes timeout for fingerprint verification
      });
    });

    it('should notify target client with pair_incoming', async () => {
      const requesterWs = await createAndRegisterClient(VALID_CODE_REQ, VALID_PUBKEY_1);
      const targetWs = await createAndRegisterClient(VALID_CODE_TGT, VALID_PUBKEY_2);

      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: VALID_CODE_TGT,
      }));

      expect(targetWs.sentMessages).toContainEqual({
        type: 'pair_incoming',
        fromCode: VALID_CODE_REQ,
        fromPublicKey: VALID_PUBKEY_1,
        expiresIn: 120000, // 2 minutes timeout for fingerprint verification
      });
    });

    it('should return error for non-existent target code', async () => {
      const requesterWs = await createAndRegisterClient(VALID_CODE_REQ, VALID_PUBKEY_1);

      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: 'ZZZZZ9', // Valid format but not registered (no O or I)
      }));

      const errorMsg = requesterWs.getLastMessage();
      expect(errorMsg.type).toBe('pair_error');
      expect(errorMsg.error).toBe('Pair request could not be processed');
    });

    it('should limit pending requests per target (max 10)', async () => {
      const targetWs = await createAndRegisterClient(VALID_CODE_TGT, VALID_PUBKEY_2);

      // Create 10 requesters and send pair requests
      const requesters: MockWebSocket[] = [];
      for (let i = 0; i < 10; i++) {
        const ws = await createAndRegisterClient(VALID_CODES[i], VALID_PUBKEYS[i]);
        requesters.push(ws);
        await handler.handleMessage(ws as any, JSON.stringify({
          type: 'pair_request',
          targetCode: VALID_CODE_TGT,
        }));
      }

      // Target should have received 10 pair_incoming messages
      expect(targetWs.sentMessages.filter(m => m.type === 'pair_incoming')).toHaveLength(10);

      // 11th request should fail
      const extraRequester = await createAndRegisterClient(VALID_CODE_EXT, VALID_PUBKEY_3);
      await handler.handleMessage(extraRequester as any, JSON.stringify({
        type: 'pair_request',
        targetCode: VALID_CODE_TGT,
      }));

      const errorMsg = extraRequester.getLastMessage();
      expect(errorMsg.type).toBe('pair_error');
      expect(errorMsg.error).toBe('Pair request could not be processed');
    });

    it('should reject pair request to self', async () => {
      const ws = await createAndRegisterClient(VALID_CODE_SLF, VALID_PUBKEY_1);

      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'pair_request',
        targetCode: VALID_CODE_SLF,
      }));

      const errorMsg = ws.getLastMessage();
      expect(errorMsg.type).toBe('pair_error');
      expect(errorMsg.error).toBe('Pair request could not be processed');
    });

    it('should reject pair request from unregistered client', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      ws.clearMessages();

      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'pair_request',
        targetCode: 'AAATGT', // Valid format but not registered
      }));

      const errorMsg = ws.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toContain('Not registered');
    });

    it('should replace existing request from same requester', async () => {
      const requesterWs = await createAndRegisterClient(VALID_CODE_REQ, VALID_PUBKEY_1);
      const targetWs = await createAndRegisterClient(VALID_CODE_TGT, VALID_PUBKEY_2);

      // First request
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: VALID_CODE_TGT,
      }));

      // Second request from same requester (should replace, not add)
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: VALID_CODE_TGT,
      }));

      // Target should have received 2 notifications (one for each request)
      const incomingMsgs = targetWs.sentMessages.filter(m => m.type === 'pair_incoming');
      expect(incomingMsgs).toHaveLength(2);

      // But internally there should only be 1 pending request
      // Verify by accepting and checking no duplicates
      targetWs.clearMessages();
      await handler.handleMessage(targetWs as any, JSON.stringify({
        type: 'pair_response',
        targetCode: VALID_CODE_REQ,
        accepted: true,
      }));

      // Requester should get exactly one pair_matched
      const matchedMsgs = requesterWs.sentMessages.filter(m => m.type === 'pair_matched');
      expect(matchedMsgs).toHaveLength(1);
    });
  });

  describe('Pair Response Handling', () => {
    it('should send pair_matched to both when accepted', async () => {
      const requesterWs = await createAndRegisterClient(VALID_CODE_REQ, VALID_PUBKEY_1);
      const targetWs = await createAndRegisterClient(VALID_CODE_TGT, VALID_PUBKEY_2);

      // Send pair request
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: VALID_CODE_TGT,
      }));

      targetWs.clearMessages();
      requesterWs.clearMessages();

      // Accept the request
      await handler.handleMessage(targetWs as any, JSON.stringify({
        type: 'pair_response',
        targetCode: VALID_CODE_REQ,
        accepted: true,
      }));

      // Both should receive pair_matched
      const requesterMatched = requesterWs.sentMessages.find(m => m.type === 'pair_matched');
      const targetMatched = targetWs.sentMessages.find(m => m.type === 'pair_matched');

      expect(requesterMatched).toEqual({
        type: 'pair_matched',
        peerCode: VALID_CODE_TGT,
        peerPublicKey: VALID_PUBKEY_2,
        isInitiator: true,
      });

      expect(targetMatched).toEqual({
        type: 'pair_matched',
        peerCode: VALID_CODE_REQ,
        peerPublicKey: VALID_PUBKEY_1,
        isInitiator: false,
      });
    });

    it('should send pair_rejected to requester when rejected', async () => {
      const requesterWs = await createAndRegisterClient(VALID_CODE_REQ, VALID_PUBKEY_1);
      const targetWs = await createAndRegisterClient(VALID_CODE_TGT, VALID_PUBKEY_2);

      // Send pair request
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: VALID_CODE_TGT,
      }));

      requesterWs.clearMessages();

      // Reject the request
      await handler.handleMessage(targetWs as any, JSON.stringify({
        type: 'pair_response',
        targetCode: VALID_CODE_REQ,
        accepted: false,
      }));

      // Requester should receive pair_rejected
      const rejectedMsg = requesterWs.sentMessages.find(m => m.type === 'pair_rejected');
      expect(rejectedMsg).toEqual({
        type: 'pair_rejected',
        peerCode: VALID_CODE_TGT,
      });

      // Target should not receive pair_rejected (they did the rejecting)
      expect(targetWs.sentMessages.find(m => m.type === 'pair_rejected')).toBeUndefined();
    });

    it('should clear pending request after response', async () => {
      const requesterWs = await createAndRegisterClient(VALID_CODE_REQ, VALID_PUBKEY_1);
      const targetWs = await createAndRegisterClient(VALID_CODE_TGT, VALID_PUBKEY_2);

      // Send pair request
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: VALID_CODE_TGT,
      }));

      // Accept the request
      await handler.handleMessage(targetWs as any, JSON.stringify({
        type: 'pair_response',
        targetCode: VALID_CODE_REQ,
        accepted: true,
      }));

      targetWs.clearMessages();

      // Try to respond again - should fail since request was cleared
      await handler.handleMessage(targetWs as any, JSON.stringify({
        type: 'pair_response',
        targetCode: VALID_CODE_REQ,
        accepted: true,
      }));

      const errorMsg = targetWs.getLastMessage();
      expect(errorMsg.type).toBe('pair_error');
      expect(errorMsg.error).toBe('No pending request from this peer');
    });

    it('should return error for non-existent pending request', async () => {
      const targetWs = await createAndRegisterClient(VALID_CODE_TGT, VALID_PUBKEY_2);

      // Try to respond to non-existent request
      await handler.handleMessage(targetWs as any, JSON.stringify({
        type: 'pair_response',
        targetCode: 'ZZZZZ9', // Valid format but not registered (no O or I)
        accepted: true,
      }));

      const errorMsg = targetWs.getLastMessage();
      expect(errorMsg.type).toBe('pair_error');
      expect(errorMsg.error).toBe('No pending request from this peer');
    });
  });

  describe('Timeout Handling', () => {
    it('should send pair_timeout for expired requests', async () => {
      const requesterWs = await createAndRegisterClient(VALID_CODE_REQ, VALID_PUBKEY_1);
      await createAndRegisterClient(VALID_CODE_TGT, VALID_PUBKEY_2);

      // Send pair request
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: VALID_CODE_TGT,
      }));

      requesterWs.clearMessages();

      // Advance time past the timeout (120 seconds - Issue #35)
      vi.advanceTimersByTime(120001);

      // Requester should receive pair_timeout
      const timeoutMsg = requesterWs.sentMessages.find(m => m.type === 'pair_timeout');
      expect(timeoutMsg).toEqual({
        type: 'pair_timeout',
        peerCode: VALID_CODE_TGT,
      });
    });

    it('should send pair_expiring warning before timeout (Issue #35)', async () => {
      const requesterWs = await createAndRegisterClient(VALID_CODE_REQ, VALID_PUBKEY_1);
      const targetWs = await createAndRegisterClient(VALID_CODE_TGT, VALID_PUBKEY_2);

      // Send pair request
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: VALID_CODE_TGT,
      }));

      requesterWs.clearMessages();
      targetWs.clearMessages();

      // Advance time to just before the warning (90 seconds = 120s - 30s warning)
      vi.advanceTimersByTime(89999);

      // Neither should have received pair_expiring yet
      let requesterWarning = requesterWs.sentMessages.find(m => m.type === 'pair_expiring');
      let targetWarning = targetWs.sentMessages.find(m => m.type === 'pair_expiring');
      expect(requesterWarning).toBeUndefined();
      expect(targetWarning).toBeUndefined();

      // Advance time to trigger the warning
      vi.advanceTimersByTime(2);

      // Both should receive pair_expiring warning
      requesterWarning = requesterWs.sentMessages.find(m => m.type === 'pair_expiring');
      targetWarning = targetWs.sentMessages.find(m => m.type === 'pair_expiring');

      expect(requesterWarning).toEqual({
        type: 'pair_expiring',
        peerCode: VALID_CODE_TGT,
        remainingSeconds: 30,
      });
      expect(targetWarning).toEqual({
        type: 'pair_expiring',
        peerCode: VALID_CODE_REQ,
        remainingSeconds: 30,
      });
    });

    it('should include expiresIn in pair_incoming message (Issue #35)', async () => {
      const requesterWs = await createAndRegisterClient(VALID_CODE_REQ, VALID_PUBKEY_1);
      const targetWs = await createAndRegisterClient(VALID_CODE_TGT, VALID_PUBKEY_2);

      targetWs.clearMessages();

      // Send pair request
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: VALID_CODE_TGT,
      }));

      // Target should receive pair_incoming with expiresIn field
      const pairIncoming = targetWs.sentMessages.find(m => m.type === 'pair_incoming');
      expect(pairIncoming).toBeDefined();
      expect(pairIncoming.expiresIn).toBe(120000); // 120 seconds
    });

    it('should clear pending request after timeout', async () => {
      const requesterWs = await createAndRegisterClient(VALID_CODE_REQ, VALID_PUBKEY_1);
      const targetWs = await createAndRegisterClient(VALID_CODE_TGT, VALID_PUBKEY_2);

      // Send pair request
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: VALID_CODE_TGT,
      }));

      // Advance time past the timeout
      vi.advanceTimersByTime(120001);

      targetWs.clearMessages();

      // Try to respond after timeout - should fail since request was cleared
      await handler.handleMessage(targetWs as any, JSON.stringify({
        type: 'pair_response',
        targetCode: VALID_CODE_REQ,
        accepted: true,
      }));

      const errorMsg = targetWs.getLastMessage();
      expect(errorMsg.type).toBe('pair_error');
      expect(errorMsg.error).toBe('No pending request from this peer');
    });

    it('should not send timeout if request was accepted before timeout', async () => {
      const requesterWs = await createAndRegisterClient(VALID_CODE_REQ, VALID_PUBKEY_1);
      const targetWs = await createAndRegisterClient(VALID_CODE_TGT, VALID_PUBKEY_2);

      // Send pair request
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: VALID_CODE_TGT,
      }));

      // Accept before timeout
      await handler.handleMessage(targetWs as any, JSON.stringify({
        type: 'pair_response',
        targetCode: VALID_CODE_REQ,
        accepted: true,
      }));

      requesterWs.clearMessages();

      // Advance time past the timeout
      vi.advanceTimersByTime(120001);

      // Requester should NOT receive pair_timeout
      const timeoutMsg = requesterWs.sentMessages.find(m => m.type === 'pair_timeout');
      expect(timeoutMsg).toBeUndefined();
    });
  });

  describe('Rate Limiting', () => {
    it('should allow messages under limit (100/min)', async () => {
      const ws = await createAndRegisterClient(VALID_CODE_CLI, VALID_PUBKEY_1);

      // Send 100 messages (1 was already sent for registration)
      for (let i = 0; i < 99; i++) {
        await handler.handleMessage(ws as any, JSON.stringify({
          type: 'ping',
        }));
      }

      // All should succeed - count pong responses
      const pongMsgs = ws.sentMessages.filter(m => m.type === 'pong');
      expect(pongMsgs.length).toBe(99);
    });

    it('should reject messages over limit', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      ws.clearMessages();

      // Send 101 messages (registration + 100 pings)
      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'register',
        pairingCode: VALID_CODE_CLI,
        publicKey: VALID_PUBKEY_1,
      }));

      for (let i = 0; i < 100; i++) {
        await handler.handleMessage(ws as any, JSON.stringify({
          type: 'ping',
        }));
      }

      // The last message should be rate limit error
      const errorMsgs = ws.sentMessages.filter(m => m.type === 'error' && m.message.includes('Rate limit'));
      expect(errorMsgs.length).toBeGreaterThan(0);
    });

    it('should reset after time window', async () => {
      const ws = await createAndRegisterClient(VALID_CODE_CLI, VALID_PUBKEY_1);

      // Send 100 messages to hit the limit
      for (let i = 0; i < 100; i++) {
        await handler.handleMessage(ws as any, JSON.stringify({
          type: 'ping',
        }));
      }

      ws.clearMessages();

      // Should be rate limited now
      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'ping',
      }));
      expect(ws.getLastMessage().type).toBe('error');

      // Advance time past the window (60 seconds for rate limiting)
      vi.advanceTimersByTime(60001);

      ws.clearMessages();

      // Should be allowed again
      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'ping',
      }));
      expect(ws.getLastMessage().type).toBe('pong');
    });
  });

  describe('Cleanup on Disconnect', () => {
    it('should clear pending requests when target disconnects', async () => {
      const requesterWs = await createAndRegisterClient(VALID_CODE_REQ, VALID_PUBKEY_1);
      const targetWs = await createAndRegisterClient(VALID_CODE_TGT, VALID_PUBKEY_2);

      // Send pair request
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: VALID_CODE_TGT,
      }));

      // Target disconnects
      await handler.handleDisconnect(targetWs as any);

      // Verify that the pending request was cleared by trying to respond
      // (would need a new target, but we can verify by timeout not firing)
      requesterWs.clearMessages();

      // Advance time past the timeout - should not fire since request was cleared
      vi.advanceTimersByTime(120001);

      // No timeout message because cleanup cleared the timer
      const timeoutMsg = requesterWs.sentMessages.find(m => m.type === 'pair_timeout');
      expect(timeoutMsg).toBeUndefined();
    });

    it('should clear pending requests when requester disconnects', async () => {
      const requesterWs = await createAndRegisterClient(VALID_CODE_REQ, VALID_PUBKEY_1);
      const targetWs = await createAndRegisterClient(VALID_CODE_TGT, VALID_PUBKEY_2);

      // Send pair request
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: VALID_CODE_TGT,
      }));

      // Requester disconnects
      await handler.handleDisconnect(requesterWs as any);

      targetWs.clearMessages();

      // Target tries to respond - should fail since request was cleared
      await handler.handleMessage(targetWs as any, JSON.stringify({
        type: 'pair_response',
        targetCode: VALID_CODE_REQ,
        accepted: true,
      }));

      const errorMsg = targetWs.getLastMessage();
      expect(errorMsg.type).toBe('pair_error');
      expect(errorMsg.error).toBe('No pending request from this peer');
    });

    it('should clear timers for disconnected client', async () => {
      const requesterWs = await createAndRegisterClient(VALID_CODE_REQ, VALID_PUBKEY_1);
      await createAndRegisterClient(VALID_CODE_TGT, VALID_PUBKEY_2);

      // Send pair request (starts a timer)
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: VALID_CODE_TGT,
      }));

      // Disconnect the requester
      await handler.handleDisconnect(requesterWs as any);

      // Advance time past the timeout
      vi.advanceTimersByTime(120001);

      // No error should occur - timer should have been cleared
      // If timer wasn't cleared, it would try to send to closed socket
      // The test passing without errors indicates the timer was properly cleared
    });

    it('should clear rate limiting data for disconnected client', async () => {
      const ws = await createAndRegisterClient(VALID_CODE_CLI, VALID_PUBKEY_1);

      // Send some messages
      for (let i = 0; i < 50; i++) {
        await handler.handleMessage(ws as any, JSON.stringify({
          type: 'ping',
        }));
      }

      // Disconnect
      await handler.handleDisconnect(ws as any);

      // Reconnect with same pairing code
      const ws2 = await createAndRegisterClient(VALID_CODE_CLI, VALID_PUBKEY_1);

      // Should be able to send messages without being rate limited
      // (rate limit was cleared on disconnect)
      ws2.clearMessages();
      for (let i = 0; i < 50; i++) {
        await handler.handleMessage(ws2 as any, JSON.stringify({
          type: 'ping',
        }));
      }

      const errorMsgs = ws2.sentMessages.filter(m => m.type === 'error');
      expect(errorMsgs.length).toBe(0);
    });

    it('should clear pairing code mappings on disconnect', async () => {
      const ws = await createAndRegisterClient(VALID_CODE_DSC, VALID_PUBKEY_1);

      // Verify client is registered by sending a signaling message
      const otherWs = await createAndRegisterClient(VALID_CODE_OTH, VALID_PUBKEY_3);

      // Should be able to send to disconnect-test
      await handler.handleMessage(otherWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: VALID_CODE_DSC,
      }));

      // Verify it worked
      const incomingMsg = ws.sentMessages.find(m => m.type === 'pair_incoming');
      expect(incomingMsg).toBeDefined();

      // Disconnect
      await handler.handleDisconnect(ws as any);

      otherWs.clearMessages();

      // Try to send to disconnected client - should fail
      await handler.handleMessage(otherWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: VALID_CODE_DSC,
      }));

      const errorMsg = otherWs.getLastMessage();
      expect(errorMsg.type).toBe('pair_error');
      expect(errorMsg.error).toBe('Pair request could not be processed');
    });

    it('should update signalingClientCount on disconnect', async () => {
      const ws1 = await createAndRegisterClient(VALID_CODE_C1, VALID_PUBKEY_1);
      await createAndRegisterClient(VALID_CODE_C2, VALID_PUBKEY_2);

      expect(handler.signalingClientCount).toBe(2);

      await handler.handleDisconnect(ws1 as any);

      expect(handler.signalingClientCount).toBe(1);
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing targetCode in pair request', async () => {
      const ws = await createAndRegisterClient(VALID_CODE_CLI, VALID_PUBKEY_1);

      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'pair_request',
        // targetCode is missing
      }));

      const errorMsg = ws.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toContain('Missing required field: targetCode');
    });

    it('should handle pairing code registration without publicKey', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      ws.clearMessages();

      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'register',
        pairingCode: VALID_CODE_CLI, // Valid format but missing publicKey
        // publicKey is missing
      }));

      const errorMsg = ws.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toContain('Missing required field: publicKey');
    });

    it('should handle pair response from unregistered client', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      ws.clearMessages();

      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'pair_response',
        targetCode: 'AAAAAA', // Valid format
        accepted: true,
      }));

      const errorMsg = ws.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toContain('Not registered');
    });

    it('should handle multiple pair requests to same target from different requesters', async () => {
      const targetWs = await createAndRegisterClient(VALID_CODE_TGT, VALID_PUBKEY_2);
      const requester1 = await createAndRegisterClient(VALID_CODE_REQ, VALID_PUBKEY_1);
      const requester2 = await createAndRegisterClient(VALID_CODE_EXT, VALID_PUBKEY_2);

      // Both send pair requests
      await handler.handleMessage(requester1 as any, JSON.stringify({
        type: 'pair_request',
        targetCode: VALID_CODE_TGT,
      }));

      await handler.handleMessage(requester2 as any, JSON.stringify({
        type: 'pair_request',
        targetCode: VALID_CODE_TGT,
      }));

      // Target should have received 2 pair_incoming messages
      const incomingMsgs = targetWs.sentMessages.filter(m => m.type === 'pair_incoming');
      expect(incomingMsgs).toHaveLength(2);

      // Target can accept both
      await handler.handleMessage(targetWs as any, JSON.stringify({
        type: 'pair_response',
        targetCode: VALID_CODE_REQ,
        accepted: true,
      }));

      await handler.handleMessage(targetWs as any, JSON.stringify({
        type: 'pair_response',
        targetCode: VALID_CODE_EXT,
        accepted: true,
      }));

      // Both requesters should receive pair_matched
      expect(requester1.sentMessages.find(m => m.type === 'pair_matched')).toBeDefined();
      expect(requester2.sentMessages.find(m => m.type === 'pair_matched')).toBeDefined();
    });
  });

  describe('Pairing Code Format Validation (Issue #17)', () => {
    it('should reject registration with invalid pairing code format', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      ws.clearMessages();

      // Try to register with an invalid code (contains 'O' which is excluded)
      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'register',
        pairingCode: 'ABCDO1', // Contains O and 1, both excluded
        publicKey: VALID_PUBKEY_1,
      }));

      const errorMsg = ws.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toBe('Invalid pairing code format');
    });

    it('should reject registration with pairing code too short', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      ws.clearMessages();

      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'register',
        pairingCode: 'ABC', // Too short
        publicKey: VALID_PUBKEY_1,
      }));

      const errorMsg = ws.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toBe('Invalid pairing code format');
    });

    it('should reject registration with pairing code too long', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      ws.clearMessages();

      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'register',
        pairingCode: 'ABCDEFGH', // Too long (8 chars)
        publicKey: VALID_PUBKEY_1,
      }));

      const errorMsg = ws.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toBe('Invalid pairing code format');
    });

    it('should reject pair_request with invalid target code format', async () => {
      const ws = await createAndRegisterClient(VALID_CODE_REQ, VALID_PUBKEY_1);

      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'pair_request',
        targetCode: 'invalid!', // Contains invalid characters
      }));

      const errorMsg = ws.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toBe('Invalid target code format');
    });

    it('should reject pair_response with invalid target code format', async () => {
      const ws = await createAndRegisterClient(VALID_CODE_REQ, VALID_PUBKEY_1);

      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'pair_response',
        targetCode: 'ABC123!', // Contains invalid character
        accepted: true,
      }));

      const errorMsg = ws.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toBe('Invalid target code format');
    });

    it('should accept registration with valid pairing code format', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      ws.clearMessages();

      // Valid code using only allowed characters
      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'register',
        pairingCode: 'ABC234', // All valid chars: A, B, C, 2, 3, 4
        publicKey: VALID_PUBKEY_1,
      }));

      const msg = ws.getLastMessage();
      expect(msg.type).toBe('registered');
      expect(msg.pairingCode).toBe('ABC234');
    });
  });
});

/**
 * DHT-based redirect tests for cross-server pairing.
 *
 * When a pairing code is registered, the server checks the DHT hash ring
 * and includes redirect targets in the 'registered' response. The client
 * then connects to those redirect servers directly.
 */
describe('DHT Redirect in Pairing Registration', () => {
  // Mock FederationManager that returns redirect targets
  class MockFederationManager extends EventEmitter {
    private redirectTargets: Array<{ serverId: string; endpoint: string; hashes: string[] }> = [];

    setRedirectTargets(targets: Array<{ serverId: string; endpoint: string; hashes: string[] }>) {
      this.redirectTargets = targets;
    }

    getRedirectTargets(hashes: string[]): Array<{ serverId: string; endpoint: string; hashes: string[] }> {
      return this.redirectTargets;
    }

    getRoutingTable() {
      return { getRedirectTargets: (h: string[]) => this.getRedirectTargets(h) };
    }

    getRing() {
      return {};
    }
  }

  let handler: ClientHandler;
  let federation: MockFederationManager;

  beforeEach(() => {
    vi.useFakeTimers();

    const identity: ServerIdentity = {
      serverId: 'server-a',
      nodeId: 'node-a',
      ephemeralId: 'srv-a',
      publicKey: new Uint8Array(32).fill(1),
      privateKey: new Uint8Array(64).fill(2),
    };

    const config: ClientHandlerConfig = {
      heartbeatInterval: 30000,
      heartbeatTimeout: 90000,
      maxConnectionsPerPeer: 20,
      pairRequestTimeout: 120000,
      pairRequestWarningTime: 30000,
    };

    federation = new MockFederationManager();
    const relay = new RelayRegistry();
    const drz = new MockDistributedRendezvous();

    handler = new ClientHandler(
      identity,
      'ws://server-a:8080',
      config,
      relay,
      drz as unknown as DistributedRendezvous,
      {},
      undefined,
      undefined,
      federation as any
    );
  });

  afterEach(async () => {
    await handler.shutdown();
    vi.useRealTimers();
  });

  it('should include redirects in registered response when DHT routes elsewhere', async () => {
    // Configure DHT to redirect this code to server-b
    federation.setRedirectTargets([
      { serverId: 'server-b', endpoint: 'wss://server-b.example.com', hashes: [VALID_CODE_REQ] },
    ]);

    const ws = new MockWebSocket();
    handler.handleConnection(ws as any);
    ws.clearMessages();

    await handler.handleMessage(ws as any, JSON.stringify({
      type: 'register',
      pairingCode: VALID_CODE_REQ,
      publicKey: VALID_PUBKEY_1,
    }));

    const registered = ws.getLastMessage();
    expect(registered.type).toBe('registered');
    expect(registered.pairingCode).toBe(VALID_CODE_REQ);
    expect(registered.redirects).toBeDefined();
    expect(registered.redirects).toHaveLength(1);
    expect(registered.redirects[0].serverId).toBe('server-b');
    expect(registered.redirects[0].endpoint).toBe('wss://server-b.example.com');
  });

  it('should not include redirects when no DHT redirect targets', async () => {
    // No redirect targets configured (solo server)
    federation.setRedirectTargets([]);

    const ws = new MockWebSocket();
    handler.handleConnection(ws as any);
    ws.clearMessages();

    await handler.handleMessage(ws as any, JSON.stringify({
      type: 'register',
      pairingCode: VALID_CODE_REQ,
      publicKey: VALID_PUBKEY_1,
    }));

    const registered = ws.getLastMessage();
    expect(registered.type).toBe('registered');
    expect(registered.pairingCode).toBe(VALID_CODE_REQ);
    expect(registered.redirects).toBeUndefined();
  });

  it('should include multiple redirects when DHT routes to multiple servers', async () => {
    federation.setRedirectTargets([
      { serverId: 'server-b', endpoint: 'wss://server-b.example.com', hashes: [VALID_CODE_REQ] },
      { serverId: 'server-c', endpoint: 'wss://server-c.example.com', hashes: [VALID_CODE_REQ] },
    ]);

    const ws = new MockWebSocket();
    handler.handleConnection(ws as any);
    ws.clearMessages();

    await handler.handleMessage(ws as any, JSON.stringify({
      type: 'register',
      pairingCode: VALID_CODE_REQ,
      publicKey: VALID_PUBKEY_1,
    }));

    const registered = ws.getLastMessage();
    expect(registered.redirects).toHaveLength(2);
  });

  it('should work without federation (no redirects)', async () => {
    // Create handler without federation
    const identity: ServerIdentity = {
      serverId: 'solo-server',
      nodeId: 'solo-node',
      ephemeralId: 'srv-solo',
      publicKey: new Uint8Array(32).fill(5),
      privateKey: new Uint8Array(64).fill(6),
    };
    const soloHandler = new ClientHandler(
      identity,
      'ws://solo:8080',
      {
        heartbeatInterval: 30000,
        heartbeatTimeout: 90000,
        maxConnectionsPerPeer: 20,
      },
      new RelayRegistry(),
      new MockDistributedRendezvous() as unknown as DistributedRendezvous,
    );

    const ws = new MockWebSocket();
    soloHandler.handleConnection(ws as any);
    ws.clearMessages();

    await soloHandler.handleMessage(ws as any, JSON.stringify({
      type: 'register',
      pairingCode: VALID_CODE_REQ,
      publicKey: VALID_PUBKEY_1,
    }));

    const registered = ws.getLastMessage();
    expect(registered.type).toBe('registered');
    expect(registered.redirects).toBeUndefined();

    await soloHandler.shutdown();
  });

  it('should return pair_error for unknown target codes (no server-to-server relay)', async () => {
    const ws = new MockWebSocket();
    handler.handleConnection(ws as any);
    ws.clearMessages();

    await handler.handleMessage(ws as any, JSON.stringify({
      type: 'register',
      pairingCode: VALID_CODE_REQ,
      publicKey: VALID_PUBKEY_1,
    }));
    ws.clearMessages();

    // Try to pair with a code that isn't registered on this server
    await handler.handleMessage(ws as any, JSON.stringify({
      type: 'pair_request',
      targetCode: VALID_CODE_TGT,
    }));

    const error = ws.getLastMessage();
    expect(error.type).toBe('pair_error');
    expect(error.error).toBe('Pair request could not be processed');
  });
});
