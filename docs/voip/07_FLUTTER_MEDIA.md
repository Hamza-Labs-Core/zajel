# Task 07: Flutter Media Service

## Status: NOT STARTED
## Depends On: Nothing (can start immediately)

## Owner Files (Only edit these)
- `packages/app/lib/core/media/media_service.dart` (create new)

## Task Description
Create a MediaService class for Flutter to manage camera and microphone.

## Requirements

### 1. Dependencies

Add to `packages/app/pubspec.yaml`:
```yaml
dependencies:
  flutter_webrtc: ^0.9.47
```

### 2. Create `media_service.dart`

```dart
import 'package:flutter_webrtc/flutter_webrtc.dart';

class MediaState {
  final bool hasAudio;
  final bool hasVideo;
  final bool audioMuted;
  final bool videoMuted;

  MediaState({
    required this.hasAudio,
    required this.hasVideo,
    required this.audioMuted,
    required this.videoMuted,
  });
}

class MediaService {
  MediaStream? _localStream;
  bool _audioMuted = false;
  bool _videoMuted = false;

  /// Request media access
  /// [video] - true for video call, false for audio only
  Future<MediaStream> requestMedia(bool video) async {
    final constraints = <String, dynamic>{
      'audio': {
        'echoCancellation': true,
        'noiseSuppression': true,
      },
      'video': video
          ? {
              'width': 1280,
              'height': 720,
              'facingMode': 'user',
            }
          : false,
    };

    _localStream = await navigator.mediaDevices.getUserMedia(constraints);
    return _localStream!;
  }

  /// Toggle audio mute
  /// Returns new muted state
  bool toggleMute() {
    _audioMuted = !_audioMuted;
    _localStream?.getAudioTracks().forEach((track) {
      track.enabled = !_audioMuted;
    });
    return _audioMuted;
  }

  /// Toggle video on/off
  /// Returns new video state (true = video on)
  bool toggleVideo() {
    _videoMuted = !_videoMuted;
    _localStream?.getVideoTracks().forEach((track) {
      track.enabled = !_videoMuted;
    });
    return !_videoMuted;
  }

  /// Switch between front/back camera
  Future<void> switchCamera() async {
    final videoTrack = _localStream?.getVideoTracks().firstOrNull;
    if (videoTrack != null) {
      await Helper.switchCamera(videoTrack);
    }
  }

  /// Stop all tracks and release resources
  Future<void> stopAllTracks() async {
    await _localStream?.dispose();
    _localStream = null;
    _audioMuted = false;
    _videoMuted = false;
  }

  /// Get current media state
  MediaState getState() {
    return MediaState(
      hasAudio: _localStream?.getAudioTracks().isNotEmpty ?? false,
      hasVideo: _localStream?.getVideoTracks().isNotEmpty ?? false,
      audioMuted: _audioMuted,
      videoMuted: _videoMuted,
    );
  }

  /// Get the local MediaStream
  MediaStream? get localStream => _localStream;
}
```

### 3. Error Handling

Handle these cases:
- Permission denied
- Device not found
- Platform not supported

```dart
Future<MediaStream> requestMedia(bool video) async {
  try {
    // ... existing code
  } on PlatformException catch (e) {
    if (e.code == 'permissionDenied') {
      throw MediaPermissionDeniedException();
    }
    rethrow;
  }
}

class MediaPermissionDeniedException implements Exception {
  final String message = 'Camera/microphone permission denied';
}
```

## Acceptance Criteria
- [ ] MediaService class created
- [ ] requestMedia works for audio and video
- [ ] toggleMute works
- [ ] toggleVideo works
- [ ] switchCamera works
- [ ] stopAllTracks cleans up properly
- [ ] Error handling for permissions
- [ ] Unit tests

## Notes
- flutter_webrtc handles cross-platform (iOS, Android, Web, Desktop)
- This mirrors the web MediaService API
- VoIPService (Task 09) will use this
