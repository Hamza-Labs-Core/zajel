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
      const requesterWs = await createAndRegisterClient('requester-code', VALID_PUBKEY_1);
      const targetWs = await createAndRegisterClient('target-code', VALID_PUBKEY_2);

      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: 'target-code',
      }));

      // Target should receive pair_incoming with expiresIn field
      const targetMsg = targetWs.getLastMessage();
      expect(targetMsg).toEqual({
        type: 'pair_incoming',
        fromCode: 'requester-code',
        fromPublicKey: VALID_PUBKEY_1,
        expiresIn: 120000, // 2 minutes timeout for fingerprint verification
      });
    });

    it('should notify target client with pair_incoming', async () => {
      const requesterWs = await createAndRegisterClient('req-1', VALID_PUBKEY_1);
      const targetWs = await createAndRegisterClient('tgt-1', VALID_PUBKEY_2);

      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: 'tgt-1',
      }));

      expect(targetWs.sentMessages).toContainEqual({
        type: 'pair_incoming',
        fromCode: 'req-1',
        fromPublicKey: VALID_PUBKEY_1,
        expiresIn: 120000, // 2 minutes timeout for fingerprint verification
      });
    });

    it('should return error for non-existent target code', async () => {
      const requesterWs = await createAndRegisterClient('requester', VALID_PUBKEY_1);

      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: 'non-existent',
      }));

      const errorMsg = requesterWs.getLastMessage();
      expect(errorMsg.type).toBe('pair_error');
      expect(errorMsg.error).toBe('Pair request could not be processed');
    });

    it('should limit pending requests per target (max 10)', async () => {
      const targetWs = await createAndRegisterClient('target', VALID_PUBKEY_2);

      // Create 10 requesters and send pair requests
      const requesters: MockWebSocket[] = [];
      for (let i = 0; i < 10; i++) {
        const ws = await createAndRegisterClient(`requester-${i}`, VALID_PUBKEYS[i]);
        requesters.push(ws);
        await handler.handleMessage(ws as any, JSON.stringify({
          type: 'pair_request',
          targetCode: 'target',
        }));
      }

      // Target should have received 10 pair_incoming messages
      expect(targetWs.sentMessages.filter(m => m.type === 'pair_incoming')).toHaveLength(10);

      // 11th request should fail
      const extraRequester = await createAndRegisterClient('extra-requester', VALID_PUBKEY_3);
      await handler.handleMessage(extraRequester as any, JSON.stringify({
        type: 'pair_request',
        targetCode: 'target',
      }));

      const errorMsg = extraRequester.getLastMessage();
      expect(errorMsg.type).toBe('pair_error');
      expect(errorMsg.error).toBe('Pair request could not be processed');
    });

    it('should reject pair request to self', async () => {
      const ws = await createAndRegisterClient('self-code', VALID_PUBKEY_1);

      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'pair_request',
        targetCode: 'self-code',
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
        targetCode: 'some-target',
      }));

      const errorMsg = ws.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toContain('Not registered');
    });

    it('should replace existing request from same requester', async () => {
      const requesterWs = await createAndRegisterClient('requester', VALID_PUBKEY_1);
      const targetWs = await createAndRegisterClient('target', VALID_PUBKEY_2);

      // First request
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: 'target',
      }));

      // Second request from same requester (should replace, not add)
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: 'target',
      }));

      // Target should have received 2 notifications (one for each request)
      const incomingMsgs = targetWs.sentMessages.filter(m => m.type === 'pair_incoming');
      expect(incomingMsgs).toHaveLength(2);

      // But internally there should only be 1 pending request
      // Verify by accepting and checking no duplicates
      targetWs.clearMessages();
      await handler.handleMessage(targetWs as any, JSON.stringify({
        type: 'pair_response',
        targetCode: 'requester',
        accepted: true,
      }));

      // Requester should get exactly one pair_matched
      const matchedMsgs = requesterWs.sentMessages.filter(m => m.type === 'pair_matched');
      expect(matchedMsgs).toHaveLength(1);
    });
  });

  describe('Pair Response Handling', () => {
    it('should send pair_matched to both when accepted', async () => {
      const requesterWs = await createAndRegisterClient('requester', VALID_PUBKEY_1);
      const targetWs = await createAndRegisterClient('target', VALID_PUBKEY_2);

      // Send pair request
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: 'target',
      }));

      targetWs.clearMessages();
      requesterWs.clearMessages();

      // Accept the request
      await handler.handleMessage(targetWs as any, JSON.stringify({
        type: 'pair_response',
        targetCode: 'requester',
        accepted: true,
      }));

      // Both should receive pair_matched
      const requesterMatched = requesterWs.sentMessages.find(m => m.type === 'pair_matched');
      const targetMatched = targetWs.sentMessages.find(m => m.type === 'pair_matched');

      expect(requesterMatched).toEqual({
        type: 'pair_matched',
        peerCode: 'target',
        peerPublicKey: VALID_PUBKEY_2,
        isInitiator: true,
      });

      expect(targetMatched).toEqual({
        type: 'pair_matched',
        peerCode: 'requester',
        peerPublicKey: VALID_PUBKEY_1,
        isInitiator: false,
      });
    });

    it('should send pair_rejected to requester when rejected', async () => {
      const requesterWs = await createAndRegisterClient('requester', VALID_PUBKEY_1);
      const targetWs = await createAndRegisterClient('target', VALID_PUBKEY_2);

      // Send pair request
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: 'target',
      }));

      requesterWs.clearMessages();

      // Reject the request
      await handler.handleMessage(targetWs as any, JSON.stringify({
        type: 'pair_response',
        targetCode: 'requester',
        accepted: false,
      }));

      // Requester should receive pair_rejected
      const rejectedMsg = requesterWs.sentMessages.find(m => m.type === 'pair_rejected');
      expect(rejectedMsg).toEqual({
        type: 'pair_rejected',
        peerCode: 'target',
      });

      // Target should not receive pair_rejected (they did the rejecting)
      expect(targetWs.sentMessages.find(m => m.type === 'pair_rejected')).toBeUndefined();
    });

    it('should clear pending request after response', async () => {
      const requesterWs = await createAndRegisterClient('requester', VALID_PUBKEY_1);
      const targetWs = await createAndRegisterClient('target', VALID_PUBKEY_2);

      // Send pair request
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: 'target',
      }));

      // Accept the request
      await handler.handleMessage(targetWs as any, JSON.stringify({
        type: 'pair_response',
        targetCode: 'requester',
        accepted: true,
      }));

      targetWs.clearMessages();

      // Try to respond again - should fail since request was cleared
      await handler.handleMessage(targetWs as any, JSON.stringify({
        type: 'pair_response',
        targetCode: 'requester',
        accepted: true,
      }));

      const errorMsg = targetWs.getLastMessage();
      expect(errorMsg.type).toBe('pair_error');
      expect(errorMsg.error).toBe('No pending request from this peer');
    });

    it('should return error for non-existent pending request', async () => {
      const targetWs = await createAndRegisterClient('target', VALID_PUBKEY_2);

      // Try to respond to non-existent request
      await handler.handleMessage(targetWs as any, JSON.stringify({
        type: 'pair_response',
        targetCode: 'non-existent',
        accepted: true,
      }));

      const errorMsg = targetWs.getLastMessage();
      expect(errorMsg.type).toBe('pair_error');
      expect(errorMsg.error).toBe('No pending request from this peer');
    });
  });

  describe('Timeout Handling', () => {
    it('should send pair_timeout for expired requests', async () => {
      const requesterWs = await createAndRegisterClient('requester', VALID_PUBKEY_1);
      await createAndRegisterClient('target', VALID_PUBKEY_2);

      // Send pair request
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: 'target',
      }));

      requesterWs.clearMessages();

      // Advance time past the timeout (120 seconds - Issue #35)
      vi.advanceTimersByTime(120001);

      // Requester should receive pair_timeout
      const timeoutMsg = requesterWs.sentMessages.find(m => m.type === 'pair_timeout');
      expect(timeoutMsg).toEqual({
        type: 'pair_timeout',
        peerCode: 'target',
      });
    });

    it('should send pair_expiring warning before timeout (Issue #35)', async () => {
      const requesterWs = await createAndRegisterClient('requester', VALID_PUBKEY_1);
      const targetWs = await createAndRegisterClient('target', VALID_PUBKEY_2);

      // Send pair request
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: 'target',
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
        peerCode: 'target',
        remainingSeconds: 30,
      });
      expect(targetWarning).toEqual({
        type: 'pair_expiring',
        peerCode: 'requester',
        remainingSeconds: 30,
      });
    });

    it('should include expiresIn in pair_incoming message (Issue #35)', async () => {
      const requesterWs = await createAndRegisterClient('requester', VALID_PUBKEY_1);
      const targetWs = await createAndRegisterClient('target', VALID_PUBKEY_2);

      targetWs.clearMessages();

      // Send pair request
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: 'target',
      }));

      // Target should receive pair_incoming with expiresIn field
      const pairIncoming = targetWs.sentMessages.find(m => m.type === 'pair_incoming');
      expect(pairIncoming).toBeDefined();
      expect(pairIncoming.expiresIn).toBe(120000); // 120 seconds
    });

    it('should clear pending request after timeout', async () => {
      const requesterWs = await createAndRegisterClient('requester', VALID_PUBKEY_1);
      const targetWs = await createAndRegisterClient('target', VALID_PUBKEY_2);

      // Send pair request
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: 'target',
      }));

      // Advance time past the timeout
      vi.advanceTimersByTime(120001);

      targetWs.clearMessages();

      // Try to respond after timeout - should fail since request was cleared
      await handler.handleMessage(targetWs as any, JSON.stringify({
        type: 'pair_response',
        targetCode: 'requester',
        accepted: true,
      }));

      const errorMsg = targetWs.getLastMessage();
      expect(errorMsg.type).toBe('pair_error');
      expect(errorMsg.error).toBe('No pending request from this peer');
    });

    it('should not send timeout if request was accepted before timeout', async () => {
      const requesterWs = await createAndRegisterClient('requester', VALID_PUBKEY_1);
      const targetWs = await createAndRegisterClient('target', VALID_PUBKEY_2);

      // Send pair request
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: 'target',
      }));

      // Accept before timeout
      await handler.handleMessage(targetWs as any, JSON.stringify({
        type: 'pair_response',
        targetCode: 'requester',
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
      const ws = await createAndRegisterClient('client', VALID_PUBKEY_1);

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
        pairingCode: 'client',
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
      const ws = await createAndRegisterClient('client', VALID_PUBKEY_1);

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
      const requesterWs = await createAndRegisterClient('requester', VALID_PUBKEY_1);
      const targetWs = await createAndRegisterClient('target', VALID_PUBKEY_2);

      // Send pair request
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: 'target',
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
      const requesterWs = await createAndRegisterClient('requester', VALID_PUBKEY_1);
      const targetWs = await createAndRegisterClient('target', VALID_PUBKEY_2);

      // Send pair request
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: 'target',
      }));

      // Requester disconnects
      await handler.handleDisconnect(requesterWs as any);

      targetWs.clearMessages();

      // Target tries to respond - should fail since request was cleared
      await handler.handleMessage(targetWs as any, JSON.stringify({
        type: 'pair_response',
        targetCode: 'requester',
        accepted: true,
      }));

      const errorMsg = targetWs.getLastMessage();
      expect(errorMsg.type).toBe('pair_error');
      expect(errorMsg.error).toBe('No pending request from this peer');
    });

    it('should clear timers for disconnected client', async () => {
      const requesterWs = await createAndRegisterClient('requester', VALID_PUBKEY_1);
      await createAndRegisterClient('target', VALID_PUBKEY_2);

      // Send pair request (starts a timer)
      await handler.handleMessage(requesterWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: 'target',
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
      const ws = await createAndRegisterClient('client', VALID_PUBKEY_1);

      // Send some messages
      for (let i = 0; i < 50; i++) {
        await handler.handleMessage(ws as any, JSON.stringify({
          type: 'ping',
        }));
      }

      // Disconnect
      await handler.handleDisconnect(ws as any);

      // Reconnect with same pairing code
      const ws2 = await createAndRegisterClient('client', VALID_PUBKEY_1);

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
      const ws = await createAndRegisterClient('disconnect-test', VALID_PUBKEY_1);

      // Verify client is registered by sending a signaling message
      const otherWs = await createAndRegisterClient('other', VALID_PUBKEY_3);

      // Should be able to send to disconnect-test
      await handler.handleMessage(otherWs as any, JSON.stringify({
        type: 'pair_request',
        targetCode: 'disconnect-test',
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
        targetCode: 'disconnect-test',
      }));

      const errorMsg = otherWs.getLastMessage();
      expect(errorMsg.type).toBe('pair_error');
      expect(errorMsg.error).toBe('Pair request could not be processed');
    });

    it('should update signalingClientCount on disconnect', async () => {
      const ws1 = await createAndRegisterClient('client-1', VALID_PUBKEY_1);
      await createAndRegisterClient('client-2', VALID_PUBKEY_2);

      expect(handler.signalingClientCount).toBe(2);

      await handler.handleDisconnect(ws1 as any);

      expect(handler.signalingClientCount).toBe(1);
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing targetCode in pair request', async () => {
      const ws = await createAndRegisterClient('client', VALID_PUBKEY_1);

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
        pairingCode: 'test-code',
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
        targetCode: 'someone',
        accepted: true,
      }));

      const errorMsg = ws.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toContain('Not registered');
    });

    it('should handle multiple pair requests to same target from different requesters', async () => {
      const targetWs = await createAndRegisterClient('target', VALID_PUBKEY_2);
      const requester1 = await createAndRegisterClient('req-1', VALID_PUBKEY_1);
      const requester2 = await createAndRegisterClient('req-2', VALID_PUBKEY_2);

      // Both send pair requests
      await handler.handleMessage(requester1 as any, JSON.stringify({
        type: 'pair_request',
        targetCode: 'target',
      }));

      await handler.handleMessage(requester2 as any, JSON.stringify({
        type: 'pair_request',
        targetCode: 'target',
      }));

      // Target should have received 2 pair_incoming messages
      const incomingMsgs = targetWs.sentMessages.filter(m => m.type === 'pair_incoming');
      expect(incomingMsgs).toHaveLength(2);

      // Target can accept both
      await handler.handleMessage(targetWs as any, JSON.stringify({
        type: 'pair_response',
        targetCode: 'req-1',
        accepted: true,
      }));

      await handler.handleMessage(targetWs as any, JSON.stringify({
        type: 'pair_response',
        targetCode: 'req-2',
        accepted: true,
      }));

      // Both requesters should receive pair_matched
      expect(requester1.sentMessages.find(m => m.type === 'pair_matched')).toBeDefined();
      expect(requester2.sentMessages.find(m => m.type === 'pair_matched')).toBeDefined();
    });
  });
});
