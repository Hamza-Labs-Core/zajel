/**
 * MediaService Tests
 *
 * Tests for camera and microphone access management.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MediaService,
  MediaError,
  MediaErrorCodes,
} from '../media';

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

// Helper to create mock streams
function createMockStream(hasAudio: boolean, hasVideo: boolean): MockMediaStream {
  const tracks: MockMediaStreamTrack[] = [];
  if (hasAudio) {
    tracks.push(new MockMediaStreamTrack('audio'));
  }
  if (hasVideo) {
    tracks.push(new MockMediaStreamTrack('video'));
  }
  return new MockMediaStream(tracks);
}

describe('MediaService', () => {
  let mediaService: MediaService;
  let mockGetUserMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Create mock getUserMedia
    mockGetUserMedia = vi.fn();

    // Mock navigator.mediaDevices
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: mockGetUserMedia,
      },
    });

    mediaService = new MediaService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('requestMedia', () => {
    it('should request audio-only stream when video is false', async () => {
      const mockStream = createMockStream(true, false);
      mockGetUserMedia.mockResolvedValue(mockStream);

      const stream = await mediaService.requestMedia(false);

      expect(mockGetUserMedia).toHaveBeenCalledWith({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      expect(stream).toBe(mockStream);
    });

    it('should request video+audio stream when video is true', async () => {
      const mockStream = createMockStream(true, true);
      mockGetUserMedia.mockResolvedValue(mockStream);

      const stream = await mediaService.requestMedia(true);

      expect(mockGetUserMedia).toHaveBeenCalledWith({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user',
        },
      });
      expect(stream).toBe(mockStream);
    });

    it('should stop existing stream before requesting new one', async () => {
      const firstStream = createMockStream(true, true);
      const secondStream = createMockStream(true, false);

      mockGetUserMedia
        .mockResolvedValueOnce(firstStream)
        .mockResolvedValueOnce(secondStream);

      // First request
      await mediaService.requestMedia(true);

      // Second request should stop first stream
      await mediaService.requestMedia(false);

      // All tracks from first stream should be stopped
      firstStream.getTracks().forEach((track) => {
        expect(track.isStopped()).toBe(true);
      });
    });

    it('should reset mute states when requesting new media', async () => {
      const firstStream = createMockStream(true, true);
      const secondStream = createMockStream(true, true);

      mockGetUserMedia
        .mockResolvedValueOnce(firstStream)
        .mockResolvedValueOnce(secondStream);

      // First request and mute
      await mediaService.requestMedia(true);
      mediaService.toggleMute();
      mediaService.toggleVideo();

      let state = mediaService.getState();
      expect(state.audioMuted).toBe(true);
      expect(state.videoMuted).toBe(true);

      // Second request should reset
      await mediaService.requestMedia(true);

      state = mediaService.getState();
      expect(state.audioMuted).toBe(false);
      expect(state.videoMuted).toBe(false);
    });

    it('should throw MediaError when permission is denied', async () => {
      const error = new DOMException('Permission denied', 'NotAllowedError');
      mockGetUserMedia.mockRejectedValue(error);

      await expect(mediaService.requestMedia(true)).rejects.toThrow(MediaError);

      try {
        await mediaService.requestMedia(true);
      } catch (e) {
        expect(e).toBeInstanceOf(MediaError);
        expect((e as MediaError).code).toBe(MediaErrorCodes.MEDIA_PERMISSION_DENIED);
      }
    });

    it('should throw MediaError when device is not found', async () => {
      const error = new DOMException('Device not found', 'NotFoundError');
      mockGetUserMedia.mockRejectedValue(error);

      await expect(mediaService.requestMedia(true)).rejects.toThrow(MediaError);

      try {
        await mediaService.requestMedia(true);
      } catch (e) {
        expect(e).toBeInstanceOf(MediaError);
        expect((e as MediaError).code).toBe(MediaErrorCodes.MEDIA_DEVICE_NOT_FOUND);
      }
    });

    it('should throw MediaError when device is in use', async () => {
      const error = new DOMException('Device in use', 'NotReadableError');
      mockGetUserMedia.mockRejectedValue(error);

      await expect(mediaService.requestMedia(true)).rejects.toThrow(MediaError);

      try {
        await mediaService.requestMedia(true);
      } catch (e) {
        expect(e).toBeInstanceOf(MediaError);
        expect((e as MediaError).code).toBe(MediaErrorCodes.MEDIA_DEVICE_NOT_FOUND);
      }
    });

    it('should throw MediaError when constraints cannot be satisfied', async () => {
      const error = new DOMException('Constraints error', 'OverconstrainedError');
      mockGetUserMedia.mockRejectedValue(error);

      await expect(mediaService.requestMedia(true)).rejects.toThrow(MediaError);

      try {
        await mediaService.requestMedia(true);
      } catch (e) {
        expect(e).toBeInstanceOf(MediaError);
        expect((e as MediaError).code).toBe(MediaErrorCodes.MEDIA_CONSTRAINT_ERROR);
      }
    });

    it('should throw MediaError when getUserMedia is not supported', async () => {
      // Remove mediaDevices
      vi.stubGlobal('navigator', {});

      await expect(mediaService.requestMedia(true)).rejects.toThrow(MediaError);

      try {
        await mediaService.requestMedia(true);
      } catch (e) {
        expect(e).toBeInstanceOf(MediaError);
        expect((e as MediaError).code).toBe(MediaErrorCodes.MEDIA_NOT_SUPPORTED);
      }
    });

    it('should throw MediaError when mediaDevices.getUserMedia is not available', async () => {
      vi.stubGlobal('navigator', { mediaDevices: {} });

      await expect(mediaService.requestMedia(true)).rejects.toThrow(MediaError);

      try {
        await mediaService.requestMedia(true);
      } catch (e) {
        expect(e).toBeInstanceOf(MediaError);
        expect((e as MediaError).code).toBe(MediaErrorCodes.MEDIA_NOT_SUPPORTED);
      }
    });
  });

  describe('toggleMute', () => {
    beforeEach(async () => {
      const mockStream = createMockStream(true, true);
      mockGetUserMedia.mockResolvedValue(mockStream);
      await mediaService.requestMedia(true);
    });

    it('should mute audio on first toggle', () => {
      const result = mediaService.toggleMute();

      expect(result).toBe(true);
      expect(mediaService.getState().audioMuted).toBe(true);
    });

    it('should unmute audio on second toggle', () => {
      mediaService.toggleMute(); // Mute
      const result = mediaService.toggleMute(); // Unmute

      expect(result).toBe(false);
      expect(mediaService.getState().audioMuted).toBe(false);
    });

    it('should disable audio tracks when muted', () => {
      const stream = mediaService.getLocalStream() as unknown as MockMediaStream;
      const audioTracks = stream.getAudioTracks();

      mediaService.toggleMute();

      audioTracks.forEach((track) => {
        expect(track.enabled).toBe(false);
      });
    });

    it('should enable audio tracks when unmuted', () => {
      const stream = mediaService.getLocalStream() as unknown as MockMediaStream;
      const audioTracks = stream.getAudioTracks();

      mediaService.toggleMute(); // Mute
      mediaService.toggleMute(); // Unmute

      audioTracks.forEach((track) => {
        expect(track.enabled).toBe(true);
      });
    });

    it('should handle toggle when no stream exists', () => {
      // Create new service without stream
      const newService = new MediaService();

      // Should not throw
      const result = newService.toggleMute();
      expect(result).toBe(true);
    });
  });

  describe('toggleVideo', () => {
    beforeEach(async () => {
      const mockStream = createMockStream(true, true);
      mockGetUserMedia.mockResolvedValue(mockStream);
      await mediaService.requestMedia(true);
    });

    it('should turn off video on first toggle', () => {
      const result = mediaService.toggleVideo();

      // Returns true if video is ON
      expect(result).toBe(false);
      expect(mediaService.getState().videoMuted).toBe(true);
    });

    it('should turn on video on second toggle', () => {
      mediaService.toggleVideo(); // Off
      const result = mediaService.toggleVideo(); // On

      expect(result).toBe(true);
      expect(mediaService.getState().videoMuted).toBe(false);
    });

    it('should disable video tracks when turned off', () => {
      const stream = mediaService.getLocalStream() as unknown as MockMediaStream;
      const videoTracks = stream.getVideoTracks();

      mediaService.toggleVideo();

      videoTracks.forEach((track) => {
        expect(track.enabled).toBe(false);
      });
    });

    it('should enable video tracks when turned on', () => {
      const stream = mediaService.getLocalStream() as unknown as MockMediaStream;
      const videoTracks = stream.getVideoTracks();

      mediaService.toggleVideo(); // Off
      mediaService.toggleVideo(); // On

      videoTracks.forEach((track) => {
        expect(track.enabled).toBe(true);
      });
    });
  });

  describe('switchCamera', () => {
    it('should throw when no stream exists', async () => {
      await expect(mediaService.switchCamera()).rejects.toThrow(MediaError);

      try {
        await mediaService.switchCamera();
      } catch (e) {
        expect(e).toBeInstanceOf(MediaError);
        expect((e as MediaError).code).toBe(MediaErrorCodes.MEDIA_NO_STREAM);
      }
    });

    it('should throw when no video tracks exist', async () => {
      const mockStream = createMockStream(true, false); // Audio only
      mockGetUserMedia.mockResolvedValue(mockStream);
      await mediaService.requestMedia(false);

      await expect(mediaService.switchCamera()).rejects.toThrow(MediaError);

      try {
        await mediaService.switchCamera();
      } catch (e) {
        expect(e).toBeInstanceOf(MediaError);
        expect((e as MediaError).code).toBe(MediaErrorCodes.MEDIA_SWITCH_CAMERA_FAILED);
      }
    });

    it('should switch from user to environment facing mode', async () => {
      const firstStream = createMockStream(true, true);
      const newVideoStream = new MockMediaStream([new MockMediaStreamTrack('video')]);

      mockGetUserMedia
        .mockResolvedValueOnce(firstStream)
        .mockResolvedValueOnce(newVideoStream);

      await mediaService.requestMedia(true);
      expect(mediaService.getCurrentFacingMode()).toBe('user');

      await mediaService.switchCamera();

      expect(mediaService.getCurrentFacingMode()).toBe('environment');
      expect(mockGetUserMedia).toHaveBeenLastCalledWith({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'environment',
        },
      });
    });

    it('should switch from environment to user facing mode', async () => {
      const firstStream = createMockStream(true, true);
      const secondStream = new MockMediaStream([new MockMediaStreamTrack('video')]);
      const thirdStream = new MockMediaStream([new MockMediaStreamTrack('video')]);

      mockGetUserMedia
        .mockResolvedValueOnce(firstStream)
        .mockResolvedValueOnce(secondStream)
        .mockResolvedValueOnce(thirdStream);

      await mediaService.requestMedia(true);
      await mediaService.switchCamera(); // Now environment
      await mediaService.switchCamera(); // Back to user

      expect(mediaService.getCurrentFacingMode()).toBe('user');
      expect(mockGetUserMedia).toHaveBeenLastCalledWith({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user',
        },
      });
    });

    it('should stop old video tracks before switching', async () => {
      const firstStream = createMockStream(true, true);
      const newVideoStream = new MockMediaStream([new MockMediaStreamTrack('video')]);

      mockGetUserMedia
        .mockResolvedValueOnce(firstStream)
        .mockResolvedValueOnce(newVideoStream);

      await mediaService.requestMedia(true);
      const oldVideoTracks = firstStream.getVideoTracks();

      await mediaService.switchCamera();

      oldVideoTracks.forEach((track) => {
        expect(track.isStopped()).toBe(true);
      });
    });

    it('should preserve video mute state after switching', async () => {
      const firstStream = createMockStream(true, true);
      const newVideoStream = new MockMediaStream([new MockMediaStreamTrack('video')]);

      mockGetUserMedia
        .mockResolvedValueOnce(firstStream)
        .mockResolvedValueOnce(newVideoStream);

      await mediaService.requestMedia(true);
      mediaService.toggleVideo(); // Mute video

      await mediaService.switchCamera();

      const stream = mediaService.getLocalStream() as unknown as MockMediaStream;
      const newVideoTrack = stream.getVideoTracks()[0];
      expect(newVideoTrack.enabled).toBe(false);
    });

    it('should throw MediaError when switching fails', async () => {
      const firstStream = createMockStream(true, true);
      mockGetUserMedia
        .mockResolvedValueOnce(firstStream)
        .mockRejectedValueOnce(new Error('Camera switch failed'));

      await mediaService.requestMedia(true);

      await expect(mediaService.switchCamera()).rejects.toThrow(MediaError);

      try {
        await mediaService.switchCamera();
      } catch (e) {
        expect(e).toBeInstanceOf(MediaError);
        expect((e as MediaError).code).toBe(MediaErrorCodes.MEDIA_SWITCH_CAMERA_FAILED);
      }
    });
  });

  describe('stopAllTracks', () => {
    it('should stop all tracks when stream exists', async () => {
      const mockStream = createMockStream(true, true);
      mockGetUserMedia.mockResolvedValue(mockStream);
      await mediaService.requestMedia(true);

      mediaService.stopAllTracks();

      mockStream.getTracks().forEach((track) => {
        expect(track.isStopped()).toBe(true);
      });
    });

    it('should set localStream to null', async () => {
      const mockStream = createMockStream(true, true);
      mockGetUserMedia.mockResolvedValue(mockStream);
      await mediaService.requestMedia(true);

      mediaService.stopAllTracks();

      expect(mediaService.getLocalStream()).toBeNull();
    });

    it('should reset mute states', async () => {
      const mockStream = createMockStream(true, true);
      mockGetUserMedia.mockResolvedValue(mockStream);
      await mediaService.requestMedia(true);

      mediaService.toggleMute();
      mediaService.toggleVideo();
      mediaService.stopAllTracks();

      const state = mediaService.getState();
      expect(state.audioMuted).toBe(false);
      expect(state.videoMuted).toBe(false);
    });

    it('should reset facing mode to user', async () => {
      const firstStream = createMockStream(true, true);
      const newVideoStream = new MockMediaStream([new MockMediaStreamTrack('video')]);

      mockGetUserMedia
        .mockResolvedValueOnce(firstStream)
        .mockResolvedValueOnce(newVideoStream);

      await mediaService.requestMedia(true);
      await mediaService.switchCamera(); // Now environment

      mediaService.stopAllTracks();

      expect(mediaService.getCurrentFacingMode()).toBe('user');
    });

    it('should handle being called when no stream exists', () => {
      // Should not throw
      expect(() => mediaService.stopAllTracks()).not.toThrow();
    });

    it('should handle being called multiple times', async () => {
      const mockStream = createMockStream(true, true);
      mockGetUserMedia.mockResolvedValue(mockStream);
      await mediaService.requestMedia(true);

      // Should not throw
      expect(() => {
        mediaService.stopAllTracks();
        mediaService.stopAllTracks();
        mediaService.stopAllTracks();
      }).not.toThrow();
    });
  });

  describe('getState', () => {
    it('should return correct initial state', () => {
      const state = mediaService.getState();

      expect(state).toEqual({
        hasAudio: false,
        hasVideo: false,
        audioMuted: false,
        videoMuted: false,
      });
    });

    it('should return correct state after video call', async () => {
      const mockStream = createMockStream(true, true);
      mockGetUserMedia.mockResolvedValue(mockStream);
      await mediaService.requestMedia(true);

      const state = mediaService.getState();

      expect(state).toEqual({
        hasAudio: true,
        hasVideo: true,
        audioMuted: false,
        videoMuted: false,
      });
    });

    it('should return correct state after audio-only call', async () => {
      const mockStream = createMockStream(true, false);
      mockGetUserMedia.mockResolvedValue(mockStream);
      await mediaService.requestMedia(false);

      const state = mediaService.getState();

      expect(state).toEqual({
        hasAudio: true,
        hasVideo: false,
        audioMuted: false,
        videoMuted: false,
      });
    });

    it('should return correct state after muting', async () => {
      const mockStream = createMockStream(true, true);
      mockGetUserMedia.mockResolvedValue(mockStream);
      await mediaService.requestMedia(true);

      mediaService.toggleMute();
      mediaService.toggleVideo();

      const state = mediaService.getState();

      expect(state).toEqual({
        hasAudio: true,
        hasVideo: true,
        audioMuted: true,
        videoMuted: true,
      });
    });

    it('should return correct state after stopping', async () => {
      const mockStream = createMockStream(true, true);
      mockGetUserMedia.mockResolvedValue(mockStream);
      await mediaService.requestMedia(true);

      mediaService.stopAllTracks();

      const state = mediaService.getState();

      expect(state).toEqual({
        hasAudio: false,
        hasVideo: false,
        audioMuted: false,
        videoMuted: false,
      });
    });
  });

  describe('getLocalStream', () => {
    it('should return null when no stream exists', () => {
      expect(mediaService.getLocalStream()).toBeNull();
    });

    it('should return stream after requesting media', async () => {
      const mockStream = createMockStream(true, true);
      mockGetUserMedia.mockResolvedValue(mockStream);
      await mediaService.requestMedia(true);

      expect(mediaService.getLocalStream()).toBe(mockStream);
    });

    it('should return null after stopping tracks', async () => {
      const mockStream = createMockStream(true, true);
      mockGetUserMedia.mockResolvedValue(mockStream);
      await mediaService.requestMedia(true);

      mediaService.stopAllTracks();

      expect(mediaService.getLocalStream()).toBeNull();
    });
  });

  describe('MediaError', () => {
    it('should have correct user message for permission denied', () => {
      const error = new MediaError(
        'Test error',
        MediaErrorCodes.MEDIA_PERMISSION_DENIED
      );

      expect(error.userMessage).toBe(
        'Camera/microphone access was denied. Please allow access in your browser settings.'
      );
    });

    it('should have correct user message for device not found', () => {
      const error = new MediaError(
        'Test error',
        MediaErrorCodes.MEDIA_DEVICE_NOT_FOUND
      );

      expect(error.userMessage).toBe(
        'No camera or microphone found. Please connect a device and try again.'
      );
    });

    it('should have correct user message for not supported', () => {
      const error = new MediaError(
        'Test error',
        MediaErrorCodes.MEDIA_NOT_SUPPORTED
      );

      expect(error.userMessage).toBe(
        'Your browser does not support camera/microphone access.'
      );
    });

    it('should fall back to message when no user message exists', () => {
      const error = new MediaError('Custom error message', 'UNKNOWN_CODE' as any);

      expect(error.userMessage).toBe('Custom error message');
    });
  });
});
