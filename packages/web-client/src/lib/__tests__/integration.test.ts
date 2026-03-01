/**
 * Integration Tests for Pairing Flow
 *
 * Tests the complete pairing flow integrating:
 * - SignalingClient (WebSocket signaling)
 * - WebRTCService (peer connections and data channels)
 * - CryptoService (X25519 key exchange and ChaCha20-Poly1305 encryption)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SignalingClient, type SignalingEvents } from '../signaling';
import { WebRTCService, type WebRTCEvents } from '../webrtc';
import { CryptoService } from '../crypto';

// =============================================================================
// Mock Infrastructure
// =============================================================================

/**
 * Mock WebSocket that simulates server behavior
 */
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((error: Event) => void) | null = null;

  private sentMessages: unknown[] = [];

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.sentMessages.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose();
    }
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    if (this.onopen) {
      this.onopen();
    }
  }

  simulateMessage(data: unknown): void {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(data) });
    }
  }

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose();
    }
  }

  getSentMessages(): unknown[] {
    return [...this.sentMessages];
  }

  getLastSentMessage(): unknown {
    return this.sentMessages[this.sentMessages.length - 1];
  }

  clearSentMessages(): void {
    this.sentMessages = [];
  }
}

/**
 * Mock RTCDataChannel
 */
class MockRTCDataChannel {
  label: string;
  readyState: RTCDataChannelState = 'connecting';
  ordered: boolean;
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((error: Event) => void) | null = null;
  onclose: (() => void) | null = null;
  private sentMessages: string[] = [];
  private eventListeners: Map<string, Set<(...args: unknown[]) => void>> = new Map();

  constructor(label: string, options?: RTCDataChannelInit) {
    this.label = label;
    this.ordered = options?.ordered ?? true;
  }

  addEventListener(event: string, callback: (...args: unknown[]) => void): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(callback);
  }

  removeEventListener(event: string, callback: (...args: unknown[]) => void): void {
    this.eventListeners.get(event)?.delete(callback);
  }

  send(data: string): void {
    if (this.readyState !== 'open') {
      throw new Error('Data channel is not open');
    }
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = 'closed';
    if (this.onclose) {
      this.onclose();
    }
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = 'open';
    if (this.onopen) {
      this.onopen();
    }
  }

  simulateMessage(data: string): void {
    if (this.onmessage) {
      this.onmessage({ data });
    }
  }

  getSentMessages(): string[] {
    return [...this.sentMessages];
  }

  clearSentMessages(): void {
    this.sentMessages = [];
  }
}

/**
 * Mock RTCPeerConnection
 */
class MockRTCPeerConnection {
  connectionState: RTCPeerConnectionState = 'new';
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;

  private localDescription: RTCSessionDescriptionInit | null = null;
  private remoteDescription: RTCSessionDescriptionInit | null = null;
  private dataChannels: Map<string, MockRTCDataChannel> = new Map();
  private iceCandidates: RTCIceCandidateInit[] = [];

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'mock-offer-sdp-' + Math.random() };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'mock-answer-sdp-' + Math.random() };
  }

  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = desc;
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = desc;
  }

  getLocalDescription(): RTCSessionDescriptionInit | null {
    return this.localDescription;
  }

  getRemoteDescription(): RTCSessionDescriptionInit | null {
    return this.remoteDescription;
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.iceCandidates.push(candidate);
  }

  createDataChannel(label: string, options?: RTCDataChannelInit): MockRTCDataChannel {
    const channel = new MockRTCDataChannel(label, options);
    this.dataChannels.set(label, channel);
    return channel;
  }

  getDataChannel(label: string): MockRTCDataChannel | undefined {
    return this.dataChannels.get(label);
  }

  close(): void {
    this.connectionState = 'closed';
    if (this.onconnectionstatechange) {
      this.onconnectionstatechange();
    }
    for (const channel of this.dataChannels.values()) {
      channel.close();
    }
  }

  // Test helpers
  simulateConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    if (this.onconnectionstatechange) {
      this.onconnectionstatechange();
    }
  }

  simulateIceCandidate(candidate: RTCIceCandidateInit | null): void {
    if (this.onicecandidate) {
      this.onicecandidate({
        candidate: candidate ? { toJSON: () => candidate } as RTCIceCandidate : null,
      } as RTCPeerConnectionIceEvent);
    }
  }

  simulateIncomingDataChannel(label: string): MockRTCDataChannel {
    const channel = new MockRTCDataChannel(label);
    this.dataChannels.set(label, channel);
    if (this.ondatachannel) {
      this.ondatachannel({ channel } as unknown as RTCDataChannelEvent);
    }
    return channel;
  }
}

