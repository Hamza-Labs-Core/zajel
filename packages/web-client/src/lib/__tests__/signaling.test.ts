/**
 * SignalingClient Tests
 *
 * Tests for WebSocket-based signaling for WebRTC peer connections.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SignalingClient, type SignalingEvents } from '../signaling';

// Mock WebSocket
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

  private sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.sentMessages.push(data);
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

  simulateRawMessage(data: string): void {
    if (this.onmessage) {
      this.onmessage({ data });
    }
  }

  simulateError(): void {
    if (this.onerror) {
      this.onerror(new Event('error'));
    }
  }

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose();
    }
  }

  getSentMessages(): unknown[] {
    return this.sentMessages.map((m) => JSON.parse(m));
  }

  getLastSentMessage(): unknown {
    const messages = this.getSentMessages();
    return messages[messages.length - 1];
  }

  clearSentMessages(): void {
    this.sentMessages = [];
  }
}

// Mock crypto.getRandomValues
const mockGetRandomValues = vi.fn((array: Uint8Array) => {
  for (let i = 0; i < array.length; i++) {
    array[i] = i * 10; // Deterministic values for testing
  }
  return array;
});

describe('SignalingClient', () => {
  let mockWs: MockWebSocket | null = null;
  let client: SignalingClient;
  let events: SignalingEvents;

  beforeEach(() => {
    // Reset mocks
    vi.useFakeTimers();
    mockWs = null;

    // Mock WebSocket constructor
    vi.stubGlobal(
      'WebSocket',
      vi.fn((url: string) => {
        mockWs = new MockWebSocket(url);
        return mockWs;
      })
    );

    // Mock WebSocket static constants
    (globalThis.WebSocket as unknown as typeof MockWebSocket).OPEN = MockWebSocket.OPEN;
    (globalThis.WebSocket as unknown as typeof MockWebSocket).CONNECTING = MockWebSocket.CONNECTING;
    (globalThis.WebSocket as unknown as typeof MockWebSocket).CLOSING = MockWebSocket.CLOSING;
    (globalThis.WebSocket as unknown as typeof MockWebSocket).CLOSED = MockWebSocket.CLOSED;

    // Mock crypto
    vi.stubGlobal('crypto', {
      getRandomValues: mockGetRandomValues,
    });

    // Create mock events
    events = {
      onStateChange: vi.fn(),
      onPairIncoming: vi.fn(),
      onPairMatched: vi.fn(),
      onPairRejected: vi.fn(),
      onPairTimeout: vi.fn(),
      onPairError: vi.fn(),
      onOffer: vi.fn(),
      onAnswer: vi.fn(),
      onIceCandidate: vi.fn(),
      onError: vi.fn(),
    };

    client = new SignalingClient('wss://test.example.com', events);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('Pairing code validation', () => {
    const ALLOWED_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

    it('should accept valid 6-char codes from allowed charset', () => {
      client.connect('test-public-key');
      mockWs!.simulateOpen();
      mockWs!.simulateMessage({ type: 'registered', pairingCode: 'ABC123' });
      mockWs!.clearSentMessages();

      // Valid codes should work
      client.requestPairing('ABC234');
      expect(events.onError).not.toHaveBeenCalled();
      expect(mockWs!.getSentMessages()).toHaveLength(1);
    });

    it('should reject codes with wrong length', () => {
      client.connect('test-public-key');
      mockWs!.simulateOpen();
      mockWs!.simulateMessage({ type: 'registered', pairingCode: 'ABC123' });
      mockWs!.clearSentMessages();

      // Too short
      client.requestPairing('ABC23');
      expect(events.onError).toHaveBeenCalledWith('Invalid pairing code format');
      expect(mockWs!.getSentMessages()).toHaveLength(0);

      vi.mocked(events.onError).mockClear();
      mockWs!.clearSentMessages();

      // Too long
      client.requestPairing('ABC2345');
      expect(events.onError).toHaveBeenCalledWith('Invalid pairing code format');
      expect(mockWs!.getSentMessages()).toHaveLength(0);
    });

    it('should reject codes with invalid characters', () => {
      client.connect('test-public-key');
      mockWs!.simulateOpen();
      mockWs!.simulateMessage({ type: 'registered', pairingCode: 'ABC123' });
      mockWs!.clearSentMessages();

      // Contains 0 (not in allowed charset)
      client.requestPairing('ABC0DE');
      expect(events.onError).toHaveBeenCalledWith('Invalid pairing code format');

      vi.mocked(events.onError).mockClear();
      mockWs!.clearSentMessages();

      // Contains 1 (not in allowed charset)
      client.requestPairing('ABC1DE');
      expect(events.onError).toHaveBeenCalledWith('Invalid pairing code format');

      vi.mocked(events.onError).mockClear();
      mockWs!.clearSentMessages();

      // Contains O (not in allowed charset - letter O, not zero)
      client.requestPairing('ABCODE');
      expect(events.onError).toHaveBeenCalledWith('Invalid pairing code format');

      vi.mocked(events.onError).mockClear();
      mockWs!.clearSentMessages();

      // Contains I (not in allowed charset)
      client.requestPairing('ABCIDE');
      expect(events.onError).toHaveBeenCalledWith('Invalid pairing code format');
    });

    it('should reject lowercase codes', () => {
      client.connect('test-public-key');
      mockWs!.simulateOpen();
      mockWs!.simulateMessage({ type: 'registered', pairingCode: 'ABC123' });
      mockWs!.clearSentMessages();

      client.requestPairing('abc234');
      expect(events.onError).toHaveBeenCalledWith('Invalid pairing code format');
      expect(mockWs!.getSentMessages()).toHaveLength(0);
    });

    it('should validate code in requestPairing before sending', () => {
      client.connect('test-public-key');
      mockWs!.simulateOpen();
      mockWs!.simulateMessage({ type: 'registered', pairingCode: 'ABC123' });
      mockWs!.clearSentMessages();

      // Invalid code - should not send message
      client.requestPairing('invalid');
      expect(mockWs!.getSentMessages()).toHaveLength(0);
      expect(events.onError).toHaveBeenCalledWith('Invalid pairing code format');

      vi.mocked(events.onError).mockClear();

      // Valid code - should send message
      client.requestPairing('ABC234');
      expect(mockWs!.getSentMessages()).toHaveLength(1);
      expect(events.onError).not.toHaveBeenCalled();
    });

    it('should validate code in respondToPairing before sending', () => {
      client.connect('test-public-key');
      mockWs!.simulateOpen();
      mockWs!.simulateMessage({ type: 'registered', pairingCode: 'ABC123' });
      mockWs!.clearSentMessages();

      // Invalid code - should not send message
      client.respondToPairing('bad', true);
      expect(mockWs!.getSentMessages()).toHaveLength(0);
      expect(events.onError).toHaveBeenCalledWith('Invalid pairing code format');

      vi.mocked(events.onError).mockClear();

      // Valid code - should send message
      client.respondToPairing('ABC234', true);
      expect(mockWs!.getSentMessages()).toHaveLength(1);
      expect(events.onError).not.toHaveBeenCalled();
    });
  });

  describe('Connection state management', () => {
    it('should have initial state as disconnected', () => {
      expect(client.connectionState).toBe('disconnected');
    });

    it('should change state to connecting on connect', () => {
      client.connect('test-public-key');
      expect(events.onStateChange).toHaveBeenCalledWith('connecting');
      expect(client.connectionState).toBe('connecting');
    });

    it('should change state to registered after successful registration', () => {
      client.connect('test-public-key');
      mockWs!.simulateOpen();
      mockWs!.simulateMessage({ type: 'registered', pairingCode: 'ABC123' });

      expect(events.onStateChange).toHaveBeenCalledWith('registered');
      expect(client.connectionState).toBe('registered');
    });

    it('should change state to disconnected on disconnect', () => {
      client.connect('test-public-key');
      mockWs!.simulateOpen();
      mockWs!.simulateMessage({ type: 'registered', pairingCode: 'ABC123' });

      client.disconnect();

      expect(events.onStateChange).toHaveBeenCalledWith('disconnected');
      expect(client.connectionState).toBe('disconnected');
    });

    it('should return generated pairing code via getter', () => {
      client.connect('test-public-key');

      // The code is generated from mocked crypto.getRandomValues
      // With deterministic mock values [0, 10, 20, 30, 40, 50]
      // Each value % 32 (charset length) gives indices into PAIRING_CODE_CHARS
      const code = client.pairingCode;
      expect(code).toHaveLength(6);
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    });
  });

  describe('Message handling', () => {
    beforeEach(() => {
      client.connect('test-public-key');
      mockWs!.simulateOpen();
    });

    it('should reject messages over 1MB size limit', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Create a message larger than 1MB
      const largeData = 'x'.repeat(1024 * 1024 + 1);
      mockWs!.simulateRawMessage(largeData);

      expect(consoleSpy).toHaveBeenCalledWith(
        'Rejected WebSocket message: exceeds 1MB size limit'
      );

      consoleSpy.mockRestore();
    });

    it('should handle registered message', () => {
      mockWs!.simulateMessage({ type: 'registered', pairingCode: 'ABC123' });

      expect(events.onStateChange).toHaveBeenCalledWith('registered');
      expect(client.connectionState).toBe('registered');
    });

    it('should handle pair_incoming message', () => {
      mockWs!.simulateMessage({
        type: 'pair_incoming',
        fromCode: 'XYZ789',
        fromPublicKey: 'peer-public-key',
      });

      expect(events.onStateChange).toHaveBeenCalledWith('pending_approval');
      expect(events.onPairIncoming).toHaveBeenCalledWith('XYZ789', 'peer-public-key');
    });

    it('should handle pair_matched message', () => {
      mockWs!.simulateMessage({
        type: 'pair_matched',
        peerCode: 'XYZ789',
        peerPublicKey: 'peer-public-key',
        isInitiator: true,
      });

      expect(events.onStateChange).toHaveBeenCalledWith('matched');
      expect(events.onPairMatched).toHaveBeenCalledWith(
        'XYZ789',
        'peer-public-key',
        true
      );
    });

    it('should handle pair_rejected message', () => {
      mockWs!.simulateMessage({ type: 'registered', pairingCode: 'ABC123' });
      vi.mocked(events.onStateChange).mockClear();

      mockWs!.simulateMessage({
        type: 'pair_rejected',
        peerCode: 'XYZ789',
      });

      expect(events.onStateChange).toHaveBeenCalledWith('registered');
      expect(events.onPairRejected).toHaveBeenCalledWith('XYZ789');
    });

    it('should handle pair_timeout message', () => {
      mockWs!.simulateMessage({ type: 'registered', pairingCode: 'ABC123' });
      vi.mocked(events.onStateChange).mockClear();

      mockWs!.simulateMessage({
        type: 'pair_timeout',
        peerCode: 'XYZ789',
      });

      expect(events.onStateChange).toHaveBeenCalledWith('registered');
      expect(events.onPairTimeout).toHaveBeenCalledWith('XYZ789');
    });

    it('should handle pair_error message', () => {
      mockWs!.simulateMessage({ type: 'registered', pairingCode: 'ABC123' });
      vi.mocked(events.onStateChange).mockClear();

      mockWs!.simulateMessage({
        type: 'pair_error',
        error: 'Target not found',
      });

      expect(events.onStateChange).toHaveBeenCalledWith('registered');
      expect(events.onPairError).toHaveBeenCalledWith('Target not found');
    });

    it('should handle offer message', () => {
      const offer: RTCSessionDescriptionInit = { type: 'offer', sdp: 'test-sdp' };
      mockWs!.simulateMessage({
        type: 'offer',
        from: 'XYZ789',
        payload: offer,
      });

      expect(events.onOffer).toHaveBeenCalledWith('XYZ789', offer);
    });

    it('should handle answer message', () => {
      const answer: RTCSessionDescriptionInit = { type: 'answer', sdp: 'test-sdp' };
      mockWs!.simulateMessage({
        type: 'answer',
        from: 'XYZ789',
        payload: answer,
      });

      expect(events.onAnswer).toHaveBeenCalledWith('XYZ789', answer);
    });

    it('should handle ice_candidate message', () => {
      const candidate: RTCIceCandidateInit = { candidate: 'test-candidate' };
      mockWs!.simulateMessage({
        type: 'ice_candidate',
        from: 'XYZ789',
        payload: candidate,
      });

      expect(events.onIceCandidate).toHaveBeenCalledWith('XYZ789', candidate);
    });

    it('should handle error message', () => {
      mockWs!.simulateMessage({
        type: 'error',
        message: 'Something went wrong',
      });

      expect(events.onError).toHaveBeenCalledWith('Something went wrong');
    });

    it('should handle pong message silently', () => {
      // pong is a keepalive response, should not trigger any callbacks
      mockWs!.simulateMessage({ type: 'pong' });

      // Only state change from registered should have been called
      expect(events.onError).not.toHaveBeenCalled();
      expect(events.onPairMatched).not.toHaveBeenCalled();
    });

    it('should handle malformed JSON gracefully', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockWs!.simulateRawMessage('not valid json');

      expect(consoleSpy).toHaveBeenCalled();
      expect(events.onError).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('WebSocket lifecycle', () => {
    it('should schedule reconnect on unexpected disconnect', () => {
      client.connect('test-public-key');
      mockWs!.simulateOpen();
      mockWs!.simulateMessage({ type: 'registered', pairingCode: 'ABC123' });

      // Simulate unexpected close
      mockWs!.simulateClose();

      expect(events.onStateChange).toHaveBeenCalledWith('disconnected');

      // Should schedule reconnect (3 second delay)
      vi.advanceTimersByTime(3000);

      // A new WebSocket should be created
      expect(WebSocket).toHaveBeenCalledTimes(2);
    });

    it('should not reconnect after explicit disconnect', () => {
      client.connect('test-public-key');
      mockWs!.simulateOpen();
      mockWs!.simulateMessage({ type: 'registered', pairingCode: 'ABC123' });

      // Explicit disconnect
      client.disconnect();

      // Advance timers past reconnect delay
      vi.advanceTimersByTime(5000);

      // Should only have the initial connection
      expect(WebSocket).toHaveBeenCalledTimes(1);
    });

    it('should stop ping on disconnect', () => {
      client.connect('test-public-key');
      mockWs!.simulateOpen();
      mockWs!.clearSentMessages();

      // Verify ping is being sent
      vi.advanceTimersByTime(25000);
      const messages = mockWs!.getSentMessages();
      expect(messages.some((m) => (m as { type: string }).type === 'ping')).toBe(true);

      mockWs!.clearSentMessages();

      // Disconnect
      client.disconnect();

      // Create a fresh mock for checking no more pings
      const oldWs = mockWs;

      // Try to advance time - should not send more pings
      vi.advanceTimersByTime(50000);

      // No new messages should be sent since we disconnected
      expect(oldWs!.getSentMessages()).toHaveLength(0);
    });

    it('should send ping every 25 seconds', () => {
      client.connect('test-public-key');
      mockWs!.simulateOpen();
      mockWs!.clearSentMessages();

      // First ping at 25 seconds
      vi.advanceTimersByTime(25000);
      let messages = mockWs!.getSentMessages();
      expect(messages.filter((m) => (m as { type: string }).type === 'ping')).toHaveLength(1);

      // Second ping at 50 seconds
      vi.advanceTimersByTime(25000);
      messages = mockWs!.getSentMessages();
      expect(messages.filter((m) => (m as { type: string }).type === 'ping')).toHaveLength(2);
    });

    it('should register with pairing code and public key on connect', () => {
      client.connect('my-public-key');
      mockWs!.simulateOpen();

      const messages = mockWs!.getSentMessages();
      const registerMsg = messages.find(
        (m) => (m as { type: string }).type === 'register'
      ) as { type: string; pairingCode: string; publicKey: string } | undefined;

      expect(registerMsg).toBeDefined();
      expect(registerMsg!.publicKey).toBe('my-public-key');
      expect(registerMsg!.pairingCode).toHaveLength(6);
    });

    it('should close existing connection before creating new one', () => {
      client.connect('test-public-key');
      const firstWs = mockWs;
      mockWs!.simulateOpen();

      // Connect again
      client.connect('test-public-key-2');

      expect(firstWs!.readyState).toBe(MockWebSocket.CLOSED);
      expect(WebSocket).toHaveBeenCalledTimes(2);
    });

    it('should handle WebSocket error', () => {
      client.connect('test-public-key');
      mockWs!.simulateOpen();

      mockWs!.simulateError();

      expect(events.onError).toHaveBeenCalledWith('Connection error');
    });
  });

  describe('Pairing workflow', () => {
    beforeEach(() => {
      client.connect('test-public-key');
      mockWs!.simulateOpen();
      mockWs!.simulateMessage({ type: 'registered', pairingCode: 'ABC123' });
      mockWs!.clearSentMessages();
    });

    it('should send pair_request and update state to waiting_approval', () => {
      client.requestPairing('XYZ789');

      const messages = mockWs!.getSentMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'pair_request',
        targetCode: 'XYZ789',
      });
      expect(events.onStateChange).toHaveBeenCalledWith('waiting_approval');
    });

    it('should send pair_response with accepted=true', () => {
      client.respondToPairing('XYZ789', true);

      const messages = mockWs!.getSentMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'pair_response',
        targetCode: 'XYZ789',
        accepted: true,
      });
    });

    it('should send pair_response with accepted=false and reset state', () => {
      // First get into pending_approval state
      mockWs!.simulateMessage({
        type: 'pair_incoming',
        fromCode: 'XYZ789',
        fromPublicKey: 'peer-key',
      });
      vi.mocked(events.onStateChange).mockClear();
      mockWs!.clearSentMessages();

      client.respondToPairing('XYZ789', false);

      const messages = mockWs!.getSentMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'pair_response',
        targetCode: 'XYZ789',
        accepted: false,
      });
      expect(events.onStateChange).toHaveBeenCalledWith('registered');
    });
  });

  describe('WebRTC signaling methods', () => {
    beforeEach(() => {
      client.connect('test-public-key');
      mockWs!.simulateOpen();
      mockWs!.clearSentMessages();
    });

    it('should send offer message', () => {
      const offer: RTCSessionDescriptionInit = { type: 'offer', sdp: 'test-offer-sdp' };
      client.sendOffer('XYZ789', offer);

      expect(mockWs!.getLastSentMessage()).toEqual({
        type: 'offer',
        target: 'XYZ789',
        payload: offer,
      });
    });

    it('should send answer message', () => {
      const answer: RTCSessionDescriptionInit = { type: 'answer', sdp: 'test-answer-sdp' };
      client.sendAnswer('XYZ789', answer);

      expect(mockWs!.getLastSentMessage()).toEqual({
        type: 'answer',
        target: 'XYZ789',
        payload: answer,
      });
    });

    it('should send ICE candidate message', () => {
      const candidate: RTCIceCandidateInit = {
        candidate: 'candidate:123',
        sdpMid: '0',
        sdpMLineIndex: 0,
      };
      client.sendIceCandidate('XYZ789', candidate);

      expect(mockWs!.getLastSentMessage()).toEqual({
        type: 'ice_candidate',
        target: 'XYZ789',
        payload: candidate,
      });
    });

    it('should not send when WebSocket is not open', () => {
      client.disconnect();
      mockWs!.clearSentMessages();

      client.sendOffer('XYZ789', { type: 'offer', sdp: 'test' });

      expect(mockWs!.getSentMessages()).toHaveLength(0);
    });
  });
});
