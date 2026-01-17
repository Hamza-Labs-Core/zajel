/**
 * Media Service for Camera and Microphone Access
 *
 * Handles all media device operations for VoIP calls including:
 * - Requesting camera/microphone permissions
 * - Toggling audio/video mute states
 * - Switching between front/back cameras (mobile)
 * - Proper resource cleanup
 */

import { logger } from './logger';
import { ZajelError, ErrorCodes } from './errors';

// Add media-specific error codes
export const MediaErrorCodes = {
  MEDIA_PERMISSION_DENIED: 'MEDIA_001',
  MEDIA_DEVICE_NOT_FOUND: 'MEDIA_002',
  MEDIA_NOT_SUPPORTED: 'MEDIA_003',
  MEDIA_CONSTRAINT_ERROR: 'MEDIA_004',
  MEDIA_NO_STREAM: 'MEDIA_005',
  MEDIA_SWITCH_CAMERA_FAILED: 'MEDIA_006',
} as const;

export type MediaErrorCode = (typeof MediaErrorCodes)[keyof typeof MediaErrorCodes];

// User-friendly error messages for media errors
export const MediaUserMessages: Record<string, string> = {
  [MediaErrorCodes.MEDIA_PERMISSION_DENIED]:
    'Camera/microphone access was denied. Please allow access in your browser settings.',
  [MediaErrorCodes.MEDIA_DEVICE_NOT_FOUND]:
    'No camera or microphone found. Please connect a device and try again.',
  [MediaErrorCodes.MEDIA_NOT_SUPPORTED]:
    'Your browser does not support camera/microphone access.',
  [MediaErrorCodes.MEDIA_CONSTRAINT_ERROR]:
    'The requested media settings are not supported by your device.',
  [MediaErrorCodes.MEDIA_NO_STREAM]:
    'No active media stream. Please start a call first.',
  [MediaErrorCodes.MEDIA_SWITCH_CAMERA_FAILED]:
    'Failed to switch camera. Please try again.',
};

/**
 * Custom error class for media-related errors.
 */
export class MediaError extends ZajelError {
  constructor(
    message: string,
    code: MediaErrorCode = MediaErrorCodes.MEDIA_PERMISSION_DENIED,
    context?: Record<string, unknown>
  ) {
    super(message, code as unknown as typeof ErrorCodes[keyof typeof ErrorCodes], true, context);
    this.name = 'MediaError';
  }

  override get userMessage(): string {
    return MediaUserMessages[this.code] || this.message;
  }
}

/**
 * Represents the current state of media devices.
 */
export interface MediaState {
  hasAudio: boolean;
  hasVideo: boolean;
  audioMuted: boolean;
  videoMuted: boolean;
}

/**
 * Camera facing mode for mobile devices.
 */
export type FacingMode = 'user' | 'environment';

/**
 * MediaService manages camera and microphone access for VoIP calls.
 *
 * Usage:
 * ```typescript
 * const mediaService = new MediaService();
 *
 * // Request video call media
 * const stream = await mediaService.requestMedia(true);
 *
 * // Attach to video element
 * videoElement.srcObject = stream;
 *
 * // Toggle mute
 * const isMuted = mediaService.toggleMute();
 *
 * // Stop all tracks when done
 * mediaService.stopAllTracks();
 * ```
 */
export class MediaService {
  private localStream: MediaStream | null = null;
  private audioMuted = false;
  private videoMuted = false;
  private currentFacingMode: FacingMode = 'user';

  /**
   * Request media access from user.
   *
   * @param video - true for video call, false for audio only
   * @returns MediaStream with requested tracks
   * @throws MediaError if permission denied, device not found, or not supported
   */
  async requestMedia(video: boolean): Promise<MediaStream> {
    // Check if getUserMedia is supported
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      logger.error('Media', 'getUserMedia not supported');
      throw new MediaError(
        'getUserMedia not supported',
        MediaErrorCodes.MEDIA_NOT_SUPPORTED
      );
    }

    // Stop any existing stream before requesting new one
    this.stopAllTracks();

