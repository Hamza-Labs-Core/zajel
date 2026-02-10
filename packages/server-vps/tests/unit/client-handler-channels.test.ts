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
import type { ServerIdentity } from '../../src/types.js';

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
});
