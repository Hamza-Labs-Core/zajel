/**
 * RelayRegistryDO Tests
 *
 * Tests for the Durable Object wrapper that integrates all components.
 * Note: These tests mock the Durable Object state since we can't run
 * actual Durable Objects in the test environment.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock Cloudflare Durable Object state
class MockDurableObjectState {
  constructor() {
    this.storage = new MockStorage();
    this.acceptedWebSockets = [];
  }

  acceptWebSocket(ws) {
    this.acceptedWebSockets.push(ws);
  }

  blockConcurrencyWhile(fn) {
    return fn();
  }
}

class MockStorage {
  constructor() {
    this.data = new Map();
    this.alarm = null;
  }

  async get(key) {
    return this.data.get(key);
  }

  async put(key, value) {
    this.data.set(key, value);
  }

  async delete(key) {
    this.data.delete(key);
  }

  async getAlarm() {
    return this.alarm;
  }

  async setAlarm(time) {
    this.alarm = time;
  }
}

// We need to test the integration at a higher level
// since Durable Objects have specific runtime requirements

describe('RelayRegistryDO Integration', () => {
  describe('Component Integration', () => {
    it('should have all required exports', async () => {
      const { RelayRegistry } = await import('../relay-registry.js');
      const { RendezvousRegistry } = await import('../rendezvous-registry.js');
      const { WebSocketHandler } = await import('../websocket-handler.js');

      expect(RelayRegistry).toBeDefined();
      expect(RendezvousRegistry).toBeDefined();
      expect(WebSocketHandler).toBeDefined();
    });

    it('should integrate relay and rendezvous registries through handler', async () => {
      const { RelayRegistry } = await import('../relay-registry.js');
      const { RendezvousRegistry } = await import('../rendezvous-registry.js');
      const { WebSocketHandler } = await import('../websocket-handler.js');

      const relayRegistry = new RelayRegistry();
      const rendezvousRegistry = new RendezvousRegistry();
      const wsConnections = new Map();

      const handler = new WebSocketHandler({
        relayRegistry,
        rendezvousRegistry,
        wsConnections,
      });

      // Create mock WebSocket
      const sent = [];
      const mockWs = {
        send: (data) => sent.push(JSON.parse(data)),
      };

      // Register a peer
      handler.handleMessage(mockWs, JSON.stringify({
        type: 'register',
        peerId: 'peer1',
        maxConnections: 20,
        publicKey: 'pk1',
      }));

      // Verify peer is registered in relay registry
      expect(relayRegistry.getPeer('peer1')).toBeDefined();

      // Verify WebSocket connection is tracked
      expect(wsConnections.get('peer1')).toBe(mockWs);

      // Verify response was sent
      const registeredResponse = sent.find(m => m.type === 'registered');
      expect(registeredResponse).toBeDefined();
    });

    it('should handle full rendezvous flow', async () => {
      const { RelayRegistry } = await import('../relay-registry.js');
      const { RendezvousRegistry } = await import('../rendezvous-registry.js');
      const { WebSocketHandler } = await import('../websocket-handler.js');

      const relayRegistry = new RelayRegistry();
      const rendezvousRegistry = new RendezvousRegistry();
      const wsConnections = new Map();

      const handler = new WebSocketHandler({
        relayRegistry,
        rendezvousRegistry,
        wsConnections,
      });

      // Alice's WebSocket
      const aliceSent = [];
      const aliceWs = {
        send: (data) => aliceSent.push(JSON.parse(data)),
      };

      // Bob's WebSocket
      const bobSent = [];
      const bobWs = {
        send: (data) => bobSent.push(JSON.parse(data)),
      };

      // Alice registers
      handler.handleMessage(aliceWs, JSON.stringify({
        type: 'register',
        peerId: 'alice',
      }));

      // Alice registers rendezvous points
      handler.handleMessage(aliceWs, JSON.stringify({
        type: 'register_rendezvous',
        peerId: 'alice',
        dailyPoints: ['day_shared'],
        hourlyTokens: ['hr_shared'],
        deadDrop: 'alice_encrypted_message',
        relayId: 'relay1',
      }));

      // Bob registers
      handler.handleMessage(bobWs, JSON.stringify({
        type: 'register',
        peerId: 'bob',
      }));

      // Bob registers same rendezvous points
      handler.handleMessage(bobWs, JSON.stringify({
        type: 'register_rendezvous',
        peerId: 'bob',
        dailyPoints: ['day_shared'],
        hourlyTokens: ['hr_shared'],
        deadDrop: 'bob_encrypted_message',
        relayId: 'relay2',
      }));

      // Bob should receive Alice's dead drop and live match
      const bobResult = bobSent.find(m => m.type === 'rendezvous_result');
      expect(bobResult).toBeDefined();
      expect(bobResult.deadDrops).toHaveLength(1);
      expect(bobResult.deadDrops[0].peerId).toBe('alice');
      expect(bobResult.liveMatches).toHaveLength(1);
      expect(bobResult.liveMatches[0].peerId).toBe('alice');

      // Alice should be notified of Bob's live match
      const aliceMatch = aliceSent.find(m => m.type === 'rendezvous_match');
      expect(aliceMatch).toBeDefined();
      expect(aliceMatch.match.peerId).toBe('bob');
    });

    it('should handle peer disconnect properly', async () => {
      const { RelayRegistry } = await import('../relay-registry.js');
      const { RendezvousRegistry } = await import('../rendezvous-registry.js');
      const { WebSocketHandler } = await import('../websocket-handler.js');

      const relayRegistry = new RelayRegistry();
      const rendezvousRegistry = new RendezvousRegistry();
      const wsConnections = new Map();

      const handler = new WebSocketHandler({
        relayRegistry,
        rendezvousRegistry,
        wsConnections,
      });

      const sent = [];
      const mockWs = {
        send: (data) => sent.push(JSON.parse(data)),
      };

      // Register peer
      handler.handleMessage(mockWs, JSON.stringify({
        type: 'register',
        peerId: 'peer1',
      }));

      // Register rendezvous
      handler.handleMessage(mockWs, JSON.stringify({
        type: 'register_rendezvous',
        peerId: 'peer1',
        dailyPoints: ['day_point'],
        hourlyTokens: ['hr_token'],
        deadDrop: 'encrypted',
        relayId: 'relay1',
      }));

      // Verify registrations
      expect(relayRegistry.getPeer('peer1')).toBeDefined();
      expect(rendezvousRegistry.getDailyPoint('day_point')).toHaveLength(1);

      // Disconnect
      handler.handleDisconnect(mockWs, 'peer1');

      // Verify cleanup
      expect(relayRegistry.getPeer('peer1')).toBeUndefined();
      expect(wsConnections.get('peer1')).toBeUndefined();
      expect(rendezvousRegistry.getDailyPoint('day_point')).toHaveLength(0);
    });
  });

  describe('Message Protocol', () => {
    it('should handle all message types', async () => {
      const { RelayRegistry } = await import('../relay-registry.js');
      const { RendezvousRegistry } = await import('../rendezvous-registry.js');
      const { WebSocketHandler } = await import('../websocket-handler.js');

      const handler = new WebSocketHandler({
        relayRegistry: new RelayRegistry(),
        rendezvousRegistry: new RendezvousRegistry(),
        wsConnections: new Map(),
      });

      const sent = [];
      const mockWs = {
        send: (data) => sent.push(JSON.parse(data)),
      };

      const messageTypes = [
        { type: 'register', peerId: 'p1' },
        { type: 'ping' },
        { type: 'heartbeat', peerId: 'p1' },
        { type: 'update_load', peerId: 'p1', connectedCount: 5 },
        { type: 'get_relays', peerId: 'p1' },
        { type: 'register_rendezvous', peerId: 'p1', dailyPoints: [], hourlyTokens: [], deadDrop: '', relayId: 'r1' },
      ];

      for (const msg of messageTypes) {
        handler.handleMessage(mockWs, JSON.stringify(msg));
      }

      // Verify all responses received
      expect(sent.find(m => m.type === 'registered')).toBeDefined();
      expect(sent.find(m => m.type === 'pong')).toBeDefined();
      expect(sent.find(m => m.type === 'heartbeat_ack')).toBeDefined();
      expect(sent.find(m => m.type === 'load_updated')).toBeDefined();
      expect(sent.find(m => m.type === 'relays')).toBeDefined();
      expect(sent.find(m => m.type === 'rendezvous_result')).toBeDefined();
    });
  });
});
