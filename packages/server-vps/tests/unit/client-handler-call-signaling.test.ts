/**
 * Client Handler Call Signaling Tests
 *
 * Tests for VoIP call signaling message validation and forwarding:
 * - Payload validation (callId, sdp, candidate)
 * - Message type-specific validation
 * - Size limits for SDP and ICE candidates
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { ClientHandler, type ClientHandlerConfig } from '../../src/client/handler.js';
import { RelayRegistry } from '../../src/registry/relay-registry.js';
import { DistributedRendezvous } from '../../src/registry/distributed-rendezvous.js';
import type { ServerIdentity } from '../../src/types.js';
import { CALL_SIGNALING } from '../../src/constants.js';

// Valid 32-byte base64-encoded public key for testing
const VALID_PUBKEY = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDE=';
const VALID_PUBKEY_2 = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDI=';

// Valid pairing codes (6-char, excluding I, O, 0, 1)
const SENDER_CODE = 'SND234';
const TARGET_CODE = 'TGT567';

// Valid UUID v4 for callId
const VALID_CALL_ID = '550e8400-e29b-41d4-a716-446655440000';

// Sample SDP (simplified)
const VALID_SDP = 'v=0\r\no=- 123456789 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';

// Sample ICE candidate
const VALID_ICE_CANDIDATE = 'candidate:1 1 udp 2122260223 192.168.1.1 54321 typ host';

// Mock WebSocket implementation
class MockWebSocket extends EventEmitter {
  readyState: number = 1;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  sentMessages: any[] = [];

  send(data: string): void {
    if (this.readyState === MockWebSocket.OPEN) {
      this.sentMessages.push(JSON.parse(data));
    }
  }

  close(): void {
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

describe('ClientHandler Call Signaling', () => {
  let handler: ClientHandler;
  let senderWs: MockWebSocket;
  let targetWs: MockWebSocket;
  let relayRegistry: RelayRegistry;
  let distributedRendezvous: MockDistributedRendezvous;

  const config: ClientHandlerConfig = {
    heartbeatInterval: 30000,
    heartbeatTimeout: 90000,
    maxConnectionsPerPeer: 20,
    pairRequestTimeout: 120000,
    pairRequestWarningTime: 30000,
  };

  const mockIdentity: ServerIdentity = {
    serverId: 'test-server-1',
    nodeId: 'test-node-1',
    ephemeralId: 'srv-test-1',
    publicKey: new Uint8Array(32).fill(1),
    privateKey: new Uint8Array(64).fill(2),
  };

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

  beforeEach(async () => {
    vi.useFakeTimers();
    relayRegistry = new RelayRegistry();
    distributedRendezvous = new MockDistributedRendezvous();

    handler = new ClientHandler(
      mockIdentity,
      'ws://localhost:8080',
      config,
      relayRegistry,
      distributedRendezvous as unknown as DistributedRendezvous
    );

    // Register both sender and target
    senderWs = await createAndRegisterClient(SENDER_CODE, VALID_PUBKEY);
    targetWs = await createAndRegisterClient(TARGET_CODE, VALID_PUBKEY_2);
  });

  afterEach(async () => {
    await handler.shutdown();
    vi.useRealTimers();
  });

  describe('call_offer validation', () => {
    it('should forward valid call_offer', async () => {
      await handler.handleMessage(senderWs as any, JSON.stringify({
        type: 'call_offer',
        target: TARGET_CODE,
        payload: {
          callId: VALID_CALL_ID,
          sdp: VALID_SDP,
          withVideo: true,
        },
      }));

      // Target should receive the forwarded message
      const targetMsg = targetWs.getLastMessage();
      expect(targetMsg.type).toBe('call_offer');
      expect(targetMsg.from).toBe(SENDER_CODE);
      expect(targetMsg.payload.callId).toBe(VALID_CALL_ID);
      expect(targetMsg.payload.sdp).toBe(VALID_SDP);
    });

    it('should reject call_offer without callId', async () => {
      await handler.handleMessage(senderWs as any, JSON.stringify({
        type: 'call_offer',
        target: TARGET_CODE,
        payload: {
          sdp: VALID_SDP,
        },
      }));

      const senderMsg = senderWs.getLastMessage();
      expect(senderMsg.type).toBe('error');
      expect(senderMsg.message).toContain('callId');
    });

    it('should reject call_offer with invalid callId format', async () => {
      await handler.handleMessage(senderWs as any, JSON.stringify({
        type: 'call_offer',
        target: TARGET_CODE,
        payload: {
          callId: 'not-a-uuid',
          sdp: VALID_SDP,
        },
      }));

      const senderMsg = senderWs.getLastMessage();
      expect(senderMsg.type).toBe('error');
      expect(senderMsg.message).toContain('UUID');
    });

    it('should reject call_offer without sdp', async () => {
      await handler.handleMessage(senderWs as any, JSON.stringify({
        type: 'call_offer',
        target: TARGET_CODE,
        payload: {
          callId: VALID_CALL_ID,
        },
      }));

      const senderMsg = senderWs.getLastMessage();
      expect(senderMsg.type).toBe('error');
      expect(senderMsg.message).toContain('sdp');
    });

    it('should reject call_offer with empty sdp', async () => {
      await handler.handleMessage(senderWs as any, JSON.stringify({
        type: 'call_offer',
        target: TARGET_CODE,
        payload: {
          callId: VALID_CALL_ID,
          sdp: '',
        },
      }));

      const senderMsg = senderWs.getLastMessage();
      expect(senderMsg.type).toBe('error');
      expect(senderMsg.message).toContain('sdp');
    });

    it('should reject call_offer with oversized sdp', async () => {
      const oversizedSdp = 'x'.repeat(CALL_SIGNALING.MAX_SDP_LENGTH + 1);

      await handler.handleMessage(senderWs as any, JSON.stringify({
        type: 'call_offer',
        target: TARGET_CODE,
        payload: {
          callId: VALID_CALL_ID,
          sdp: oversizedSdp,
        },
      }));

      const senderMsg = senderWs.getLastMessage();
      expect(senderMsg.type).toBe('error');
      expect(senderMsg.message).toContain('too large');
    });
  });

  describe('call_answer validation', () => {
    it('should forward valid call_answer', async () => {
      await handler.handleMessage(senderWs as any, JSON.stringify({
        type: 'call_answer',
        target: TARGET_CODE,
        payload: {
          callId: VALID_CALL_ID,
          sdp: VALID_SDP,
        },
      }));

      const targetMsg = targetWs.getLastMessage();
      expect(targetMsg.type).toBe('call_answer');
      expect(targetMsg.from).toBe(SENDER_CODE);
    });

    it('should reject call_answer without sdp', async () => {
      await handler.handleMessage(senderWs as any, JSON.stringify({
        type: 'call_answer',
        target: TARGET_CODE,
        payload: {
          callId: VALID_CALL_ID,
        },
      }));

      const senderMsg = senderWs.getLastMessage();
      expect(senderMsg.type).toBe('error');
      expect(senderMsg.message).toContain('sdp');
    });
  });

  describe('call_ice validation', () => {
    it('should forward valid call_ice', async () => {
      await handler.handleMessage(senderWs as any, JSON.stringify({
        type: 'call_ice',
        target: TARGET_CODE,
        payload: {
          callId: VALID_CALL_ID,
          candidate: VALID_ICE_CANDIDATE,
          sdpMid: 'audio',
          sdpMLineIndex: 0,
        },
      }));

      const targetMsg = targetWs.getLastMessage();
      expect(targetMsg.type).toBe('call_ice');
      expect(targetMsg.from).toBe(SENDER_CODE);
      expect(targetMsg.payload.candidate).toBe(VALID_ICE_CANDIDATE);
    });

    it('should reject call_ice without candidate', async () => {
      await handler.handleMessage(senderWs as any, JSON.stringify({
        type: 'call_ice',
        target: TARGET_CODE,
        payload: {
          callId: VALID_CALL_ID,
        },
      }));

      const senderMsg = senderWs.getLastMessage();
      expect(senderMsg.type).toBe('error');
      expect(senderMsg.message).toContain('candidate');
    });

    it('should reject call_ice with empty candidate', async () => {
      await handler.handleMessage(senderWs as any, JSON.stringify({
        type: 'call_ice',
        target: TARGET_CODE,
        payload: {
          callId: VALID_CALL_ID,
          candidate: '',
        },
      }));

      const senderMsg = senderWs.getLastMessage();
      expect(senderMsg.type).toBe('error');
      expect(senderMsg.message).toContain('candidate');
    });

    it('should reject call_ice with oversized candidate', async () => {
      const oversizedCandidate = 'x'.repeat(CALL_SIGNALING.MAX_ICE_CANDIDATE_LENGTH + 1);

      await handler.handleMessage(senderWs as any, JSON.stringify({
        type: 'call_ice',
        target: TARGET_CODE,
        payload: {
          callId: VALID_CALL_ID,
          candidate: oversizedCandidate,
        },
      }));

      const senderMsg = senderWs.getLastMessage();
      expect(senderMsg.type).toBe('error');
      expect(senderMsg.message).toContain('too large');
    });
  });

  describe('call_reject validation', () => {
    it('should forward valid call_reject', async () => {
      await handler.handleMessage(senderWs as any, JSON.stringify({
        type: 'call_reject',
        target: TARGET_CODE,
        payload: {
          callId: VALID_CALL_ID,
          reason: 'busy',
        },
      }));

      const targetMsg = targetWs.getLastMessage();
      expect(targetMsg.type).toBe('call_reject');
      expect(targetMsg.from).toBe(SENDER_CODE);
    });

    it('should reject call_reject without callId', async () => {
      await handler.handleMessage(senderWs as any, JSON.stringify({
        type: 'call_reject',
        target: TARGET_CODE,
        payload: {
          reason: 'busy',
        },
      }));

      const senderMsg = senderWs.getLastMessage();
      expect(senderMsg.type).toBe('error');
      expect(senderMsg.message).toContain('callId');
    });
  });

  describe('call_hangup validation', () => {
    it('should forward valid call_hangup', async () => {
      await handler.handleMessage(senderWs as any, JSON.stringify({
        type: 'call_hangup',
        target: TARGET_CODE,
        payload: {
          callId: VALID_CALL_ID,
        },
      }));

      const targetMsg = targetWs.getLastMessage();
      expect(targetMsg.type).toBe('call_hangup');
      expect(targetMsg.from).toBe(SENDER_CODE);
    });

    it('should reject call_hangup with invalid callId', async () => {
      await handler.handleMessage(senderWs as any, JSON.stringify({
        type: 'call_hangup',
        target: TARGET_CODE,
        payload: {
          callId: 'invalid',
        },
      }));

      const senderMsg = senderWs.getLastMessage();
      expect(senderMsg.type).toBe('error');
      expect(senderMsg.message).toContain('UUID');
    });
  });

  describe('general validation', () => {
    it('should reject call message without payload', async () => {
      await handler.handleMessage(senderWs as any, JSON.stringify({
        type: 'call_offer',
        target: TARGET_CODE,
      }));

      const senderMsg = senderWs.getLastMessage();
      expect(senderMsg.type).toBe('error');
      expect(senderMsg.message).toContain('payload');
    });

    it('should reject call message with null payload', async () => {
      await handler.handleMessage(senderWs as any, JSON.stringify({
        type: 'call_offer',
        target: TARGET_CODE,
        payload: null,
      }));

      const senderMsg = senderWs.getLastMessage();
      expect(senderMsg.type).toBe('error');
      expect(senderMsg.message).toContain('payload');
    });

    it('should reject call message from unregistered sender', async () => {
      const unregisteredWs = new MockWebSocket();

      await handler.handleMessage(unregisteredWs as any, JSON.stringify({
        type: 'call_offer',
        target: TARGET_CODE,
        payload: {
          callId: VALID_CALL_ID,
          sdp: VALID_SDP,
        },
      }));

      const msg = unregisteredWs.getLastMessage();
      expect(msg.type).toBe('error');
      expect(msg.message).toContain('Not registered');
    });

    it('should reject call message to non-existent target', async () => {
      await handler.handleMessage(senderWs as any, JSON.stringify({
        type: 'call_offer',
        target: 'XXX999', // Valid format but not registered
        payload: {
          callId: VALID_CALL_ID,
          sdp: VALID_SDP,
        },
      }));

      const senderMsg = senderWs.getLastMessage();
      expect(senderMsg.type).toBe('error');
      expect(senderMsg.message).toContain('not found');
    });
  });
});