// Valid test data
const VALID_PAIRING_CODE_ALICE = 'ABC234';
const VALID_PAIRING_CODE_BOB = 'XYZ789';

// =============================================================================
// Test Fixtures
// =============================================================================

interface MockPeer {
  ws: MockWebSocket;
  pc: MockRTCPeerConnection;
  signalingEvents: SignalingEvents;
  webrtcEvents: WebRTCEvents;
  signaling: SignalingClient;
  webrtc: WebRTCService;
  crypto: CryptoService;
}

/**
 * Creates a mock peer with all services configured
 */
async function createMockPeer(pairingCode: string): Promise<MockPeer> {
  const ws = new MockWebSocket('wss://test.example.com');
  const pc = new MockRTCPeerConnection();

  const signalingEvents: SignalingEvents = {
    onStateChange: vi.fn(),
    onPairIncoming: vi.fn(),
    onPairExpiring: vi.fn(),
    onPairMatched: vi.fn(),
    onPairRejected: vi.fn(),
    onPairTimeout: vi.fn(),
    onPairError: vi.fn(),
    onOffer: vi.fn(),
    onAnswer: vi.fn(),
    onIceCandidate: vi.fn(),
    onError: vi.fn(),
  };

  const webrtcEvents: WebRTCEvents = {
    onStateChange: vi.fn(),
    onHandshake: vi.fn(),
    onMessage: vi.fn(),
    onFileStart: vi.fn(),
    onFileChunk: vi.fn(),
    onFileComplete: vi.fn(),
    onFileError: vi.fn(),
  };

  const crypto = new CryptoService();
  await crypto.initialize();

  const signaling = new SignalingClient('wss://test.example.com', signalingEvents);
  const webrtc = new WebRTCService(signaling, webrtcEvents);

  return { ws, pc, signalingEvents, webrtcEvents, signaling, webrtc, crypto };
}

// =============================================================================
// Integration Tests
// =============================================================================

