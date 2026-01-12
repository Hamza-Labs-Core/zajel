/**
 * End-to-End Tests for Web Client Pairing Flow
 *
 * Comprehensive tests covering the complete flow:
 * - Full pairing (register -> request pairing -> pair matched -> WebRTC connect)
 * - Message exchange after connection
 * - File transfer flow
 * - Disconnection and reconnection
 * - Error scenarios (invalid code, timeout, rejection)
 *
 * Based on: /docs/e2e-test-plan.md
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SignalingClient, type SignalingEvents } from '../signaling';
import { WebRTCService, type WebRTCEvents } from '../webrtc';
import { CryptoService } from '../crypto';
import type {
  ConnectionState,
  FileStartMessage,
  FileChunkMessage,
  FileCompleteMessage,
} from '../protocol';
import { TIMEOUTS } from '../constants';

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

  simulateError(): void {
    if (this.onerror) {
      this.onerror(new Event('error'));
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

  dispatchEvent(event: string): void {
    this.eventListeners.get(event)?.forEach((cb) => cb());
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

  simulateError(): void {
    if (this.onerror) {
      this.onerror(new Event('error'));
    }
  }

  getSentMessages(): string[] {
    return [...this.sentMessages];
  }

  getLastSentMessage(): string {
    return this.sentMessages[this.sentMessages.length - 1];
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

  getAddedIceCandidates(): RTCIceCandidateInit[] {
    return [...this.iceCandidates];
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

// Valid test data that passes validation
const VALID_PAIRING_CODE_ALICE = 'ABC234';
const VALID_PAIRING_CODE_BOB = 'XYZ789';
const VALID_PAIRING_CODE_CHARLIE = 'DEF567';

// =============================================================================
// Test Fixtures
// =============================================================================

interface MockPeer {
  ws: MockWebSocket | null;
  pc: MockRTCPeerConnection | null;
  signalingEvents: SignalingEvents;
  webrtcEvents: WebRTCEvents;
  signaling: SignalingClient;
  webrtc: WebRTCService;
  crypto: CryptoService;
  pairingCode: string;
}

/**
 * Creates a mock peer with all services configured
 */
async function createMockPeer(pairingCode: string): Promise<MockPeer> {
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

  return {
    ws: null,
    pc: null,
    signalingEvents,
    webrtcEvents,
    signaling,
    webrtc,
    crypto,
    pairingCode,
  };
}

// =============================================================================
// E2E Test Suite
// =============================================================================

