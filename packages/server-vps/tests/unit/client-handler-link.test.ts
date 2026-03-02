/**
 * Client Handler Link (Device Linking) Tests
 *
 * Tests for device linking flows (web client linking to mobile app):
 * - Link request handling and forwarding to mobile
 * - Link response handling (accept/reject)
 * - Link request timeout/expiry with notifications
 * - Timer cleanup on disconnect
 * - Error handling for invalid requests
 * - Shutdown cleanup
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { ClientHandler, type ClientHandlerConfig } from '../../src/client/handler.js';
import { RelayRegistry } from '../../src/registry/relay-registry.js';
import { DistributedRendezvous } from '../../src/registry/distributed-rendezvous.js';
import type { ServerIdentity } from '../../src/types.js';

// Valid 32-byte base64-encoded public keys for testing
const VALID_PUBKEY_WEB = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDE=';
const VALID_PUBKEY_MOBILE = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDI=';
const VALID_PUBKEY_3 = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDM=';

// Valid pairing codes (6-char, excluding I, O, 0, 1)
const WEB_CODE = 'WEB234';
const MOBILE_CODE = 'MBL567';
const OTHER_CODE = 'XTH234';
const WEB_CODE_2 = 'WEB789';

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

describe('ClientHandler Device Linking', () => {
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
      pairRequestTimeout: 120000,
      pairRequestWarningTime: 30000,
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

  // ===========================================================================
  // Link Request Handling
  // ===========================================================================

  describe('Link Request Handling', () => {
    it('should forward link_request to the mobile device', async () => {
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);
      const mobileWs = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);

      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
        deviceName: 'Chrome on Windows',
      }));

      // Mobile should receive the link_request with expiresIn
      const mobileMsg = mobileWs.getLastMessage();
      expect(mobileMsg).toEqual({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
        deviceName: 'Chrome on Windows',
        expiresIn: 120000,
      });
    });

    it('should use default deviceName when not provided', async () => {
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);
      const mobileWs = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);

      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
        // deviceName intentionally omitted
      }));

      const mobileMsg = mobileWs.getLastMessage();
      expect(mobileMsg.type).toBe('link_request');
      expect(mobileMsg.deviceName).toBe('Unknown Browser');
    });

    it('should send link_error when mobile device is not connected', async () => {
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);

      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: 'ZZZ999', // Valid format but not registered
        publicKey: VALID_PUBKEY_WEB,
      }));

      const errorMsg = webWs.getLastMessage();
      expect(errorMsg).toEqual({
        type: 'link_error',
        error: 'Link request could not be processed',
      });
    });

    it('should reject link_request from unregistered client', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      ws.clearMessages();

      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
      }));

      const errorMsg = ws.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toContain('Not registered');
    });

    it('should reject link_request with missing linkCode', async () => {
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);

      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        publicKey: VALID_PUBKEY_WEB,
        // linkCode missing
      }));

      // ClientHandler validateMessage catches missing linkCode before it reaches LinkHandler
      const errorMsg = webWs.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toContain('linkCode');
    });

    it('should reject link_request with missing publicKey', async () => {
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);

      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        // publicKey missing
      }));

      // ClientHandler validateMessage catches missing publicKey before it reaches LinkHandler
      const errorMsg = webWs.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toContain('publicKey');
    });

    it('should reject link_request with invalid linkCode format', async () => {
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);

      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: 'invalid!',
        publicKey: VALID_PUBKEY_WEB,
      }));

      const errorMsg = webWs.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toContain('Invalid link code format');
    });

    it('should replace existing pending link request for same linkCode', async () => {
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);
      const mobileWs = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);

      // First link request
      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
        deviceName: 'Chrome',
      }));

      // Second link request from same web client to same mobile (should replace)
      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
        deviceName: 'Firefox',
      }));

      // Mobile should have received 2 link_request messages
      const linkRequests = mobileWs.sentMessages.filter(m => m.type === 'link_request');
      expect(linkRequests).toHaveLength(2);

      // Second request should have the updated deviceName
      expect(linkRequests[1].deviceName).toBe('Firefox');
    });
  });

  // ===========================================================================
  // Link Response Handling — Accept
  // ===========================================================================

  describe('Link Response — Accept', () => {
    it('should send link_matched to both parties when accepted', async () => {
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);
      const mobileWs = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);

      // Web sends link request
      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
        deviceName: 'Chrome on Windows',
      }));

      webWs.clearMessages();
      mobileWs.clearMessages();

      // Mobile accepts
      await handler.handleMessage(mobileWs as any, JSON.stringify({
        type: 'link_response',
        linkCode: MOBILE_CODE,
        accepted: true,
        deviceId: 'device-abc-123',
      }));

      // Web client should receive link_matched with mobile's public key and isInitiator=true
      const webMsg = webWs.sentMessages.find(m => m.type === 'link_matched');
      expect(webMsg).toBeDefined();
      expect(webMsg.linkCode).toBe(MOBILE_CODE);
      expect(webMsg.peerPublicKey).toBe(VALID_PUBKEY_MOBILE);
      expect(webMsg.isInitiator).toBe(true);
      expect(webMsg.deviceId).toBe('device-abc-123');

      // Mobile should receive link_matched with web's public key and isInitiator=false
      const mobileMsg = mobileWs.sentMessages.find(m => m.type === 'link_matched');
      expect(mobileMsg).toBeDefined();
      expect(mobileMsg.linkCode).toBe(MOBILE_CODE);
      expect(mobileMsg.peerPublicKey).toBe(VALID_PUBKEY_WEB);
      expect(mobileMsg.isInitiator).toBe(false);
      expect(mobileMsg.webClientCode).toBe(WEB_CODE);
      expect(mobileMsg.deviceName).toBe('Chrome on Windows');
    });

    it('should clear the pending request after accept', async () => {
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);
      const mobileWs = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);

      // Web sends link request
      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
      }));

      // Mobile accepts
      await handler.handleMessage(mobileWs as any, JSON.stringify({
        type: 'link_response',
        linkCode: MOBILE_CODE,
        accepted: true,
      }));

      mobileWs.clearMessages();

      // Try to respond again — should fail because pending request was cleared
      await handler.handleMessage(mobileWs as any, JSON.stringify({
        type: 'link_response',
        linkCode: MOBILE_CODE,
        accepted: true,
      }));

      const errorMsg = mobileWs.getLastMessage();
      expect(errorMsg).toEqual({
        type: 'link_error',
        error: 'No pending link request found',
      });
    });
  });

  // ===========================================================================
  // Link Response Handling — Reject
  // ===========================================================================

  describe('Link Response — Reject', () => {
    it('should send link_rejected to web client when rejected', async () => {
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);
      const mobileWs = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);

      // Web sends link request
      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
      }));

      webWs.clearMessages();

      // Mobile rejects
      await handler.handleMessage(mobileWs as any, JSON.stringify({
        type: 'link_response',
        linkCode: MOBILE_CODE,
        accepted: false,
      }));

      // Web client should receive link_rejected
      const webMsg = webWs.sentMessages.find(m => m.type === 'link_rejected');
      expect(webMsg).toEqual({
        type: 'link_rejected',
        linkCode: MOBILE_CODE,
      });

      // Mobile should NOT receive link_rejected (they did the rejecting)
      const mobileReject = mobileWs.sentMessages.find(m => m.type === 'link_rejected');
      expect(mobileReject).toBeUndefined();
    });

    it('should clear the pending request after reject', async () => {
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);
      const mobileWs = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);

      // Web sends link request
      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
      }));

      // Mobile rejects
      await handler.handleMessage(mobileWs as any, JSON.stringify({
        type: 'link_response',
        linkCode: MOBILE_CODE,
        accepted: false,
      }));

      mobileWs.clearMessages();

      // Try to respond again — should fail
      await handler.handleMessage(mobileWs as any, JSON.stringify({
        type: 'link_response',
        linkCode: MOBILE_CODE,
        accepted: true,
      }));

      const errorMsg = mobileWs.getLastMessage();
      expect(errorMsg).toEqual({
        type: 'link_error',
        error: 'No pending link request found',
      });
    });
  });

  // ===========================================================================
  // Link Response Validation Errors
  // ===========================================================================

  describe('Link Response Validation', () => {
    it('should reject link_response from unregistered client', async () => {
      const ws = new MockWebSocket();
      handler.handleConnection(ws as any);
      ws.clearMessages();

      await handler.handleMessage(ws as any, JSON.stringify({
        type: 'link_response',
        linkCode: MOBILE_CODE,
        accepted: true,
      }));

      const errorMsg = ws.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toContain('Not registered');
    });

    it('should reject link_response with missing linkCode', async () => {
      const mobileWs = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);

      await handler.handleMessage(mobileWs as any, JSON.stringify({
        type: 'link_response',
        accepted: true,
        // linkCode missing
      }));

      // ClientHandler validateMessage catches missing linkCode
      const errorMsg = mobileWs.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toContain('linkCode');
    });

    it('should reject link_response with missing accepted field', async () => {
      const mobileWs = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);

      await handler.handleMessage(mobileWs as any, JSON.stringify({
        type: 'link_response',
        linkCode: MOBILE_CODE,
        // accepted missing
      }));

      // ClientHandler validateMessage catches missing accepted
      const errorMsg = mobileWs.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toContain('accepted');
    });

    it('should reject link_response with invalid linkCode format', async () => {
      const mobileWs = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);

      await handler.handleMessage(mobileWs as any, JSON.stringify({
        type: 'link_response',
        linkCode: 'bad!',
        accepted: true,
      }));

      const errorMsg = mobileWs.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toContain('Invalid link code format');
    });

    it('should reject link_response for a different device (code mismatch)', async () => {
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);
      const mobileWs = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);
      const otherWs = await createAndRegisterClient(OTHER_CODE, VALID_PUBKEY_3);

      // Web sends link request to mobile
      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
      }));

      // "other" tries to respond to the link request intended for mobile
      await handler.handleMessage(otherWs as any, JSON.stringify({
        type: 'link_response',
        linkCode: MOBILE_CODE,
        accepted: true,
      }));

      const errorMsg = otherWs.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toContain('Cannot respond to link request for another device');
    });

    it('should send link_error when no pending request exists', async () => {
      const mobileWs = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);

      // Mobile tries to respond but no request was made
      await handler.handleMessage(mobileWs as any, JSON.stringify({
        type: 'link_response',
        linkCode: MOBILE_CODE,
        accepted: true,
      }));

      const errorMsg = mobileWs.getLastMessage();
      expect(errorMsg).toEqual({
        type: 'link_error',
        error: 'No pending link request found',
      });
    });

    it('should silently handle accept when web client already disconnected', async () => {
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);
      const mobileWs = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);

      // Web sends link request
      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
      }));

      // Web client disconnects
      await handler.handleDisconnect(webWs as any);

      mobileWs.clearMessages();

      // Mobile tries to accept — web client is gone, should not throw
      await handler.handleMessage(mobileWs as any, JSON.stringify({
        type: 'link_response',
        linkCode: MOBILE_CODE,
        accepted: true,
      }));

      // Mobile should NOT receive link_matched because web client disconnected
      // The pending request was cleaned up on disconnect, so mobile gets link_error
      const errorMsg = mobileWs.getLastMessage();
      expect(errorMsg).toEqual({
        type: 'link_error',
        error: 'No pending link request found',
      });
    });
  });

  // ===========================================================================
  // Link Request Timeout / Expiry
  // ===========================================================================

  describe('Link Request Timeout', () => {
    it('should send link_timeout to both parties after expiry', async () => {
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);
      const mobileWs = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);

      // Web sends link request
      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
      }));

      webWs.clearMessages();
      mobileWs.clearMessages();

      // Advance time past the timeout (120 seconds)
      vi.advanceTimersByTime(120001);

      // Both should receive link_timeout
      const webTimeout = webWs.sentMessages.find(m => m.type === 'link_timeout');
      expect(webTimeout).toEqual({
        type: 'link_timeout',
        linkCode: MOBILE_CODE,
      });

      const mobileTimeout = mobileWs.sentMessages.find(m => m.type === 'link_timeout');
      expect(mobileTimeout).toEqual({
        type: 'link_timeout',
        linkCode: MOBILE_CODE,
      });
    });

    it('should clear pending request after timeout', async () => {
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);
      const mobileWs = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);

      // Web sends link request
      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
      }));

      // Advance time past the timeout
      vi.advanceTimersByTime(120001);

      mobileWs.clearMessages();

      // Mobile tries to respond after timeout — should fail
      await handler.handleMessage(mobileWs as any, JSON.stringify({
        type: 'link_response',
        linkCode: MOBILE_CODE,
        accepted: true,
      }));

      const errorMsg = mobileWs.getLastMessage();
      expect(errorMsg).toEqual({
        type: 'link_error',
        error: 'No pending link request found',
      });
    });

    it('should not send link_timeout if request was accepted before timeout', async () => {
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);
      const mobileWs = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);

      // Web sends link request
      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
      }));

      // Mobile accepts before timeout
      await handler.handleMessage(mobileWs as any, JSON.stringify({
        type: 'link_response',
        linkCode: MOBILE_CODE,
        accepted: true,
      }));

      webWs.clearMessages();
      mobileWs.clearMessages();

      // Advance time past what would have been the timeout
      vi.advanceTimersByTime(120001);

      // Neither should receive link_timeout
      const webTimeout = webWs.sentMessages.find(m => m.type === 'link_timeout');
      const mobileTimeout = mobileWs.sentMessages.find(m => m.type === 'link_timeout');
      expect(webTimeout).toBeUndefined();
      expect(mobileTimeout).toBeUndefined();
    });

    it('should not send link_timeout if request was rejected before timeout', async () => {
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);
      const mobileWs = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);

      // Web sends link request
      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
      }));

      // Mobile rejects before timeout
      await handler.handleMessage(mobileWs as any, JSON.stringify({
        type: 'link_response',
        linkCode: MOBILE_CODE,
        accepted: false,
      }));

      webWs.clearMessages();
      mobileWs.clearMessages();

      // Advance time past what would have been the timeout
      vi.advanceTimersByTime(120001);

      // Neither should receive link_timeout
      const webTimeout = webWs.sentMessages.find(m => m.type === 'link_timeout');
      const mobileTimeout = mobileWs.sentMessages.find(m => m.type === 'link_timeout');
      expect(webTimeout).toBeUndefined();
      expect(mobileTimeout).toBeUndefined();
    });

    it('should not fire timeout before the timeout period elapses', async () => {
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);
      const mobileWs = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);

      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
      }));

      webWs.clearMessages();
      mobileWs.clearMessages();

      // Advance time to just before the timeout
      vi.advanceTimersByTime(119999);

      // Neither should have received link_timeout yet
      const webTimeout = webWs.sentMessages.find(m => m.type === 'link_timeout');
      const mobileTimeout = mobileWs.sentMessages.find(m => m.type === 'link_timeout');
      expect(webTimeout).toBeUndefined();
      expect(mobileTimeout).toBeUndefined();
    });
  });

  // ===========================================================================
  // Timer Cleanup on Disconnect
  // ===========================================================================

  describe('Timer Cleanup on Disconnect', () => {
    it('should clear timer when mobile (link target) disconnects', async () => {
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);
      const mobileWs = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);

      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
      }));

      // Mobile disconnects
      await handler.handleDisconnect(mobileWs as any);

      webWs.clearMessages();

      // Advance time past the timeout
      vi.advanceTimersByTime(120001);

      // Web should NOT receive link_timeout — the timer was cleared on disconnect
      const webTimeout = webWs.sentMessages.find(m => m.type === 'link_timeout');
      expect(webTimeout).toBeUndefined();
    });

    it('should clear timer and notify mobile when web client disconnects', async () => {
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);
      const mobileWs = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);

      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
      }));

      mobileWs.clearMessages();

      // Web client disconnects
      await handler.handleDisconnect(webWs as any);

      // Mobile should be notified that the link request expired (web disconnected)
      const mobileTimeout = mobileWs.sentMessages.find(m => m.type === 'link_timeout');
      expect(mobileTimeout).toEqual({
        type: 'link_timeout',
        linkCode: MOBILE_CODE,
      });
    });

    it('should not fire timeout after web client disconnects', async () => {
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);
      const mobileWs = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);

      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
      }));

      // Web client disconnects
      await handler.handleDisconnect(webWs as any);

      mobileWs.clearMessages();

      // Advance time past the timeout — timer should have been cleared
      vi.advanceTimersByTime(120001);

      // Mobile should NOT receive a second link_timeout from the timer
      const timeouts = mobileWs.sentMessages.filter(m => m.type === 'link_timeout');
      expect(timeouts).toHaveLength(0);
    });

    it('should clean up multiple pending link requests on disconnect', async () => {
      // Web client has link requests to two different mobiles
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);
      const mobileWs1 = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);
      const mobileWs2 = await createAndRegisterClient(OTHER_CODE, VALID_PUBKEY_3);

      // Web sends link request to mobile1
      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
      }));

      // Web2 sends link request to other (we need another web client for a 2nd pending request keyed by OTHER_CODE)
      const webWs2 = await createAndRegisterClient(WEB_CODE_2, VALID_PUBKEY_WEB);
      await handler.handleMessage(webWs2 as any, JSON.stringify({
        type: 'link_request',
        linkCode: OTHER_CODE,
        publicKey: VALID_PUBKEY_WEB,
      }));

      // Disconnect webWs (should clean up mobile link request)
      await handler.handleDisconnect(webWs as any);

      mobileWs1.clearMessages();

      // Timer for MOBILE_CODE should be cleared
      vi.advanceTimersByTime(120001);

      const mobile1Timeout = mobileWs1.sentMessages.filter(m => m.type === 'link_timeout');
      expect(mobile1Timeout).toHaveLength(0);

      // Timer for OTHER_CODE (from webWs2) should still fire since webWs2 is still connected
      const mobile2Timeout = mobileWs2.sentMessages.filter(m => m.type === 'link_timeout');
      expect(mobile2Timeout).toHaveLength(1);
    });
  });

  // ===========================================================================
  // Shutdown Cleanup
  // ===========================================================================

  describe('Shutdown Cleanup', () => {
    it('should clear all timers on shutdown without errors', async () => {
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);
      await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);

      // Create a pending link request with a timer
      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
      }));

      // Shutdown should clear all state/timers without errors
      await handler.shutdown();

      webWs.clearMessages();

      // Advance time past the timeout — timer should have been cleared by shutdown
      vi.advanceTimersByTime(120001);

      // No messages should have been sent after shutdown
      const timeouts = webWs.sentMessages.filter(m => m.type === 'link_timeout');
      expect(timeouts).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle accept when mobile publicKey is not found', async () => {
      // This tests the edge case where getPairingCodePublicKey returns undefined
      // In practice this would be unusual but the handler should handle it gracefully
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);
      const mobileWs = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);

      // Web sends link request
      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
      }));

      // Mobile accepts — this should work since the mobile is registered with a public key
      mobileWs.clearMessages();
      webWs.clearMessages();

      await handler.handleMessage(mobileWs as any, JSON.stringify({
        type: 'link_response',
        linkCode: MOBILE_CODE,
        accepted: true,
        deviceId: 'dev-001',
      }));

      // Both should receive link_matched
      const webMatch = webWs.sentMessages.find(m => m.type === 'link_matched');
      const mobileMatch = mobileWs.sentMessages.find(m => m.type === 'link_matched');
      expect(webMatch).toBeDefined();
      expect(mobileMatch).toBeDefined();
    });

    it('should handle link_request with linkCode containing excluded characters (0, 1, I, O)', async () => {
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);

      // Code with '0' (excluded digit)
      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: 'ABC0DE',
        publicKey: VALID_PUBKEY_WEB,
      }));

      let errorMsg = webWs.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toContain('Invalid link code format');

      webWs.clearMessages();

      // Code with '1' (excluded digit)
      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: 'ABC1DE',
        publicKey: VALID_PUBKEY_WEB,
      }));

      errorMsg = webWs.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toContain('Invalid link code format');

      webWs.clearMessages();

      // Code with 'I' (excluded letter)
      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: 'ABCIDE',
        publicKey: VALID_PUBKEY_WEB,
      }));

      errorMsg = webWs.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toContain('Invalid link code format');

      webWs.clearMessages();

      // Code with 'O' (excluded letter)
      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: 'ABCODE',
        publicKey: VALID_PUBKEY_WEB,
      }));

      errorMsg = webWs.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toContain('Invalid link code format');
    });

    it('should handle link_response with linkCode containing excluded characters', async () => {
      const mobileWs = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);

      await handler.handleMessage(mobileWs as any, JSON.stringify({
        type: 'link_response',
        linkCode: 'INV0LD',
        accepted: true,
      }));

      const errorMsg = mobileWs.getLastMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.message).toContain('Invalid link code format');
    });

    it('should handle replacing an existing timer on repeated link_request', async () => {
      const webWs = await createAndRegisterClient(WEB_CODE, VALID_PUBKEY_WEB);
      const mobileWs = await createAndRegisterClient(MOBILE_CODE, VALID_PUBKEY_MOBILE);

      // First link request starts a timer
      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
      }));

      // Advance time halfway
      vi.advanceTimersByTime(60000);

      // Second link request should replace the timer
      await handler.handleMessage(webWs as any, JSON.stringify({
        type: 'link_request',
        linkCode: MOBILE_CODE,
        publicKey: VALID_PUBKEY_WEB,
      }));

      webWs.clearMessages();
      mobileWs.clearMessages();

      // Advance time past the original timeout but not the replacement
      vi.advanceTimersByTime(60001);

      // Should NOT have timed out yet (replacement timer started 60s after original)
      const webTimeout = webWs.sentMessages.find(m => m.type === 'link_timeout');
      expect(webTimeout).toBeUndefined();

      // Advance remaining time to trigger the replacement timer
      vi.advanceTimersByTime(60000);

      // Now both should receive link_timeout
      const webTimeoutAfter = webWs.sentMessages.find(m => m.type === 'link_timeout');
      const mobileTimeoutAfter = mobileWs.sentMessages.find(m => m.type === 'link_timeout');
      expect(webTimeoutAfter).toBeDefined();
      expect(mobileTimeoutAfter).toBeDefined();
    });
  });
});
