/**
 * Client Handler Chunk Relay Tests
 *
 * Tests for the VPS-side chunk relay infrastructure:
 * - chunk_announce: peer announces it has chunks
 * - chunk_request: peer requests a chunk (serve from cache or pull from source)
 * - chunk_push: peer sends chunk data (response to pull), cache and fan out
 * - Cache TTL cleanup and LRU eviction
 * - Pending request deduplication (pull once, serve many)
 * - Peer disconnect cleanup
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { ClientHandler, type ClientHandlerConfig } from '../../src/client/handler.js';
import { ChunkRelay } from '../../src/client/chunk-relay.js';
import { RelayRegistry } from '../../src/registry/relay-registry.js';
import { SQLiteStorage } from '../../src/storage/sqlite.js';
import type { ServerIdentity } from '../../src/types.js';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

// Valid 32-byte base64-encoded public keys for testing
const VALID_PUBKEY_1 = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDE=';
const VALID_PUBKEY_2 = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDI=';
const VALID_PUBKEY_3 = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDM=';

// Valid pairing codes
const PEER_CODE_1 = 'CHK234';
const PEER_CODE_2 = 'CHK567';
const PEER_CODE_3 = 'CHK893';

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

  getMessagesByType(type: string): any[] {
    return this.sentMessages.filter((m: any) => m.type === type);
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

// Helper: create a test storage with real SQLite
function createTestStorage(): { storage: SQLiteStorage; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'zajel-chunk-test-'));
  const dbPath = join(tmpDir, 'test.db');
  const storage = new SQLiteStorage(dbPath);
  return { storage, tmpDir };
}

// Helper: create a handler with real storage for chunk relay
function createHandlerWithStorage(storage: SQLiteStorage) {
  const identity: ServerIdentity = {
    serverId: 'test-server-id',
    nodeId: 'test-node-id',
    ephemeralId: 'srv-test',
    publicKey: new Uint8Array(32),
    privateKey: new Uint8Array(32),
  };

  const config: ClientHandlerConfig = {
    heartbeatInterval: 30000,
    heartbeatTimeout: 90000,
    maxConnectionsPerPeer: 10,
    pairRequestTimeout: 5000,
    pairRequestWarningTime: 2000,
  };

  const relayRegistry = new RelayRegistry();
  const distributedRendezvous = new MockDistributedRendezvous();

  const handler = new ClientHandler(
    identity,
    'ws://localhost:8080',
    config,
    relayRegistry,
    distributedRendezvous as any,
    {},
    storage
  );

  return handler;
}

// Helper: register a peer with a pairing code
async function registerPeer(handler: ClientHandler, ws: MockWebSocket, code: string, pubkey: string) {
  await handler.handleMessage(ws as any, JSON.stringify({
    type: 'register',
    pairingCode: code,
    publicKey: pubkey,
  }));
}

describe('Chunk Announce', () => {
  let handler: ClientHandler;
  let storage: SQLiteStorage;
  let tmpDir: string;
  let peerWs: MockWebSocket;

  beforeEach(async () => {
    ({ storage, tmpDir } = createTestStorage());
    await storage.init();
    handler = createHandlerWithStorage(storage);

    peerWs = new MockWebSocket();
    handler.handleConnection(peerWs as any);
    await registerPeer(handler, peerWs, PEER_CODE_1, VALID_PUBKEY_1);
    peerWs.clearMessages();
  });

  afterEach(async () => {
    await handler.shutdown();
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should acknowledge chunk announce', async () => {
    await handler.handleMessage(peerWs as any, JSON.stringify({
      type: 'chunk_announce',
      peerId: 'peer-1',
      chunks: [
        { chunkId: 'chunk-abc', channelId: 'ch_1' },
        { chunkId: 'chunk-def', channelId: 'ch_1' },
      ],
    }));

    const ack = peerWs.getLastMessage();
    expect(ack.type).toBe('chunk_announce_ack');
    expect(ack.registered).toBe(2);
  });

  it('should reject announce with missing peerId', async () => {
    await handler.handleMessage(peerWs as any, JSON.stringify({
      type: 'chunk_announce',
      chunks: [{ chunkId: 'chunk-abc', channelId: 'ch_1' }],
    }));

    const lastMsg = peerWs.getLastMessage();
    expect(lastMsg.type).toBe('error');
    expect(lastMsg.message).toContain('peerId');
  });

  it('should reject announce with missing chunks', async () => {
    await handler.handleMessage(peerWs as any, JSON.stringify({
      type: 'chunk_announce',
      peerId: 'peer-1',
    }));

    const lastMsg = peerWs.getLastMessage();
    expect(lastMsg.type).toBe('error');
    expect(lastMsg.message).toContain('chunks');
  });

  it('should reject announce with empty chunks array', async () => {
    await handler.handleMessage(peerWs as any, JSON.stringify({
      type: 'chunk_announce',
      peerId: 'peer-1',
      chunks: [],
    }));

    const lastMsg = peerWs.getLastMessage();
    expect(lastMsg.type).toBe('error');
    expect(lastMsg.message).toContain('chunks');
  });

  it('should reject chunk without chunkId', async () => {
    await handler.handleMessage(peerWs as any, JSON.stringify({
      type: 'chunk_announce',
      peerId: 'peer-1',
      chunks: [{ channelId: 'ch_1' }],
    }));

    const lastMsg = peerWs.getLastMessage();
    expect(lastMsg.type).toBe('error');
    expect(lastMsg.message).toContain('chunkId');
  });

  it('should store chunk sources in database', async () => {
    await handler.handleMessage(peerWs as any, JSON.stringify({
      type: 'chunk_announce',
      peerId: 'peer-1',
      chunks: [
        { chunkId: 'chunk-abc', channelId: 'ch_1' },
      ],
    }));

    // Verify directly from storage
    const sources = await storage.getChunkSources('chunk-abc');
    expect(sources.length).toBe(1);
    expect(sources[0]!.peerId).toBe('peer-1');
  });
});

describe('Chunk Request - Cache Hit', () => {
  let handler: ClientHandler;
  let storage: SQLiteStorage;
  let tmpDir: string;
  let peerWs: MockWebSocket;

  beforeEach(async () => {
    ({ storage, tmpDir } = createTestStorage());
    await storage.init();
    handler = createHandlerWithStorage(storage);

    peerWs = new MockWebSocket();
    handler.handleConnection(peerWs as any);
    await registerPeer(handler, peerWs, PEER_CODE_1, VALID_PUBKEY_1);
    peerWs.clearMessages();
  });

  afterEach(async () => {
    await handler.shutdown();
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should serve cached chunk immediately', async () => {
    // Pre-populate cache
    const chunkData = Buffer.from(JSON.stringify({ content: 'hello' }));
    await storage.cacheChunk('chunk-cached', 'ch_1', chunkData);

    await handler.handleMessage(peerWs as any, JSON.stringify({
      type: 'chunk_request',
      chunkId: 'chunk-cached',
      channelId: 'ch_1',
    }));

    const response = peerWs.getMessagesByType('chunk_response');
    expect(response.length).toBe(1);
    expect(response[0].chunkId).toBe('chunk-cached');
    expect(response[0].source).toBe('cache');
    expect(response[0].data).toBe(chunkData.toString('base64'));
  });

  it('should reject request with missing chunkId', async () => {
    await handler.handleMessage(peerWs as any, JSON.stringify({
      type: 'chunk_request',
      channelId: 'ch_1',
    }));

    const lastMsg = peerWs.getLastMessage();
    expect(lastMsg.type).toBe('error');
    expect(lastMsg.message).toContain('chunkId');
  });

  it('should reject request with missing channelId', async () => {
    await handler.handleMessage(peerWs as any, JSON.stringify({
      type: 'chunk_request',
      chunkId: 'chunk-123',
    }));

    const lastMsg = peerWs.getLastMessage();
    expect(lastMsg.type).toBe('error');
    expect(lastMsg.message).toContain('channelId');
  });
});

describe('Chunk Request - Cache Miss with Source', () => {
  let handler: ClientHandler;
  let storage: SQLiteStorage;
  let tmpDir: string;
  let requesterWs: MockWebSocket;
  let sourceWs: MockWebSocket;

  beforeEach(async () => {
    ({ storage, tmpDir } = createTestStorage());
    await storage.init();
    handler = createHandlerWithStorage(storage);

    // Register source peer
    sourceWs = new MockWebSocket();
    handler.handleConnection(sourceWs as any);
    await registerPeer(handler, sourceWs, PEER_CODE_2, VALID_PUBKEY_2);

    // Source announces a chunk
    await handler.handleMessage(sourceWs as any, JSON.stringify({
      type: 'chunk_announce',
      peerId: PEER_CODE_2,
      chunks: [{ chunkId: 'chunk-remote', channelId: 'ch_1' }],
    }));
    sourceWs.clearMessages();

    // Register requester peer
    requesterWs = new MockWebSocket();
    handler.handleConnection(requesterWs as any);
    await registerPeer(handler, requesterWs, PEER_CODE_1, VALID_PUBKEY_1);
    requesterWs.clearMessages();
  });

  afterEach(async () => {
    await handler.shutdown();
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should send chunk_pull to source and chunk_pulling to requester', async () => {
    await handler.handleMessage(requesterWs as any, JSON.stringify({
      type: 'chunk_request',
      chunkId: 'chunk-remote',
      channelId: 'ch_1',
    }));

    // Requester should receive chunk_pulling notification
    const pulling = requesterWs.getMessagesByType('chunk_pulling');
    expect(pulling.length).toBe(1);
    expect(pulling[0].chunkId).toBe('chunk-remote');

    // Source should receive chunk_pull request
    const pull = sourceWs.getMessagesByType('chunk_pull');
    expect(pull.length).toBe(1);
    expect(pull[0].chunkId).toBe('chunk-remote');
    expect(pull[0].channelId).toBe('ch_1');
  });

  it('should return error when no source is available', async () => {
    await handler.handleMessage(requesterWs as any, JSON.stringify({
      type: 'chunk_request',
      chunkId: 'chunk-nonexistent',
      channelId: 'ch_1',
    }));

    const errorMsg = requesterWs.getMessagesByType('chunk_error');
    expect(errorMsg.length).toBe(1);
    expect(errorMsg[0].error).toContain('No source available');
  });
});

describe('Chunk Push - Cache and Fan Out', () => {
  let handler: ClientHandler;
  let storage: SQLiteStorage;
  let tmpDir: string;
  let sourceWs: MockWebSocket;
  let requester1Ws: MockWebSocket;
  let requester2Ws: MockWebSocket;

  beforeEach(async () => {
    ({ storage, tmpDir } = createTestStorage());
    await storage.init();
    handler = createHandlerWithStorage(storage);

    // Register source peer
    sourceWs = new MockWebSocket();
    handler.handleConnection(sourceWs as any);
    await registerPeer(handler, sourceWs, PEER_CODE_3, VALID_PUBKEY_3);

    // Source announces a chunk
    await handler.handleMessage(sourceWs as any, JSON.stringify({
      type: 'chunk_announce',
      peerId: PEER_CODE_3,
      chunks: [{ chunkId: 'chunk-push-test', channelId: 'ch_1' }],
    }));
    sourceWs.clearMessages();

    // Register requester 1
    requester1Ws = new MockWebSocket();
    handler.handleConnection(requester1Ws as any);
    await registerPeer(handler, requester1Ws, PEER_CODE_1, VALID_PUBKEY_1);
    requester1Ws.clearMessages();

    // Register requester 2
    requester2Ws = new MockWebSocket();
    handler.handleConnection(requester2Ws as any);
    await registerPeer(handler, requester2Ws, PEER_CODE_2, VALID_PUBKEY_2);
    requester2Ws.clearMessages();
  });

  afterEach(async () => {
    await handler.shutdown();
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should cache chunk and acknowledge push', async () => {
    const chunkData = Buffer.from('test-chunk-data').toString('base64');

    await handler.handleMessage(sourceWs as any, JSON.stringify({
      type: 'chunk_push',
      chunkId: 'chunk-push-test',
      channelId: 'ch_1',
      data: chunkData,
    }));

    const ack = sourceWs.getMessagesByType('chunk_push_ack');
    expect(ack.length).toBe(1);
    expect(ack[0].chunkId).toBe('chunk-push-test');
    expect(ack[0].cached).toBe(true);

    // Verify it's in the cache
    const cached = await storage.getCachedChunk('chunk-push-test');
    expect(cached).not.toBeNull();
    expect(cached!.data.toString('base64')).toBe(chunkData);
  });

  it('should fan out to pending requesters when chunk is pushed', async () => {
    // Both requesters request the same chunk
    await handler.handleMessage(requester1Ws as any, JSON.stringify({
      type: 'chunk_request',
      chunkId: 'chunk-push-test',
      channelId: 'ch_1',
    }));

    await handler.handleMessage(requester2Ws as any, JSON.stringify({
      type: 'chunk_request',
      chunkId: 'chunk-push-test',
      channelId: 'ch_1',
    }));

    requester1Ws.clearMessages();
    requester2Ws.clearMessages();

    // Source pushes the chunk
    const chunkData = Buffer.from('multicast-data').toString('base64');
    await handler.handleMessage(sourceWs as any, JSON.stringify({
      type: 'chunk_push',
      chunkId: 'chunk-push-test',
      channelId: 'ch_1',
      data: chunkData,
    }));

    // Both requesters should receive chunk_response
    const r1Response = requester1Ws.getMessagesByType('chunk_response');
    expect(r1Response.length).toBe(1);
    expect(r1Response[0].chunkId).toBe('chunk-push-test');
    expect(r1Response[0].data).toBe(chunkData);
    expect(r1Response[0].source).toBe('relay');

    const r2Response = requester2Ws.getMessagesByType('chunk_response');
    expect(r2Response.length).toBe(1);
    expect(r2Response[0].chunkId).toBe('chunk-push-test');
    expect(r2Response[0].data).toBe(chunkData);
    expect(r2Response[0].source).toBe('relay');

    // Source should see servedCount = 2
    const ack = sourceWs.getMessagesByType('chunk_push_ack');
    expect(ack[0].servedCount).toBe(2);
  });

  it('should reject push with missing data', async () => {
    await handler.handleMessage(sourceWs as any, JSON.stringify({
      type: 'chunk_push',
      chunkId: 'chunk-push-test',
      channelId: 'ch_1',
    }));

    const lastMsg = sourceWs.getLastMessage();
    expect(lastMsg.type).toBe('error');
    expect(lastMsg.message).toContain('data');
  });

  it('should reject push with missing chunkId', async () => {
    await handler.handleMessage(sourceWs as any, JSON.stringify({
      type: 'chunk_push',
      channelId: 'ch_1',
      data: 'dGVzdA==',
    }));

    const lastMsg = sourceWs.getLastMessage();
    expect(lastMsg.type).toBe('error');
    expect(lastMsg.message).toContain('chunkId');
  });

  it('should reject push with payload exceeding 4096 bytes', async () => {
    const largeBuffer = Buffer.alloc(4097, 0x41);
    const data = largeBuffer.toString('base64');

    await handler.handleMessage(sourceWs as any, JSON.stringify({
      type: 'chunk_push',
      chunkId: 'chunk-too-large',
      channelId: 'ch_1',
      data,
    }));

    const lastMsg = sourceWs.getLastMessage();
    expect(lastMsg.type).toBe('error');
    expect(lastMsg.message).toContain('Chunk payload too large');
    expect(lastMsg.message).toContain('4096');
  });

  it('should accept push with payload exactly at 4096 bytes', async () => {
    const exactBuffer = Buffer.alloc(4096, 0x42);
    const data = exactBuffer.toString('base64');

    await handler.handleMessage(sourceWs as any, JSON.stringify({
      type: 'chunk_push',
      chunkId: 'chunk-exact-limit',
      channelId: 'ch_1',
      data,
    }));

    const ack = sourceWs.getMessagesByType('chunk_push_ack');
    expect(ack.length).toBe(1);
    expect(ack[0].chunkId).toBe('chunk-exact-limit');
    expect(ack[0].cached).toBe(true);
  });
});

describe('ChunkRelay - Standalone Unit Tests', () => {
  let storage: SQLiteStorage;
  let tmpDir: string;
  let relay: ChunkRelay;

  beforeEach(async () => {
    ({ storage, tmpDir } = createTestStorage());
    await storage.init();
    relay = new ChunkRelay(storage);
  });

  afterEach(() => {
    relay.shutdown();
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('handleAnnounce', () => {
    it('should register chunks and return count', async () => {
      const result = await relay.handleAnnounce('peer-a', [
        { chunkId: 'c1', channelId: 'ch1' },
        { chunkId: 'c2', channelId: 'ch1' },
        { chunkId: 'c3', channelId: 'ch2' },
      ]);

      expect(result.registered).toBe(3);

      // Verify in storage
      const sources = await storage.getChunkSources('c1');
      expect(sources.length).toBe(1);
      expect(sources[0]!.peerId).toBe('peer-a');
    });

    it('should skip chunks without chunkId', async () => {
      const result = await relay.handleAnnounce('peer-a', [
        { chunkId: 'c1', channelId: 'ch1' },
        { chunkId: '', channelId: 'ch1' },
      ]);

      expect(result.registered).toBe(1);
    });

    it('should update announced_at on re-announce', async () => {
      await relay.handleAnnounce('peer-a', [{ chunkId: 'c1', channelId: 'ch1' }]);

      const sources1 = await storage.getChunkSources('c1');
      const time1 = sources1[0]!.announcedAt;

      // Wait a small amount and re-announce
      await new Promise(resolve => setTimeout(resolve, 10));
      await relay.handleAnnounce('peer-a', [{ chunkId: 'c1', channelId: 'ch1' }]);

      const sources2 = await storage.getChunkSources('c1');
      expect(sources2[0]!.announcedAt).toBeGreaterThanOrEqual(time1);
    });
  });

  describe('handleRequest - cache hit', () => {
    it('should serve from cache and return served=true', async () => {
      // Pre-populate cache
      const data = Buffer.from('cached-data');
      await storage.cacheChunk('c1', 'ch1', data);

      const ws = new MockWebSocket();

      const result = await relay.handleRequest('peer-b', ws as any, 'c1', 'ch1');

      expect(result.served).toBe(true);
      expect(result.pulling).toBe(false);
      expect(result.error).toBeUndefined();

      // WebSocket should have received chunk_response
      const response = ws.getMessagesByType('chunk_response');
      expect(response.length).toBe(1);
      expect(response[0].chunkId).toBe('c1');
      expect(response[0].source).toBe('cache');
    });
  });

  describe('handleRequest - cache miss, no source', () => {
    it('should return error when no source available', async () => {
      const ws = new MockWebSocket();

      const result = await relay.handleRequest('peer-b', ws as any, 'c-missing', 'ch1');

      expect(result.served).toBe(false);
      expect(result.pulling).toBe(false);
      expect(result.error).toContain('No source available');
    });
  });

  describe('handleRequest - cache miss, source available', () => {
    it('should initiate pull from online source', async () => {
      // Register source peer
      const sourceWs = new MockWebSocket();
      relay.registerPeer('peer-source', sourceWs as any);

      // Announce chunk from source
      await relay.handleAnnounce('peer-source', [{ chunkId: 'c1', channelId: 'ch1' }]);

      // Set up send callback
      const sentMessages: Array<{ peerId: string; message: object }> = [];
      relay.setSendCallback((peerId, message) => {
        sentMessages.push({ peerId, message });
        return true;
      });

      const requesterWs = new MockWebSocket();
      const result = await relay.handleRequest('peer-requester', requesterWs as any, 'c1', 'ch1');

      expect(result.served).toBe(false);
      expect(result.pulling).toBe(true);

      // Source peer should have been sent a chunk_pull
      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0]!.peerId).toBe('peer-source');
      expect((sentMessages[0]!.message as any).type).toBe('chunk_pull');
      expect((sentMessages[0]!.message as any).chunkId).toBe('c1');
    });

    it('should deduplicate pulls for the same chunk', async () => {
      const sourceWs = new MockWebSocket();
      relay.registerPeer('peer-source', sourceWs as any);
      await relay.handleAnnounce('peer-source', [{ chunkId: 'c1', channelId: 'ch1' }]);

      const sentMessages: Array<{ peerId: string; message: object }> = [];
      relay.setSendCallback((peerId, message) => {
        sentMessages.push({ peerId, message });
        return true;
      });

      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();

      await relay.handleRequest('peer-r1', ws1 as any, 'c1', 'ch1');
      await relay.handleRequest('peer-r2', ws2 as any, 'c1', 'ch1');

      // Only one chunk_pull should have been sent
      expect(sentMessages.length).toBe(1);
    });
  });

  describe('handlePush', () => {
    it('should cache the chunk', async () => {
      const data = Buffer.from('pushed-data').toString('base64');

      const result = await relay.handlePush('peer-source', 'c1', 'ch1', data);

      expect(result.cached).toBe(true);

      const cached = await storage.getCachedChunk('c1');
      expect(cached).not.toBeNull();
      expect(cached!.data.toString('base64')).toBe(data);
    });

    it('should fan out to pending requesters', async () => {
      // Set up source
      const sourceWs = new MockWebSocket();
      relay.registerPeer('peer-source', sourceWs as any);
      await relay.handleAnnounce('peer-source', [{ chunkId: 'c1', channelId: 'ch1' }]);
      relay.setSendCallback(() => true);

      // Create pending requests
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      await relay.handleRequest('peer-r1', ws1 as any, 'c1', 'ch1');
      await relay.handleRequest('peer-r2', ws2 as any, 'c1', 'ch1');

      ws1.clearMessages();
      ws2.clearMessages();

      // Push the chunk
      const data = Buffer.from('fan-out-data').toString('base64');
      const result = await relay.handlePush('peer-source', 'c1', 'ch1', data);

      expect(result.servedCount).toBe(2);

      // Both should have received chunk_response
      expect(ws1.getMessagesByType('chunk_response').length).toBe(1);
      expect(ws2.getMessagesByType('chunk_response').length).toBe(1);
    });

    it('should register pushing peer as source', async () => {
      const data = Buffer.from('source-data').toString('base64');
      await relay.handlePush('peer-pusher', 'c1', 'ch1', data);

      const sources = await storage.getChunkSources('c1');
      expect(sources.some(s => s.peerId === 'peer-pusher')).toBe(true);
    });

    it('should reject chunk push with payload exceeding 4096 bytes', async () => {
      // Create a buffer that exceeds 4096 bytes
      const largeBuffer = Buffer.alloc(4097, 0x41); // 4097 bytes of 'A'
      const data = largeBuffer.toString('base64');

      const result = await relay.handlePush('peer-source', 'c1', 'ch1', data);

      expect(result.cached).toBe(false);
      expect(result.servedCount).toBe(0);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Chunk payload too large');
      expect(result.error).toContain('4096');

      // Verify chunk was NOT cached
      const cached = await storage.getCachedChunk('c1');
      expect(cached).toBeNull();
    });

    it('should accept chunk push with payload exactly at 4096 bytes', async () => {
      // Create a buffer that is exactly 4096 bytes
      const exactBuffer = Buffer.alloc(4096, 0x42); // 4096 bytes of 'B'
      const data = exactBuffer.toString('base64');

      const result = await relay.handlePush('peer-source', 'c1', 'ch1', data);

      expect(result.cached).toBe(true);
      expect(result.error).toBeUndefined();

      // Verify chunk was cached
      const cached = await storage.getCachedChunk('c1');
      expect(cached).not.toBeNull();
      expect(cached!.data.length).toBe(4096);
    });
  });

  describe('unregisterPeer', () => {
    it('should remove chunk sources for disconnected peer', async () => {
      await relay.handleAnnounce('peer-leaving', [
        { chunkId: 'c1', channelId: 'ch1' },
        { chunkId: 'c2', channelId: 'ch1' },
      ]);

      await relay.unregisterPeer('peer-leaving');

      const s1 = await storage.getChunkSources('c1');
      const s2 = await storage.getChunkSources('c2');
      expect(s1.length).toBe(0);
      expect(s2.length).toBe(0);
    });

    it('should remove pending requests from disconnected peer', async () => {
      const sourceWs = new MockWebSocket();
      relay.registerPeer('peer-source', sourceWs as any);
      await relay.handleAnnounce('peer-source', [{ chunkId: 'c1', channelId: 'ch1' }]);
      relay.setSendCallback(() => true);

      const reqWs = new MockWebSocket();
      await relay.handleRequest('peer-leaving', reqWs as any, 'c1', 'ch1');

      await relay.unregisterPeer('peer-leaving');

      // Push should serve 0 because the pending requester was removed
      const data = Buffer.from('after-disconnect').toString('base64');
      const result = await relay.handlePush('peer-source', 'c1', 'ch1', data);
      expect(result.servedCount).toBe(0);
    });
  });

  describe('isPeerOnline', () => {
    it('should return true for registered online peer', () => {
      const ws = new MockWebSocket();
      relay.registerPeer('peer-online', ws as any);
      expect(relay.isPeerOnline('peer-online')).toBe(true);
    });

    it('should return false for unregistered peer', () => {
      expect(relay.isPeerOnline('peer-unknown')).toBe(false);
    });

    it('should return false for disconnected peer', () => {
      const ws = new MockWebSocket();
      ws.readyState = MockWebSocket.CLOSED;
      relay.registerPeer('peer-closed', ws as any);
      expect(relay.isPeerOnline('peer-closed')).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('should clean up expired chunks', async () => {
      // Manually insert old chunk
      const oldTime = Date.now() - 31 * 60 * 1000; // 31 minutes ago
      const db = (storage as any).db;
      db.prepare(`
        INSERT INTO chunk_cache (chunk_id, channel_id, data, cached_at, last_accessed, access_count)
        VALUES (?, ?, ?, ?, ?, 0)
      `).run('old-chunk', 'ch1', Buffer.from('old'), oldTime, oldTime);

      const result = await relay.cleanup();
      expect(result.expiredChunks).toBe(1);

      const cached = await storage.getCachedChunk('old-chunk');
      expect(cached).toBeNull();
    });

    it('should clean up expired chunk sources', async () => {
      // Manually insert old source
      const oldTime = Date.now() - 61 * 60 * 1000; // 61 minutes ago
      const db = (storage as any).db;
      db.prepare(`
        INSERT INTO chunk_sources (chunk_id, peer_id, announced_at)
        VALUES (?, ?, ?)
      `).run('old-src-chunk', 'old-peer', oldTime);

      const result = await relay.cleanup();
      expect(result.expiredSources).toBe(1);
    });
  });

  describe('LRU eviction', () => {
    it('should evict least recently accessed chunks when over cap', async () => {
      // We'll test via storage directly since the cap is 1000
      // Insert 3 chunks, then evict to cap of 2
      await storage.cacheChunk('c1', 'ch1', Buffer.from('d1'));
      await new Promise(r => setTimeout(r, 10));
      await storage.cacheChunk('c2', 'ch1', Buffer.from('d2'));
      await new Promise(r => setTimeout(r, 10));
      await storage.cacheChunk('c3', 'ch1', Buffer.from('d3'));

      // Access c1 to make it "recently used"
      await storage.getCachedChunk('c1');

      const evicted = await storage.evictLruChunks(2);
      expect(evicted).toBe(1);

      // c2 should be evicted (oldest last_accessed without any extra access)
      // c1 was accessed, c3 is newest
      const count = await storage.getCachedChunkCount();
      expect(count).toBe(2);
    });
  });
});

describe('Chunk Relay - Handler without storage', () => {
  it('should return error when chunk relay is not available', async () => {
    const identity: ServerIdentity = {
      serverId: 'test-server-id',
      nodeId: 'test-node-id',
      ephemeralId: 'srv-test',
      publicKey: new Uint8Array(32),
      privateKey: new Uint8Array(32),
    };

    const config: ClientHandlerConfig = {
      heartbeatInterval: 30000,
      heartbeatTimeout: 90000,
      maxConnectionsPerPeer: 10,
      pairRequestTimeout: 5000,
      pairRequestWarningTime: 2000,
    };

    const relayRegistry = new RelayRegistry();
    const distributedRendezvous = new MockDistributedRendezvous();

    // Create handler WITHOUT storage (no chunk relay)
    const handler = new ClientHandler(
      identity,
      'ws://localhost:8080',
      config,
      relayRegistry,
      distributedRendezvous as any,
    );

    const ws = new MockWebSocket();
    handler.handleConnection(ws as any);
    await registerPeer(handler, ws, PEER_CODE_1, VALID_PUBKEY_1);
    ws.clearMessages();

    await handler.handleMessage(ws as any, JSON.stringify({
      type: 'chunk_announce',
      peerId: 'peer-1',
      chunks: [{ chunkId: 'c1', channelId: 'ch1' }],
    }));

    const lastMsg = ws.getLastMessage();
    expect(lastMsg.type).toBe('error');
    expect(lastMsg.message).toContain('Chunk relay not available');

    await handler.shutdown();
  });
});