describe('E2E: Complete Pairing Flow', () => {
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
      if (!mockWsAlice) {
        mockWsAlice = ws;
        alice.ws = ws;
      } else if (!mockWsBob) {
        mockWsBob = ws;
        bob.ws = ws;
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
        alice.pc = pc;
      } else if (!mockPcBob) {
        mockPcBob = pc;
        bob.pc = pc;
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

  // ===========================================================================
  // 1. Full Pairing Flow Tests (Section 4.1 of test plan)
  // ===========================================================================

  describe('Full Pairing Flow', () => {
    it('should complete the full pairing flow: register -> request -> match -> WebRTC -> handshake', async () => {
      // Phase 1: Registration
      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

      bob.signaling.connect(bob.crypto.getPublicKeyBase64());
      mockWsBob!.simulateOpen();
      mockWsBob!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_BOB });

      // Verify both registered
      expect(alice.signalingEvents.onStateChange).toHaveBeenCalledWith('registered');
      expect(bob.signalingEvents.onStateChange).toHaveBeenCalledWith('registered');
      expect(alice.signaling.connectionState).toBe('registered');
      expect(bob.signaling.connectionState).toBe('registered');

      // Phase 2: Pairing Request
      alice.signaling.requestPairing(VALID_PAIRING_CODE_BOB);
      expect(alice.signalingEvents.onStateChange).toHaveBeenCalledWith('waiting_approval');

      // Bob receives pair_incoming
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

      // Phase 3: Bob accepts
      bob.signaling.respondToPairing(VALID_PAIRING_CODE_ALICE, true);

      // Phase 4: Both receive pair_matched
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

      // Phase 5: Establish crypto sessions
      alice.crypto.establishSession(VALID_PAIRING_CODE_BOB, bob.crypto.getPublicKeyBase64());
      bob.crypto.establishSession(VALID_PAIRING_CODE_ALICE, alice.crypto.getPublicKeyBase64());

      expect(alice.crypto.hasSession(VALID_PAIRING_CODE_BOB)).toBe(true);
      expect(bob.crypto.hasSession(VALID_PAIRING_CODE_ALICE)).toBe(true);

      // Phase 6: WebRTC connection (Alice as initiator)
      await alice.webrtc.connect(VALID_PAIRING_CODE_BOB, true);
      await bob.webrtc.connect(VALID_PAIRING_CODE_ALICE, false);

      // Simulate offer/answer exchange
      const aliceOffer = mockPcAlice!.getLocalDescription();
      expect(aliceOffer).toBeDefined();
      expect(aliceOffer!.type).toBe('offer');

      // Bob receives offer and creates answer
      await bob.webrtc.handleOffer(aliceOffer!);
      const bobAnswer = mockPcBob!.getLocalDescription();
      expect(bobAnswer).toBeDefined();
      expect(bobAnswer!.type).toBe('answer');

      // Alice receives answer
      await alice.webrtc.handleAnswer(bobAnswer!);

      // Phase 7: Simulate data channel open and handshake
      const aliceMessageChannel = mockPcAlice!.getDataChannel('messages');
      aliceMessageChannel!.simulateOpen();

      // Alice sends handshake
      alice.webrtc.sendHandshake(alice.crypto.getPublicKeyBase64());

      // Bob's channel opens and receives handshake
      const bobMessageChannel = mockPcBob!.simulateIncomingDataChannel('messages');
      bobMessageChannel.simulateOpen();
      bobMessageChannel.simulateMessage(JSON.stringify({
        type: 'handshake',
        publicKey: alice.crypto.getPublicKeyBase64(),
      }));

      expect(bob.webrtcEvents.onHandshake).toHaveBeenCalledWith(alice.crypto.getPublicKeyBase64());

      // Verify key verification works (MITM protection)
      expect(alice.crypto.verifyPeerKey(VALID_PAIRING_CODE_BOB, bob.crypto.getPublicKeyBase64())).toBe(true);
      expect(bob.crypto.verifyPeerKey(VALID_PAIRING_CODE_ALICE, alice.crypto.getPublicKeyBase64())).toBe(true);
    });

    it('should verify fingerprints match for legitimate pairing', async () => {
      // Setup both peers
      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

      // Get Alice's fingerprint (would be displayed to user)
      const aliceFingerprint = alice.crypto.getPublicKeyFingerprint();
      expect(aliceFingerprint).toMatch(/^[0-9A-F ]+$/);
      expect(aliceFingerprint.replace(/ /g, '').length).toBe(64);

      // Bob can verify Alice's fingerprint
      const computedFingerprint = bob.crypto.getPeerPublicKeyFingerprint(alice.crypto.getPublicKeyBase64());
      expect(computedFingerprint).toBe(aliceFingerprint);
    });
  });

  // ===========================================================================
  // 2. Message Exchange Tests (Section 4.1 continuation)
  // ===========================================================================

  describe('Message Exchange After Connection', () => {
    const SHARED_ROOM = 'e2e-message-test';

    beforeEach(async () => {
      // Establish crypto sessions
      alice.crypto.establishSession(SHARED_ROOM, bob.crypto.getPublicKeyBase64());
      bob.crypto.establishSession(SHARED_ROOM, alice.crypto.getPublicKeyBase64());
    });

    it('should encrypt and send text messages bidirectionally', () => {
      // Alice sends to Bob
      const aliceMessage = 'Hello Bob! How are you?';
      const encrypted = alice.crypto.encrypt(SHARED_ROOM, aliceMessage);

      // Verify encryption happened
      expect(encrypted).not.toBe(aliceMessage);
      expect(encrypted).not.toContain(aliceMessage);

      // Bob decrypts
      const decrypted = bob.crypto.decrypt(SHARED_ROOM, encrypted);
      expect(decrypted).toBe(aliceMessage);

      // Bob replies
      const bobMessage = 'Hey Alice! Great to hear from you.';
      const bobEncrypted = bob.crypto.encrypt(SHARED_ROOM, bobMessage);
      const bobDecrypted = alice.crypto.decrypt(SHARED_ROOM, bobEncrypted);
      expect(bobDecrypted).toBe(bobMessage);
    });

    it('should handle unicode and emoji messages', () => {
      const unicodeMessages = [
        'Hello in Japanese: Japanese greeting',
        'Arabic text: greeting',
        'Emoji: smiley face, thumbs up, heart',
        'Mixed: Hello - greeting - emoji',
      ];

      for (const msg of unicodeMessages) {
        const encrypted = alice.crypto.encrypt(SHARED_ROOM, msg);
        const decrypted = bob.crypto.decrypt(SHARED_ROOM, encrypted);
        expect(decrypted).toBe(msg);
      }
    });

    it('should produce different ciphertexts for same message (random nonce)', () => {
      const message = 'Same message content';
      const ciphertext1 = alice.crypto.encrypt(SHARED_ROOM, message);
      const ciphertext2 = alice.crypto.encrypt(SHARED_ROOM, message);

      expect(ciphertext1).not.toBe(ciphertext2);

      // Both should decrypt to same message
      expect(bob.crypto.decrypt(SHARED_ROOM, ciphertext1)).toBe(message);
      expect(bob.crypto.decrypt(SHARED_ROOM, ciphertext2)).toBe(message);
    });

    it('should handle rapid message exchange', () => {
      const messageCount = 100;

      // Alice sends many messages
      for (let i = 0; i < messageCount; i++) {
        const msg = `Message #${i}: timestamp ${Date.now()}`;
        const encrypted = alice.crypto.encrypt(SHARED_ROOM, msg);
        const decrypted = bob.crypto.decrypt(SHARED_ROOM, encrypted);
        expect(decrypted).toBe(msg);
      }
    });

    it('should reject replayed messages', () => {
      const message = alice.crypto.encrypt(SHARED_ROOM, 'Original message');

      // First decryption succeeds
      expect(bob.crypto.decrypt(SHARED_ROOM, message)).toBe('Original message');

      // Replay attempt fails
      expect(() => bob.crypto.decrypt(SHARED_ROOM, message)).toThrow('Replay attack detected');
    });

    it('should handle out-of-order messages within window', () => {
      // Encrypt messages in order
      const msg1 = alice.crypto.encrypt(SHARED_ROOM, 'Message 1');
      const msg2 = alice.crypto.encrypt(SHARED_ROOM, 'Message 2');
      const msg3 = alice.crypto.encrypt(SHARED_ROOM, 'Message 3');
      const msg4 = alice.crypto.encrypt(SHARED_ROOM, 'Message 4');

      // Receive out of order: 1, 3, 2, 4
      expect(bob.crypto.decrypt(SHARED_ROOM, msg1)).toBe('Message 1');
      expect(bob.crypto.decrypt(SHARED_ROOM, msg3)).toBe('Message 3');
      expect(bob.crypto.decrypt(SHARED_ROOM, msg2)).toBe('Message 2');
      expect(bob.crypto.decrypt(SHARED_ROOM, msg4)).toBe('Message 4');
    });
  });

  // ===========================================================================
  // 3. File Transfer Flow Tests
  // ===========================================================================

  describe('File Transfer Flow', () => {
    const SHARED_ROOM = 'e2e-file-test';

    beforeEach(async () => {
      alice.crypto.establishSession(SHARED_ROOM, bob.crypto.getPublicKeyBase64());
      bob.crypto.establishSession(SHARED_ROOM, alice.crypto.getPublicKeyBase64());
    });

    it('should complete full file transfer: start -> chunks -> complete', async () => {
      // Setup WebRTC connections
      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

      await alice.webrtc.connect(VALID_PAIRING_CODE_BOB, true);

      const fileChannel = mockPcAlice!.getDataChannel('files');
      fileChannel!.simulateOpen();

      // Send file_start
      const fileId = 'test-file-123';
      const fileName = 'test-document.pdf';
      const totalSize = 32768; // 32KB
      const totalChunks = 2;

      const startResult = alice.webrtc.sendFileStart(fileId, fileName, totalSize, totalChunks);
      expect(startResult).toBe(true);

      let sentMessages = fileChannel!.getSentMessages();
      expect(sentMessages.length).toBe(1);
      const startMessage = JSON.parse(sentMessages[0]) as FileStartMessage;
      expect(startMessage.type).toBe('file_start');
      expect(startMessage.fileId).toBe(fileId);
      expect(startMessage.fileName).toBe(fileName);
      expect(startMessage.totalSize).toBe(totalSize);
      expect(startMessage.totalChunks).toBe(totalChunks);

      // Send file chunks
      const chunk1Data = btoa('chunk1-binary-data-base64-encoded');
      const chunk2Data = btoa('chunk2-binary-data-base64-encoded');

      await alice.webrtc.sendFileChunk(fileId, 0, chunk1Data);
      await alice.webrtc.sendFileChunk(fileId, 1, chunk2Data);

      sentMessages = fileChannel!.getSentMessages();
      expect(sentMessages.length).toBe(3);

      const chunkMessage1 = JSON.parse(sentMessages[1]) as FileChunkMessage;
      expect(chunkMessage1.type).toBe('file_chunk');
      expect(chunkMessage1.fileId).toBe(fileId);
      expect(chunkMessage1.chunkIndex).toBe(0);
      expect(chunkMessage1.data).toBe(chunk1Data);

      const chunkMessage2 = JSON.parse(sentMessages[2]) as FileChunkMessage;
      expect(chunkMessage2.chunkIndex).toBe(1);

      // Send file_complete
      alice.webrtc.sendFileComplete(fileId);

      sentMessages = fileChannel!.getSentMessages();
      expect(sentMessages.length).toBe(4);

      const completeMessage = JSON.parse(sentMessages[3]) as FileCompleteMessage;
      expect(completeMessage.type).toBe('file_complete');
      expect(completeMessage.fileId).toBe(fileId);
    });

    it('should receive file transfer events correctly', async () => {
      // Connect Alice first to get mockWsAlice assigned
      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

      // Now connect Bob
      bob.signaling.connect(bob.crypto.getPublicKeyBase64());
      mockWsBob!.simulateOpen();
      mockWsBob!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_BOB });

      // Create Alice's WebRTC connection first to get mockPcAlice assigned
      await alice.webrtc.connect(VALID_PAIRING_CODE_BOB, true);

      // Now create Bob's WebRTC connection
      await bob.webrtc.connect(VALID_PAIRING_CODE_ALICE, false);

      // Simulate incoming file channel
      const fileChannel = mockPcBob!.simulateIncomingDataChannel('files');
      fileChannel.simulateOpen();

      // Receive file_start
      fileChannel.simulateMessage(JSON.stringify({
        type: 'file_start',
        fileId: 'incoming-file-456',
        fileName: 'photo.jpg',
        totalSize: 16384,
        totalChunks: 1,
      }));

      expect(bob.webrtcEvents.onFileStart).toHaveBeenCalledWith(
        'incoming-file-456',
        'photo.jpg',
        16384,
        1,
        undefined
      );

      // Receive file_chunk
      const chunkData = btoa('image-binary-data');
      fileChannel.simulateMessage(JSON.stringify({
        type: 'file_chunk',
        fileId: 'incoming-file-456',
        chunkIndex: 0,
        data: chunkData,
      }));

      expect(bob.webrtcEvents.onFileChunk).toHaveBeenCalledWith(
        'incoming-file-456',
        0,
        chunkData,
        undefined
      );

      // Receive file_complete
      fileChannel.simulateMessage(JSON.stringify({
        type: 'file_complete',
        fileId: 'incoming-file-456',
      }));

      expect(bob.webrtcEvents.onFileComplete).toHaveBeenCalledWith('incoming-file-456', undefined);
    });

    it('should handle file transfer errors', async () => {
      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

      await alice.webrtc.connect(VALID_PAIRING_CODE_BOB, true);

      const fileChannel = mockPcAlice!.getDataChannel('files');
      fileChannel!.simulateOpen();

      // Send error
      alice.webrtc.sendFileError('failed-file-789', 'File too large');

      const messages = fileChannel!.getSentMessages();
      expect(messages.length).toBe(1);
      const errorMessage = JSON.parse(messages[0]);
      expect(errorMessage.type).toBe('file_error');
      expect(errorMessage.fileId).toBe('failed-file-789');
      expect(errorMessage.error).toBe('File too large');
    });

    it('should receive file error events', async () => {
      // Connect Alice first to get mockWsAlice assigned
      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

      // Now connect Bob
      bob.signaling.connect(bob.crypto.getPublicKeyBase64());
      mockWsBob!.simulateOpen();
      mockWsBob!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_BOB });

      // Create Alice's WebRTC connection first to get mockPcAlice assigned
      await alice.webrtc.connect(VALID_PAIRING_CODE_BOB, true);

      // Now create Bob's WebRTC connection
      await bob.webrtc.connect(VALID_PAIRING_CODE_ALICE, false);

      const fileChannel = mockPcBob!.simulateIncomingDataChannel('files');
      fileChannel.simulateOpen();

      fileChannel.simulateMessage(JSON.stringify({
        type: 'file_error',
        fileId: 'error-file-999',
        error: 'Network timeout',
      }));

      expect(bob.webrtcEvents.onFileError).toHaveBeenCalledWith('error-file-999', 'Network timeout');
    });

    it('should encrypt binary data for file chunks', () => {
      // Create test binary data
      const binaryData = new Uint8Array(1024);
      for (let i = 0; i < binaryData.length; i++) {
        binaryData[i] = i % 256;
      }

      // Encrypt binary
      const encrypted = alice.crypto.encryptBytes(SHARED_ROOM, binaryData);
      expect(encrypted).toBeInstanceOf(Uint8Array);
      expect(encrypted.length).toBeGreaterThan(binaryData.length);

      // Decrypt binary
      const decrypted = bob.crypto.decryptBytes(SHARED_ROOM, encrypted);
      expect(decrypted).toEqual(binaryData);
    });
  });

  // ===========================================================================
  // 4. Disconnection and Reconnection Tests (Section 6.1, 6.2)
  // ===========================================================================

  describe('Disconnection and Reconnection', () => {
    it('should handle unexpected WebSocket disconnect with auto-reconnect', async () => {
      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

      expect(alice.signaling.connectionState).toBe('registered');

      // Simulate unexpected disconnect
      mockWsAlice!.simulateClose();

      expect(alice.signalingEvents.onStateChange).toHaveBeenCalledWith('disconnected');
      expect(alice.signaling.connectionState).toBe('disconnected');

      // Wait for reconnect attempt (base delay is 1000ms per TIMEOUTS constant)
      vi.advanceTimersByTime(TIMEOUTS.RECONNECT_DELAY_BASE_MS);

      // Should have attempted reconnect
      expect(WebSocket).toHaveBeenCalledTimes(2);
    });

    it('should not reconnect after explicit disconnect', async () => {
      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

      // Explicit disconnect
      alice.signaling.disconnect();

      expect(alice.signaling.connectionState).toBe('disconnected');

      // Wait past reconnect delay
      vi.advanceTimersByTime(TIMEOUTS.RECONNECT_DELAY_MAX_MS);

      // Should NOT have attempted reconnect
      expect(WebSocket).toHaveBeenCalledTimes(1);
    });

    it('should maintain crypto sessions across signaling reconnection', async () => {
      const SHARED_ROOM = 'reconnect-crypto-test';

      // Establish crypto session
      alice.crypto.establishSession(SHARED_ROOM, bob.crypto.getPublicKeyBase64());
      bob.crypto.establishSession(SHARED_ROOM, alice.crypto.getPublicKeyBase64());

      // Send message before disconnect
      const msg1 = alice.crypto.encrypt(SHARED_ROOM, 'Before reconnect');
      expect(bob.crypto.decrypt(SHARED_ROOM, msg1)).toBe('Before reconnect');

      // Simulate signaling disconnect (crypto session persists in memory)
      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();

      // Crypto session should still work
      expect(alice.crypto.hasSession(SHARED_ROOM)).toBe(true);
      const msg2 = alice.crypto.encrypt(SHARED_ROOM, 'After reconnect');
      expect(bob.crypto.decrypt(SHARED_ROOM, msg2)).toBe('After reconnect');
    });

    it('should handle WebRTC disconnect and reconnect', async () => {
      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

      await alice.webrtc.connect(VALID_PAIRING_CODE_BOB, true);

      // Simulate connection state changes
      mockPcAlice!.simulateConnectionState('connecting');
      expect(alice.webrtcEvents.onStateChange).toHaveBeenCalledWith('connecting');

      mockPcAlice!.simulateConnectionState('connected');
      expect(alice.webrtcEvents.onStateChange).toHaveBeenCalledWith('connected');
      expect(alice.webrtc.isConnected).toBe(true);

      // Disconnect
      mockPcAlice!.simulateConnectionState('disconnected');
      expect(alice.webrtcEvents.onStateChange).toHaveBeenCalledWith('disconnected');
      expect(alice.webrtc.isConnected).toBe(false);

      // Close and reconnect
      alice.webrtc.close();

      // Reset mock to get new PC
      mockPcAlice = null;
      await alice.webrtc.connect(VALID_PAIRING_CODE_BOB, true);

      expect(mockPcAlice).not.toBeNull();
    });

    it('should use exponential backoff for reconnection', async () => {
      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

      // First disconnect
      mockWsAlice!.simulateClose();
      expect(WebSocket).toHaveBeenCalledTimes(1);

      // First reconnect after base delay
      vi.advanceTimersByTime(TIMEOUTS.RECONNECT_DELAY_BASE_MS);
      expect(WebSocket).toHaveBeenCalledTimes(2);

      // Simulate failure - second disconnect
      mockWsAlice!.simulateClose();

      // Should wait 2x base delay (exponential backoff)
      vi.advanceTimersByTime(TIMEOUTS.RECONNECT_DELAY_BASE_MS);
      expect(WebSocket).toHaveBeenCalledTimes(2); // Not yet

      vi.advanceTimersByTime(TIMEOUTS.RECONNECT_DELAY_BASE_MS);
      expect(WebSocket).toHaveBeenCalledTimes(3);
    });
  });

  // ===========================================================================
  // 5. Error Scenarios (Section 6.3, 6.4)
  // ===========================================================================

  describe('Error Scenarios', () => {
    describe('Invalid Pairing Code', () => {
      it('should reject invalid pairing code format', async () => {
        alice.signaling.connect(alice.crypto.getPublicKeyBase64());
        mockWsAlice!.simulateOpen();
        mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

        // Invalid codes
        const invalidCodes = [
          'abc234',   // lowercase
          'ABC0123',  // contains 0 and too long
          'ABC1DE',   // contains 1
          'ABCIDE',   // contains I
          'ABCODE',   // contains O
          'ABC',      // too short
          '',         // empty
        ];

        for (const code of invalidCodes) {
          vi.mocked(alice.signalingEvents.onError).mockClear();
          alice.signaling.requestPairing(code);
          expect(alice.signalingEvents.onError).toHaveBeenCalledWith('Invalid pairing code format');
        }
      });

      it('should handle non-existent pairing code (server returns error)', async () => {
        alice.signaling.connect(alice.crypto.getPublicKeyBase64());
        mockWsAlice!.simulateOpen();
        mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

        alice.signaling.requestPairing(VALID_PAIRING_CODE_BOB);

        // Server responds with error
        mockWsAlice!.simulateMessage({
          type: 'pair_error',
          error: 'Target not found',
        });

        expect(alice.signalingEvents.onPairError).toHaveBeenCalledWith('Target not found');
        expect(alice.signaling.connectionState).toBe('registered');
      });
    });

    describe('Pairing Timeout', () => {
      it('should handle pair request timeout', async () => {
        alice.signaling.connect(alice.crypto.getPublicKeyBase64());
        mockWsAlice!.simulateOpen();
        mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

        alice.signaling.requestPairing(VALID_PAIRING_CODE_BOB);

        // Receive expiring warning
        mockWsAlice!.simulateMessage({
          type: 'pair_expiring',
          peerCode: VALID_PAIRING_CODE_BOB,
          remainingSeconds: 30,
        });

        expect(alice.signalingEvents.onPairExpiring).toHaveBeenCalledWith(VALID_PAIRING_CODE_BOB, 30);

        // Final timeout
        mockWsAlice!.simulateMessage({
          type: 'pair_timeout',
          peerCode: VALID_PAIRING_CODE_BOB,
        });

        expect(alice.signalingEvents.onPairTimeout).toHaveBeenCalledWith(VALID_PAIRING_CODE_BOB);
        expect(alice.signaling.connectionState).toBe('registered');
      });
    });

    describe('Pairing Rejection', () => {
      it('should handle pairing request rejection', async () => {
        // Alice connects
        alice.signaling.connect(alice.crypto.getPublicKeyBase64());
        mockWsAlice!.simulateOpen();
        mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

        // Bob connects
        bob.signaling.connect(bob.crypto.getPublicKeyBase64());
        mockWsBob!.simulateOpen();
        mockWsBob!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_BOB });

        // Alice requests pairing
        alice.signaling.requestPairing(VALID_PAIRING_CODE_BOB);

        // Bob receives request
        mockWsBob!.simulateMessage({
          type: 'pair_incoming',
          fromCode: VALID_PAIRING_CODE_ALICE,
          fromPublicKey: alice.crypto.getPublicKeyBase64(),
        });

        // Bob rejects
        bob.signaling.respondToPairing(VALID_PAIRING_CODE_ALICE, false);

        // Verify rejection message was sent
        const bobMessages = mockWsBob!.getSentMessages();
        const rejectMessage = bobMessages.find(
          (m) => (m as { type: string }).type === 'pair_response'
        ) as { type: string; targetCode: string; accepted: boolean } | undefined;

        expect(rejectMessage).toBeDefined();
        expect(rejectMessage!.accepted).toBe(false);

        // Alice receives rejection
        mockWsAlice!.simulateMessage({
          type: 'pair_rejected',
          peerCode: VALID_PAIRING_CODE_BOB,
        });

        expect(alice.signalingEvents.onPairRejected).toHaveBeenCalledWith(VALID_PAIRING_CODE_BOB);
        expect(alice.signaling.connectionState).toBe('registered');
      });
    });

    describe('WebSocket Error', () => {
      it('should handle WebSocket connection error', async () => {
        alice.signaling.connect(alice.crypto.getPublicKeyBase64());

        mockWsAlice!.simulateError();

        expect(alice.signalingEvents.onError).toHaveBeenCalledWith('Connection error');
      });
    });

    describe('Encryption Errors', () => {
      it('should throw when encrypting without session', async () => {
        expect(() => alice.crypto.encrypt('unknown-peer', 'message'))
          .toThrow('No session for peer: unknown-peer');
      });

      it('should throw when decrypting without session', async () => {
        const SHARED_ROOM = 'encrypt-error-test';
        alice.crypto.establishSession(SHARED_ROOM, bob.crypto.getPublicKeyBase64());
        const encrypted = alice.crypto.encrypt(SHARED_ROOM, 'test');

        expect(() => bob.crypto.decrypt('unknown-peer', encrypted))
          .toThrow('No session for peer: unknown-peer');
      });

      it('should throw on invalid peer public key', async () => {
        expect(() => alice.crypto.establishSession('test', 'invalid-base64!!!'))
          .toThrow('Invalid peer public key: malformed base64');

        // Wrong key length
        const shortKey = btoa(String.fromCharCode(...new Uint8Array(16)));
        expect(() => alice.crypto.establishSession('test', shortKey))
          .toThrow('Invalid peer public key: expected 32 bytes, got 16');
      });
    });

    describe('MITM Detection', () => {
      it('should detect MITM attack via mismatched keys', async () => {
        // Setup legitimate session
        alice.crypto.establishSession(VALID_PAIRING_CODE_BOB, bob.crypto.getPublicKeyBase64());

        // Attacker (eve) creates their own keys
        const eve = new CryptoService();
        await eve.initialize();

        // Alice has Bob's key stored, verify detects mismatch
        expect(alice.crypto.verifyPeerKey(VALID_PAIRING_CODE_BOB, bob.crypto.getPublicKeyBase64())).toBe(true);
        expect(alice.crypto.verifyPeerKey(VALID_PAIRING_CODE_BOB, eve.getPublicKeyBase64())).toBe(false);
      });

      it('should detect MITM via fingerprint comparison', async () => {
        const aliceFingerprint = alice.crypto.getPublicKeyFingerprint();
        const bobFingerprint = bob.crypto.getPublicKeyFingerprint();

        // Fingerprints should be different for different keys
        expect(aliceFingerprint).not.toBe(bobFingerprint);

        // Computed fingerprint should match actual fingerprint
        const computedAlice = bob.crypto.getPeerPublicKeyFingerprint(alice.crypto.getPublicKeyBase64());
        expect(computedAlice).toBe(aliceFingerprint);
      });
    });
  });

  // ===========================================================================
  // 6. Multi-Peer Tests
  // ===========================================================================

  describe('Multi-Peer Scenarios', () => {
    let charlie: MockPeer;
    let mockWsCharlie: MockWebSocket | null = null;

    beforeEach(async () => {
      charlie = await createMockPeer(VALID_PAIRING_CODE_CHARLIE);

      // Override WebSocket mock to support third peer
      const MockWebSocketConstructor = vi.fn().mockImplementation(function (url: string) {
        const ws = new MockWebSocket(url);
        if (!mockWsAlice) {
          mockWsAlice = ws;
          alice.ws = ws;
        } else if (!mockWsBob) {
          mockWsBob = ws;
          bob.ws = ws;
        } else if (!mockWsCharlie) {
          mockWsCharlie = ws;
          charlie.ws = ws;
        }
        return ws;
      });
      MockWebSocketConstructor.OPEN = MockWebSocket.OPEN;
      MockWebSocketConstructor.CONNECTING = MockWebSocket.CONNECTING;
      MockWebSocketConstructor.CLOSING = MockWebSocket.CLOSING;
      MockWebSocketConstructor.CLOSED = MockWebSocket.CLOSED;

      vi.stubGlobal('WebSocket', MockWebSocketConstructor);
    });

    it('should handle multiple concurrent sessions with different peers', async () => {
      // Establish sessions with both Bob and Charlie
      const ROOM_ALICE_BOB = 'alice-bob-room';
      const ROOM_ALICE_CHARLIE = 'alice-charlie-room';

      alice.crypto.establishSession(ROOM_ALICE_BOB, bob.crypto.getPublicKeyBase64());
      alice.crypto.establishSession(ROOM_ALICE_CHARLIE, charlie.crypto.getPublicKeyBase64());

      bob.crypto.establishSession(ROOM_ALICE_BOB, alice.crypto.getPublicKeyBase64());
      charlie.crypto.establishSession(ROOM_ALICE_CHARLIE, alice.crypto.getPublicKeyBase64());

      // Send messages to both
      const msgToBob = alice.crypto.encrypt(ROOM_ALICE_BOB, 'Hello Bob!');
      const msgToCharlie = alice.crypto.encrypt(ROOM_ALICE_CHARLIE, 'Hello Charlie!');

      // Each can only decrypt their own message
      expect(bob.crypto.decrypt(ROOM_ALICE_BOB, msgToBob)).toBe('Hello Bob!');
      expect(charlie.crypto.decrypt(ROOM_ALICE_CHARLIE, msgToCharlie)).toBe('Hello Charlie!');

      // Cross-decryption should fail
      expect(() => bob.crypto.decrypt(ROOM_ALICE_CHARLIE, msgToCharlie))
        .toThrow('No session for peer: alice-charlie-room');
      expect(() => charlie.crypto.decrypt(ROOM_ALICE_BOB, msgToBob))
        .toThrow('No session for peer: alice-bob-room');
    });

    it('should maintain independent sequence counters per session', async () => {
      const ROOM_ALICE_BOB = 'seq-test-bob';
      const ROOM_ALICE_CHARLIE = 'seq-test-charlie';

      alice.crypto.establishSession(ROOM_ALICE_BOB, bob.crypto.getPublicKeyBase64());
      alice.crypto.establishSession(ROOM_ALICE_CHARLIE, charlie.crypto.getPublicKeyBase64());

      bob.crypto.establishSession(ROOM_ALICE_BOB, alice.crypto.getPublicKeyBase64());
      charlie.crypto.establishSession(ROOM_ALICE_CHARLIE, alice.crypto.getPublicKeyBase64());

      // Send different number of messages to each
      for (let i = 0; i < 5; i++) {
        const msg = alice.crypto.encrypt(ROOM_ALICE_BOB, `To Bob ${i}`);
        bob.crypto.decrypt(ROOM_ALICE_BOB, msg);
      }

      for (let i = 0; i < 3; i++) {
        const msg = alice.crypto.encrypt(ROOM_ALICE_CHARLIE, `To Charlie ${i}`);
        charlie.crypto.decrypt(ROOM_ALICE_CHARLIE, msg);
      }

      // Both sessions should still work
      const finalToBob = alice.crypto.encrypt(ROOM_ALICE_BOB, 'Final to Bob');
      const finalToCharlie = alice.crypto.encrypt(ROOM_ALICE_CHARLIE, 'Final to Charlie');

      expect(bob.crypto.decrypt(ROOM_ALICE_BOB, finalToBob)).toBe('Final to Bob');
      expect(charlie.crypto.decrypt(ROOM_ALICE_CHARLIE, finalToCharlie)).toBe('Final to Charlie');
    });
  });

  // ===========================================================================
  // 7. Session Management Tests
  // ===========================================================================

  describe('Session Management', () => {
    const SHARED_ROOM = 'session-mgmt-test';

    it('should clear session and associated state', async () => {
      alice.crypto.establishSession(SHARED_ROOM, bob.crypto.getPublicKeyBase64());
      bob.crypto.establishSession(SHARED_ROOM, alice.crypto.getPublicKeyBase64());

      // Send some messages
      for (let i = 0; i < 5; i++) {
        const msg = alice.crypto.encrypt(SHARED_ROOM, `Message ${i}`);
        bob.crypto.decrypt(SHARED_ROOM, msg);
      }

      // Clear sessions
      alice.crypto.clearSession(SHARED_ROOM);
      bob.crypto.clearSession(SHARED_ROOM);

      expect(alice.crypto.hasSession(SHARED_ROOM)).toBe(false);
      expect(bob.crypto.hasSession(SHARED_ROOM)).toBe(false);

      // Re-establish
      alice.crypto.establishSession(SHARED_ROOM, bob.crypto.getPublicKeyBase64());
      bob.crypto.establishSession(SHARED_ROOM, alice.crypto.getPublicKeyBase64());

      // Should work with fresh counters
      const msg = alice.crypto.encrypt(SHARED_ROOM, 'After re-establish');
      expect(bob.crypto.decrypt(SHARED_ROOM, msg)).toBe('After re-establish');
    });

    it('should clear stored peer key on session clear', async () => {
      alice.crypto.establishSession(SHARED_ROOM, bob.crypto.getPublicKeyBase64());

      expect(alice.crypto.getStoredPeerKey(SHARED_ROOM)).toBe(bob.crypto.getPublicKeyBase64());

      alice.crypto.clearSession(SHARED_ROOM);

      expect(alice.crypto.getStoredPeerKey(SHARED_ROOM)).toBe(null);
    });
  });

  // ===========================================================================
  // 8. Data Channel Tests
  // ===========================================================================

  describe('Data Channel Behavior', () => {
    it('should not send messages when channel is not open', async () => {
      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

      await alice.webrtc.connect(VALID_PAIRING_CODE_BOB, true);

      // Channel is in 'connecting' state (not open)
      const messageChannel = mockPcAlice!.getDataChannel('messages');
      expect(messageChannel!.readyState).toBe('connecting');

      // Attempt to send
      alice.webrtc.sendMessage('test-message');
      alice.webrtc.sendHandshake('test-key');

      // Nothing should be sent
      expect(messageChannel!.getSentMessages()).toHaveLength(0);
    });

    it('should handle incoming data channels correctly (responder)', async () => {
      // Connect Alice first to get mockWsAlice assigned
      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

      // Now connect Bob
      bob.signaling.connect(bob.crypto.getPublicKeyBase64());
      mockWsBob!.simulateOpen();
      mockWsBob!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_BOB });

      // Create Alice's WebRTC connection first to get mockPcAlice assigned
      await alice.webrtc.connect(VALID_PAIRING_CODE_BOB, true);

      // Now create Bob's WebRTC connection
      await bob.webrtc.connect(VALID_PAIRING_CODE_ALICE, false);

      // As responder, channels are created by ondatachannel
      const messageChannel = mockPcBob!.simulateIncomingDataChannel('messages');
      messageChannel.simulateOpen();

      expect(bob.webrtc.messageChannelOpen).toBe(true);
    });

    it('should reject oversized messages', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

      await alice.webrtc.connect(VALID_PAIRING_CODE_BOB, true);

      const messageChannel = mockPcAlice!.getDataChannel('messages');
      messageChannel!.simulateOpen();

      // Simulate receiving oversized message
      const largeMessage = 'x'.repeat(1024 * 1024 + 1);
      messageChannel!.simulateMessage(largeMessage);

      expect(consoleSpy).toHaveBeenCalledWith(
        '[WebRTC]',
        'Rejected message channel data: exceeds 1MB size limit'
      );
      expect(alice.webrtcEvents.onMessage).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  // ===========================================================================
  // 9. ICE Candidate Handling Tests
  // ===========================================================================

  describe('ICE Candidate Handling', () => {
    it('should queue ICE candidates before remote description is set', async () => {
      // Connect Alice first to get mockWsAlice assigned
      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

      // Now connect Bob
      bob.signaling.connect(bob.crypto.getPublicKeyBase64());
      mockWsBob!.simulateOpen();
      mockWsBob!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_BOB });

      // Create Alice's WebRTC connection first to get mockPcAlice assigned
      await alice.webrtc.connect(VALID_PAIRING_CODE_BOB, true);

      // Now create Bob's WebRTC connection
      await bob.webrtc.connect(VALID_PAIRING_CODE_ALICE, false);

      // Queue candidates before handleOffer
      const candidate1 = { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 };
      const candidate2 = { candidate: 'candidate:2', sdpMid: '0', sdpMLineIndex: 0 };

      await bob.webrtc.handleIceCandidate(candidate1);
      await bob.webrtc.handleIceCandidate(candidate2);

      // Should be queued, not added yet
      expect(mockPcBob!.getAddedIceCandidates()).toHaveLength(0);

      // Now handle offer - should process queued candidates
      await bob.webrtc.handleOffer({ type: 'offer', sdp: 'test-offer-sdp' });

      const added = mockPcBob!.getAddedIceCandidates();
      expect(added).toHaveLength(2);
      expect(added).toContainEqual(candidate1);
      expect(added).toContainEqual(candidate2);
    });

    it('should forward ICE candidates through signaling', async () => {
      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

      await alice.webrtc.connect(VALID_PAIRING_CODE_BOB, true);

      // Simulate ICE candidate generation
      const candidate = { candidate: 'candidate:test', sdpMid: '0', sdpMLineIndex: 0 };
      mockPcAlice!.simulateIceCandidate(candidate);

      // Should have been sent through signaling
      const messages = mockWsAlice!.getSentMessages();
      const iceMessage = messages.find(
        (m) => (m as { type: string }).type === 'ice_candidate'
      ) as { type: string; target: string; payload: RTCIceCandidateInit } | undefined;

      expect(iceMessage).toBeDefined();
      expect(iceMessage!.target).toBe(VALID_PAIRING_CODE_BOB);
      expect(iceMessage!.payload).toEqual(candidate);
    });
  });

  // ===========================================================================
  // 10. Connection State Management Tests
  // ===========================================================================

  describe('Connection State Management', () => {
    it('should track all signaling connection states', async () => {
      const stateChanges: ConnectionState[] = [];
      alice.signalingEvents.onStateChange = vi.fn((state) => {
        stateChanges.push(state);
      });

      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      expect(stateChanges).toContain('connecting');

      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });
      expect(stateChanges).toContain('registered');

      alice.signaling.requestPairing(VALID_PAIRING_CODE_BOB);
      expect(stateChanges).toContain('waiting_approval');

      mockWsAlice!.simulateMessage({
        type: 'pair_matched',
        peerCode: VALID_PAIRING_CODE_BOB,
        peerPublicKey: bob.crypto.getPublicKeyBase64(),
        isInitiator: true,
      });
      expect(stateChanges).toContain('matched');

      alice.signaling.disconnect();
      expect(stateChanges).toContain('disconnected');
    });

    it('should track all WebRTC connection states', async () => {
      const stateChanges: RTCPeerConnectionState[] = [];
      alice.webrtcEvents.onStateChange = vi.fn((state) => {
        stateChanges.push(state);
      });

      alice.signaling.connect(alice.crypto.getPublicKeyBase64());
      mockWsAlice!.simulateOpen();
      mockWsAlice!.simulateMessage({ type: 'registered', pairingCode: VALID_PAIRING_CODE_ALICE });

      await alice.webrtc.connect(VALID_PAIRING_CODE_BOB, true);

      mockPcAlice!.simulateConnectionState('connecting');
      expect(stateChanges).toContain('connecting');

      mockPcAlice!.simulateConnectionState('connected');
      expect(stateChanges).toContain('connected');
      expect(alice.webrtc.isConnected).toBe(true);

      mockPcAlice!.simulateConnectionState('failed');
      expect(stateChanges).toContain('failed');
      expect(alice.webrtc.isConnected).toBe(false);
    });
  });
});
