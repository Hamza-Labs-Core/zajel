/**
 * WebRTCService Tests
 *
 * Tests for WebRTC peer connections and data channels.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebRTCService, type WebRTCEvents } from '../webrtc';
import type { SignalingClient } from '../signaling';

// Mock RTCDataChannel
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

  clearSentMessages(): void {
    this.sentMessages = [];
  }
}

// Mock RTCPeerConnection
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
    return { type: 'offer', sdp: 'mock-offer-sdp' };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'mock-answer-sdp' };
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
    // Close all data channels
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

// Mock SignalingClient factory
const createMockSignaling = (): SignalingClient => ({
  sendOffer: vi.fn(),
  sendAnswer: vi.fn(),
  sendIceCandidate: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  requestPairing: vi.fn(),
  respondToPairing: vi.fn(),
  connectionState: 'registered',
  pairingCode: 'ABC123',
} as unknown as SignalingClient);

// Factory function for creating fresh mocks
function createMockPeerConnection(): MockRTCPeerConnection {
  return new MockRTCPeerConnection();
}

describe('WebRTCService', () => {
  let currentMockPc: MockRTCPeerConnection;
  let mockSignaling: SignalingClient;
  let events: WebRTCEvents;
  let service: WebRTCService;

  beforeEach(() => {
    // Create fresh mock for each test
    currentMockPc = createMockPeerConnection();

    // Create a proper RTCPeerConnection mock that can be used with 'new'
    // and also tracked as a spy
    const MockRTCPeerConnectionConstructor = vi.fn().mockImplementation(function () {
      currentMockPc = createMockPeerConnection();
      return currentMockPc;
    });

    // Mock RTCPeerConnection globally
    vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnectionConstructor);

    mockSignaling = createMockSignaling();

    events = {
      onStateChange: vi.fn(),
      onHandshake: vi.fn(),
      onMessage: vi.fn(),
      onFileStart: vi.fn(),
      onFileChunk: vi.fn(),
      onFileComplete: vi.fn(),
      onFileError: vi.fn(),
    };

    service = new WebRTCService(mockSignaling, events);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('Connection as initiator', () => {
    it('should create peer connection with ICE servers', async () => {
      await service.connect('peer-123', true);

      expect(RTCPeerConnection).toHaveBeenCalledWith({
        iceServers: expect.arrayContaining([
          expect.objectContaining({ urls: expect.stringContaining('stun:') }),
        ]),
      });
    });

    it('should create data channels when initiator', async () => {
      await service.connect('peer-123', true);

      // Check that both message and file channels were created
      expect(currentMockPc.getDataChannel('messages')).toBeDefined();
      expect(currentMockPc.getDataChannel('files')).toBeDefined();
    });

    it('should create and send offer when initiator', async () => {
      await service.connect('peer-123', true);

      expect(mockSignaling.sendOffer).toHaveBeenCalledWith(
        'peer-123',
        expect.objectContaining({ type: 'offer', sdp: 'mock-offer-sdp' })
      );
    });

    it('should set local description when creating offer', async () => {
      await service.connect('peer-123', true);

      expect(currentMockPc.getLocalDescription()).toEqual({
        type: 'offer',
        sdp: 'mock-offer-sdp',
      });
    });

    it('should not send offer when not initiator', async () => {
      await service.connect('peer-123', false);

      expect(mockSignaling.sendOffer).not.toHaveBeenCalled();
    });

    it('should not create data channels when not initiator', async () => {
      await service.connect('peer-123', false);

      // Data channels are created via ondatachannel for responder
      expect(currentMockPc.getDataChannel('messages')).toBeUndefined();
      expect(currentMockPc.getDataChannel('files')).toBeUndefined();
    });
  });

  describe('ICE candidate handling', () => {
    it('should forward ICE candidates to signaling', async () => {
      await service.connect('peer-123', true);

      const candidate = { candidate: 'candidate:123', sdpMid: '0', sdpMLineIndex: 0 };
      currentMockPc.simulateIceCandidate(candidate);

      expect(mockSignaling.sendIceCandidate).toHaveBeenCalledWith(
        'peer-123',
        candidate
      );
    });

    it('should not forward null ICE candidates', async () => {
      await service.connect('peer-123', true);

      currentMockPc.simulateIceCandidate(null);

      expect(mockSignaling.sendIceCandidate).not.toHaveBeenCalled();
    });

    it('should add ICE candidates directly when remote description is set', async () => {
      await service.connect('peer-123', false);

      // Set remote description via handleOffer
      const offer: RTCSessionDescriptionInit = { type: 'offer', sdp: 'test-sdp' };
      await service.handleOffer(offer);

      const candidate = { candidate: 'test-candidate', sdpMid: '0', sdpMLineIndex: 0 };
      await service.handleIceCandidate(candidate);

      expect(currentMockPc.getAddedIceCandidates()).toContainEqual(candidate);
    });

    it('should handle ICE candidate add failure gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await service.connect('peer-123', false);

      // Set remote description
      await service.handleOffer({ type: 'offer', sdp: 'test-sdp' });

      // Make addIceCandidate throw
      currentMockPc.addIceCandidate = vi.fn().mockRejectedValue(new Error('Failed'));

      const candidate = { candidate: 'bad-candidate' };
      await service.handleIceCandidate(candidate);

      expect(consoleSpy).toHaveBeenCalledWith(
        '[WebRTC]',
        'Failed to add ICE candidate:',
        'Failed'
      );

      consoleSpy.mockRestore();
    });

    it('should queue candidates before remote description is set', async () => {
      await service.connect('peer-123', false);

      // Add candidates before handleOffer sets remote description
      const candidate1 = { candidate: 'early-candidate-1' };
      const candidate2 = { candidate: 'early-candidate-2' };

      await service.handleIceCandidate(candidate1);
      await service.handleIceCandidate(candidate2);

      // Candidates should be queued (not added yet)
      expect(currentMockPc.getAddedIceCandidates()).toHaveLength(0);

      // Now set remote description - this should process queued candidates
      const offer: RTCSessionDescriptionInit = { type: 'offer', sdp: 'test-sdp' };
      await service.handleOffer(offer);

      // All queued candidates should have been added
      const added = currentMockPc.getAddedIceCandidates();
      expect(added).toHaveLength(2);
      expect(added).toContainEqual(candidate1);
      expect(added).toContainEqual(candidate2);
    });

    it('should limit pending ICE candidate queue size', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await service.connect('peer-123', false);

      // Add more than 100 candidates before setting remote description
      for (let i = 0; i < 105; i++) {
        await service.handleIceCandidate({ candidate: `candidate-${i}` });
      }

      expect(consoleSpy).toHaveBeenCalledWith(
        '[WebRTC]',
        'ICE candidate queue full, dropping oldest candidate'
      );

      // Set remote description to process queued candidates
      await service.handleOffer({ type: 'offer', sdp: 'test-sdp' });

      // Should have limited to 100 candidates (dropped first 5)
      const added = currentMockPc.getAddedIceCandidates();
      expect(added).toHaveLength(100);
      // First candidate should be candidate-5 (0-4 were dropped)
      expect(added[0]).toEqual({ candidate: 'candidate-5' });

      consoleSpy.mockRestore();
    });
  });

  describe('Offer/Answer handling', () => {
    it('should handle incoming offer and send answer', async () => {
      await service.connect('peer-123', false);

      const offer: RTCSessionDescriptionInit = { type: 'offer', sdp: 'test-offer-sdp' };
      await service.handleOffer(offer);

      expect(currentMockPc.getRemoteDescription()).toEqual(offer);
      expect(mockSignaling.sendAnswer).toHaveBeenCalledWith(
        'peer-123',
        expect.objectContaining({ type: 'answer', sdp: 'mock-answer-sdp' })
      );
    });

    it('should set local description when creating answer', async () => {
      await service.connect('peer-123', false);

      const offer: RTCSessionDescriptionInit = { type: 'offer', sdp: 'test-offer-sdp' };
      await service.handleOffer(offer);

      expect(currentMockPc.getLocalDescription()).toEqual({
        type: 'answer',
        sdp: 'mock-answer-sdp',
      });
    });

    it('should handle incoming answer', async () => {
      await service.connect('peer-123', true);

      const answer: RTCSessionDescriptionInit = { type: 'answer', sdp: 'test-answer-sdp' };
      await service.handleAnswer(answer);

      expect(currentMockPc.getRemoteDescription()).toEqual(answer);
    });

    it('should ignore offer when no peer connection', async () => {
      // Don't connect first
      const offer: RTCSessionDescriptionInit = { type: 'offer', sdp: 'test-sdp' };
      await service.handleOffer(offer);

      expect(mockSignaling.sendAnswer).not.toHaveBeenCalled();
    });

    it('should ignore answer when no peer connection', async () => {
      // Don't connect first
      const answer: RTCSessionDescriptionInit = { type: 'answer', sdp: 'test-sdp' };
      await service.handleAnswer(answer);

      // Should not throw, just return early
    });
  });

  describe('Connection state', () => {
    it('should emit state changes', async () => {
      await service.connect('peer-123', true);

      currentMockPc.simulateConnectionState('connecting');
      expect(events.onStateChange).toHaveBeenCalledWith('connecting');

      currentMockPc.simulateConnectionState('connected');
      expect(events.onStateChange).toHaveBeenCalledWith('connected');
    });

    it('should report isConnected correctly', async () => {
      await service.connect('peer-123', true);

      expect(service.isConnected).toBe(false);

      currentMockPc.simulateConnectionState('connecting');
      expect(service.isConnected).toBe(false);

      currentMockPc.simulateConnectionState('connected');
      expect(service.isConnected).toBe(true);

      currentMockPc.simulateConnectionState('disconnected');
      expect(service.isConnected).toBe(false);
    });

    it('should report messageChannelOpen correctly', async () => {
      await service.connect('peer-123', true);

      expect(service.messageChannelOpen).toBe(false);

      const messageChannel = currentMockPc.getDataChannel('messages');
      messageChannel!.simulateOpen();

      expect(service.messageChannelOpen).toBe(true);
    });

    it('should handle all connection states', async () => {
      await service.connect('peer-123', true);

      const states: RTCPeerConnectionState[] = [
        'new',
        'connecting',
        'connected',
        'disconnected',
        'failed',
        'closed',
      ];

      for (const state of states) {
        currentMockPc.simulateConnectionState(state);
        expect(events.onStateChange).toHaveBeenCalledWith(state);
      }
    });
  });

  describe('Data channel - messages', () => {
    describe('as initiator', () => {
      beforeEach(async () => {
        await service.connect('peer-123', true);
      });

      it('should send encrypted messages when channel is open', () => {
        const messageChannel = currentMockPc.getDataChannel('messages');
        messageChannel!.simulateOpen();

        service.sendMessage('encrypted-data');

        expect(messageChannel!.getSentMessages()).toContain('encrypted-data');
      });

      it('should not send messages when channel is not open', () => {
        // Channel is in 'connecting' state by default
        service.sendMessage('encrypted-data');

        const messageChannel = currentMockPc.getDataChannel('messages');
        expect(messageChannel!.getSentMessages()).toHaveLength(0);
      });

      it('should send handshake message', () => {
        const messageChannel = currentMockPc.getDataChannel('messages');
        messageChannel!.simulateOpen();

        service.sendHandshake('my-public-key');

        const messages = messageChannel!.getSentMessages();
        expect(messages).toHaveLength(1);
        expect(JSON.parse(messages[0])).toEqual({
          type: 'handshake',
          publicKey: 'my-public-key',
        });
      });

      it('should not send handshake when channel is closed', () => {
        service.sendHandshake('my-public-key');

        const messageChannel = currentMockPc.getDataChannel('messages');
        expect(messageChannel!.getSentMessages()).toHaveLength(0);
      });

      it('should receive handshake events on initiator channel', () => {
        const messageChannel = currentMockPc.getDataChannel('messages');
        messageChannel!.simulateOpen();

        // Public key must be 32-256 chars for validation
        const validPeerKey = 'peer-key-123456789012345678901234567890';
        messageChannel!.simulateMessage(JSON.stringify({ type: 'handshake', publicKey: validPeerKey }));

        expect(events.onHandshake).toHaveBeenCalledWith(validPeerKey, undefined);
      });

      it('should receive message events on initiator channel', () => {
        const messageChannel = currentMockPc.getDataChannel('messages');
        messageChannel!.simulateOpen();

        messageChannel!.simulateMessage('encrypted-message-data');

        expect(events.onMessage).toHaveBeenCalledWith('encrypted-message-data');
      });
    });

    describe('as responder', () => {
      beforeEach(async () => {
        await service.connect('peer-123', false);
      });

      it('should handle incoming message channel', () => {
        const channel = currentMockPc.simulateIncomingDataChannel('messages');
        channel.simulateOpen();

        expect(service.messageChannelOpen).toBe(true);
      });

      it('should emit handshake events from incoming channel', () => {
        const channel = currentMockPc.simulateIncomingDataChannel('messages');
        channel.simulateOpen();

        // Public key must be 32-256 chars for validation
        const validPeerKey = 'peer-key-123456789012345678901234567890';
        channel.simulateMessage(JSON.stringify({ type: 'handshake', publicKey: validPeerKey }));

        expect(events.onHandshake).toHaveBeenCalledWith(validPeerKey, undefined);
      });

      it('should emit message events for encrypted messages (non-JSON)', () => {
        const channel = currentMockPc.simulateIncomingDataChannel('messages');
        channel.simulateOpen();

        channel.simulateMessage('encrypted-message-data');

        expect(events.onMessage).toHaveBeenCalledWith('encrypted-message-data');
      });

      it('should emit message events for encrypted messages (JSON without type)', () => {
        const channel = currentMockPc.simulateIncomingDataChannel('messages');
        channel.simulateOpen();

        const encryptedJson = JSON.stringify({ data: 'encrypted', nonce: 'abc' });
        channel.simulateMessage(encryptedJson);

        expect(events.onMessage).toHaveBeenCalledWith(encryptedJson);
      });
    });
  });

  describe('Data channel - files', () => {
    describe('as initiator', () => {
      beforeEach(async () => {
        await service.connect('peer-123', true);
      });

      it('should send file start notification', () => {
        const fileChannel = currentMockPc.getDataChannel('files');
        fileChannel!.simulateOpen();

        const result = service.sendFileStart('file-1', 'test.txt', 1024, 10);

        expect(result).toBe(true);
        const sent = fileChannel!.getSentMessages();
        expect(sent).toHaveLength(1);
        expect(JSON.parse(sent[0])).toEqual({
          type: 'file_start',
          fileId: 'file-1',
          fileName: 'test.txt',
          totalSize: 1024,
          totalChunks: 10,
          chunkHashes: undefined,
        });
      });

      it('should send file chunk', async () => {
        const fileChannel = currentMockPc.getDataChannel('files');
        fileChannel!.simulateOpen();

        const result = await service.sendFileChunk('file-1', 0, 'base64-chunk-data');

        expect(result).toBe(true);
        const sent = fileChannel!.getSentMessages();
        expect(sent).toHaveLength(1);
        expect(JSON.parse(sent[0])).toEqual({
          type: 'file_chunk',
          fileId: 'file-1',
          chunkIndex: 0,
          data: 'base64-chunk-data',
          hash: undefined,
        });
      });

      it('should send file complete notification', () => {
        const fileChannel = currentMockPc.getDataChannel('files');
        fileChannel!.simulateOpen();

        service.sendFileComplete('file-1');

        const sent = fileChannel!.getSentMessages();
        expect(sent).toHaveLength(1);
        expect(JSON.parse(sent[0])).toEqual({
          type: 'file_complete',
          fileId: 'file-1',
          fileHash: undefined,
        });
      });

      it('should send file error notification', () => {
        const fileChannel = currentMockPc.getDataChannel('files');
        fileChannel!.simulateOpen();

        service.sendFileError('file-1', 'Transfer failed');

        const sent = fileChannel!.getSentMessages();
        expect(sent).toHaveLength(1);
        expect(JSON.parse(sent[0])).toEqual({
          type: 'file_error',
          fileId: 'file-1',
          error: 'Transfer failed',
        });
      });

      it('should not send file messages when channel is not open', async () => {
        // Channel is in 'connecting' state by default
        const fileChannel = currentMockPc.getDataChannel('files');

        const startResult = service.sendFileStart('file-1', 'test.txt', 1024, 10);
        const chunkResult = await service.sendFileChunk('file-1', 0, 'data');
        service.sendFileComplete('file-1');
        service.sendFileError('file-1', 'error');

        expect(startResult).toBe(false);
        expect(chunkResult).toBe(false);
        expect(fileChannel!.getSentMessages()).toHaveLength(0);
      });
    });

    describe('as responder', () => {
      beforeEach(async () => {
        await service.connect('peer-123', false);
      });

      it('should handle incoming file channel', () => {
        const channel = currentMockPc.simulateIncomingDataChannel('files');
        channel.simulateOpen();

        // Channel should be set up for receiving
      });

      it('should emit file start event', () => {
        const channel = currentMockPc.simulateIncomingDataChannel('files');
        channel.simulateOpen();

        channel.simulateMessage(JSON.stringify({
          type: 'file_start',
          fileId: 'file-1',
          fileName: 'test.txt',
          totalSize: 1024,
          totalChunks: 10,
        }));

        // The handler passes optional chunkHashes as undefined
        expect(events.onFileStart).toHaveBeenCalledWith('file-1', 'test.txt', 1024, 10, undefined);
      });

      it('should emit file chunk event', () => {
        const channel = currentMockPc.simulateIncomingDataChannel('files');
        channel.simulateOpen();

        channel.simulateMessage(JSON.stringify({
          type: 'file_chunk',
          fileId: 'file-1',
          chunkIndex: 5,
          data: 'base64-data',
        }));

        // The handler passes optional hash as undefined
        expect(events.onFileChunk).toHaveBeenCalledWith('file-1', 5, 'base64-data', undefined);
      });

      it('should emit file complete event', () => {
        const channel = currentMockPc.simulateIncomingDataChannel('files');
        channel.simulateOpen();

        channel.simulateMessage(JSON.stringify({
          type: 'file_complete',
          fileId: 'file-1',
        }));

        // The handler passes optional fileHash as undefined
        expect(events.onFileComplete).toHaveBeenCalledWith('file-1', undefined);
      });

      it('should emit file error event', () => {
        const channel = currentMockPc.simulateIncomingDataChannel('files');
        channel.simulateOpen();

        channel.simulateMessage(JSON.stringify({
          type: 'file_error',
          fileId: 'file-1',
          error: 'Transfer failed',
        }));

        expect(events.onFileError).toHaveBeenCalledWith('file-1', 'Transfer failed');
      });

      it('should handle malformed file messages gracefully', () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const channel = currentMockPc.simulateIncomingDataChannel('files');
        channel.simulateOpen();

        channel.simulateMessage('not valid json');

        expect(consoleSpy).toHaveBeenCalledWith(
          '[WebRTC]',
          'Failed to parse file channel message as JSON'
        );
        expect(events.onFileStart).not.toHaveBeenCalled();

        consoleSpy.mockRestore();
      });
    });
  });

  describe('Message size limits', () => {
    it('should reject message channel data over 1MB', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await service.connect('peer-123', true);

      const messageChannel = currentMockPc.getDataChannel('messages');
      messageChannel!.simulateOpen();

      // Create message larger than 1MB
      const largeMessage = 'x'.repeat(1024 * 1024 + 1);
      messageChannel!.simulateMessage(largeMessage);

      expect(consoleSpy).toHaveBeenCalledWith(
        '[WebRTC]',
        'Rejected message channel data: exceeds 1MB size limit'
      );
      expect(events.onMessage).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should reject file channel data over 1MB', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await service.connect('peer-123', false);

      const channel = currentMockPc.simulateIncomingDataChannel('files');
      channel.simulateOpen();

      // Create message larger than 1MB
      const largeMessage = 'x'.repeat(1024 * 1024 + 1);
      channel.simulateMessage(largeMessage);

      expect(consoleSpy).toHaveBeenCalledWith(
        '[WebRTC]',
        'Rejected file channel data: exceeds 1MB size limit'
      );
      expect(events.onFileStart).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should accept messages at exactly 1MB', async () => {
      await service.connect('peer-123', true);

      const messageChannel = currentMockPc.getDataChannel('messages');
      messageChannel!.simulateOpen();

      // Create message at exactly 1MB
      const exactMessage = 'x'.repeat(1024 * 1024);
      messageChannel!.simulateMessage(exactMessage);

      expect(events.onMessage).toHaveBeenCalledWith(exactMessage);
    });
  });

  describe('Channel error handling', () => {
    it('should log message channel errors', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await service.connect('peer-123', true);

      const messageChannel = currentMockPc.getDataChannel('messages');
      messageChannel!.simulateOpen();
      messageChannel!.simulateError();

      expect(consoleSpy).toHaveBeenCalledWith(
        '[WebRTC]',
        'Message channel error'
      );

      consoleSpy.mockRestore();
    });
  });

  describe('Cleanup', () => {
    it('should close all resources on close()', async () => {
      await service.connect('peer-123', true);

      const messageChannel = currentMockPc.getDataChannel('messages');
      const fileChannel = currentMockPc.getDataChannel('files');

      service.close();

      expect(currentMockPc.connectionState).toBe('closed');
      expect(messageChannel!.readyState).toBe('closed');
      expect(fileChannel!.readyState).toBe('closed');
    });

    it('should handle close when not connected', () => {
      // Should not throw
      service.close();
    });

    it('should close existing connection before creating new one', async () => {
      await service.connect('peer-123', true);
      const firstPc = currentMockPc;

      await service.connect('peer-456', false);

      expect(firstPc.connectionState).toBe('closed');
    });

    it('should clear pending candidates on close', async () => {
      // Connect first
      await service.connect('peer-123', true);

      // Queue some candidates (no remote description set yet for initiator)
      await service.handleIceCandidate({ candidate: 'test-1' });
      await service.handleIceCandidate({ candidate: 'test-2' });

      // Close the connection
      service.close();

      // Connect again
      await service.connect('peer-456', false);

      // Queue new candidates after reconnect
      await service.handleIceCandidate({ candidate: 'test-3' });
      await service.handleIceCandidate({ candidate: 'test-4' });

      // Set remote description to process candidates
      await service.handleOffer({ type: 'offer', sdp: 'test-sdp' });

      // Only the candidates added after close should be present
      const added = currentMockPc.getAddedIceCandidates();
      expect(added).toHaveLength(2);
      expect(added).toContainEqual({ candidate: 'test-3' });
      expect(added).toContainEqual({ candidate: 'test-4' });
    });
  });

  describe('Channel ordering', () => {
    it('should create ordered message channel', async () => {
      await service.connect('peer-123', true);

      const messageChannel = currentMockPc.getDataChannel('messages');
      expect(messageChannel!.ordered).toBe(true);
    });

    it('should create ordered file channel', async () => {
      await service.connect('peer-123', true);

      const fileChannel = currentMockPc.getDataChannel('files');
      expect(fileChannel!.ordered).toBe(true);
    });
  });

  describe('Multiple channel labels', () => {
    it('should handle files channel by label', async () => {
      await service.connect('peer-123', false);

      const filesChannel = currentMockPc.simulateIncomingDataChannel('files');
      filesChannel.simulateOpen();

      filesChannel.simulateMessage(JSON.stringify({
        type: 'file_start',
        fileId: 'f1',
        fileName: 'test.txt',
        totalSize: 100,
        totalChunks: 1,
      }));

      expect(events.onFileStart).toHaveBeenCalled();
    });

    it('should ignore unknown channel labels', async () => {
      await service.connect('peer-123', false);

      // Simulate an unknown channel
      currentMockPc.simulateIncomingDataChannel('unknown');

      // Should not throw or affect other channels
      expect(service.messageChannelOpen).toBe(false);
    });
  });

  describe('Console logging', () => {
    it('should log when message channel opens', async () => {
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      await service.connect('peer-123', true);

      const messageChannel = currentMockPc.getDataChannel('messages');
      messageChannel!.simulateOpen();

      expect(consoleSpy).toHaveBeenCalledWith('[WebRTC]', 'Message channel open');

      consoleSpy.mockRestore();
    });
  });
});
