/// Mock MediaService for CI/integration testing.
///
/// This provides a fake MediaService implementation that doesn't require
/// real camera/microphone access, avoiding platform channel issues in
/// integration tests running without full device capabilities.
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:zajel/core/media/media_service.dart';

/// Mock implementation of MediaStream for testing.
///
/// Provides fake audio/video tracks that can be used in tests
/// without requiring real media device access.
class MockMediaStream implements MediaStream {
  final String _id;
  final bool _hasAudio;
  final bool _hasVideo;
  final List<MediaStreamTrack> _audioTracks = [];
  final List<MediaStreamTrack> _videoTracks = [];

  MockMediaStream({
    String? id,
    bool hasAudio = true,
    bool hasVideo = false,
  })  : _id = id ?? 'mock-stream-${DateTime.now().millisecondsSinceEpoch}',
        _hasAudio = hasAudio,
        _hasVideo = hasVideo {
    if (_hasAudio) {
      _audioTracks.add(MockMediaStreamTrack(kind: 'audio'));
    }
    if (_hasVideo) {
      _videoTracks.add(MockMediaStreamTrack(kind: 'video'));
    }
  }

  @override
  String get id => _id;

  @override
  List<MediaStreamTrack> getAudioTracks() => List.unmodifiable(_audioTracks);

  @override
  List<MediaStreamTrack> getVideoTracks() => List.unmodifiable(_videoTracks);

  @override
  List<MediaStreamTrack> getTracks() =>
      List.unmodifiable([..._audioTracks, ..._videoTracks]);

  @override
  Future<void> addTrack(MediaStreamTrack track,
      {bool addToNative = true}) async {
    if (track.kind == 'audio') {
      _audioTracks.add(track);
    } else if (track.kind == 'video') {
      _videoTracks.add(track);
    }
  }

  @override
  Future<void> removeTrack(MediaStreamTrack track,
      {bool removeFromNative = true}) async {
    _audioTracks.remove(track);
    _videoTracks.remove(track);
  }

  @override
  Future<void> dispose() async {
    for (final track in getTracks()) {
      await track.stop();
    }
    _audioTracks.clear();
    _videoTracks.clear();
  }

  @override
  Future<MediaStream> clone() async {
    return MockMediaStream(
      hasAudio: _hasAudio,
      hasVideo: _hasVideo,
    );
  }

  @override
  bool? get active => _audioTracks.isNotEmpty || _videoTracks.isNotEmpty;

  @override
  String get ownerTag => '';

  // Note: ownerTag setter is not in the MediaStream interface,
  // but may be needed for some WebRTC implementations
  set ownerTag(String ownerTag) {}

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// Mock implementation of MediaStreamTrack for testing.
class MockMediaStreamTrack implements MediaStreamTrack {
  final String _id;
  final String _kind;
  bool _enabled;

  MockMediaStreamTrack({
    String? id,
    required String kind,
    bool enabled = true,
  })  : _id = id ?? 'mock-track-${DateTime.now().millisecondsSinceEpoch}',
        _kind = kind,
        _enabled = enabled;

  @override
  String get id => _id;

  @override
  String? get kind => _kind;

  @override
  String? get label => 'Mock $_kind track';

  @override
  bool get enabled => _enabled;

  @override
  set enabled(bool enabled) {
    _enabled = enabled;
  }

  @override
  bool? get muted => !_enabled;

  @override
  Future<void> stop() async {
    _enabled = false;
  }

  @override
  Future<void> dispose() async {
    await stop();
  }

  @override
  Map<String, dynamic> getConstraints() => {};

  @override
  Future<void> applyConstraints([Map<String, dynamic>? constraints]) async {}

  @override
  Future<bool> hasTorch() async => false;

  @override
  Future<void> setTorch(bool torch) async {}

  @override
  Future<ByteBuffer> captureFrame() async => Uint8List(0).buffer;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// Mock MediaService that works in integration tests without real devices.
///
/// Usage:
/// ```dart
/// // In your test setup:
/// final mockMedia = MockMediaService();
/// // Override the provider or inject directly into your services
/// ```
class MockMediaService extends MediaService {
  MockMediaStream? _mockStream;
  bool _audioMuted = false;
  bool _videoMuted = false;

  /// Track if requestMedia was called for test assertions.
  int requestMediaCallCount = 0;

  /// Track the last video parameter passed to requestMedia.
  bool? lastRequestedVideo;

  @override
  MediaStream? get localStream => _mockStream;

  @override
  Future<MediaStream> requestMedia(bool video) async {
    requestMediaCallCount++;
    lastRequestedVideo = video;

    // Simulate a short delay like real media acquisition
    await Future.delayed(const Duration(milliseconds: 50));

    // Stop any existing stream
    if (_mockStream != null) {
      await stopAllTracks();
    }

    _mockStream = MockMediaStream(
      hasAudio: true,
      hasVideo: video,
    );

    _audioMuted = false;
    _videoMuted = false;

    return _mockStream!;
  }

  @override
  bool toggleMute() {
    _audioMuted = !_audioMuted;

    if (_mockStream != null) {
      for (final track in _mockStream!.getAudioTracks()) {
        track.enabled = !_audioMuted;
      }
    }

    return _audioMuted;
  }

  @override
  bool toggleVideo() {
    _videoMuted = !_videoMuted;

    if (_mockStream != null) {
      for (final track in _mockStream!.getVideoTracks()) {
        track.enabled = !_videoMuted;
      }
    }

    // Return whether video is ON (opposite of muted)
    return !_videoMuted;
  }

  @override
  Future<void> switchCamera() async {
    // No-op in mock - just simulate success
    await Future.delayed(const Duration(milliseconds: 10));
  }

  @override
  Future<void> stopAllTracks() async {
    if (_mockStream != null) {
      await _mockStream!.dispose();
      _mockStream = null;
    }
    _audioMuted = false;
    _videoMuted = false;
  }

  @override
  MediaState getState() {
    return MediaState(
      hasAudio: _mockStream?.getAudioTracks().isNotEmpty ?? false,
      hasVideo: _mockStream?.getVideoTracks().isNotEmpty ?? false,
      audioMuted: _audioMuted,
      videoMuted: _videoMuted,
    );
  }

  @override
  void setAudioMuted(bool muted) {
    if (_audioMuted == muted) return;
    _audioMuted = muted;

    if (_mockStream != null) {
      for (final track in _mockStream!.getAudioTracks()) {
        track.enabled = !_audioMuted;
      }
    }
  }

  @override
  void setVideoMuted(bool muted) {
    if (_videoMuted == muted) return;
    _videoMuted = muted;

    if (_mockStream != null) {
      for (final track in _mockStream!.getVideoTracks()) {
        track.enabled = !_videoMuted;
      }
    }
  }

  @override
  bool get isAudioMuted => _audioMuted;

  @override
  bool get isVideoMuted => _videoMuted;

  @override
  Future<void> dispose() async {
    await stopAllTracks();
  }

  /// Reset all state for test isolation.
  void reset() {
    _mockStream = null;
    _audioMuted = false;
    _videoMuted = false;
    requestMediaCallCount = 0;
    lastRequestedVideo = null;
  }
}