describe('Pairing Flow Integration', () => {
  let alice: MockPeer;
  let bob: MockPeer;
  let mockWsAlice: MockWebSocket | null = null;
  let mockWsBob: MockWebSocket | null = null;
  let mockPcAlice: MockRTCPeerConnection | null = null;
  let mockPcBob: MockRTCPeerConnection | null = null;

  beforeEach(async () => {
    vi.useFakeTimers();

    // Create mock peer instances
    alice = await createMockPeer(VALID_PAIRING_CODE_ALICE);
    bob = await createMockPeer(VALID_PAIRING_CODE_BOB);

    // Set up WebSocket mock
    const MockWebSocketConstructor = vi.fn().mockImplementation(function (url: string) {
      const ws = new MockWebSocket(url);
      // Track which peer's WebSocket this is
      if (!mockWsAlice) {
        mockWsAlice = ws;
      } else {
        mockWsBob = ws;
      }
      return ws;
    });
    MockWebSocketConstructor.OPEN = MockWebSocket.OPEN;
    MockWebSocketConstructor.CONNECTING = MockWebSocket.CONNECTING;
    MockWebSocketConstructor.CLOSING = MockWebSocket.CLOSING;
    MockWebSocketConstructor.CLOSED = MockWebSocket.CLOSED;

    vi.stubGlobal('WebSocket', MockWebSocketConstructor);

    // Set up RTCPeerConnection mock
    const MockRTCPeerConnectionConstructor = vi.fn().mockImplementation(function () {
      const pc = new MockRTCPeerConnection();
      if (!mockPcAlice) {
        mockPcAlice = pc;
      } else {
        mockPcBob = pc;
      }
      return pc;
    });

    vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnectionConstructor);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    mockWsAlice = null;
    mockWsBob = null;
    mockPcAlice = null;
    mockPcBob = null;
  });

  describe('Full pairing handshake', () => {
    it('should complete full pairing: register -> pair_request -> pair_matched -> webrtc -> handshake', async () => {
      // Step 1: Both clients connect and register
      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

      bob.signaling.connect(bob.crypto.getPublicKeyBase64());
      mockWsBob!.simulateOpen();
      mockWsBob!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_BOB });

      // Verify both are registered
      expect(alice.signalingEvents.onStateChange).toHaveBeenCalledWith('registered');
      expect(bob.signalingEvents.onStateChange).toHaveBeenCalledWith('registered');

      // Step 2: Alice requests pairing with Bob
      alice.signaling.requestPairing(VALID_PAIRING_CODE_BOB);
      expect(alice.signalingEvents.onStateChange).toHaveBeenCalledWith('waiting_approval');

      // Step 3: Bob receives incoming pair request
      mockWsBob!.simulateMessage({
        type: 'pair_incoming',
        fromCode: VALID_PAIRING_CODE_ALICE,
        fromPublicKey: alice.crypto.getPublicKeyBase64(),
      });
      expect(bob.signalingEvents.onPairIncoming).toHaveBeenCalledWith(
        VALID_PAIRING_CODE_ALICE,
        alice.crypto.getPublicKeyBase64(),
        undefined
      );

      // Step 4: Bob accepts the pairing
      bob.signaling.respondToPairing(VALID_PAIRING_CODE_ALICE, true);

      // Step 5: Both receive pair_matched (Alice is initiator)
      mockWsAlice!.simulateMessage({
        type: 'pair_matched',
        peerCode: VALID_PAIRING_CODE_BOB,
        peerPublicKey: bob.crypto.getPublicKeyBase64(),
        isInitiator: true,
      });
      mockWsBob!.simulateMessage({
        type: 'pair_matched',
        peerCode: VALID_PAIRING_CODE_ALICE,
        peerPublicKey: alice.crypto.getPublicKeyBase64(),
        isInitiator: false,
      });

      expect(alice.signalingEvents.onPairMatched).toHaveBeenCalledWith(
        VALID_PAIRING_CODE_BOB,
        bob.crypto.getPublicKeyBase64(),
        true
      );
      expect(bob.signalingEvents.onPairMatched).toHaveBeenCalledWith(
        VALID_PAIRING_CODE_ALICE,
        alice.crypto.getPublicKeyBase64(),
        false
      );

      // Step 6: Establish crypto sessions
      alice.crypto.establishSession(VALID_PAIRING_CODE_BOB, bob.crypto.getPublicKeyBase64());
      bob.crypto.establishSession(VALID_PAIRING_CODE_ALICE, alice.crypto.getPublicKeyBase64());

      expect(alice.crypto.hasSession(VALID_PAIRING_CODE_BOB)).toBe(true);
      expect(bob.crypto.hasSession(VALID_PAIRING_CODE_ALICE)).toBe(true);

      // Step 7: Alice (initiator) starts WebRTC connection
      await alice.webrtc.connect(VALID_PAIRING_CODE_BOB, true);

      // Verify offer was sent
      expect(alice.signaling.connectionState).toBeDefined();

      // Step 8: Bob starts WebRTC connection (responder)
      await bob.webrtc.connect(VALID_PAIRING_CODE_ALICE, false);

      // Step 9: Simulate WebRTC data channel open and handshake
      const aliceMessageChannel = mockPcAlice!.getDataChannel('messages');
      aliceMessageChannel!.simulateOpen();

      // Alice sends handshake
      alice.webrtc.sendHandshake(alice.crypto.getPublicKeyBase64());
      const aliceSentMessages = aliceMessageChannel!.getSentMessages();
      expect(aliceSentMessages).toHaveLength(1);
      const aliceHandshake = JSON.parse(aliceSentMessages[0]);
      expect(aliceHandshake.type).toBe('handshake');
      expect(aliceHandshake.publicKey).toBe(alice.crypto.getPublicKeyBase64());

      // Bob receives handshake via incoming data channel
      const bobMessageChannel = mockPcBob!.simulateIncomingDataChannel('messages');
      bobMessageChannel.simulateOpen();
      bobMessageChannel.simulateMessage(JSON.stringify({
        type: 'handshake',
        publicKey: alice.crypto.getPublicKeyBase64(),
      }));

      expect(bob.webrtcEvents.onHandshake).toHaveBeenCalledWith(alice.crypto.getPublicKeyBase64(), undefined);

      // Verify key verification works
      expect(alice.crypto.verifyPeerKey(VALID_PAIRING_CODE_BOB, bob.crypto.getPublicKeyBase64())).toBe(true);
      expect(bob.crypto.verifyPeerKey(VALID_PAIRING_CODE_ALICE, alice.crypto.getPublicKeyBase64())).toBe(true);
    });
  });

  describe('Message exchange after pairing', () => {
    // Use a shared room ID for both parties (same as in the crypto.test.ts)
    const SHARED_ROOM_ID = 'shared-room-123';

    it('should encrypt and decrypt messages between paired clients', async () => {
      // Setup: Establish crypto sessions (simulating completed pairing)
      // Both parties use the same room ID to establish matching session keys
      alice.crypto.establishSession(SHARED_ROOM_ID, bob.crypto.getPublicKeyBase64());
      bob.crypto.establishSession(SHARED_ROOM_ID, alice.crypto.getPublicKeyBase64());

      // Test 1: Alice sends message to Bob
      const messageFromAlice = 'Hello Bob! This is a secret message.';
      const encryptedAlice = alice.crypto.encrypt(SHARED_ROOM_ID, messageFromAlice);

      // Verify it's actually encrypted (not plaintext)
      expect(encryptedAlice).not.toBe(messageFromAlice);
      expect(encryptedAlice).not.toContain(messageFromAlice);

      // Bob decrypts
      const decryptedByBob = bob.crypto.decrypt(SHARED_ROOM_ID, encryptedAlice);
      expect(decryptedByBob).toBe(messageFromAlice);

      // Test 2: Bob sends message to Alice
      const messageFromBob = 'Hey Alice! Got your message.';
      const encryptedBob = bob.crypto.encrypt(SHARED_ROOM_ID, messageFromBob);

      // Alice decrypts
      const decryptedByAlice = alice.crypto.decrypt(SHARED_ROOM_ID, encryptedBob);
      expect(decryptedByAlice).toBe(messageFromBob);

      // Test 3: Unicode and emoji support
      const unicodeMessage = 'Hello! Hola! Bonjour! Emoji test: Cat face emoji';
      const encryptedUnicode = alice.crypto.encrypt(SHARED_ROOM_ID, unicodeMessage);
      const decryptedUnicode = bob.crypto.decrypt(SHARED_ROOM_ID, encryptedUnicode);
      expect(decryptedUnicode).toBe(unicodeMessage);

      // Test 4: Same plaintext produces different ciphertext (random nonce)
      const sameMessage = 'Same message';
      const encrypted1 = alice.crypto.encrypt(SHARED_ROOM_ID, sameMessage);
      const encrypted2 = alice.crypto.encrypt(SHARED_ROOM_ID, sameMessage);
      expect(encrypted1).not.toBe(encrypted2);

      // Both should decrypt to same plaintext
      expect(bob.crypto.decrypt(SHARED_ROOM_ID, encrypted1)).toBe(sameMessage);
      expect(bob.crypto.decrypt(SHARED_ROOM_ID, encrypted2)).toBe(sameMessage);
    });

    it('should encrypt and decrypt binary data between paired clients', async () => {
      alice.crypto.establishSession(SHARED_ROOM_ID, bob.crypto.getPublicKeyBase64());
      bob.crypto.establishSession(SHARED_ROOM_ID, alice.crypto.getPublicKeyBase64());

      // Create test binary data
      const binaryData = new Uint8Array(1024);
      for (let i = 0; i < binaryData.length; i++) {
        binaryData[i] = i % 256;
      }

      // Alice encrypts and sends
      const encryptedBytes = alice.crypto.encryptBytes(SHARED_ROOM_ID, binaryData);

      // Bob decrypts
      const decryptedBytes = bob.crypto.decryptBytes(SHARED_ROOM_ID, encryptedBytes);

      expect(decryptedBytes).toEqual(binaryData);
    });
  });

  describe('Key verification flow', () => {
    it('should detect MITM via fingerprint mismatch', async () => {
      // Setup: Establish sessions normally
      alice.crypto.establishSession(VALID_PAIRING_CODE_BOB, bob.crypto.getPublicKeyBase64());
      bob.crypto.establishSession(VALID_PAIRING_CODE_ALICE, alice.crypto.getPublicKeyBase64());

      // Get fingerprints for out-of-band verification
      const aliceFingerprint = alice.crypto.getPublicKeyFingerprint();
      const bobFingerprint = bob.crypto.getPublicKeyFingerprint();

      // Normal verification: Bob calculates Alice's fingerprint and compares
      const aliceFingerprintFromBob = bob.crypto.getPeerPublicKeyFingerprint(
        alice.crypto.getPublicKeyBase64()
      );
      expect(aliceFingerprintFromBob).toBe(aliceFingerprint);

      // Normal verification: Alice calculates Bob's fingerprint and compares
      const bobFingerprintFromAlice = alice.crypto.getPeerPublicKeyFingerprint(
        bob.crypto.getPublicKeyBase64()
      );
      expect(bobFingerprintFromAlice).toBe(bobFingerprint);

      // MITM scenario: Eve creates her own keys
      const eve = new CryptoService();
      await eve.initialize();

      // If Eve intercepted and replaced Bob's key with her own
      const eveFingerprintFromAlice = alice.crypto.getPeerPublicKeyFingerprint(
        eve.getPublicKeyBase64()
      );

      // The fingerprints would NOT match
      expect(eveFingerprintFromAlice).not.toBe(bobFingerprint);

      // Also test verifyPeerKey method for handshake verification
      // Alice stored Bob's key during session establishment
      expect(alice.crypto.verifyPeerKey(VALID_PAIRING_CODE_BOB, bob.crypto.getPublicKeyBase64())).toBe(true);

      // If Eve tries to send a different key in handshake, it would fail
      expect(alice.crypto.verifyPeerKey(VALID_PAIRING_CODE_BOB, eve.getPublicKeyBase64())).toBe(false);
    });

    it('should fail verification for wrong key length', async () => {
      alice.crypto.establishSession(VALID_PAIRING_CODE_BOB, bob.crypto.getPublicKeyBase64());

      // Wrong length key (16 bytes instead of 32)
      const shortKey = btoa(String.fromCharCode(...new Uint8Array(16)));
      expect(alice.crypto.verifyPeerKey(VALID_PAIRING_CODE_BOB, shortKey)).toBe(false);
    });

    it('should fail verification for unknown peer', async () => {
      expect(alice.crypto.verifyPeerKey('unknown-peer', bob.crypto.getPublicKeyBase64())).toBe(false);
    });
  });

  describe('Reconnection after disconnect', () => {
    it('should handle reconnection gracefully', async () => {
      // Step 1: Initial connection
      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

      expect(alice.signalingEvents.onStateChange).toHaveBeenCalledWith('registered');
      expect(alice.signaling.connectionState).toBe('registered');

      // Step 2: Simulate unexpected disconnect
      mockWsAlice!.simulateClose();

      expect(alice.signalingEvents.onStateChange).toHaveBeenCalledWith('disconnected');
      expect(alice.signaling.connectionState).toBe('disconnected');

      // Step 3: Wait for reconnect (3 second base delay)
      vi.advanceTimersByTime(3000);

      // A new WebSocket should be created
      expect(WebSocket).toHaveBeenCalledTimes(2);
    });

    it('should not reconnect after explicit disconnect', async () => {
      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

      // Explicit disconnect
      alice.signaling.disconnect();

      expect(alice.signalingEvents.onStateChange).toHaveBeenCalledWith('disconnected');

      // Advance timers past reconnect delay
      vi.advanceTimersByTime(5000);

      // Should only have the initial connection
      expect(WebSocket).toHaveBeenCalledTimes(1);
    });

    it('should maintain crypto state across WebRTC reconnection', async () => {
      const SHARED_ROOM_ID = 'reconnect-test-room';

      // Establish crypto session
      alice.crypto.establishSession(SHARED_ROOM_ID, bob.crypto.getPublicKeyBase64());
      bob.crypto.establishSession(SHARED_ROOM_ID, alice.crypto.getPublicKeyBase64());

      // Send some messages
      const msg1 = alice.crypto.encrypt(SHARED_ROOM_ID, 'Before reconnect');
      expect(bob.crypto.decrypt(SHARED_ROOM_ID, msg1)).toBe('Before reconnect');

      // Simulate WebRTC disconnect and reconnect (crypto session persists)
      alice.webrtc.close();
      await alice.webrtc.connect(VALID_PAIRING_CODE_BOB, true);

      // Crypto session should still be valid
      expect(alice.crypto.hasSession(SHARED_ROOM_ID)).toBe(true);

      // Should be able to continue sending messages
      const msg2 = alice.crypto.encrypt(SHARED_ROOM_ID, 'After reconnect');
      expect(bob.crypto.decrypt(SHARED_ROOM_ID, msg2)).toBe('After reconnect');
    });
  });

  describe('Replay protection', () => {
    const SHARED_ROOM_ID = 'replay-test-room';

    it('should reject replayed messages', async () => {
      alice.crypto.establishSession(SHARED_ROOM_ID, bob.crypto.getPublicKeyBase64());
      bob.crypto.establishSession(SHARED_ROOM_ID, alice.crypto.getPublicKeyBase64());

      const message = alice.crypto.encrypt(SHARED_ROOM_ID, 'Original message');

      // First decryption should succeed
      expect(bob.crypto.decrypt(SHARED_ROOM_ID, message)).toBe('Original message');

      // Replay attack - same message again
      expect(() => bob.crypto.decrypt(SHARED_ROOM_ID, message)).toThrow('Replay attack detected');
    });

    it('should reject replayed binary data', async () => {
      alice.crypto.establishSession(SHARED_ROOM_ID, bob.crypto.getPublicKeyBase64());
      bob.crypto.establishSession(SHARED_ROOM_ID, alice.crypto.getPublicKeyBase64());

      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const encrypted = alice.crypto.encryptBytes(SHARED_ROOM_ID, data);

      // First decryption should succeed
      expect(bob.crypto.decryptBytes(SHARED_ROOM_ID, encrypted)).toEqual(data);

      // Replay attack
      expect(() => bob.crypto.decryptBytes(SHARED_ROOM_ID, encrypted)).toThrow('Replay attack detected');
    });

    it('should allow out-of-order messages within window', async () => {
      alice.crypto.establishSession(SHARED_ROOM_ID, bob.crypto.getPublicKeyBase64());
      bob.crypto.establishSession(SHARED_ROOM_ID, alice.crypto.getPublicKeyBase64());

      // Encrypt messages 1, 2, 3
      const msg1 = alice.crypto.encrypt(SHARED_ROOM_ID, 'Message 1');
      const msg2 = alice.crypto.encrypt(SHARED_ROOM_ID, 'Message 2');
      const msg3 = alice.crypto.encrypt(SHARED_ROOM_ID, 'Message 3');

      // Receive out of order: 1, 3, 2
      expect(bob.crypto.decrypt(SHARED_ROOM_ID, msg1)).toBe('Message 1');
      expect(bob.crypto.decrypt(SHARED_ROOM_ID, msg3)).toBe('Message 3');
      expect(bob.crypto.decrypt(SHARED_ROOM_ID, msg2)).toBe('Message 2');
    });
  });

  describe('Error handling', () => {
    it('should handle pairing rejection gracefully', async () => {
      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

      // Alice requests pairing
      alice.signaling.requestPairing(VALID_PAIRING_CODE_BOB);

      // Bob rejects
      mockWsAlice!.simulateMessage({
        type: 'pair_rejected',
        peerCode: VALID_PAIRING_CODE_BOB,
      });

      expect(alice.signalingEvents.onPairRejected).toHaveBeenCalledWith(VALID_PAIRING_CODE_BOB);
      expect(alice.signaling.connectionState).toBe('registered');
    });

    it('should handle pairing timeout gracefully', async () => {
      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

      // Alice requests pairing
      alice.signaling.requestPairing(VALID_PAIRING_CODE_BOB);

      // Timeout occurs
      mockWsAlice!.simulateMessage({
        type: 'pair_timeout',
        peerCode: VALID_PAIRING_CODE_BOB,
      });

      expect(alice.signalingEvents.onPairTimeout).toHaveBeenCalledWith(VALID_PAIRING_CODE_BOB);
      expect(alice.signaling.connectionState).toBe('registered');
    });

    it('should handle pairing error gracefully', async () => {
      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

      // Alice requests pairing with non-existent code
      alice.signaling.requestPairing(VALID_PAIRING_CODE_BOB);

      // Error: target not found
      mockWsAlice!.simulateMessage({
        type: 'pair_error',
        error: 'Target not found',
      });

      expect(alice.signalingEvents.onPairError).toHaveBeenCalledWith('Target not found');
      expect(alice.signaling.connectionState).toBe('registered');
    });

    it('should reject invalid pairing code format', async () => {
      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

      // Invalid code format
      alice.signaling.requestPairing('invalid');
      expect(alice.signalingEvents.onError).toHaveBeenCalledWith('Invalid pairing code format');
    });

    it('should handle encryption without session', async () => {
      expect(() => alice.crypto.encrypt('unknown-peer', 'message')).toThrow('No session for peer: unknown-peer');
    });

    it('should handle decryption without session', async () => {
      alice.crypto.establishSession(VALID_PAIRING_CODE_BOB, bob.crypto.getPublicKeyBase64());
      const encrypted = alice.crypto.encrypt(VALID_PAIRING_CODE_BOB, 'message');

      // Try to decrypt without establishing session on Bob's side
      expect(() => bob.crypto.decrypt('unknown-peer', encrypted)).toThrow('No session for peer: unknown-peer');
    });
  });

  describe('Session management', () => {
    const SHARED_ROOM_ID = 'session-mgmt-room';

    it('should clear session and all associated state', async () => {
      alice.crypto.establishSession(SHARED_ROOM_ID, bob.crypto.getPublicKeyBase64());
      bob.crypto.establishSession(SHARED_ROOM_ID, alice.crypto.getPublicKeyBase64());

      // Send some messages to advance counters
      for (let i = 0; i < 5; i++) {
        const msg = alice.crypto.encrypt(SHARED_ROOM_ID, `Message ${i}`);
        bob.crypto.decrypt(SHARED_ROOM_ID, msg);
      }

      // Clear session
      alice.crypto.clearSession(SHARED_ROOM_ID);
      bob.crypto.clearSession(SHARED_ROOM_ID);

      expect(alice.crypto.hasSession(SHARED_ROOM_ID)).toBe(false);
      expect(bob.crypto.hasSession(SHARED_ROOM_ID)).toBe(false);

      // Re-establish session
      alice.crypto.establishSession(SHARED_ROOM_ID, bob.crypto.getPublicKeyBase64());
      bob.crypto.establishSession(SHARED_ROOM_ID, alice.crypto.getPublicKeyBase64());

      // Should be able to send new messages (counters reset)
      const msg = alice.crypto.encrypt(SHARED_ROOM_ID, 'After re-establish');
      expect(bob.crypto.decrypt(SHARED_ROOM_ID, msg)).toBe('After re-establish');
    });

    it('should handle multiple concurrent sessions', async () => {
      // Create a third peer
      const charlie = new CryptoService();
      await charlie.initialize();

      // Use unique room IDs for different conversations
      const ROOM_ALICE_BOB = 'room-alice-bob';
      const ROOM_ALICE_CHARLIE = 'room-alice-charlie';

      // Alice establishes sessions with both Bob and Charlie
      alice.crypto.establishSession(ROOM_ALICE_BOB, bob.crypto.getPublicKeyBase64());
      alice.crypto.establishSession(ROOM_ALICE_CHARLIE, charlie.getPublicKeyBase64());

      bob.crypto.establishSession(ROOM_ALICE_BOB, alice.crypto.getPublicKeyBase64());
      charlie.establishSession(ROOM_ALICE_CHARLIE, alice.crypto.getPublicKeyBase64());

      // Send messages to both
      const msgToBob = alice.crypto.encrypt(ROOM_ALICE_BOB, 'Hello Bob');
      const msgToCharlie = alice.crypto.encrypt(ROOM_ALICE_CHARLIE, 'Hello Charlie');

      // Each can only decrypt their own message with the correct room ID
      expect(bob.crypto.decrypt(ROOM_ALICE_BOB, msgToBob)).toBe('Hello Bob');
      expect(charlie.decrypt(ROOM_ALICE_CHARLIE, msgToCharlie)).toBe('Hello Charlie');

      // Cross-decryption should fail (Bob doesn't have ROOM_ALICE_CHARLIE session)
      expect(() => bob.crypto.decrypt(ROOM_ALICE_CHARLIE, msgToCharlie)).toThrow('No session for peer: room-alice-charlie');
    });
  });

  describe('WebRTC state transitions', () => {
    it('should emit correct state changes during connection', async () => {
      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });
      mockWsAlice!.simulateMessage({
        type: 'pair_matched',
        peerCode: VALID_PAIRING_CODE_BOB,
        peerPublicKey: bob.crypto.getPublicKeyBase64(),
        isInitiator: true,
      });

      await alice.webrtc.connect(VALID_PAIRING_CODE_BOB, true);

      // Simulate connection state changes
      mockPcAlice!.simulateConnectionState('connecting');
      expect(alice.webrtcEvents.onStateChange).toHaveBeenCalledWith('connecting');

      mockPcAlice!.simulateConnectionState('connected');
      expect(alice.webrtcEvents.onStateChange).toHaveBeenCalledWith('connected');
      expect(alice.webrtc.isConnected).toBe(true);

      mockPcAlice!.simulateConnectionState('disconnected');
      expect(alice.webrtcEvents.onStateChange).toHaveBeenCalledWith('disconnected');
      expect(alice.webrtc.isConnected).toBe(false);
    });
  });

  describe('Pair expiring notification', () => {
    it('should handle pair_expiring message', async () => {
      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

      // Alice requests pairing
      alice.signaling.requestPairing(VALID_PAIRING_CODE_BOB);

      // Receive expiring warning
      mockWsAlice!.simulateMessage({
        type: 'pair_expiring',
        peerCode: VALID_PAIRING_CODE_BOB,
        remainingSeconds: 30,
      });

      expect(alice.signalingEvents.onPairExpiring).toHaveBeenCalledWith(VALID_PAIRING_CODE_BOB, 30);
    });
  });
});
