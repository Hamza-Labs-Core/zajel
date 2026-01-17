import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import type { VoIPService, CallState, CallInfo, VoIPError } from '../lib/voip';

interface CallViewProps {
  voipService: VoIPService;
  peerName: string;
  onClose: () => void;
}

/**
 * Full-screen call interface for active calls.
 * Displays local/remote video, call controls, and call status.
 */
export function CallView({ voipService, peerName, onClose }: CallViewProps) {
  const [state, setState] = useState<CallState>('connecting');
  const [duration, setDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false);
  const [callEnded, setCallEnded] = useState(false);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const callEndTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Subscribe to voipService events
  useEffect(() => {
    const handleStateChange = (newState: CallState, call: CallInfo | null) => {
      setState(newState);

      if (newState === 'connected' && call?.startTime) {
        // Start duration timer
        startDurationTimer(call.startTime);
      } else if (newState === 'ended') {
        stopDurationTimer();
        setCallEnded(true);
        // Brief delay before closing
        callEndTimeoutRef.current = setTimeout(() => {
          onClose();
        }, 2000);
      }
    };

    const handleRemoteStream = (stream: MediaStream) => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = stream;
        // Check if remote has video tracks
        setHasRemoteVideo(stream.getVideoTracks().length > 0);
      }
    };

    const handleError = (error: VoIPError) => {
      // Log error but don't close - let state change handle it
      console.error('Call error:', error.userMessage);
    };

    const unsubStateChange = voipService.on('state-change', handleStateChange);
    const unsubRemoteStream = voipService.on('remote-stream', handleRemoteStream);
    const unsubError = voipService.on('error', handleError);

    // Get initial state
    const currentCall = voipService.getCurrentCall();
    if (currentCall) {
      setState(currentCall.state);
      if (currentCall.startTime) {
        startDurationTimer(currentCall.startTime);
      }
      if (currentCall.remoteStream && remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = currentCall.remoteStream;
        setHasRemoteVideo(currentCall.remoteStream.getVideoTracks().length > 0);
      }
    }

    // Set local video
    const localStream = voipService.getLocalStream();
    if (localStream && localVideoRef.current) {
      localVideoRef.current.srcObject = localStream;
      setIsVideoOn(localStream.getVideoTracks().some(t => t.enabled));
    }

    return () => {
      unsubStateChange();
      unsubRemoteStream();
      unsubError();
      stopDurationTimer();
      if (callEndTimeoutRef.current) {
        clearTimeout(callEndTimeoutRef.current);
      }
    };
  }, [voipService, onClose]);

  const startDurationTimer = useCallback((startTime: number) => {
    stopDurationTimer();
    const updateDuration = () => {
      setDuration(Math.floor((Date.now() - startTime) / 1000));
    };
    updateDuration();
    durationIntervalRef.current = setInterval(updateDuration, 1000);
  }, []);

  const stopDurationTimer = useCallback(() => {
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
  }, []);

  // Format duration as MM:SS or HH:MM:SS
  const formatDuration = (seconds: number): string => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hrs > 0) {
      return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const handleToggleMute = () => {
    const newMuted = voipService.toggleMute();
    setIsMuted(newMuted);
  };

  const handleToggleVideo = () => {
    const newVideoOn = voipService.toggleVideo();
    setIsVideoOn(newVideoOn);
  };

  const handleHangup = () => {
    voipService.hangup();
  };

  // Get status text based on state
  const getStatusText = (): string => {
    switch (state) {
      case 'outgoing':
        return 'Calling...';
      case 'connecting':
        return 'Connecting...';
      case 'connected':
        return formatDuration(duration);
      case 'ended':
        return 'Call ended';
      default:
        return '';
    }
  };

  // Show call ended overlay
  if (callEnded) {
    return (
      <div class="call-view call-ended" role="dialog" aria-label="Call ended">
        <div class="call-ended-content">
          <div class="call-ended-icon" aria-hidden="true">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" />
            </svg>
          </div>
          <p class="call-ended-text">Call ended</p>
          {duration > 0 && (
            <p class="call-ended-duration">Duration: {formatDuration(duration)}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      class="call-view"
      role="dialog"
      aria-label={`Call with ${peerName}`}
      aria-describedby="call-status"
    >
      {/* Remote video (full screen background) */}
      <div class="remote-video-container">
        {hasRemoteVideo ? (
          <video
            ref={remoteVideoRef}
            class="remote-video"
            autoPlay
            playsInline
            aria-label={`${peerName}'s video`}
          />
        ) : (
          <div class="remote-video-placeholder" aria-hidden="true">
            <div class="avatar-large">
              <svg width="80" height="80" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
              </svg>
            </div>
          </div>
        )}
      </div>

      {/* Local video preview (small corner) */}
      <div class={`local-video-container ${!isVideoOn ? 'video-off' : ''}`}>
        <video
          ref={localVideoRef}
          class="local-video"
          autoPlay
          playsInline
          muted
          aria-label="Your video preview"
        />
        {!isVideoOn && (
          <div class="video-off-indicator" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z" />
            </svg>
          </div>
        )}
      </div>

      {/* Call info overlay */}
      <div class="call-info">
        <h2 class="peer-name">{peerName}</h2>
        <p id="call-status" class="call-status" role="status" aria-live="polite">
          {state === 'outgoing' && (
            <span class="calling-indicator">
              <span class="dot dot-1"></span>
              <span class="dot dot-2"></span>
              <span class="dot dot-3"></span>
            </span>
          )}
          {getStatusText()}
        </p>
      </div>

      {/* Control bar */}
      <div class="call-controls" role="group" aria-label="Call controls">
        {/* Mute button */}
        <button
          class={`control-btn ${isMuted ? 'active' : ''}`}
          onClick={handleToggleMute}
          aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
          aria-pressed={isMuted}
          title={isMuted ? 'Unmute' : 'Mute'}
        >
          {isMuted ? (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
            </svg>
          ) : (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z" />
            </svg>
          )}
        </button>

        {/* Video toggle button */}
        <button
          class={`control-btn ${!isVideoOn ? 'active' : ''}`}
          onClick={handleToggleVideo}
          aria-label={isVideoOn ? 'Turn off camera' : 'Turn on camera'}
          aria-pressed={!isVideoOn}
          title={isVideoOn ? 'Turn off video' : 'Turn on video'}
        >
          {isVideoOn ? (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
            </svg>
          ) : (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z" />
            </svg>
          )}
        </button>

        {/* Hangup button */}
        <button
          class="control-btn control-btn-hangup"
          onClick={handleHangup}
          aria-label="End call"
          title="End call"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" />
          </svg>
        </button>
      </div>

      {/* Screen reader status announcements */}
      <div class="sr-only" aria-live="assertive">
        {state === 'connected' && duration === 0 && 'Call connected'}
      </div>
    </div>
  );
}
