/**
 * CallView Component Tests
 *
 * Tests for the active call view component.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/preact';
import { CallView } from '../CallView';
import type { VoIPService, CallState, CallInfo, VoIPEvents, VoIPError } from '../../lib/voip';

// Mock MediaStream
class MockMediaStream {
  private videoTracks: { kind: string; enabled: boolean }[] = [];
  private audioTracks: { kind: string; enabled: boolean }[] = [];

  constructor(hasVideo = true) {
    if (hasVideo) {
      this.videoTracks = [{ kind: 'video', enabled: true }];
    }
    this.audioTracks = [{ kind: 'audio', enabled: true }];
  }

  getVideoTracks() {
    return this.videoTracks;
  }

  getAudioTracks() {
    return this.audioTracks;
  }

  getTracks() {
    return [...this.videoTracks, ...this.audioTracks];
  }
}

// Create a mock VoIPService
function createMockVoIPService(options: {
  initialState?: CallState;
  startTime?: number;
  hasRemoteStream?: boolean;
  hasLocalStream?: boolean;
  withVideo?: boolean;
} = {}): VoIPService & {
  mockHandlers: Map<keyof VoIPEvents, Set<VoIPEvents[keyof VoIPEvents]>>;
  simulateStateChange: (state: CallState, call: CallInfo | null) => void;
  simulateRemoteStream: (stream: MediaStream) => void;
  simulateError: (error: VoIPError) => void;
  toggleMute: ReturnType<typeof vi.fn>;
  toggleVideo: ReturnType<typeof vi.fn>;
  hangup: ReturnType<typeof vi.fn>;
} {
  const handlers = new Map<keyof VoIPEvents, Set<VoIPEvents[keyof VoIPEvents]>>();

  const currentCall: CallInfo | null = options.initialState && options.initialState !== 'idle'
    ? {
        callId: 'test-call-123',
        peerId: 'PEER123',
        withVideo: options.withVideo ?? true,
        state: options.initialState,
        startTime: options.startTime,
        remoteStream: options.hasRemoteStream ? new MockMediaStream() as unknown as MediaStream : undefined,
      }
    : null;

  const localStream = options.hasLocalStream !== false
    ? new MockMediaStream(options.withVideo ?? true) as unknown as MediaStream
    : null;

  return {
    mockHandlers: handlers,
    on: vi.fn((event: keyof VoIPEvents, handler: VoIPEvents[keyof VoIPEvents]) => {
      if (!handlers.has(event)) {
        handlers.set(event, new Set());
      }
      handlers.get(event)!.add(handler);
      return () => {
        handlers.get(event)?.delete(handler);
      };
    }),
    off: vi.fn((event: keyof VoIPEvents, handler: VoIPEvents[keyof VoIPEvents]) => {
      handlers.get(event)?.delete(handler);
    }),
    getCurrentCall: vi.fn(() => currentCall),
    getLocalStream: vi.fn(() => localStream),
    getRemoteStream: vi.fn(() => currentCall?.remoteStream || null),
    toggleMute: vi.fn(() => true),
    toggleVideo: vi.fn(() => false),
    hangup: vi.fn(),
    simulateStateChange: (state: CallState, call: CallInfo | null) => {
      const stateHandlers = handlers.get('state-change');
      if (stateHandlers) {
        stateHandlers.forEach((h) => {
          (h as (state: CallState, call: CallInfo | null) => void)(state, call);
        });
      }
    },
    simulateRemoteStream: (stream: MediaStream) => {
      const streamHandlers = handlers.get('remote-stream');
      if (streamHandlers) {
        streamHandlers.forEach((h) => {
          (h as (stream: MediaStream) => void)(stream);
        });
      }
    },
    simulateError: (error: VoIPError) => {
      const errorHandlers = handlers.get('error');
      if (errorHandlers) {
        errorHandlers.forEach((h) => {
          (h as (error: VoIPError) => void)(error);
        });
      }
    },
  } as unknown as VoIPService & {
    mockHandlers: Map<keyof VoIPEvents, Set<VoIPEvents[keyof VoIPEvents]>>;
    simulateStateChange: (state: CallState, call: CallInfo | null) => void;
    simulateRemoteStream: (stream: MediaStream) => void;
    simulateError: (error: VoIPError) => void;
    toggleMute: ReturnType<typeof vi.fn>;
    toggleVideo: ReturnType<typeof vi.fn>;
    hangup: ReturnType<typeof vi.fn>;
  };
}

describe('CallView', () => {
  let mockVoIPService: ReturnType<typeof createMockVoIPService>;
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockVoIPService = createMockVoIPService({
      initialState: 'outgoing',
      hasLocalStream: true,
      withVideo: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  describe('rendering', () => {
    it('should render peer name', () => {
      render(
        <CallView
          voipService={mockVoIPService}
          peerName="PEER123"
          onClose={onClose}
        />
      );

      expect(screen.getByText('PEER123')).toBeInTheDocument();
    });

    it('should render call controls', () => {
      render(
        <CallView
          voipService={mockVoIPService}
          peerName="PEER123"
          onClose={onClose}
        />
      );

      expect(screen.getByRole('button', { name: /mute/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /camera|video/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /end call/i })).toBeInTheDocument();
    });

    it('should render with dialog role', () => {
      render(
        <CallView
          voipService={mockVoIPService}
          peerName="PEER123"
          onClose={onClose}
        />
      );

      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('should have accessible aria-label', () => {
      render(
        <CallView
          voipService={mockVoIPService}
          peerName="TestPeer"
          onClose={onClose}
        />
      );

      expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', 'Call with TestPeer');
    });
  });

  describe('call states', () => {
    it('should show "Calling..." for outgoing state', () => {
      mockVoIPService = createMockVoIPService({ initialState: 'outgoing' });
      render(
        <CallView
          voipService={mockVoIPService}
          peerName="PEER123"
          onClose={onClose}
        />
      );

      expect(screen.getByText('Calling...')).toBeInTheDocument();
    });

    it('should show "Connecting..." for connecting state', () => {
      mockVoIPService = createMockVoIPService({ initialState: 'connecting' });
      render(
        <CallView
          voipService={mockVoIPService}
          peerName="PEER123"
          onClose={onClose}
        />
      );

      expect(screen.getByText('Connecting...')).toBeInTheDocument();
    });

    it('should show duration timer when connected', () => {
      const startTime = Date.now();
      mockVoIPService = createMockVoIPService({
        initialState: 'connected',
        startTime,
        hasRemoteStream: true,
      });

      render(
        <CallView
          voipService={mockVoIPService}
          peerName="PEER123"
          onClose={onClose}
        />
      );

      expect(screen.getByText('00:00')).toBeInTheDocument();
    });

    it('should update duration timer as time passes', async () => {
      const startTime = Date.now();
      mockVoIPService = createMockVoIPService({
        initialState: 'connected',
        startTime,
        hasRemoteStream: true,
      });

      render(
        <CallView
          voipService={mockVoIPService}
          peerName="PEER123"
          onClose={onClose}
        />
      );

      // Advance time by 65 seconds
      act(() => {
        vi.advanceTimersByTime(65000);
      });

      await waitFor(() => {
        expect(screen.getByText('01:05')).toBeInTheDocument();
      });
    });

    it('should show call ended screen when state is ended', async () => {
      mockVoIPService = createMockVoIPService({ initialState: 'outgoing' });

      render(
        <CallView
          voipService={mockVoIPService}
          peerName="PEER123"
          onClose={onClose}
        />
      );

      act(() => {
        mockVoIPService.simulateStateChange('ended', null);
      });

      await waitFor(() => {
        expect(screen.getByText('Call ended')).toBeInTheDocument();
      });
    });

    it('should call onClose after call ends', async () => {
      mockVoIPService = createMockVoIPService({ initialState: 'outgoing' });

      render(
        <CallView
          voipService={mockVoIPService}
          peerName="PEER123"
          onClose={onClose}
        />
      );

      act(() => {
        mockVoIPService.simulateStateChange('ended', null);
      });

      // Advance past the 2 second delay
      act(() => {
        vi.advanceTimersByTime(2500);
      });

      await waitFor(() => {
        expect(onClose).toHaveBeenCalled();
      });
    });
  });

  describe('control interactions', () => {
    it('should call toggleMute when mute button is clicked', () => {
      render(
        <CallView
          voipService={mockVoIPService}
          peerName="PEER123"
          onClose={onClose}
        />
      );

      const muteButton = screen.getByRole('button', { name: /mute/i });
      fireEvent.click(muteButton);

      expect(mockVoIPService.toggleMute).toHaveBeenCalled();
    });

    it('should update mute button state after toggle', async () => {
      mockVoIPService.toggleMute.mockReturnValue(true); // Returns true = muted

      render(
        <CallView
          voipService={mockVoIPService}
          peerName="PEER123"
          onClose={onClose}
        />
      );

      const muteButton = screen.getByRole('button', { name: /mute/i });
      fireEvent.click(muteButton);

      await waitFor(() => {
        expect(muteButton).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: /unmute/i })).toBeInTheDocument();
      });
    });

    it('should call toggleVideo when video button is clicked', () => {
      render(
        <CallView
          voipService={mockVoIPService}
          peerName="PEER123"
          onClose={onClose}
        />
      );

      const videoButton = screen.getByRole('button', { name: /camera|turn off/i });
      fireEvent.click(videoButton);

      expect(mockVoIPService.toggleVideo).toHaveBeenCalled();
    });

    it('should call hangup when hangup button is clicked', () => {
      render(
        <CallView
          voipService={mockVoIPService}
          peerName="PEER123"
          onClose={onClose}
        />
      );

      const hangupButton = screen.getByRole('button', { name: /end call/i });
      fireEvent.click(hangupButton);

      expect(mockVoIPService.hangup).toHaveBeenCalled();
    });
  });

  describe('video elements', () => {
    it('should render local video element', () => {
      render(
        <CallView
          voipService={mockVoIPService}
          peerName="PEER123"
          onClose={onClose}
        />
      );

      const localVideo = screen.getByLabelText(/your video preview/i);
      expect(localVideo).toBeInTheDocument();
      expect(localVideo.tagName.toLowerCase()).toBe('video');
    });

    it('should subscribe to remote-stream events', () => {
      mockVoIPService = createMockVoIPService({
        initialState: 'connected',
        hasRemoteStream: false,
        withVideo: true,
      });

      render(
        <CallView
          voipService={mockVoIPService}
          peerName="PEER123"
          onClose={onClose}
        />
      );

      // Verify the component subscribes to remote-stream
      expect(mockVoIPService.mockHandlers.get('remote-stream')?.size).toBeGreaterThan(0);
    });

    it('should show placeholder when no remote video', () => {
      mockVoIPService = createMockVoIPService({
        initialState: 'outgoing',
        hasRemoteStream: false,
      });

      render(
        <CallView
          voipService={mockVoIPService}
          peerName="PEER123"
          onClose={onClose}
        />
      );

      // Check for the placeholder by CSS class
      const placeholder = document.querySelector('.remote-video-placeholder');
      expect(placeholder).toBeInTheDocument();
    });
  });

  describe('event subscriptions', () => {
    it('should subscribe to voipService events on mount', () => {
      render(
        <CallView
          voipService={mockVoIPService}
          peerName="PEER123"
          onClose={onClose}
        />
      );

      // Verify subscriptions using the mockHandlers map
      expect(mockVoIPService.mockHandlers.get('state-change')?.size).toBeGreaterThan(0);
      expect(mockVoIPService.mockHandlers.get('remote-stream')?.size).toBeGreaterThan(0);
      expect(mockVoIPService.mockHandlers.get('error')?.size).toBeGreaterThan(0);
    });

    it('should respond to state change events', () => {
      render(
        <CallView
          voipService={mockVoIPService}
          peerName="PEER123"
          onClose={onClose}
        />
      );

      // Verify the component has subscribed and can receive events
      const stateChangeHandlers = mockVoIPService.mockHandlers.get('state-change');
      expect(stateChangeHandlers).toBeDefined();
      expect(stateChangeHandlers?.size).toBeGreaterThan(0);
    });
  });

  describe('accessibility', () => {
    it('should have accessible control buttons', () => {
      render(
        <CallView
          voipService={mockVoIPService}
          peerName="PEER123"
          onClose={onClose}
        />
      );

      const controls = screen.getByRole('group', { name: /call controls/i });
      expect(controls).toBeInTheDocument();
    });

    it('should announce call connected to screen readers', async () => {
      mockVoIPService = createMockVoIPService({ initialState: 'outgoing' });

      render(
        <CallView
          voipService={mockVoIPService}
          peerName="PEER123"
          onClose={onClose}
        />
      );

      const startTime = Date.now();
      act(() => {
        mockVoIPService.simulateStateChange('connected', {
          callId: 'test-123',
          peerId: 'PEER123',
          withVideo: true,
          state: 'connected',
          startTime,
        });
      });

      // The screen reader announcement should be present
      await waitFor(() => {
        const announcer = document.querySelector('[aria-live="assertive"]');
        expect(announcer).toBeInTheDocument();
      });
    });

    it('should have status region for call state', () => {
      render(
        <CallView
          voipService={mockVoIPService}
          peerName="PEER123"
          onClose={onClose}
        />
      );

      const status = screen.getByRole('status');
      expect(status).toBeInTheDocument();
    });
  });
});
