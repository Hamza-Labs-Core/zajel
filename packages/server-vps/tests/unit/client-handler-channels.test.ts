/**
 * Client Handler Channel Tests
 *
 * Tests for channel upstream messaging and live streaming:
 * - Upstream message routing (subscriber -> VPS -> owner)
 * - Rate limiting on upstream messages
 * - Upstream message queuing when owner is offline
 * - Live stream start/frame/end relay
 * - Channel subscription management
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { ClientHandler, type ClientHandlerConfig } from '../../src/client/handler.js';
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

// Valid pairing codes for testing
const OWNER_CODE = 'OWN234';
const SUB_CODE_1 = 'SUB234';
const SUB_CODE_2 = 'SUB567';

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

// Helper: create a handler with mock dependencies
function createHandler() {
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

describe('Channel Owner Registration', () => {
  let handler: ClientHandler;
  let ownerWs: MockWebSocket;

  beforeEach(async () => {
    handler = createHandler();
    ownerWs = new MockWebSocket();
    handler.handleConnection(ownerWs as any);
    await registerPeer(handler, ownerWs, OWNER_CODE, VALID_PUBKEY_1);
    ownerWs.clearMessages();
  });

  afterEach(async () => {
    await handler.shutdown();
  });

  it('should register channel owner', async () => {
    await handler.handleMessage(ownerWs as any, JSON.stringify({
      type: 'channel-owner-register',
      channelId: 'ch_test_123',
    }));

    const lastMsg = ownerWs.getLastMessage();
    expect(lastMsg.type).toBe('channel-owner-registered');
    expect(lastMsg.channelId).toBe('ch_test_123');
  });

  it('should reject missing channelId', async () => {
    await handler.handleMessage(ownerWs as any, JSON.stringify({
      type: 'channel-owner-register',
    }));

    const lastMsg = ownerWs.getLastMessage();
    expect(lastMsg.type).toBe('error');
  });
});

describe('Channel Subscription', () => {
  let handler: ClientHandler;
  let subWs: MockWebSocket;

  beforeEach(async () => {
    handler = createHandler();
    subWs = new MockWebSocket();
    handler.handleConnection(subWs as any);
    await registerPeer(handler, subWs, SUB_CODE_1, VALID_PUBKEY_2);
    subWs.clearMessages();
  });

  afterEach(async () => {
    await handler.shutdown();
  });

  it('should subscribe to a channel', async () => {
    await handler.handleMessage(subWs as any, JSON.stringify({
      type: 'channel-subscribe',
      channelId: 'ch_test_123',
    }));

    const lastMsg = subWs.getLastMessage();
    expect(lastMsg.type).toBe('channel-subscribed');
    expect(lastMsg.channelId).toBe('ch_test_123');
  });

  it('should reject missing channelId', async () => {
    await handler.handleMessage(subWs as any, JSON.stringify({
      type: 'channel-subscribe',
    }));

    const lastMsg = subWs.getLastMessage();
    expect(lastMsg.type).toBe('error');
  });

  it('should notify late subscriber of active stream', async () => {
    // Set up owner and start a stream first
    const ownerWs = new MockWebSocket();
    handler.handleConnection(ownerWs as any);
    await registerPeer(handler, ownerWs, OWNER_CODE, VALID_PUBKEY_1);

    await handler.handleMessage(ownerWs as any, JSON.stringify({
      type: 'channel-owner-register',
      channelId: 'ch_stream',
    }));

    await handler.handleMessage(ownerWs as any, JSON.stringify({
      type: 'stream-start',
      streamId: 'stream_1',
      channelId: 'ch_stream',
      title: 'Test Stream',
    }));

    // Now subscribe -- should get stream-start notification
    subWs.clearMessages();
    await handler.handleMessage(subWs as any, JSON.stringify({
      type: 'channel-subscribe',
      channelId: 'ch_stream',
    }));

    const messages = subWs.sentMessages;
    const streamStart = messages.find((m: any) => m.type === 'stream-start');
    expect(streamStart).toBeDefined();
    expect(streamStart.streamId).toBe('stream_1');
    expect(streamStart.title).toBe('Test Stream');
  });
});

describe('Upstream Message Routing', () => {
  let handler: ClientHandler;
  let ownerWs: MockWebSocket;
  let subWs: MockWebSocket;

  beforeEach(async () => {
    handler = createHandler();

    ownerWs = new MockWebSocket();
    handler.handleConnection(ownerWs as any);
    await registerPeer(handler, ownerWs, OWNER_CODE, VALID_PUBKEY_1);

    subWs = new MockWebSocket();
    handler.handleConnection(subWs as any);
    await registerPeer(handler, subWs, SUB_CODE_1, VALID_PUBKEY_2);

    // Register owner for channel
    await handler.handleMessage(ownerWs as any, JSON.stringify({
      type: 'channel-owner-register',
      channelId: 'ch_upstream',
    }));

    ownerWs.clearMessages();
    subWs.clearMessages();
  });

  afterEach(async () => {
    await handler.shutdown();
  });

  it('should route upstream message to owner', async () => {
    await handler.handleMessage(subWs as any, JSON.stringify({
      type: 'upstream-message',
      channelId: 'ch_upstream',
      message: { id: 'up_1', type: 'reply', content: 'Hello' },
      ephemeralPublicKey: 'somekey123',
    }));

    // Owner should receive the message
    const ownerMsg = ownerWs.sentMessages.find((m: any) => m.type === 'upstream-message');
    expect(ownerMsg).toBeDefined();
    expect(ownerMsg.channelId).toBe('ch_upstream');
    expect(ownerMsg.message.id).toBe('up_1');
    expect(ownerMsg.ephemeralPublicKey).toBe('somekey123');

    // Subscriber should receive ack
    const subMsg = subWs.sentMessages.find((m: any) => m.type === 'upstream-ack');
    expect(subMsg).toBeDefined();
    expect(subMsg.messageId).toBe('up_1');
  });

  it('should queue upstream messages when owner is offline', async () => {
    // Disconnect the owner
    await handler.handleDisconnect(ownerWs as any);

    // Send upstream message
    await handler.handleMessage(subWs as any, JSON.stringify({
      type: 'upstream-message',
      channelId: 'ch_upstream',
      message: { id: 'up_queued', type: 'reply', content: 'Queued' },
      ephemeralPublicKey: 'key123',
    }));

    // Reconnect the owner
    const newOwnerWs = new MockWebSocket();
    handler.handleConnection(newOwnerWs as any);
    await registerPeer(handler, newOwnerWs, 'OWN567', VALID_PUBKEY_3);

    // Re-register as owner -- should flush queued messages
    await handler.handleMessage(newOwnerWs as any, JSON.stringify({
      type: 'channel-owner-register',
      channelId: 'ch_upstream',
    }));

    // Check that the queued message was delivered
    const upstreamMsg = newOwnerWs.sentMessages.find((m: any) => m.type === 'upstream-message');
    expect(upstreamMsg).toBeDefined();
    expect(upstreamMsg.message.id).toBe('up_queued');
  });

  it('should reject upstream message with missing channelId', async () => {
    await handler.handleMessage(subWs as any, JSON.stringify({
      type: 'upstream-message',
      message: { id: 'up_1' },
    }));

    const lastMsg = subWs.getLastMessage();
    expect(lastMsg.type).toBe('error');
    expect(lastMsg.message).toContain('channelId');
  });

  it('should reject upstream message with missing message field', async () => {
    await handler.handleMessage(subWs as any, JSON.stringify({
      type: 'upstream-message',
      channelId: 'ch_upstream',
    }));

    const lastMsg = subWs.getLastMessage();
    expect(lastMsg.type).toBe('error');
    expect(lastMsg.message).toContain('message');
  });

  it('should rate limit upstream messages', async () => {
    // Send many upstream messages quickly
    for (let i = 0; i < 35; i++) {
      await handler.handleMessage(subWs as any, JSON.stringify({
        type: 'upstream-message',
        channelId: 'ch_upstream',
        message: { id: `up_${i}`, type: 'reply' },
        ephemeralPublicKey: 'key',
      }));
    }

    // Some messages should have been rate limited
    const errors = subWs.sentMessages.filter((m: any) =>
      m.type === 'error' && m.message?.includes('rate limit')
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('Live Stream Relay', () => {
  let handler: ClientHandler;
  let ownerWs: MockWebSocket;
  let sub1Ws: MockWebSocket;
  let sub2Ws: MockWebSocket;

  beforeEach(async () => {
    handler = createHandler();

    ownerWs = new MockWebSocket();
    handler.handleConnection(ownerWs as any);
    await registerPeer(handler, ownerWs, OWNER_CODE, VALID_PUBKEY_1);

    sub1Ws = new MockWebSocket();
    handler.handleConnection(sub1Ws as any);
    await registerPeer(handler, sub1Ws, SUB_CODE_1, VALID_PUBKEY_2);

    sub2Ws = new MockWebSocket();
    handler.handleConnection(sub2Ws as any);
    await registerPeer(handler, sub2Ws, SUB_CODE_2, VALID_PUBKEY_3);

    // Register owner
    await handler.handleMessage(ownerWs as any, JSON.stringify({
      type: 'channel-owner-register',
      channelId: 'ch_stream',
    }));

    // Subscribe both subscribers
    await handler.handleMessage(sub1Ws as any, JSON.stringify({
      type: 'channel-subscribe',
      channelId: 'ch_stream',
    }));
    await handler.handleMessage(sub2Ws as any, JSON.stringify({
      type: 'channel-subscribe',
      channelId: 'ch_stream',
    }));

    ownerWs.clearMessages();
    sub1Ws.clearMessages();
    sub2Ws.clearMessages();
  });

  afterEach(async () => {
    await handler.shutdown();
  });

  it('should fan out stream-start to all subscribers', async () => {
    await handler.handleMessage(ownerWs as any, JSON.stringify({
      type: 'stream-start',
      streamId: 'stream_1',
      channelId: 'ch_stream',
      title: 'Live Now!',
    }));

    // Both subscribers should receive stream-start
    const sub1Start = sub1Ws.sentMessages.find((m: any) => m.type === 'stream-start');
    const sub2Start = sub2Ws.sentMessages.find((m: any) => m.type === 'stream-start');

    expect(sub1Start).toBeDefined();
    expect(sub1Start.streamId).toBe('stream_1');
    expect(sub1Start.title).toBe('Live Now!');

    expect(sub2Start).toBeDefined();
    expect(sub2Start.streamId).toBe('stream_1');

    // Owner should receive acknowledgment
    const ownerAck = ownerWs.sentMessages.find((m: any) => m.type === 'stream-started');
    expect(ownerAck).toBeDefined();
    expect(ownerAck.subscriberCount).toBe(2);
  });

  it('should reject stream-start from non-owner', async () => {
    await handler.handleMessage(sub1Ws as any, JSON.stringify({
      type: 'stream-start',
      streamId: 'stream_illegal',
      channelId: 'ch_stream',
      title: 'Unauthorized',
    }));

    const lastMsg = sub1Ws.getLastMessage();
    expect(lastMsg.type).toBe('error');
    expect(lastMsg.message).toContain('owner');
  });

  it('should fan out stream-frame to all subscribers', async () => {
    // Start the stream first
    await handler.handleMessage(ownerWs as any, JSON.stringify({
      type: 'stream-start',
      streamId: 'stream_1',
      channelId: 'ch_stream',
      title: 'Frame Test',
    }));

    sub1Ws.clearMessages();
    sub2Ws.clearMessages();

    // Send a frame
    await handler.handleMessage(ownerWs as any, JSON.stringify({
      type: 'stream-frame',
      streamId: 'stream_1',
      channelId: 'ch_stream',
      frame: { frameIndex: 0, data: 'encrypted_frame_data' },
    }));

    // Both subscribers should receive the frame
    const sub1Frame = sub1Ws.sentMessages.find((m: any) => m.type === 'stream-frame');
    const sub2Frame = sub2Ws.sentMessages.find((m: any) => m.type === 'stream-frame');

    expect(sub1Frame).toBeDefined();
    expect(sub1Frame.frame.frameIndex).toBe(0);
    expect(sub2Frame).toBeDefined();
  });

  it('should silently drop frames from non-owner', async () => {
    // Start a valid stream first
    await handler.handleMessage(ownerWs as any, JSON.stringify({
      type: 'stream-start',
      streamId: 'stream_1',
      channelId: 'ch_stream',
      title: 'Valid',
    }));

    sub1Ws.clearMessages();
    sub2Ws.clearMessages();

    // Subscriber tries to send a frame
    await handler.handleMessage(sub1Ws as any, JSON.stringify({
      type: 'stream-frame',
      streamId: 'stream_1',
      channelId: 'ch_stream',
      frame: { frameIndex: 0, data: 'forged' },
    }));

    // Sub2 should NOT receive the frame
    const sub2Frame = sub2Ws.sentMessages.find((m: any) => m.type === 'stream-frame');
    expect(sub2Frame).toBeUndefined();
  });

  it('should fan out stream-end to all subscribers', async () => {
    // Start the stream
    await handler.handleMessage(ownerWs as any, JSON.stringify({
      type: 'stream-start',
      streamId: 'stream_1',
      channelId: 'ch_stream',
      title: 'End Test',
    }));

    sub1Ws.clearMessages();
    sub2Ws.clearMessages();

    // End the stream
    await handler.handleMessage(ownerWs as any, JSON.stringify({
      type: 'stream-end',
      streamId: 'stream_1',
      channelId: 'ch_stream',
    }));

    // Both subscribers should receive stream-end
    const sub1End = sub1Ws.sentMessages.find((m: any) => m.type === 'stream-end');
    const sub2End = sub2Ws.sentMessages.find((m: any) => m.type === 'stream-end');

    expect(sub1End).toBeDefined();
    expect(sub2End).toBeDefined();

    // Owner should receive acknowledgment
    const ownerAck = ownerWs.sentMessages.find((m: any) => m.type === 'stream-ended');
    expect(ownerAck).toBeDefined();
  });

  it('should reject stream-end from non-owner', async () => {
    // Start a stream first
    await handler.handleMessage(ownerWs as any, JSON.stringify({
      type: 'stream-start',
      streamId: 'stream_1',
      channelId: 'ch_stream',
      title: 'End by Non-Owner',
    }));

    await handler.handleMessage(sub1Ws as any, JSON.stringify({
      type: 'stream-end',
      streamId: 'stream_1',
      channelId: 'ch_stream',
    }));

    const lastMsg = sub1Ws.getLastMessage();
    expect(lastMsg.type).toBe('error');
  });

  it('should end active stream when owner disconnects', async () => {
    // Start a stream
    await handler.handleMessage(ownerWs as any, JSON.stringify({
      type: 'stream-start',
      streamId: 'stream_dc',
      channelId: 'ch_stream',
      title: 'Disconnect Test',
    }));

    sub1Ws.clearMessages();
    sub2Ws.clearMessages();

    // Owner disconnects
    await handler.handleDisconnect(ownerWs as any);

    // Subscribers should receive stream-end
    const sub1End = sub1Ws.sentMessages.find((m: any) => m.type === 'stream-end');
    const sub2End = sub2Ws.sentMessages.find((m: any) => m.type === 'stream-end');

    expect(sub1End).toBeDefined();
    expect(sub1End.streamId).toBe('stream_dc');
    expect(sub2End).toBeDefined();
  });
});

describe('Cleanup', () => {
  let handler: ClientHandler;

  beforeEach(() => {
    handler = createHandler();
  });

  afterEach(async () => {
    await handler.shutdown();
  });

  it('should clean up subscriber on disconnect', async () => {
    const ownerWs = new MockWebSocket();
    handler.handleConnection(ownerWs as any);
    await registerPeer(handler, ownerWs, OWNER_CODE, VALID_PUBKEY_1);

    const subWs = new MockWebSocket();
    handler.handleConnection(subWs as any);
    await registerPeer(handler, subWs, SUB_CODE_1, VALID_PUBKEY_2);

    // Subscribe
    await handler.handleMessage(subWs as any, JSON.stringify({
      type: 'channel-subscribe',
      channelId: 'ch_cleanup',
    }));

    // Register owner and start stream
    await handler.handleMessage(ownerWs as any, JSON.stringify({
      type: 'channel-owner-register',
      channelId: 'ch_cleanup',
    }));
    await handler.handleMessage(ownerWs as any, JSON.stringify({
      type: 'stream-start',
      streamId: 'stream_cleanup',
      channelId: 'ch_cleanup',
      title: 'Cleanup',
    }));

    // Disconnect subscriber
    await handler.handleDisconnect(subWs as any);

    // Send a frame -- should not throw
    ownerWs.clearMessages();
    await handler.handleMessage(ownerWs as any, JSON.stringify({
      type: 'stream-frame',
      streamId: 'stream_cleanup',
      channelId: 'ch_cleanup',
      frame: { frameIndex: 0 },
    }));

    // No error should occur
    const errors = ownerWs.sentMessages.filter((m: any) => m.type === 'error');
    expect(errors.length).toBe(0);
  });

  it('should be safe to call handleDisconnect twice (idempotent)', async () => {
    // Bug: cleanup() calls handleDisconnect(ws) then ws.close(), which triggers
    // the 'close' event that calls handleDisconnect(ws) again.
    const ownerWs = new MockWebSocket();
    handler.handleConnection(ownerWs as any);
    await registerPeer(handler, ownerWs, OWNER_CODE, VALID_PUBKEY_1);

    await handler.handleMessage(ownerWs as any, JSON.stringify({
      type: 'channel-owner-register',
      channelId: 'ch_double',
    }));

    // Listen for client-disconnected events
    let disconnectCount = 0;
    handler.on('client-disconnected', () => {
      disconnectCount++;
    });

    // Call handleDisconnect twice (simulates cleanup() + ws 'close' event)
    await handler.handleDisconnect(ownerWs as any);
    await handler.handleDisconnect(ownerWs as any);

    // Should only emit client-disconnected once, not twice
    expect(disconnectCount).toBeLessThanOrEqual(1);
  });

  it('should reject channel-owner-register when channel already has an active owner', async () => {
    // Bug: any client can hijack any channelId by sending channel-owner-register
    const ownerWs = new MockWebSocket();
    handler.handleConnection(ownerWs as any);
    await registerPeer(handler, ownerWs, OWNER_CODE, VALID_PUBKEY_1);

    // Register as owner
    await handler.handleMessage(ownerWs as any, JSON.stringify({
      type: 'channel-owner-register',
      channelId: 'ch_owned',
    }));

    // Another client tries to claim the same channel
    const hijackerWs = new MockWebSocket();
    handler.handleConnection(hijackerWs as any);
    await registerPeer(handler, hijackerWs, SUB_CODE_1, VALID_PUBKEY_2);
    hijackerWs.clearMessages();

    await handler.handleMessage(hijackerWs as any, JSON.stringify({
      type: 'channel-owner-register',
      channelId: 'ch_owned',
    }));

    // The hijacker should get an error, NOT a success
    const lastMsg = hijackerWs.getLastMessage();
    expect(lastMsg.type).toBe('error');
  });

  it('should allow re-registration when previous owner disconnected', async () => {
    const ownerWs = new MockWebSocket();
    handler.handleConnection(ownerWs as any);
    await registerPeer(handler, ownerWs, OWNER_CODE, VALID_PUBKEY_1);

    // Register as owner
    await handler.handleMessage(ownerWs as any, JSON.stringify({
      type: 'channel-owner-register',
      channelId: 'ch_reown',
    }));

    // Owner disconnects
    await handler.handleDisconnect(ownerWs as any);

    // New client should be able to register as owner
    const newOwnerWs = new MockWebSocket();
    handler.handleConnection(newOwnerWs as any);
    await registerPeer(handler, newOwnerWs, SUB_CODE_1, VALID_PUBKEY_2);
    newOwnerWs.clearMessages();

    await handler.handleMessage(newOwnerWs as any, JSON.stringify({
      type: 'channel-owner-register',
      channelId: 'ch_reown',
    }));

    const lastMsg = newOwnerWs.getLastMessage();
    expect(lastMsg.type).toBe('channel-owner-registered');
  });

  it('should clean up upstreamQueues when owner disconnects', async () => {
    // Bug: upstreamQueues for a channel are never cleaned when the owner disconnects
    const ownerWs = new MockWebSocket();
    handler.handleConnection(ownerWs as any);
    await registerPeer(handler, ownerWs, OWNER_CODE, VALID_PUBKEY_1);

    const subWs = new MockWebSocket();
    handler.handleConnection(subWs as any);
    await registerPeer(handler, subWs, SUB_CODE_1, VALID_PUBKEY_2);

    // Register owner
    await handler.handleMessage(ownerWs as any, JSON.stringify({
      type: 'channel-owner-register',
      channelId: 'ch_queue_cleanup',
    }));

    // Owner disconnects
    await handler.handleDisconnect(ownerWs as any);

    // Subscriber sends upstream messages (these get queued since owner is offline)
    for (let i = 0; i < 5; i++) {
      await handler.handleMessage(subWs as any, JSON.stringify({
        type: 'upstream-message',
        channelId: 'ch_queue_cleanup',
        message: { id: `up_${i}`, content: 'test' },
        ephemeralPublicKey: 'key',
      }));
    }

    // New owner reconnects and registers
    const newOwnerWs = new MockWebSocket();
    handler.handleConnection(newOwnerWs as any);
    await registerPeer(handler, newOwnerWs, 'NEW234', VALID_PUBKEY_3);
    newOwnerWs.clearMessages();

    await handler.handleMessage(newOwnerWs as any, JSON.stringify({
      type: 'channel-owner-register',
      channelId: 'ch_queue_cleanup',
    }));

    // The new owner should get the queued messages flushed to them
    const upstreamMsgs = newOwnerWs.sentMessages.filter((m: any) => m.type === 'upstream-message');
    expect(upstreamMsgs.length).toBe(5);

    // After flushing, disconnect the new owner too
    await handler.handleDisconnect(newOwnerWs as any);

    // No more queued messages should exist - send more upstream messages
    for (let i = 0; i < 3; i++) {
      await handler.handleMessage(subWs as any, JSON.stringify({
        type: 'upstream-message',
        channelId: 'ch_queue_cleanup',
        message: { id: `up_new_${i}`, content: 'test' },
        ephemeralPublicKey: 'key',
      }));
    }

    // Another new owner registers - should only get the 3 new messages, not old ones
    const thirdOwnerWs = new MockWebSocket();
    handler.handleConnection(thirdOwnerWs as any);
    await registerPeer(handler, thirdOwnerWs, 'THD234', VALID_PUBKEY_1);
    thirdOwnerWs.clearMessages();

    await handler.handleMessage(thirdOwnerWs as any, JSON.stringify({
      type: 'channel-owner-register',
      channelId: 'ch_queue_cleanup',
    }));

    const thirdUpstreamMsgs = thirdOwnerWs.sentMessages.filter((m: any) => m.type === 'upstream-message');
    expect(thirdUpstreamMsgs.length).toBe(3);
  });
});

// Helper: create a handler with real storage for chunk relay (channel tests)
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

  return new ClientHandler(
    identity,
    'ws://localhost:8080',
    config,
    relayRegistry,
    distributedRendezvous as any,
    {},
    storage,
  );
}

describe('Channel Subscription with Chunk Delivery', () => {
  let handler: ClientHandler;
  let storage: SQLiteStorage;
  let tmpDir: string;
  let ownerWs: MockWebSocket;
  let subWs: MockWebSocket;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'zajel-chan-test-'));
    const dbPath = join(tmpDir, 'test.db');
    storage = new SQLiteStorage(dbPath);
    await storage.init();
    handler = createHandlerWithStorage(storage);

    ownerWs = new MockWebSocket();
    handler.handleConnection(ownerWs as any);
    await registerPeer(handler, ownerWs, OWNER_CODE, VALID_PUBKEY_1);
    ownerWs.clearMessages();

    subWs = new MockWebSocket();
    handler.handleConnection(subWs as any);
    await registerPeer(handler, subWs, SUB_CODE_1, VALID_PUBKEY_2);
    subWs.clearMessages();
  });

  afterEach(async () => {
    await handler.shutdown();
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should send chunk_available with cached chunks on subscribe', async () => {
    // Pre-populate cache with chunks for this channel
    await storage.cacheChunk('chunk-1', 'ch_cached', Buffer.from('data1'));
    await storage.cacheChunk('chunk-2', 'ch_cached', Buffer.from('data2'));
    // Chunk for a different channel — should NOT be included
    await storage.cacheChunk('chunk-other', 'ch_other', Buffer.from('other'));

    await handler.handleMessage(subWs as any, JSON.stringify({
      type: 'channel-subscribe',
      channelId: 'ch_cached',
    }));

    const subscribed = subWs.sentMessages.find((m: any) => m.type === 'channel-subscribed');
    expect(subscribed).toBeDefined();
    expect(subscribed.channelId).toBe('ch_cached');

    const available = subWs.sentMessages.find((m: any) => m.type === 'chunk_available');
    expect(available).toBeDefined();
    expect(available.channelId).toBe('ch_cached');
    expect(available.chunkIds).toHaveLength(2);
    expect(available.chunkIds).toContain('chunk-1');
    expect(available.chunkIds).toContain('chunk-2');
    // Chunk from other channel should not leak
    expect(available.chunkIds).not.toContain('chunk-other');
  });

  it('should not send chunk_available when no cached chunks exist', async () => {
    await handler.handleMessage(subWs as any, JSON.stringify({
      type: 'channel-subscribe',
      channelId: 'ch_empty',
    }));

    const subscribed = subWs.sentMessages.find((m: any) => m.type === 'channel-subscribed');
    expect(subscribed).toBeDefined();

    const available = subWs.sentMessages.find((m: any) => m.type === 'chunk_available');
    expect(available).toBeUndefined();
  });

  it('should send chunk_available to new subscriber after owner announces', async () => {
    // Owner registers and announces chunks
    await handler.handleMessage(ownerWs as any, JSON.stringify({
      type: 'channel-owner-register',
      channelId: 'ch_announce',
    }));

    // Subscribe first subscriber
    await handler.handleMessage(subWs as any, JSON.stringify({
      type: 'channel-subscribe',
      channelId: 'ch_announce',
    }));
    subWs.clearMessages();

    // Owner announces chunks — subscriber should get chunk_available
    await handler.handleMessage(ownerWs as any, JSON.stringify({
      type: 'chunk_announce',
      peerId: OWNER_CODE,
      channelId: 'ch_announce',
      chunks: [
        { chunkId: 'announced-1' },
        { chunkId: 'announced-2' },
      ],
    }));

    const available = subWs.sentMessages.find((m: any) => m.type === 'chunk_available');
    expect(available).toBeDefined();
    expect(available.channelId).toBe('ch_announce');
    expect(available.chunkIds).toContain('announced-1');
    expect(available.chunkIds).toContain('announced-2');
  });

  it('should send cached chunks to late-joining subscriber', async () => {
    // Simulate chunks already cached (e.g., from a previous owner push)
    await storage.cacheChunk('pushed-chunk-1', 'ch_late', Buffer.from('data1'));
    await storage.cacheChunk('pushed-chunk-2', 'ch_late', Buffer.from('data2'));

    // A late subscriber joins — should get chunk_available with existing chunks
    const lateSub = new MockWebSocket();
    handler.handleConnection(lateSub as any);
    await registerPeer(handler, lateSub, SUB_CODE_2, VALID_PUBKEY_3);
    lateSub.clearMessages();

    await handler.handleMessage(lateSub as any, JSON.stringify({
      type: 'channel-subscribe',
      channelId: 'ch_late',
    }));

    const available = lateSub.sentMessages.find((m: any) => m.type === 'chunk_available');
    expect(available).toBeDefined();
    expect(available.channelId).toBe('ch_late');
    expect(available.chunkIds).toHaveLength(2);
    expect(available.chunkIds).toContain('pushed-chunk-1');
    expect(available.chunkIds).toContain('pushed-chunk-2');
  });
});
