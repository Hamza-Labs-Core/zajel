import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/media/media_service.dart';

void main() {
  group('MediaState', () {
    test('initial state has no tracks and nothing muted', () {
      const state = MediaState.initial();

      expect(state.hasAudio, isFalse);
      expect(state.hasVideo, isFalse);
      expect(state.audioMuted, isFalse);
      expect(state.videoMuted, isFalse);
    });

    test('constructor creates state with provided values', () {
      const state = MediaState(
        hasAudio: true,
        hasVideo: true,
        audioMuted: true,
        videoMuted: false,
      );

      expect(state.hasAudio, isTrue);
      expect(state.hasVideo, isTrue);
      expect(state.audioMuted, isTrue);
      expect(state.videoMuted, isFalse);
    });

    test('copyWith creates a copy with modified fields', () {
      const original = MediaState(
        hasAudio: true,
        hasVideo: true,
        audioMuted: false,
        videoMuted: false,
      );

      final modified = original.copyWith(audioMuted: true);

      expect(modified.hasAudio, isTrue);
      expect(modified.hasVideo, isTrue);
      expect(modified.audioMuted, isTrue);
      expect(modified.videoMuted, isFalse);

      // Original should be unchanged
      expect(original.audioMuted, isFalse);
    });

    test('copyWith with no arguments returns equivalent state', () {
      const original = MediaState(
        hasAudio: true,
        hasVideo: false,
        audioMuted: true,
        videoMuted: false,
      );

      final copy = original.copyWith();

      expect(copy, equals(original));
    });

    test('equality works correctly', () {
      const state1 = MediaState(
        hasAudio: true,
        hasVideo: true,
        audioMuted: false,
        videoMuted: false,
      );

      const state2 = MediaState(
        hasAudio: true,
        hasVideo: true,
        audioMuted: false,
        videoMuted: false,
      );

      const state3 = MediaState(
        hasAudio: true,
        hasVideo: true,
        audioMuted: true,
        videoMuted: false,
      );

      expect(state1, equals(state2));
      expect(state1, isNot(equals(state3)));
      expect(state1.hashCode, equals(state2.hashCode));
    });

    test('toString returns descriptive string', () {
      const state = MediaState(
        hasAudio: true,
        hasVideo: false,
        audioMuted: true,
        videoMuted: false,
      );

      final str = state.toString();

      expect(str, contains('MediaState'));
      expect(str, contains('hasAudio: true'));
      expect(str, contains('hasVideo: false'));
      expect(str, contains('audioMuted: true'));
      expect(str, contains('videoMuted: false'));
    });
  });

  group('MediaPermissionDeniedException', () {
    test('default message', () {
      const exception = MediaPermissionDeniedException();

      expect(exception.message, contains('permission denied'));
    });

    test('custom message', () {
      const exception = MediaPermissionDeniedException('Camera access denied');

      expect(exception.message, 'Camera access denied');
    });

    test('toString includes exception type and message', () {
      const exception = MediaPermissionDeniedException('Test message');

      expect(exception.toString(), contains('MediaPermissionDeniedException'));
      expect(exception.toString(), contains('Test message'));
    });
  });

  group('MediaDeviceNotFoundException', () {
    test('default message', () {
      const exception = MediaDeviceNotFoundException();

      expect(exception.message, contains('not found'));
    });

    test('custom message', () {
      const exception = MediaDeviceNotFoundException('Camera not available');

      expect(exception.message, 'Camera not available');
    });

    test('toString includes exception type and message', () {
      const exception = MediaDeviceNotFoundException('Test device error');

      expect(exception.toString(), contains('MediaDeviceNotFoundException'));
      expect(exception.toString(), contains('Test device error'));
    });
  });

  group('MediaException', () {
    test('stores message', () {
      const exception = MediaException('Something went wrong');

      expect(exception.message, 'Something went wrong');
    });

    test('toString includes exception type and message', () {
      const exception = MediaException('Error details');

      expect(exception.toString(), contains('MediaException'));
      expect(exception.toString(), contains('Error details'));
    });
  });

  group('MediaService', () {
    late MediaService mediaService;

    setUp(() {
      mediaService = MediaService();
    });

    tearDown(() async {
      await mediaService.dispose();
    });

    group('initial state', () {
      test('localStream is null initially', () {
        expect(mediaService.localStream, isNull);
      });

      test('isAudioMuted is false initially', () {
        expect(mediaService.isAudioMuted, isFalse);
      });

      test('isVideoMuted is false initially', () {
        expect(mediaService.isVideoMuted, isFalse);
      });

      test('getState returns initial state when no stream', () {
        final state = mediaService.getState();

        expect(state.hasAudio, isFalse);
        expect(state.hasVideo, isFalse);
        expect(state.audioMuted, isFalse);
        expect(state.videoMuted, isFalse);
      });
    });

    group('toggleMute', () {
      test('toggleMute toggles audioMuted state', () {
        expect(mediaService.isAudioMuted, isFalse);

        final result1 = mediaService.toggleMute();
        expect(result1, isTrue);
        expect(mediaService.isAudioMuted, isTrue);

        final result2 = mediaService.toggleMute();
        expect(result2, isFalse);
        expect(mediaService.isAudioMuted, isFalse);
      });

      test('toggleMute updates state correctly', () {
        mediaService.toggleMute();
        expect(mediaService.getState().audioMuted, isTrue);

        mediaService.toggleMute();
        expect(mediaService.getState().audioMuted, isFalse);
      });
    });

    group('toggleVideo', () {
      test('toggleVideo toggles videoMuted state', () {
        expect(mediaService.isVideoMuted, isFalse);

        // First toggle: video off (muted=true), returns false (video is off)
        final result1 = mediaService.toggleVideo();
        expect(result1, isFalse);
        expect(mediaService.isVideoMuted, isTrue);

        // Second toggle: video on (muted=false), returns true (video is on)
        final result2 = mediaService.toggleVideo();
        expect(result2, isTrue);
        expect(mediaService.isVideoMuted, isFalse);
      });

      test('toggleVideo returns whether video is ON', () {
        // Initially video is on (not muted)
        expect(mediaService.isVideoMuted, isFalse);

        // Toggle returns new video-on state (false because now muted)
        final videoOn = mediaService.toggleVideo();
        expect(videoOn, isFalse);

        // Toggle again returns new video-on state (true because now unmuted)
        final videoOn2 = mediaService.toggleVideo();
        expect(videoOn2, isTrue);
      });
    });

    group('setAudioMuted', () {
      test('setAudioMuted sets mute state directly', () {
        expect(mediaService.isAudioMuted, isFalse);

        mediaService.setAudioMuted(true);
        expect(mediaService.isAudioMuted, isTrue);

        mediaService.setAudioMuted(false);
        expect(mediaService.isAudioMuted, isFalse);
      });

      test('setAudioMuted does nothing if same state', () {
        // Initially false
        mediaService.setAudioMuted(false);
        expect(mediaService.isAudioMuted, isFalse);

        // Set to true
        mediaService.setAudioMuted(true);
        expect(mediaService.isAudioMuted, isTrue);

        // Set to true again (no change)
        mediaService.setAudioMuted(true);
        expect(mediaService.isAudioMuted, isTrue);
      });
    });

    group('setVideoMuted', () {
      test('setVideoMuted sets mute state directly', () {
        expect(mediaService.isVideoMuted, isFalse);

        mediaService.setVideoMuted(true);
        expect(mediaService.isVideoMuted, isTrue);

        mediaService.setVideoMuted(false);
        expect(mediaService.isVideoMuted, isFalse);
      });

      test('setVideoMuted does nothing if same state', () {
        // Initially false
        mediaService.setVideoMuted(false);
        expect(mediaService.isVideoMuted, isFalse);

        // Set to true
        mediaService.setVideoMuted(true);
        expect(mediaService.isVideoMuted, isTrue);

        // Set to true again (no change)
        mediaService.setVideoMuted(true);
        expect(mediaService.isVideoMuted, isTrue);
      });
    });

    group('stopAllTracks', () {
      test('stopAllTracks does not throw when no stream', () async {
        // Should not throw when no stream
        await mediaService.stopAllTracks();

        expect(mediaService.localStream, isNull);
      });

      test('stopAllTracks keeps mute flags unchanged when no stream', () async {
        // Set some mute states (without a stream)
        mediaService.setAudioMuted(true);
        mediaService.setVideoMuted(true);

        // When there's no stream, stopAllTracks just returns early
        await mediaService.stopAllTracks();

        // Mute flags remain unchanged since there was no stream to process
        // (the reset only happens in the finally block when _localStream != null)
        expect(mediaService.isAudioMuted, isTrue);
        expect(mediaService.isVideoMuted, isTrue);
      });
    });

    group('switchCamera', () {
      test('switchCamera does nothing when no stream', () async {
        // Should not throw when no stream
        await mediaService.switchCamera();

        expect(mediaService.localStream, isNull);
      });
    });

    group('dispose', () {
      test('dispose cleans up resources', () async {
        await mediaService.dispose();

        expect(mediaService.localStream, isNull);
        expect(mediaService.isAudioMuted, isFalse);
        expect(mediaService.isVideoMuted, isFalse);
      });

      test('dispose can be called multiple times', () async {
        await mediaService.dispose();
        await mediaService.dispose();

        expect(mediaService.localStream, isNull);
      });
    });
  });
}