    const constraints: MediaStreamConstraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: video
        ? {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: this.currentFacingMode,
          }
        : false,
    };

    try {
      logger.info('Media', `Requesting media: video=${video}`);
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);

      // Reset mute states for new stream
      this.audioMuted = false;
      this.videoMuted = false;

      logger.info(
        'Media',
        `Media acquired: audio tracks=${this.localStream.getAudioTracks().length}, video tracks=${this.localStream.getVideoTracks().length}`
      );

      return this.localStream;
    } catch (error) {
      logger.error('Media', 'Failed to get user media:', error);
      throw this.handleMediaError(error);
    }
  }

  /**
   * Toggle audio mute state.
   *
   * @returns new muted state (true = muted)
   */
  toggleMute(): boolean {
    this.audioMuted = !this.audioMuted;
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = !this.audioMuted;
    });

    logger.info('Media', `Audio muted: ${this.audioMuted}`);
    return this.audioMuted;
  }

  /**
   * Toggle video on/off.
   *
   * @returns new video state (true = video on, false = video off)
   */
  toggleVideo(): boolean {
    this.videoMuted = !this.videoMuted;
    this.localStream?.getVideoTracks().forEach((track) => {
      track.enabled = !this.videoMuted;
    });

    logger.info('Media', `Video muted: ${this.videoMuted}`);
    // Return true if video is ON (not muted)
    return !this.videoMuted;
  }

  /**
   * Switch between front/back camera (mobile).
   * This is a best-effort operation - failures are logged but not thrown.
   * Camera switching may not be supported on all platforms/devices.
   *
   * @returns true if camera switch was successful, false otherwise
   */
  async switchCamera(): Promise<boolean> {
    if (!this.localStream) {
      logger.warn('Media', 'Cannot switch camera: no active stream');
      return false;
    }

    const videoTracks = this.localStream.getVideoTracks();
    if (videoTracks.length === 0) {
      logger.warn('Media', 'Cannot switch camera: no video tracks');
      return false;
    }

    // Toggle facing mode
    const newFacingMode: FacingMode =
      this.currentFacingMode === 'user' ? 'environment' : 'user';

    try {
      logger.info('Media', `Switching camera to: ${newFacingMode}`);

      // Request new camera stream FIRST (before stopping old one)
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: newFacingMode,
        },
      });

      const newVideoTrack = newStream.getVideoTracks()[0];
      if (!newVideoTrack) {
        logger.warn('Media', 'New stream has no video track');
        // Clean up the failed stream
        newStream.getTracks().forEach((track) => track.stop());
        return false;
      }

      // Success - now stop old tracks and add new one
      videoTracks.forEach((track) => {
        track.stop();
        this.localStream?.removeTrack(track);
      });

      this.localStream?.addTrack(newVideoTrack);
      // Apply current mute state to new track
      newVideoTrack.enabled = !this.videoMuted;

      this.currentFacingMode = newFacingMode;
      logger.info('Media', `Camera switched to: ${newFacingMode}`);
      return true;
    } catch (error) {
      logger.error('Media', 'Failed to switch camera:', error);
      // Don't rethrow - camera switching is a best-effort operation
      // and may not be supported on all platforms
      return false;
    }
  }

  /**
   * Stop all media tracks and release resources.
   * Call this when ending a call or when the component unmounts.
   */
  stopAllTracks(): void {
    if (this.localStream) {
      logger.info('Media', 'Stopping all media tracks');
      this.localStream.getTracks().forEach((track) => {
        track.stop();
      });
      this.localStream = null;
    }

    // Reset state
    this.audioMuted = false;
    this.videoMuted = false;
    this.currentFacingMode = 'user';
  }

  /**
   * Get current media state.
   *
   * @returns Current state of audio/video availability and mute status
   */
  getState(): MediaState {
    const audioTracks = this.localStream?.getAudioTracks() ?? [];
    const videoTracks = this.localStream?.getVideoTracks() ?? [];

    return {
      hasAudio: audioTracks.length > 0,
      hasVideo: videoTracks.length > 0,
      audioMuted: this.audioMuted,
      videoMuted: this.videoMuted,
    };
  }

  /**
   * Get the local MediaStream (for display in UI).
   *
   * @returns The current local MediaStream or null if not active
   */
  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  /**
   * Get the current camera facing mode.
   *
   * @returns Current facing mode ('user' or 'environment')
   */
  getCurrentFacingMode(): FacingMode {
    return this.currentFacingMode;
  }

  /**
   * Convert a getUserMedia error to a MediaError with appropriate code.
   */
  private handleMediaError(error: unknown): MediaError {
    if (error instanceof DOMException) {
      switch (error.name) {
        case 'NotAllowedError':
        case 'PermissionDeniedError':
          return new MediaError(
            'Camera/microphone permission denied',
            MediaErrorCodes.MEDIA_PERMISSION_DENIED,
            { originalError: error.name }
          );

        case 'NotFoundError':
        case 'DevicesNotFoundError':
          return new MediaError(
            'No camera or microphone found',
            MediaErrorCodes.MEDIA_DEVICE_NOT_FOUND,
            { originalError: error.name }
          );

        case 'NotReadableError':
        case 'TrackStartError':
          return new MediaError(
            'Camera/microphone is already in use',
            MediaErrorCodes.MEDIA_DEVICE_NOT_FOUND,
            { originalError: error.name }
          );

        case 'OverconstrainedError':
        case 'ConstraintNotSatisfiedError':
          return new MediaError(
            'Requested media settings not supported',
            MediaErrorCodes.MEDIA_CONSTRAINT_ERROR,
            { originalError: error.name }
          );

        case 'NotSupportedError':
          return new MediaError(
            'Media devices not supported',
            MediaErrorCodes.MEDIA_NOT_SUPPORTED,
            { originalError: error.name }
          );

        default:
          return new MediaError(
            error.message || 'Unknown media error',
            MediaErrorCodes.MEDIA_PERMISSION_DENIED,
            { originalError: error.name }
          );
      }
    }

    // Generic error
    return new MediaError(
      error instanceof Error ? error.message : 'Unknown media error',
      MediaErrorCodes.MEDIA_PERMISSION_DENIED,
      { originalError: error instanceof Error ? error.name : typeof error }
    );
  }
}
