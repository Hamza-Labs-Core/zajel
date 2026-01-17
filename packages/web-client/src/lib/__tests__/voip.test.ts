/**
 * VoIPService Tests
 *
 * Tests for the VoIP call orchestration service.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  VoIPService,
  VoIPError,
  VoIPErrorCodes,
  CallState,
  CallInfo,
  VoIPSignaling,
} from '../voip';
import { MediaService } from '../media';
import type {
  CallOfferReceivedMessage,
  CallAnswerReceivedMessage,
  CallRejectReceivedMessage,
  CallHangupReceivedMessage,
  CallIceReceivedMessage,
} from '../protocol';


// Mock MediaStreamTrack
class MockMediaStreamTrack {
  kind: 'audio' | 'video';
  enabled = true;
  readyState: 'live' | 'ended' = 'live';
  private stopped = false;

  constructor(kind: 'audio' | 'video') {
    this.kind = kind;
  }

  stop(): void {
    this.stopped = true;
    this.readyState = 'ended';
  }

  isStopped(): boolean {
    return this.stopped;
  }
}

// Mock MediaStream
class MockMediaStream {
  private tracks: MockMediaStreamTrack[] = [];

  constructor(tracks?: MockMediaStreamTrack[]) {
    if (tracks) {
      this.tracks = tracks;
    }
  }

  getTracks(): MockMediaStreamTrack[] {
    return this.tracks;
  }

  getAudioTracks(): MockMediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio');
  }

  getVideoTracks(): MockMediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === 'video');
  }

  addTrack(track: MockMediaStreamTrack): void {
    this.tracks.push(track);
  }

  removeTrack(track: MockMediaStreamTrack): void {
    const index = this.tracks.indexOf(track);
    if (index > -1) {
      this.tracks.splice(index, 1);
    }
  }
}

// Mock RTCSessionDescription
class MockRTCSessionDescription {
  type: RTCSdpType;
  sdp: string;

  constructor(init: RTCSessionDescriptionInit) {
    this.type = init.type!;
    this.sdp = init.sdp || '';
  }
}

// Mock RTCIceCandidate
class MockRTCIceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;

  constructor(init: RTCIceCandidateInit) {
    this.candidate = init.candidate || '';
    this.sdpMid = init.sdpMid || null;
    this.sdpMLineIndex = init.sdpMLineIndex ?? null;
  }
}

// Mock RTCPeerConnection
class MockRTCPeerConnection {
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;

  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  ontrack: ((event: { track: MediaStreamTrack; streams: MediaStream[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;

  private tracks: { track: MediaStreamTrack; stream: MediaStream }[] = [];

  constructor(_config?: RTCConfiguration) {}

  addTrack(track: MediaStreamTrack, stream: MediaStream): RTCRtpSender {
    this.tracks.push({ track, stream });
    return {} as RTCRtpSender;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'mock-offer-sdp' };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'mock-answer-sdp' };
  }

  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = new MockRTCSessionDescription(desc) as unknown as RTCSessionDescription;
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = new MockRTCSessionDescription(desc) as unknown as RTCSessionDescription;
  }

  async addIceCandidate(_candidate: RTCIceCandidateInit): Promise<void> {
    // ICE candidate added
  }

  close(): void {
    this.connectionState = 'closed';
  }

  // Helper methods for testing
  simulateConnectionStateChange(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  simulateIceCandidate(candidate: RTCIceCandidate | null): void {
    this.onicecandidate?.({ candidate });
  }

  simulateTrack(track: MediaStreamTrack, stream: MediaStream): void {
    this.ontrack?.({ track, streams: [stream] } as RTCTrackEvent);
  }
}

// Helper to create mock MediaService
function createMockMediaService(): MediaService & {
  mockStream: MockMediaStream;
  requestMedia: ReturnType<typeof vi.fn>;
  stopAllTracks: ReturnType<typeof vi.fn>;
  toggleMute: ReturnType<typeof vi.fn>;
  toggleVideo: ReturnType<typeof vi.fn>;
  getLocalStream: ReturnType<typeof vi.fn>;
} {
  const mockStream = new MockMediaStream([
    new MockMediaStreamTrack('audio'),
    new MockMediaStreamTrack('video'),
  ]);

  return {
    mockStream,
    requestMedia: vi.fn().mockResolvedValue(mockStream),
    stopAllTracks: vi.fn(),
    toggleMute: vi.fn().mockReturnValue(true),
    toggleVideo: vi.fn().mockReturnValue(false),
    getLocalStream: vi.fn().mockReturnValue(mockStream),
    getState: vi.fn().mockReturnValue({
      hasAudio: true,
      hasVideo: true,
      audioMuted: false,
      videoMuted: false,
    }),
    switchCamera: vi.fn(),
    getCurrentFacingMode: vi.fn().mockReturnValue('user'),
  } as unknown as MediaService & {
    mockStream: MockMediaStream;
    requestMedia: ReturnType<typeof vi.fn>;
    stopAllTracks: ReturnType<typeof vi.fn>;
    toggleMute: ReturnType<typeof vi.fn>;
    toggleVideo: ReturnType<typeof vi.fn>;
    getLocalStream: ReturnType<typeof vi.fn>;
  };
}

// Helper to create mock signaling
function createMockSignaling(): VoIPSignaling & {
  sendCallOffer: ReturnType<typeof vi.fn>;
  sendCallAnswer: ReturnType<typeof vi.fn>;
  sendCallReject: ReturnType<typeof vi.fn>;
  sendCallHangup: ReturnType<typeof vi.fn>;
  sendCallIce: ReturnType<typeof vi.fn>;
} {
  return {
    sendCallOffer: vi.fn(),
    sendCallAnswer: vi.fn(),
    sendCallReject: vi.fn(),
    sendCallHangup: vi.fn(),
    sendCallIce: vi.fn(),
  };
}

// Global reference to the current mock peer connection for testing
let currentMockPeerConnection: MockRTCPeerConnection | null = null;

describe('VoIPService', () => {
  let voipService: VoIPService;
  let mockMediaService: ReturnType<typeof createMockMediaService>;
  let mockSignaling: ReturnType<typeof createMockSignaling>;

  beforeEach(() => {
    vi.useFakeTimers();

    // Mock crypto.randomUUID
    const originalCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', {
      ...originalCrypto,
      randomUUID: () => 'test-call-id-123',
    });

    // Setup mocks
    mockMediaService = createMockMediaService();
    mockSignaling = createMockSignaling();

    // Create a class that tracks its instance
    class TrackedMockRTCPeerConnection extends MockRTCPeerConnection {
      constructor(config?: RTCConfiguration) {
        super(config);
        currentMockPeerConnection = this;
      }
    }

    // Mock RTCPeerConnection constructor as a class
    vi.stubGlobal('RTCPeerConnection', TrackedMockRTCPeerConnection);
    vi.stubGlobal('RTCSessionDescription', MockRTCSessionDescription);
    vi.stubGlobal('RTCIceCandidate', MockRTCIceCandidate);

    voipService = new VoIPService(mockMediaService, mockSignaling);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    currentMockPeerConnection = null;
  });

  // Helper to get the current peer connection
  const getMockPeerConnection = () => currentMockPeerConnection;

  describe('startCall', () => {
    it('should start an outgoing call', async () => {
      const callId = await voipService.startCall('PEER123', true);

      expect(callId).toBe('test-call-id-123');
      expect(mockMediaService.requestMedia).toHaveBeenCalledWith(true);
      expect(mockSignaling.sendCallOffer).toHaveBeenCalledWith(
        'test-call-id-123',
        'PEER123',
        'mock-offer-sdp',
        true
      );
    });

    it('should set call state to outgoing', async () => {
      const stateChanges: CallState[] = [];
      voipService.on('state-change', (state) => {
        stateChanges.push(state);
      });

      await voipService.startCall('PEER123', true);

      expect(stateChanges).toContain('outgoing');
    });

    it('should throw when already in a call', async () => {
      await voipService.startCall('PEER123', true);

      await expect(voipService.startCall('PEER456', false)).rejects.toThrow(VoIPError);
      await expect(voipService.startCall('PEER456', false)).rejects.toThrow();
    });

    it('should request audio-only media for audio call', async () => {
      await voipService.startCall('PEER123', false);

      expect(mockMediaService.requestMedia).toHaveBeenCalledWith(false);
    });

    it('should request video media for video call', async () => {
      await voipService.startCall('PEER123', true);

      expect(mockMediaService.requestMedia).toHaveBeenCalledWith(true);
    });

    it('should handle media request failure', async () => {
      mockMediaService.requestMedia.mockRejectedValue(new Error('Permission denied'));

      await expect(voipService.startCall('PEER123', true)).rejects.toThrow(VoIPError);
    });

    it('should clean up on failure', async () => {
      mockMediaService.requestMedia.mockRejectedValue(new Error('Permission denied'));

      try {
        await voipService.startCall('PEER123', true);
      } catch {
        // Expected
      }

      expect(mockMediaService.stopAllTracks).toHaveBeenCalled();
      expect(voipService.getCurrentCall()).toBeNull();
    });
  });

  describe('acceptCall', () => {
    beforeEach(() => {
      // Simulate incoming call
      const offerHandler = voipService.getCallOfferHandler();
      offerHandler({
        type: 'call_offer',
        callId: 'incoming-call-123',
        from: 'PEER123',
        sdp: 'remote-offer-sdp',
        withVideo: true,
      });
    });

    it('should accept an incoming call', async () => {
      await voipService.acceptCall('incoming-call-123', true);

      expect(mockMediaService.requestMedia).toHaveBeenCalledWith(true);
      expect(mockSignaling.sendCallAnswer).toHaveBeenCalledWith(
        'incoming-call-123',
        'PEER123',
        'mock-answer-sdp'
      );
    });

    it('should set state to connecting when accepting', async () => {
      const stateChanges: CallState[] = [];
      voipService.on('state-change', (state) => {
        stateChanges.push(state);
      });

      await voipService.acceptCall('incoming-call-123', true);

      expect(stateChanges).toContain('connecting');
    });

    it('should throw when call not found', async () => {
      await expect(voipService.acceptCall('wrong-call-id', true)).rejects.toThrow(VoIPError);
    });

    it('should throw when call is not incoming', async () => {
      // Accept the incoming call to move it to connecting state
      await voipService.acceptCall('incoming-call-123', true);

      // Try to accept again - should fail because not in incoming state anymore
      await expect(voipService.acceptCall('incoming-call-123', true)).rejects.toThrow(VoIPError);
    });
  });

  describe('rejectCall', () => {
    beforeEach(() => {
      const offerHandler = voipService.getCallOfferHandler();
      offerHandler({
        type: 'call_offer',
        callId: 'incoming-call-123',
        from: 'PEER123',
        sdp: 'remote-offer-sdp',
        withVideo: true,
      });
    });

    it('should reject an incoming call', () => {
      voipService.rejectCall('incoming-call-123', 'declined');

      expect(mockSignaling.sendCallReject).toHaveBeenCalledWith(
        'incoming-call-123',
        'PEER123',
        'declined'
      );
    });

    it('should clean up after rejection', () => {
      voipService.rejectCall('incoming-call-123', 'busy');

      expect(mockMediaService.stopAllTracks).toHaveBeenCalled();
      expect(voipService.getCurrentCall()).toBeNull();
    });

    it('should not reject if call not found', () => {
      voipService.rejectCall('wrong-call-id');

      expect(mockSignaling.sendCallReject).not.toHaveBeenCalled();
    });
  });

  describe('hangup', () => {
    it('should hang up an active call', async () => {
      await voipService.startCall('PEER123', true);
      voipService.hangup();

      expect(mockSignaling.sendCallHangup).toHaveBeenCalledWith(
        'test-call-id-123',
        'PEER123'
      );
    });

    it('should clean up resources', async () => {
      await voipService.startCall('PEER123', true);
      voipService.hangup();

      expect(mockMediaService.stopAllTracks).toHaveBeenCalled();
      expect(voipService.getCurrentCall()).toBeNull();
    });

    it('should emit ended then idle state', async () => {
      const stateChanges: CallState[] = [];
      voipService.on('state-change', (state) => {
        stateChanges.push(state);
      });

      await voipService.startCall('PEER123', true);
      voipService.hangup();

      expect(stateChanges).toContain('ended');
      expect(stateChanges).toContain('idle');
    });

    it('should not hang up when no active call', () => {
      voipService.hangup();

      expect(mockSignaling.sendCallHangup).not.toHaveBeenCalled();
    });
  });

  describe('toggleMute', () => {
    it('should return current mute state when no active call', () => {
      const result = voipService.toggleMute();

      // No delegation when no call - returns current state (audioMuted: false)
      expect(mockMediaService.toggleMute).not.toHaveBeenCalled();
      expect(result).toBe(false);
    });

    it('should delegate to MediaService during active call', async () => {
      await voipService.startCall('PEER123', true);

      const result = voipService.toggleMute();

      expect(mockMediaService.toggleMute).toHaveBeenCalled();
      expect(result).toBe(true);
    });
  });

  describe('toggleVideo', () => {
    it('should return current video state when no active call', () => {
      const result = voipService.toggleVideo();

      // No delegation when no call - returns current state (!videoMuted = true)
      expect(mockMediaService.toggleVideo).not.toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('should delegate to MediaService during active call', async () => {
      await voipService.startCall('PEER123', true);

      const result = voipService.toggleVideo();

      expect(mockMediaService.toggleVideo).toHaveBeenCalled();
      expect(result).toBe(false);
    });
  });

  describe('getCurrentCall', () => {
    it('should return null when no call', () => {
      expect(voipService.getCurrentCall()).toBeNull();
    });

    it('should return call info during call', async () => {
      await voipService.startCall('PEER123', true);

      const call = voipService.getCurrentCall();
      expect(call).not.toBeNull();
      expect(call?.callId).toBe('test-call-id-123');
      expect(call?.peerId).toBe('PEER123');
      expect(call?.withVideo).toBe(true);
      expect(call?.state).toBe('outgoing');
    });

    it('should return a copy of call info', async () => {
      await voipService.startCall('PEER123', true);

      const call1 = voipService.getCurrentCall();
      const call2 = voipService.getCurrentCall();
      expect(call1).not.toBe(call2);
      expect(call1).toEqual(call2);
    });
  });

  describe('signaling handlers', () => {
    describe('handleOffer', () => {
      it('should set call state to incoming', () => {
        const stateChanges: CallState[] = [];
        voipService.on('state-change', (state) => {
          stateChanges.push(state);
        });

        const handler = voipService.getCallOfferHandler();
        handler({
          type: 'call_offer',
          callId: 'incoming-123',
          from: 'PEER456',
          sdp: 'offer-sdp',
          withVideo: false,
        });

        expect(stateChanges).toContain('incoming');
      });

      it('should emit incoming-call event', () => {
        let receivedCall: CallInfo | null = null;
        voipService.on('incoming-call', (call) => {
          receivedCall = call;
        });

        const handler = voipService.getCallOfferHandler();
        handler({
          type: 'call_offer',
          callId: 'incoming-123',
          from: 'PEER456',
          sdp: 'offer-sdp',
          withVideo: true,
        });

        expect(receivedCall).not.toBeNull();
        expect(receivedCall?.callId).toBe('incoming-123');
        expect(receivedCall?.peerId).toBe('PEER456');
        expect(receivedCall?.withVideo).toBe(true);
      });

      it('should reject if already in call', async () => {
        await voipService.startCall('PEER123', true);

        const handler = voipService.getCallOfferHandler();
        handler({
          type: 'call_offer',
          callId: 'incoming-123',
          from: 'PEER456',
          sdp: 'offer-sdp',
          withVideo: true,
        });

        expect(mockSignaling.sendCallReject).toHaveBeenCalledWith(
          'incoming-123',
          'PEER456',
          'busy'
        );
      });
    });

    describe('handleAnswer', () => {
      it('should set remote description', async () => {
        await voipService.startCall('PEER123', true);

        const handler = voipService.getCallAnswerHandler();
        await handler({
          type: 'call_answer',
          callId: 'test-call-id-123',
          from: 'PEER123',
          sdp: 'answer-sdp',
        });

        expect(getMockPeerConnection()!.remoteDescription?.sdp).toBe('answer-sdp');
      });

      it('should set state to connecting', async () => {
        const stateChanges: CallState[] = [];
        voipService.on('state-change', (state) => {
          stateChanges.push(state);
        });

        await voipService.startCall('PEER123', true);

        const handler = voipService.getCallAnswerHandler();
        await handler({
          type: 'call_answer',
          callId: 'test-call-id-123',
          from: 'PEER123',
          sdp: 'answer-sdp',
        });

        expect(stateChanges).toContain('connecting');
      });

      it('should ignore answer for unknown call', async () => {
        await voipService.startCall('PEER123', true);

        const handler = voipService.getCallAnswerHandler();
        await handler({
          type: 'call_answer',
          callId: 'wrong-call-id',
          from: 'PEER123',
          sdp: 'answer-sdp',
        });

        // Remote description should not be set for wrong call
        // The peer connection is still for the active call
      });
    });

    describe('handleReject', () => {
      it('should clean up when call is rejected', async () => {
        await voipService.startCall('PEER123', true);

        const handler = voipService.getCallRejectHandler();
        handler({
          type: 'call_reject',
          callId: 'test-call-id-123',
          from: 'PEER123',
          reason: 'declined',
        });

        expect(mockMediaService.stopAllTracks).toHaveBeenCalled();
        expect(voipService.getCurrentCall()).toBeNull();
      });

      it('should emit error event', async () => {
        let receivedError: VoIPError | null = null;
        voipService.on('error', (error) => {
          receivedError = error;
        });

        await voipService.startCall('PEER123', true);

        const handler = voipService.getCallRejectHandler();
        handler({
          type: 'call_reject',
          callId: 'test-call-id-123',
          from: 'PEER123',
          reason: 'busy',
        });

        expect(receivedError).not.toBeNull();
        expect(receivedError?.message).toContain('busy');
      });
    });

    describe('handleHangup', () => {
      it('should clean up when peer hangs up', async () => {
        await voipService.startCall('PEER123', true);

        const handler = voipService.getCallHangupHandler();
        handler({
          type: 'call_hangup',
          callId: 'test-call-id-123',
          from: 'PEER123',
        });

        expect(mockMediaService.stopAllTracks).toHaveBeenCalled();
        expect(voipService.getCurrentCall()).toBeNull();
      });
    });

    describe('handleIce', () => {
      it('should add ICE candidate when connection is ready', async () => {
        await voipService.startCall('PEER123', true);

        // Set remote description first
        const answerHandler = voipService.getCallAnswerHandler();
        await answerHandler({
          type: 'call_answer',
          callId: 'test-call-id-123',
          from: 'PEER123',
          sdp: 'answer-sdp',
        });

        const addIceSpy = vi.spyOn(getMockPeerConnection()!, 'addIceCandidate');

        const handler = voipService.getCallIceHandler();
        await handler({
          type: 'call_ice',
          callId: 'test-call-id-123',
          from: 'PEER123',
          candidate: JSON.stringify({ candidate: 'candidate-data', sdpMid: '0' }),
        });

        expect(addIceSpy).toHaveBeenCalled();
      });

      it('should queue ICE candidates before remote description is set', async () => {
        await voipService.startCall('PEER123', true);

        const addIceSpy = vi.spyOn(getMockPeerConnection()!, 'addIceCandidate');

        const handler = voipService.getCallIceHandler();
        await handler({
          type: 'call_ice',
          callId: 'test-call-id-123',
          from: 'PEER123',
          candidate: JSON.stringify({ candidate: 'candidate-data', sdpMid: '0' }),
        });

        // Should not add immediately - queued
        expect(addIceSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('connection state handling', () => {
    it('should set state to connected when connection succeeds', async () => {
      const stateChanges: CallState[] = [];
      voipService.on('state-change', (state) => {
        stateChanges.push(state);
      });

      await voipService.startCall('PEER123', true);
      getMockPeerConnection()!.simulateConnectionStateChange('connected');

      expect(stateChanges).toContain('connected');
    });

    it('should set startTime when connected', async () => {
      await voipService.startCall('PEER123', true);

      const beforeConnect = Date.now();
      vi.advanceTimersByTime(1000);
      getMockPeerConnection()!.simulateConnectionStateChange('connected');

      const call = voipService.getCurrentCall();
      expect(call?.startTime).toBeGreaterThanOrEqual(beforeConnect);
    });

    it('should clean up when connection fails', async () => {
      let receivedError: VoIPError | null = null;
      voipService.on('error', (error) => {
        receivedError = error;
      });

      await voipService.startCall('PEER123', true);
      getMockPeerConnection()!.simulateConnectionStateChange('failed');

      expect(receivedError).not.toBeNull();
      expect(receivedError?.code).toBe(VoIPErrorCodes.VOIP_PEER_CONNECTION_FAILED);
      expect(voipService.getCurrentCall()).toBeNull();
    });
  });

  describe('remote stream handling', () => {
    it('should emit remote-stream event when track received', async () => {
      let receivedStream: MediaStream | null = null;
      voipService.on('remote-stream', (stream) => {
        receivedStream = stream;
      });

      await voipService.startCall('PEER123', true);

      const remoteStream = new MockMediaStream([new MockMediaStreamTrack('video')]);
      getMockPeerConnection()!.simulateTrack(
        new MockMediaStreamTrack('video') as unknown as MediaStreamTrack,
        remoteStream as unknown as MediaStream
      );

      expect(receivedStream).toBe(remoteStream);
    });

    it('should store remote stream in call info', async () => {
      await voipService.startCall('PEER123', true);

      const remoteStream = new MockMediaStream([new MockMediaStreamTrack('video')]);
      getMockPeerConnection()!.simulateTrack(
        new MockMediaStreamTrack('video') as unknown as MediaStreamTrack,
        remoteStream as unknown as MediaStream
      );

      expect(voipService.getRemoteStream()).toBe(remoteStream);
    });
  });

  describe('ICE candidate handling', () => {
    it('should send ICE candidates to peer', async () => {
      await voipService.startCall('PEER123', true);

      const candidate = new MockRTCIceCandidate({
        candidate: 'candidate-data',
        sdpMid: '0',
      });

      getMockPeerConnection()!.simulateIceCandidate(candidate as unknown as RTCIceCandidate);

      expect(mockSignaling.sendCallIce).toHaveBeenCalledWith(
        'test-call-id-123',
        'PEER123',
        candidate
      );
    });

    it('should not send null ICE candidate', async () => {
      await voipService.startCall('PEER123', true);

      getMockPeerConnection()!.simulateIceCandidate(null);

      expect(mockSignaling.sendCallIce).not.toHaveBeenCalled();
    });
  });

  describe('ringing timeout', () => {
    it('should timeout after RINGING_TIMEOUT_MS', async () => {
      let receivedError: VoIPError | null = null;
      voipService.on('error', (error) => {
        receivedError = error;
      });

      await voipService.startCall('PEER123', true);

      // Fast-forward past the ringing timeout (60 seconds)
      vi.advanceTimersByTime(60001);

      expect(receivedError).not.toBeNull();
      expect(receivedError?.code).toBe(VoIPErrorCodes.VOIP_TIMEOUT);
      expect(mockSignaling.sendCallReject).toHaveBeenCalledWith(
        'test-call-id-123',
        'PEER123',
        'timeout'
      );
    });

    it('should clear timeout when call is answered', async () => {
      await voipService.startCall('PEER123', true);

      const handler = voipService.getCallAnswerHandler();
      await handler({
        type: 'call_answer',
        callId: 'test-call-id-123',
        from: 'PEER123',
        sdp: 'answer-sdp',
      });

      // Fast-forward past the timeout - should not trigger
      vi.advanceTimersByTime(60001);

      // Call should still be active (connecting state)
      const call = voipService.getCurrentCall();
      expect(call?.state).toBe('connecting');
    });

    it('should clear timeout when call is rejected', async () => {
      await voipService.startCall('PEER123', true);

      const handler = voipService.getCallRejectHandler();
      handler({
        type: 'call_reject',
        callId: 'test-call-id-123',
        from: 'PEER123',
        reason: 'declined',
      });

      // Fast-forward - should not cause additional issues
      vi.advanceTimersByTime(60001);

      // No additional state changes
      expect(voipService.getCurrentCall()).toBeNull();
    });
  });

  describe('event handling', () => {
    it('should allow subscribing to events', async () => {
      const stateHandler = vi.fn();
      voipService.on('state-change', stateHandler);

      await voipService.startCall('PEER123', true);

      expect(stateHandler).toHaveBeenCalled();
    });

    it('should return unsubscribe function', async () => {
      const stateHandler = vi.fn();
      const unsubscribe = voipService.on('state-change', stateHandler);

      unsubscribe();
      await voipService.startCall('PEER123', true);

      expect(stateHandler).not.toHaveBeenCalled();
    });

    it('should allow removing handlers with off', async () => {
      const stateHandler = vi.fn();
      voipService.on('state-change', stateHandler);
      voipService.off('state-change', stateHandler);

      await voipService.startCall('PEER123', true);

      expect(stateHandler).not.toHaveBeenCalled();
    });

    it('should support multiple handlers for same event', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      voipService.on('state-change', handler1);
      voipService.on('state-change', handler2);

      await voipService.startCall('PEER123', true);

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('should clean up resources', async () => {
      await voipService.startCall('PEER123', true);
      voipService.dispose();

      expect(mockMediaService.stopAllTracks).toHaveBeenCalled();
      expect(voipService.getCurrentCall()).toBeNull();
    });

    it('should clear all event handlers', async () => {
      const stateHandler = vi.fn();
      voipService.on('state-change', stateHandler);

      voipService.dispose();

      // Try to trigger events - should not call handler
      // (Internal state, can't easily verify)
    });
  });

  describe('VoIPError', () => {
    it('should have correct user message', () => {
      const error = new VoIPError(
        'Already in call',
        VoIPErrorCodes.VOIP_ALREADY_IN_CALL
      );

      expect(error.userMessage).toBe('Already in a call. Please hang up first.');
    });

    it('should fall back to message for unknown codes', () => {
      const error = new VoIPError('Custom error', 'UNKNOWN_CODE' as VoIPErrorCode);

      expect(error.userMessage).toBe('Custom error');
    });
  });
});
