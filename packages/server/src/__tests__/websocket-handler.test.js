/**
 * WebSocket Handler Tests
 *
 * Tests for the WebSocket message routing and handling:
 * - Peer registration
 * - Rendezvous point registration
 * - Load updates
 * - Disconnect handling
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebSocketHandler } from '../websocket-handler.js';
import { RelayRegistry } from '../relay-registry.js';
import { RendezvousRegistry } from '../rendezvous-registry.js';

/**
 * Mock WebSocket for testing
 */
class MockWebSocket {
  constructor() {
    this.sent = [];
    this.closed = false;
    this.closeCode = null;
    this.closeReason = null;
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close(code, reason) {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }

  getLastMessage() {
    return this.sent[this.sent.length - 1];
  }

  getMessagesOfType(type) {
    return this.sent.filter(m => m.type === type);
  }
}

/**
 * Create test handler with registries
 */
function createTestHandler() {
  const relayRegistry = new RelayRegistry();
  const rendezvousRegistry = new RendezvousRegistry();
  const wsConnections = new Map();

  const handler = new WebSocketHandler({
    relayRegistry,
    rendezvousRegistry,
    wsConnections,
  });

  return {
    handler,
    relayRegistry,
    rendezvousRegistry,
    wsConnections,
    createWs: () => new MockWebSocket(),
  };
}

describe('WebSocketHandler', () => {
  describe('register message', () => {
    it('should register peer and return available relays', () => {
      const { handler, createWs, relayRegistry } = createTestHandler();
      const ws = createWs();

      // Pre-register some relays
      relayRegistry.register('relay1', { maxConnections: 20, publicKey: 'pk1' });
      relayRegistry.register('relay2', { maxConnections: 20, publicKey: 'pk2' });

      handler.handleMessage(ws, JSON.stringify({
        type: 'register',
        peerId: 'peer1',
        publicKey: 'pk_peer1',
        maxConnections: 20,
      }));

      const response = ws.getMessagesOfType('registered')[0];
      expect(response).toBeDefined();
      expect(response.relays).toBeDefined();
      expect(Array.isArray(response.relays)).toBe(true);
    });

    it('should store WebSocket connection for peer', () => {
      const { handler, createWs, wsConnections } = createTestHandler();
      const ws = createWs();

      handler.handleMessage(ws, JSON.stringify({
        type: 'register',
        peerId: 'peer1',
      }));

      expect(wsConnections.get('peer1')).toBe(ws);
    });

    it('should add peer to relay registry', () => {
      const { handler, createWs, relayRegistry } = createTestHandler();
      const ws = createWs();

      handler.handleMessage(ws, JSON.stringify({
        type: 'register',
        peerId: 'peer1',
        maxConnections: 30,
        publicKey: 'pk1',
      }));

      const peer = relayRegistry.getPeer('peer1');
      expect(peer).toBeDefined();
      expect(peer.maxConnections).toBe(30);
      expect(peer.publicKey).toBe('pk1');
    });

    it('should use default maxConnections if not provided', () => {
      const { handler, createWs, relayRegistry } = createTestHandler();
      const ws = createWs();

      handler.handleMessage(ws, JSON.stringify({
        type: 'register',
        peerId: 'peer1',
      }));

      expect(relayRegistry.getPeer('peer1').maxConnections).toBe(20);
    });

    it('should exclude self from returned relays', () => {
      const { handler, createWs, relayRegistry } = createTestHandler();
      const ws = createWs();

      // Pre-register the peer as a relay
      relayRegistry.register('peer1', { maxConnections: 20 });

      handler.handleMessage(ws, JSON.stringify({
        type: 'register',
        peerId: 'peer1',
      }));

      const response = ws.getMessagesOfType('registered')[0];
      expect(response.relays.find(r => r.peerId === 'peer1')).toBeUndefined();
    });
  });

  describe('update_load message', () => {
    it('should update peer connection count', () => {
      const { handler, createWs, relayRegistry } = createTestHandler();
      const ws = createWs();

      handler.handleMessage(ws, JSON.stringify({
        type: 'register',
        peerId: 'peer1',
        maxConnections: 20,
      }));

      handler.handleMessage(ws, JSON.stringify({
        type: 'update_load',
        peerId: 'peer1',
        connectedCount: 10,
      }));

      expect(relayRegistry.getPeer('peer1').connectedCount).toBe(10);
    });

    it('should send acknowledgement', () => {
      const { handler, createWs } = createTestHandler();
      const ws = createWs();

      handler.handleMessage(ws, JSON.stringify({
        type: 'register',
        peerId: 'peer1',
      }));

      handler.handleMessage(ws, JSON.stringify({
        type: 'update_load',
        peerId: 'peer1',
        connectedCount: 10,
      }));

      const response = ws.getMessagesOfType('load_updated')[0];
      expect(response).toBeDefined();
    });
  });

  describe('register_rendezvous message', () => {
    it('should register meeting points and return matches', () => {
      const { handler, createWs } = createTestHandler();
      const ws = createWs();

      handler.handleMessage(ws, JSON.stringify({
        type: 'register',
        peerId: 'peer1',
      }));

      handler.handleMessage(ws, JSON.stringify({
        type: 'register_rendezvous',
        peerId: 'peer1',
        dailyPoints: ['day_abc'],
        hourlyTokens: ['hr_xyz'],
        deadDrop: 'encrypted',
        relayId: 'relay1',
      }));

      const response = ws.getMessagesOfType('rendezvous_result')[0];
      expect(response).toBeDefined();
      expect(response.liveMatches).toBeDefined();
      expect(response.deadDrops).toBeDefined();
    });

    it('should return dead drops from other peers', () => {
      const { handler, createWs, rendezvousRegistry } = createTestHandler();

      // Alice registers first
      rendezvousRegistry.registerDailyPoints('alice', {
        points: ['day_abc'],
        deadDrop: 'alice_encrypted',
        relayId: 'relay1',
      });

      const ws = createWs();

      handler.handleMessage(ws, JSON.stringify({
        type: 'register',
        peerId: 'bob',
      }));

      handler.handleMessage(ws, JSON.stringify({
        type: 'register_rendezvous',
        peerId: 'bob',
        dailyPoints: ['day_abc'],
        hourlyTokens: [],
        deadDrop: 'bob_encrypted',
        relayId: 'relay2',
      }));

      const response = ws.getMessagesOfType('rendezvous_result')[0];
      expect(response.deadDrops).toHaveLength(1);
      expect(response.deadDrops[0].peerId).toBe('alice');
    });

    it('should return live matches and notify original peers', () => {
      const { handler, createWs, wsConnections, rendezvousRegistry } = createTestHandler();

      // Alice is already connected
      const aliceWs = createWs();
      wsConnections.set('alice', aliceWs);

      rendezvousRegistry.registerHourlyTokens('alice', {
        tokens: ['hr_xyz'],
        relayId: 'relay1',
      });

      // Set up notification callback
      rendezvousRegistry.onMatch = (peerId, match) => {
        const targetWs = wsConnections.get(peerId);
        if (targetWs) {
          targetWs.send(JSON.stringify({
            type: 'rendezvous_match',
            match,
          }));
        }
      };

      // Bob registers
      const bobWs = createWs();
      handler.handleMessage(bobWs, JSON.stringify({
        type: 'register',
        peerId: 'bob',
      }));

      handler.handleMessage(bobWs, JSON.stringify({
        type: 'register_rendezvous',
        peerId: 'bob',
        dailyPoints: [],
        hourlyTokens: ['hr_xyz'],
        deadDrop: '',
        relayId: 'relay2',
      }));

      // Bob should get live match
      const bobResponse = bobWs.getMessagesOfType('rendezvous_result')[0];
      expect(bobResponse.liveMatches).toHaveLength(1);
      expect(bobResponse.liveMatches[0].peerId).toBe('alice');

      // Alice should be notified
      const aliceNotification = aliceWs.getMessagesOfType('rendezvous_match')[0];
      expect(aliceNotification).toBeDefined();
      expect(aliceNotification.match.peerId).toBe('bob');
    });
  });

  describe('get_relays message', () => {
    it('should return available relays', () => {
      const { handler, createWs, relayRegistry } = createTestHandler();
      const ws = createWs();

      relayRegistry.register('relay1', { maxConnections: 20, publicKey: 'pk1' });
      relayRegistry.register('relay2', { maxConnections: 20, publicKey: 'pk2' });

      handler.handleMessage(ws, JSON.stringify({
        type: 'register',
        peerId: 'peer1',
      }));

      handler.handleMessage(ws, JSON.stringify({
        type: 'get_relays',
        peerId: 'peer1',
      }));

      const response = ws.getMessagesOfType('relays')[0];
      expect(response).toBeDefined();
      expect(response.relays).toBeDefined();
      expect(response.relays.length).toBeGreaterThan(0);
    });
  });

  describe('ping message', () => {
    it('should respond with pong', () => {
      const { handler, createWs } = createTestHandler();
      const ws = createWs();

      handler.handleMessage(ws, JSON.stringify({
        type: 'ping',
      }));

      const response = ws.getMessagesOfType('pong')[0];
      expect(response).toBeDefined();
    });
  });

  describe('disconnect handling', () => {
    it('should unregister peer on disconnect', () => {
      const { handler, createWs, relayRegistry, wsConnections } = createTestHandler();
      const ws = createWs();

      handler.handleMessage(ws, JSON.stringify({
        type: 'register',
        peerId: 'peer1',
      }));

      expect(relayRegistry.getPeer('peer1')).toBeDefined();

      handler.handleDisconnect(ws, 'peer1');

      expect(relayRegistry.getPeer('peer1')).toBeUndefined();
      expect(wsConnections.get('peer1')).toBeUndefined();
    });

    it('should unregister from rendezvous on disconnect', () => {
      const { handler, createWs, rendezvousRegistry } = createTestHandler();
      const ws = createWs();

      handler.handleMessage(ws, JSON.stringify({
        type: 'register',
        peerId: 'peer1',
      }));

      handler.handleMessage(ws, JSON.stringify({
        type: 'register_rendezvous',
        peerId: 'peer1',
        dailyPoints: ['day_abc'],
        hourlyTokens: ['hr_xyz'],
        deadDrop: 'encrypted',
        relayId: 'relay1',
      }));

      handler.handleDisconnect(ws, 'peer1');

      const entries = rendezvousRegistry.getDailyPoint('day_abc');
      expect(entries.find(e => e.peerId === 'peer1')).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('should send error for invalid JSON', () => {
      const { handler, createWs } = createTestHandler();
      const ws = createWs();

      handler.handleMessage(ws, 'not valid json');

      const response = ws.getMessagesOfType('error')[0];
      expect(response).toBeDefined();
      expect(response.message).toContain('Invalid');
    });

    it('should send error for unknown message type', () => {
      const { handler, createWs } = createTestHandler();
      const ws = createWs();

      handler.handleMessage(ws, JSON.stringify({
        type: 'unknown_type',
      }));

      const response = ws.getMessagesOfType('error')[0];
      expect(response).toBeDefined();
      expect(response.message).toContain('Unknown');
    });

    it('should send error when peerId is missing for register', () => {
      const { handler, createWs } = createTestHandler();
      const ws = createWs();

      handler.handleMessage(ws, JSON.stringify({
        type: 'register',
      }));

      const response = ws.getMessagesOfType('error')[0];
      expect(response).toBeDefined();
      expect(response.message).toContain('peerId');
    });
  });

  describe('heartbeat', () => {
    it('should update lastSeen on heartbeat', () => {
      const { handler, createWs, relayRegistry } = createTestHandler();
      const ws = createWs();

      handler.handleMessage(ws, JSON.stringify({
        type: 'register',
        peerId: 'peer1',
      }));

      const beforeHeartbeat = relayRegistry.getPeer('peer1').lastUpdate;

      handler.handleMessage(ws, JSON.stringify({
        type: 'heartbeat',
        peerId: 'peer1',
      }));

      expect(relayRegistry.getPeer('peer1').lastUpdate).toBeGreaterThanOrEqual(beforeHeartbeat);
    });
  });
});
