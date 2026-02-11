/**
 * WebSocket Handler Chunk Message Tests
 *
 * Tests for chunk-related WebSocket message handling:
 * - chunk_announce: Owner/subscriber announces available chunks
 * - chunk_request: Subscriber requests a chunk
 * - chunk_push: Peer pushes chunk data to server (response to chunk_pull)
 * - Multicast optimization (pull once, serve many)
 * - Disconnect cleanup for chunk index
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebSocketHandler } from '../websocket-handler.js';
import { RelayRegistry } from '../relay-registry.js';
import { RendezvousRegistry } from '../rendezvous-registry.js';
import { ChunkIndex } from '../chunk-index.js';

/**
 * Mock WebSocket for testing
 */
class MockWebSocket {
  constructor() {
    this.sent = [];
    this.closed = false;
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close(code, reason) {
    this.closed = true;
  }

  getLastMessage() {
    return this.sent[this.sent.length - 1];
  }

  getMessagesOfType(type) {
    return this.sent.filter(m => m.type === type);
  }
}

/**
 * Create test handler with all registries including chunk index
 */
function createTestHandler() {
  const relayRegistry = new RelayRegistry();
  const rendezvousRegistry = new RendezvousRegistry();
  const chunkIndex = new ChunkIndex();
  const wsConnections = new Map();

  const handler = new WebSocketHandler({
    relayRegistry,
    rendezvousRegistry,
    chunkIndex,
    wsConnections,
  });

  return {
    handler,
    relayRegistry,
    rendezvousRegistry,
    chunkIndex,
    wsConnections,
    createWs: () => new MockWebSocket(),
  };
}

/**
 * Helper: register a peer via WebSocket
 */
function registerPeer(handler, wsConnections, peerId) {
  const ws = new MockWebSocket();
  wsConnections.set(peerId, ws);
  handler.handleMessage(ws, JSON.stringify({
    type: 'register',
    peerId,
  }));
  return ws;
}

describe('WebSocketHandler - Chunk Messages', () => {
  // ---------------------------------------------------------------------------
  // chunk_announce
  // ---------------------------------------------------------------------------

  describe('chunk_announce', () => {
    it('should register chunk sources and send ack', () => {
      const { handler, chunkIndex, wsConnections } = createTestHandler();
      const ws = registerPeer(handler, wsConnections, 'owner1');

      handler.handleMessage(ws, JSON.stringify({
        type: 'chunk_announce',
        peerId: 'owner1',
        chunks: [
          { chunkId: 'ch_001', routingHash: 'hash_a' },
          { chunkId: 'ch_002', routingHash: 'hash_a' },
        ],
      }));

      const ack = ws.getMessagesOfType('chunk_announce_ack')[0];
      expect(ack).toBeDefined();
      expect(ack.registered).toBe(2);

      // Verify chunks are in the index
      expect(chunkIndex.getChunkSources('ch_001')).toHaveLength(1);
      expect(chunkIndex.getChunkSources('ch_002')).toHaveLength(1);
    });

    it('should send error if peerId is missing', () => {
      const { handler, wsConnections } = createTestHandler();
      const ws = registerPeer(handler, wsConnections, 'peer1');

      handler.handleMessage(ws, JSON.stringify({
        type: 'chunk_announce',
        chunks: [{ chunkId: 'ch_001', routingHash: 'hash_a' }],
      }));

      const error = ws.getMessagesOfType('error')[0];
      expect(error).toBeDefined();
      expect(error.message).toContain('peerId');
    });

    it('should send error if chunks array is empty', () => {
      const { handler, wsConnections } = createTestHandler();
      const ws = registerPeer(handler, wsConnections, 'peer1');

      handler.handleMessage(ws, JSON.stringify({
        type: 'chunk_announce',
        peerId: 'peer1',
        chunks: [],
      }));

      const error = ws.getMessagesOfType('error')[0];
      expect(error).toBeDefined();
      expect(error.message).toContain('chunks');
    });

    it('should trigger chunk_pull if there are pending requests', () => {
      const { handler, chunkIndex, wsConnections } = createTestHandler();

      // Subscriber requests a chunk that nobody has
      const subscriberWs = registerPeer(handler, wsConnections, 'sub1');
      chunkIndex.addPendingRequest('ch_001', 'sub1');

      // Owner announces the chunk
      const ownerWs = registerPeer(handler, wsConnections, 'owner1');
      handler.handleMessage(ownerWs, JSON.stringify({
        type: 'chunk_announce',
        peerId: 'owner1',
        chunks: [{ chunkId: 'ch_001', routingHash: 'hash_a' }],
      }));

      // Owner should receive a chunk_pull request
      const pull = ownerWs.getMessagesOfType('chunk_pull')[0];
      expect(pull).toBeDefined();
      expect(pull.chunkId).toBe('ch_001');
    });

    it('should not trigger chunk_pull if chunk is already cached', () => {
      const { handler, chunkIndex, wsConnections } = createTestHandler();

      // Cache the chunk
      chunkIndex.cacheChunk('ch_001', { chunk_id: 'ch_001' });
      chunkIndex.addPendingRequest('ch_001', 'sub1');

      // Owner announces
      const ownerWs = registerPeer(handler, wsConnections, 'owner1');
      handler.handleMessage(ownerWs, JSON.stringify({
        type: 'chunk_announce',
        peerId: 'owner1',
        chunks: [{ chunkId: 'ch_001', routingHash: 'hash_a' }],
      }));

      // Should NOT get a pull request since it's cached
      const pulls = ownerWs.getMessagesOfType('chunk_pull');
      expect(pulls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // chunk_request
  // ---------------------------------------------------------------------------

  describe('chunk_request', () => {
    it('should serve chunk from cache immediately', () => {
      const { handler, chunkIndex, wsConnections } = createTestHandler();
      const ws = registerPeer(handler, wsConnections, 'sub1');

      const chunkData = { chunk_id: 'ch_001', routing_hash: 'hash_a', payload: 'test' };
      chunkIndex.cacheChunk('ch_001', chunkData);

      handler.handleMessage(ws, JSON.stringify({
        type: 'chunk_request',
        peerId: 'sub1',
        chunkId: 'ch_001',
      }));

      const response = ws.getMessagesOfType('chunk_data')[0];
      expect(response).toBeDefined();
      expect(response.chunkId).toBe('ch_001');
      expect(response.data).toEqual(chunkData);
      expect(response.source).toBe('cache');
    });

    it('should pull from online source when not cached', () => {
      const { handler, chunkIndex, wsConnections } = createTestHandler();

      // Owner has the chunk
      const ownerWs = registerPeer(handler, wsConnections, 'owner1');
      chunkIndex.announceChunks('owner1', [{ chunkId: 'ch_001', routingHash: 'hash_a' }]);

      // Subscriber requests it
      const subWs = registerPeer(handler, wsConnections, 'sub1');
      handler.handleMessage(subWs, JSON.stringify({
        type: 'chunk_request',
        peerId: 'sub1',
        chunkId: 'ch_001',
      }));

      // Owner should receive a chunk_pull
      const pull = ownerWs.getMessagesOfType('chunk_pull')[0];
      expect(pull).toBeDefined();
      expect(pull.chunkId).toBe('ch_001');
    });

    it('should return chunk_not_found when no sources available', () => {
      const { handler, wsConnections } = createTestHandler();
      const ws = registerPeer(handler, wsConnections, 'sub1');

      handler.handleMessage(ws, JSON.stringify({
        type: 'chunk_request',
        peerId: 'sub1',
        chunkId: 'ch_unknown',
      }));

      const response = ws.getMessagesOfType('chunk_not_found')[0];
      expect(response).toBeDefined();
      expect(response.chunkId).toBe('ch_unknown');
    });

    it('should send error if required fields are missing', () => {
      const { handler, wsConnections } = createTestHandler();
      const ws = registerPeer(handler, wsConnections, 'sub1');

      handler.handleMessage(ws, JSON.stringify({
        type: 'chunk_request',
        peerId: 'sub1',
      }));

      const error = ws.getMessagesOfType('error')[0];
      expect(error).toBeDefined();
    });

    it('should only pull once for multiple requests (multicast)', () => {
      const { handler, chunkIndex, wsConnections } = createTestHandler();

      // Owner has the chunk
      const ownerWs = registerPeer(handler, wsConnections, 'owner1');
      chunkIndex.announceChunks('owner1', [{ chunkId: 'ch_001', routingHash: 'hash_a' }]);

      // Two subscribers request the same chunk
      const sub1Ws = registerPeer(handler, wsConnections, 'sub1');
      const sub2Ws = registerPeer(handler, wsConnections, 'sub2');

      handler.handleMessage(sub1Ws, JSON.stringify({
        type: 'chunk_request',
        peerId: 'sub1',
        chunkId: 'ch_001',
      }));

      handler.handleMessage(sub2Ws, JSON.stringify({
        type: 'chunk_request',
        peerId: 'sub2',
        chunkId: 'ch_001',
      }));

      // Owner should only receive ONE chunk_pull (multicast optimization)
      const pulls = ownerWs.getMessagesOfType('chunk_pull');
      expect(pulls).toHaveLength(1);
    });

    it('should not pull from offline source peers', () => {
      const { handler, chunkIndex, wsConnections } = createTestHandler();

      // Announce chunk from peer that is NOT in wsConnections (offline)
      chunkIndex.announceChunks('offline_peer', [{ chunkId: 'ch_001', routingHash: 'hash_a' }]);

      const subWs = registerPeer(handler, wsConnections, 'sub1');
      handler.handleMessage(subWs, JSON.stringify({
        type: 'chunk_request',
        peerId: 'sub1',
        chunkId: 'ch_001',
      }));

      // Should get chunk_not_found since the source is offline
      const notFound = subWs.getMessagesOfType('chunk_not_found')[0];
      expect(notFound).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // chunk_push
  // ---------------------------------------------------------------------------

  describe('chunk_push', () => {
    it('should cache the chunk and send ack', () => {
      const { handler, chunkIndex, wsConnections } = createTestHandler();
      const ws = registerPeer(handler, wsConnections, 'owner1');

      const chunkData = { chunk_id: 'ch_001', routing_hash: 'hash_a', payload: 'test' };

      handler.handleMessage(ws, JSON.stringify({
        type: 'chunk_push',
        peerId: 'owner1',
        chunkId: 'ch_001',
        data: chunkData,
      }));

      const ack = ws.getMessagesOfType('chunk_push_ack')[0];
      expect(ack).toBeDefined();
      expect(ack.chunkId).toBe('ch_001');

      // Verify chunk is cached
      expect(chunkIndex.getCachedChunk('ch_001')).toEqual(chunkData);
    });

    it('should serve all pending requesters after push (multicast)', () => {
      const { handler, chunkIndex, wsConnections } = createTestHandler();

      // Two subscribers are waiting for the chunk
      const sub1Ws = registerPeer(handler, wsConnections, 'sub1');
      const sub2Ws = registerPeer(handler, wsConnections, 'sub2');
      chunkIndex.addPendingRequest('ch_001', 'sub1');
      chunkIndex.addPendingRequest('ch_001', 'sub2');

      // Owner pushes the chunk
      const ownerWs = registerPeer(handler, wsConnections, 'owner1');
      const chunkData = { chunk_id: 'ch_001', routing_hash: 'hash_a', payload: 'test' };

      handler.handleMessage(ownerWs, JSON.stringify({
        type: 'chunk_push',
        peerId: 'owner1',
        chunkId: 'ch_001',
        data: chunkData,
      }));

      // Both subscribers should receive chunk_data
      const sub1Data = sub1Ws.getMessagesOfType('chunk_data')[0];
      const sub2Data = sub2Ws.getMessagesOfType('chunk_data')[0];

      expect(sub1Data).toBeDefined();
      expect(sub1Data.data).toEqual(chunkData);
      expect(sub1Data.source).toBe('relay');

      expect(sub2Data).toBeDefined();
      expect(sub2Data.data).toEqual(chunkData);
      expect(sub2Data.source).toBe('relay');
    });

    it('should send error if required fields are missing', () => {
      const { handler, wsConnections } = createTestHandler();
      const ws = registerPeer(handler, wsConnections, 'peer1');

      handler.handleMessage(ws, JSON.stringify({
        type: 'chunk_push',
        peerId: 'peer1',
      }));

      const error = ws.getMessagesOfType('error')[0];
      expect(error).toBeDefined();
    });

    it('should handle push for chunk with no pending requests', () => {
      const { handler, chunkIndex, wsConnections } = createTestHandler();
      const ws = registerPeer(handler, wsConnections, 'owner1');

      handler.handleMessage(ws, JSON.stringify({
        type: 'chunk_push',
        peerId: 'owner1',
        chunkId: 'ch_001',
        data: { chunk_id: 'ch_001' },
      }));

      const ack = ws.getMessagesOfType('chunk_push_ack')[0];
      expect(ack).toBeDefined();

      // Chunk should still be cached
      expect(chunkIndex.isChunkCached('ch_001')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Full flow: announce -> request -> pull -> push -> serve
  // ---------------------------------------------------------------------------

  describe('full chunk flow', () => {
    it('should handle complete chunk distribution flow', () => {
      const { handler, wsConnections } = createTestHandler();

      // Step 1: Owner registers and announces chunks
      const ownerWs = registerPeer(handler, wsConnections, 'owner1');

      handler.handleMessage(ownerWs, JSON.stringify({
        type: 'chunk_announce',
        peerId: 'owner1',
        chunks: [
          { chunkId: 'ch_001', routingHash: 'hash_a' },
          { chunkId: 'ch_002', routingHash: 'hash_a' },
        ],
      }));

      const announceAck = ownerWs.getMessagesOfType('chunk_announce_ack')[0];
      expect(announceAck.registered).toBe(2);

      // Step 2: Subscriber requests a chunk
      const subWs = registerPeer(handler, wsConnections, 'sub1');

      handler.handleMessage(subWs, JSON.stringify({
        type: 'chunk_request',
        peerId: 'sub1',
        chunkId: 'ch_001',
      }));

      // Step 3: Server should ask owner for the chunk
      const pull = ownerWs.getMessagesOfType('chunk_pull')[0];
      expect(pull).toBeDefined();
      expect(pull.chunkId).toBe('ch_001');

      // Step 4: Owner pushes the chunk data
      const chunkData = {
        chunk_id: 'ch_001',
        routing_hash: 'hash_a',
        encrypted_payload: 'base64data',
        signature: 'sig',
      };

      handler.handleMessage(ownerWs, JSON.stringify({
        type: 'chunk_push',
        peerId: 'owner1',
        chunkId: 'ch_001',
        data: chunkData,
      }));

      // Step 5: Subscriber should receive the chunk data
      const subData = subWs.getMessagesOfType('chunk_data')[0];
      expect(subData).toBeDefined();
      expect(subData.chunkId).toBe('ch_001');
      expect(subData.data).toEqual(chunkData);
    });

    it('should handle subscriber re-seeding (swarm)', () => {
      const { handler, chunkIndex, wsConnections } = createTestHandler();

      // Owner announces
      const ownerWs = registerPeer(handler, wsConnections, 'owner1');
      handler.handleMessage(ownerWs, JSON.stringify({
        type: 'chunk_announce',
        peerId: 'owner1',
        chunks: [{ chunkId: 'ch_001', routingHash: 'hash_a' }],
      }));

      // Subscriber 1 gets the chunk (simulated by having data)
      const sub1Ws = registerPeer(handler, wsConnections, 'sub1');

      // Sub1 re-announces as a source (swarm seeding)
      handler.handleMessage(sub1Ws, JSON.stringify({
        type: 'chunk_announce',
        peerId: 'sub1',
        chunks: [{ chunkId: 'ch_001', routingHash: 'hash_a' }],
      }));

      // Now two sources should be available
      const sources = chunkIndex.getChunkSources('ch_001');
      expect(sources.length).toBeGreaterThanOrEqual(2);
      expect(sources.map(s => s.peerId)).toContain('owner1');
      expect(sources.map(s => s.peerId)).toContain('sub1');
    });
  });

  // ---------------------------------------------------------------------------
  // Disconnect cleanup
  // ---------------------------------------------------------------------------

  describe('disconnect with chunks', () => {
    it('should clean up chunk sources on disconnect', () => {
      const { handler, chunkIndex, wsConnections } = createTestHandler();

      const ws = registerPeer(handler, wsConnections, 'owner1');

      handler.handleMessage(ws, JSON.stringify({
        type: 'chunk_announce',
        peerId: 'owner1',
        chunks: [{ chunkId: 'ch_001', routingHash: 'hash_a' }],
      }));

      expect(chunkIndex.getChunkSources('ch_001')).toHaveLength(1);

      handler.handleDisconnect(ws, 'owner1');

      expect(chunkIndex.getChunkSources('ch_001')).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Handler without chunk index (backward compatibility)
  // ---------------------------------------------------------------------------

  describe('backward compatibility (no chunk index)', () => {
    it('should send error when chunk messages arrive without chunk index', () => {
      const relayRegistry = new RelayRegistry();
      const rendezvousRegistry = new RendezvousRegistry();
      const wsConnections = new Map();

      // Handler without chunkIndex
      const handler = new WebSocketHandler({
        relayRegistry,
        rendezvousRegistry,
        wsConnections,
      });

      const ws = new MockWebSocket();
      wsConnections.set('peer1', ws);
      handler.handleMessage(ws, JSON.stringify({
        type: 'register',
        peerId: 'peer1',
      }));

      handler.handleMessage(ws, JSON.stringify({
        type: 'chunk_announce',
        peerId: 'peer1',
        chunks: [{ chunkId: 'ch_001', routingHash: 'hash_a' }],
      }));

      const error = ws.getMessagesOfType('error')[0];
      expect(error).toBeDefined();
      expect(error.message).toContain('not available');
    });

    it('should handle disconnect gracefully without chunk index', () => {
      const relayRegistry = new RelayRegistry();
      const rendezvousRegistry = new RendezvousRegistry();
      const wsConnections = new Map();

      const handler = new WebSocketHandler({
        relayRegistry,
        rendezvousRegistry,
        wsConnections,
      });

      const ws = new MockWebSocket();
      handler.handleMessage(ws, JSON.stringify({
        type: 'register',
        peerId: 'peer1',
      }));

      // Should not throw
      handler.handleDisconnect(ws, 'peer1');
    });
  });
});
