import 'package:flutter/services.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../logging/logger_service.dart';
import '../models/media_device.dart';

/// Represents the current state of media tracks.
class MediaState {
  /// Whether an audio track is present.
  final bool hasAudio;

  /// Whether a video track is present.
  final bool hasVideo;

  /// Whether audio is currently muted.
  final bool audioMuted;

  /// Whether video is currently disabled.
  final bool videoMuted;

  const MediaState({
    required this.hasAudio,
    required this.hasVideo,
    required this.audioMuted,
    required this.videoMuted,
  });

  /// Creates an initial state with no tracks.
  const MediaState.initial()
      : hasAudio = false,
        hasVideo = false,
        audioMuted = false,
        videoMuted = false;

  /// Creates a copy with modified fields.
  MediaState copyWith({
    bool? hasAudio,
    bool? hasVideo,
    bool? audioMuted,
    bool? videoMuted,
  }) {
    return MediaState(
      hasAudio: hasAudio ?? this.hasAudio,
      hasVideo: hasVideo ?? this.hasVideo,
      audioMuted: audioMuted ?? this.audioMuted,
      videoMuted: videoMuted ?? this.videoMuted,
    );
  }

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    return other is MediaState &&
        other.hasAudio == hasAudio &&
        other.hasVideo == hasVideo &&
        other.audioMuted == audioMuted &&
        other.videoMuted == videoMuted;
  }

  @override
  int get hashCode {
    return Object.hash(hasAudio, hasVideo, audioMuted, videoMuted);
  }

  @override
  String toString() {
    return 'MediaState(hasAudio: $hasAudio, hasVideo: $hasVideo, '
        'audioMuted: $audioMuted, videoMuted: $videoMuted)';
  }
}

/// Exception thrown when camera/microphone permission is denied.
class MediaPermissionDeniedException implements Exception {
  /// The error message describing what permission was denied.
  final String message;

  /// Creates a new permission denied exception.
  const MediaPermissionDeniedException([
    this.message = 'Camera/microphone permission denied',
  ]);

  @override
  String toString() => 'MediaPermissionDeniedException: $message';
}

/// Exception thrown when a media device is not found.
class MediaDeviceNotFoundException implements Exception {
  /// The error message describing which device was not found.
  final String message;

  /// Creates a new device not found exception.
  const MediaDeviceNotFoundException([
    this.message = 'Media device not found',
  ]);

  @override
  String toString() => 'MediaDeviceNotFoundException: $message';
}

/// Exception thrown for general media errors.
class MediaException implements Exception {
  /// The error message.
  final String message;

  /// Creates a new media exception.
  const MediaException(this.message);

  @override
  String toString() => 'MediaException: $message';
}

/// Service for managing camera and microphone access.
///
/// Provides functionality to:
/// - Request media access (camera and/or microphone)
/// - Toggle audio mute
/// - Toggle video on/off
/// - Switch between front and back cameras
/// - Stop all media tracks and release resources
///
/// This service uses flutter_webrtc for cross-platform media access
/// (iOS, Android, Web, Desktop).
class MediaService {
  static const String _tag = 'MediaService';

  MediaStream? _localStream;
  bool _audioMuted = false;
  bool _videoMuted = false;

  // Selected device IDs (null = system default)
  String? _selectedAudioInputId;
  String? _selectedAudioOutputId;
  String? _selectedVideoInputId;

  // Audio processing settings
  bool _noiseSuppression = true;
  bool _echoCancellation = true;
  bool _autoGainControl = true;

  SharedPreferences? _prefs;

  /// Initialize media preferences from SharedPreferences.
  void initPreferences(SharedPreferences prefs) {
    _prefs = prefs;
    // Use _nonEmpty to avoid empty-string device IDs creating invalid constraints
    _selectedAudioInputId = _nonEmpty(prefs.getString('media_audioInputId'));
    _selectedAudioOutputId = _nonEmpty(prefs.getString('media_audioOutputId'));
    _selectedVideoInputId = _nonEmpty(prefs.getString('media_videoInputId'));
    _noiseSuppression = prefs.getBool('media_noiseSuppression') ?? true;
    _echoCancellation = prefs.getBool('media_echoCancellation') ?? true;
    _autoGainControl = prefs.getBool('media_autoGainControl') ?? true;
  }

  static String? _nonEmpty(String? value) =>
      (value != null && value.isNotEmpty) ? value : null;

  /// Get the currently selected audio input device ID.
  String? get selectedAudioInputId => _selectedAudioInputId;

  /// Get the currently selected audio output device ID.
  String? get selectedAudioOutputId => _selectedAudioOutputId;

  /// Get the currently selected video input device ID.
  String? get selectedVideoInputId => _selectedVideoInputId;

  /// Whether noise suppression is enabled.
  bool get noiseSuppression => _noiseSuppression;

  /// Whether echo cancellation is enabled.
  bool get echoCancellation => _echoCancellation;

  /// Whether automatic gain control is enabled.
  bool get autoGainControl => _autoGainControl;

  /// The current local media stream.
  ///
  /// Returns null if no media has been requested yet.
  MediaStream? get localStream => _localStream;

  /// Request media access for audio and optionally video.
  ///
  /// [video] - true for video call (camera + microphone),
  ///           false for audio only (microphone only).
  ///
  /// Returns the [MediaStream] containing the requested tracks.
  ///
  /// Throws:
  /// - [MediaPermissionDeniedException] if the user denies permission.
  /// - [MediaDeviceNotFoundException] if no suitable device is found.
  /// - [MediaException] for other errors.
  Future<MediaStream> requestMedia(bool video) async {
    logger.info(_tag, 'Requesting media: video=$video');

    // Stop any existing stream before requesting new one
    if (_localStream != null) {
      await stopAllTracks();
    }

    final audioConstraints = <String, dynamic>{
      'echoCancellation': _echoCancellation,
      'noiseSuppression': _noiseSuppression,
      'autoGainControl': _autoGainControl,
    };
    if (_selectedAudioInputId != null) {
      audioConstraints['deviceId'] = {'exact': _selectedAudioInputId};
    }

    final videoConstraints = video
        ? <String, dynamic>{
            'width': {'ideal': 1280},
            'height': {'ideal': 720},
            'facingMode': 'user',
            'frameRate': {'ideal': 30},
            if (_selectedVideoInputId != null)
              'deviceId': {'exact': _selectedVideoInputId},
          }
        : false;

    final constraints = <String, dynamic>{
      'audio': audioConstraints,
      'video': videoConstraints,
    };

    try {
      _localStream = await navigator.mediaDevices.getUserMedia(constraints);

      // Reset mute states for new stream
      _audioMuted = false;
      _videoMuted = false;

      logger.info(
        _tag,
        'Media acquired: audioTracks=${_localStream!.getAudioTracks().length}, '
            'videoTracks=${_localStream!.getVideoTracks().length}',
      );

      return _localStream!;
    } on PlatformException catch (e) {
      logger.error(_tag, 'Platform error requesting media', e);
      _handlePlatformException(e);
    } catch (e) {
      logger.error(_tag, 'Error requesting media', e);

      // Check for common error patterns in the error message
      final errorString = e.toString().toLowerCase();
      if (errorString.contains('permission') ||
          errorString.contains('denied') ||
          errorString.contains('notallowed')) {
        throw const MediaPermissionDeniedException();
      }
      if (errorString.contains('notfound') ||
          errorString.contains('not found') ||
          errorString.contains('no device')) {
        throw MediaDeviceNotFoundException(
          video ? 'Camera not found' : 'Microphone not found',
        );
      }

      throw MediaException('Failed to access media: $e');
    }
  }

  /// Toggle audio mute state.
  ///
  /// Returns the new mute state (true = muted, false = unmuted).
  ///
  /// If no stream is available, returns the current mute state.
  bool toggleMute() {
    _audioMuted = !_audioMuted;

    final audioTracks = _localStream?.getAudioTracks();
    if (audioTracks != null && audioTracks.isNotEmpty) {
      for (final track in audioTracks) {
        track.enabled = !_audioMuted;
      }
      logger.info(_tag, 'Audio mute toggled: muted=$_audioMuted');
    } else {
      logger.warning(_tag, 'No audio tracks to toggle mute');
    }

    return _audioMuted;
  }

  /// Toggle video on/off state.
  ///
  /// Returns the new video state (true = video on, false = video off).
  ///
  /// If no stream is available, returns the current video state.
  bool toggleVideo() {
    _videoMuted = !_videoMuted;

    final videoTracks = _localStream?.getVideoTracks();
    if (videoTracks != null && videoTracks.isNotEmpty) {
      for (final track in videoTracks) {
        track.enabled = !_videoMuted;
      }
      logger.info(_tag, 'Video toggled: disabled=$_videoMuted');
    } else {
      logger.warning(_tag, 'No video tracks to toggle');
    }

    // Return whether video is ON (opposite of muted)
    return !_videoMuted;
  }

  /// Switch between front and back cameras.
  ///
  /// Does nothing if no video track is available or if the platform
  /// doesn't support camera switching.
  Future<void> switchCamera() async {
    final videoTracks = _localStream?.getVideoTracks();
    if (videoTracks == null || videoTracks.isEmpty) {
      logger.warning(_tag, 'No video track available to switch camera');
      return;
    }

    final videoTrack = videoTracks.first;

    try {
      await Helper.switchCamera(videoTrack);
      logger.info(_tag, 'Camera switched successfully');
    } catch (e) {
      logger.error(_tag, 'Error switching camera', e);
      // Don't rethrow - camera switching is a best-effort operation
      // and may not be supported on all platforms
    }
  }

  /// Stop all tracks and release media resources.
  ///
  /// This should be called when the call ends or when the media
  /// is no longer needed to properly release camera and microphone.
  Future<void> stopAllTracks() async {
    if (_localStream == null) {
      logger.debug(_tag, 'No stream to stop');
      return;
    }

    logger.info(_tag, 'Stopping all tracks');

    try {
      // Stop individual tracks first
      for (final track in _localStream!.getTracks()) {
        await track.stop();
      }

      // Dispose the stream
      await _localStream!.dispose();
    } catch (e) {
      logger.error(_tag, 'Error stopping tracks', e);
    } finally {
      _localStream = null;
      _audioMuted = false;
      _videoMuted = false;
    }
  }

  /// Get the current media state.
  ///
  /// Returns a [MediaState] object containing information about
  /// available tracks and their mute states.
  MediaState getState() {
    final audioTracks = _localStream?.getAudioTracks();
    final videoTracks = _localStream?.getVideoTracks();

    return MediaState(
      hasAudio: audioTracks != null && audioTracks.isNotEmpty,
      hasVideo: videoTracks != null && videoTracks.isNotEmpty,
      audioMuted: _audioMuted,
      videoMuted: _videoMuted,
    );
  }

  /// Set audio mute state directly.
  ///
  /// This is useful when syncing with external state.
  void setAudioMuted(bool muted) {
    if (_audioMuted == muted) return;

    _audioMuted = muted;
    final audioTracks = _localStream?.getAudioTracks();
    if (audioTracks != null) {
      for (final track in audioTracks) {
        track.enabled = !_audioMuted;
      }
    }
    logger.info(_tag, 'Audio mute set: muted=$_audioMuted');
  }

  /// Set video disabled state directly.
  ///
  /// This is useful when syncing with external state.
  void setVideoMuted(bool muted) {
    if (_videoMuted == muted) return;

    _videoMuted = muted;
    final videoTracks = _localStream?.getVideoTracks();
    if (videoTracks != null) {
      for (final track in videoTracks) {
        track.enabled = !_videoMuted;
      }
    }
    logger.info(_tag, 'Video mute set: disabled=$_videoMuted');
  }

  /// Check if audio is currently muted.
  bool get isAudioMuted => _audioMuted;

  /// Check if video is currently disabled.
  bool get isVideoMuted => _videoMuted;

  /// Handle platform-specific exceptions and convert them to typed exceptions.
  Never _handlePlatformException(PlatformException e) {
    final code = e.code.toLowerCase();
    final message = (e.message ?? '').toLowerCase();

    // Check for permission denied
    if (code.contains('permission') ||
        code.contains('denied') ||
        code.contains('notallowed') ||
        message.contains('permission') ||
        message.contains('denied')) {
      throw MediaPermissionDeniedException(e.message ?? 'Permission denied');
    }

    // Check for device not found
    if (code.contains('notfound') ||
        code.contains('notreadable') ||
        message.contains('not found') ||
        message.contains('no device')) {
      throw MediaDeviceNotFoundException(e.message ?? 'Device not found');
    }

    // Generic media error
    throw MediaException(e.message ?? 'Unknown media error');
  }

  // ── Device enumeration ──────────────────────────────────────

  /// Enumerate all available media devices.
  Future<List<MediaDevice>> enumerateDevices() async {
    try {
      final devices = await navigator.mediaDevices.enumerateDevices();
      return devices
          .map((d) => MediaDevice(
                deviceId: d.deviceId,
                label: d.label.isNotEmpty ? d.label : _defaultLabel(d.kind ?? ''),
                kind: d.kind ?? '',
              ))
          .toList();
    } catch (e) {
      logger.error(_tag, 'Error enumerating devices', e);
      return [];
    }
  }

  /// Get available audio input devices (microphones).
  Future<List<MediaDevice>> getAudioInputs() async {
    final devices = await enumerateDevices();
    return devices.where((d) => d.isAudioInput).toList();
  }

  /// Get available audio output devices (speakers).
  Future<List<MediaDevice>> getAudioOutputs() async {
    final devices = await enumerateDevices();
    return devices.where((d) => d.isAudioOutput).toList();
  }

  /// Get available video input devices (cameras).
  Future<List<MediaDevice>> getVideoInputs() async {
    final devices = await enumerateDevices();
    return devices.where((d) => d.isVideoInput).toList();
  }

  // ── Device selection ──────────────────────────────────────

  /// Select an audio input device by ID. Pass null for system default.
  Future<void> selectAudioInput(String? deviceId) async {
    _selectedAudioInputId = deviceId;
    if (deviceId != null && deviceId.isNotEmpty) {
      await _prefs?.setString('media_audioInputId', deviceId);
    } else {
      await _prefs?.remove('media_audioInputId');
    }
    logger.info(_tag, 'Audio input selected: $deviceId');
  }

  /// Select an audio output device by ID. Pass null for system default.
  Future<void> selectAudioOutput(String? deviceId) async {
    _selectedAudioOutputId = deviceId;
    if (deviceId != null && deviceId.isNotEmpty) {
      await _prefs?.setString('media_audioOutputId', deviceId);
    } else {
      await _prefs?.remove('media_audioOutputId');
    }
    logger.info(_tag, 'Audio output selected: $deviceId');
  }

  /// Select a video input device by ID. Pass null for system default.
  Future<void> selectVideoInput(String? deviceId) async {
    _selectedVideoInputId = deviceId;
    if (deviceId != null && deviceId.isNotEmpty) {
      await _prefs?.setString('media_videoInputId', deviceId);
    } else {
      await _prefs?.remove('media_videoInputId');
    }
    logger.info(_tag, 'Video input selected: $deviceId');
  }

  // ── Audio processing settings ─────────────────────────────

  /// Enable or disable noise suppression.
  Future<void> setNoiseSuppression(bool enabled) async {
    _noiseSuppression = enabled;
    await _prefs?.setBool('media_noiseSuppression', enabled);
    logger.info(_tag, 'Noise suppression: $enabled');
  }

  /// Enable or disable echo cancellation.
  Future<void> setEchoCancellation(bool enabled) async {
    _echoCancellation = enabled;
    await _prefs?.setBool('media_echoCancellation', enabled);
    logger.info(_tag, 'Echo cancellation: $enabled');
  }

  /// Enable or disable automatic gain control.
  Future<void> setAutoGainControl(bool enabled) async {
    _autoGainControl = enabled;
    await _prefs?.setBool('media_autoGainControl', enabled);
    logger.info(_tag, 'Auto gain control: $enabled');
  }

  String _defaultLabel(String kind) {
    switch (kind) {
      case 'audioinput':
        return 'Microphone';
      case 'audiooutput':
        return 'Speaker';
      case 'videoinput':
        return 'Camera';
      default:
        return 'Unknown Device';
    }
  }

  /// Dispose the service and release all resources.
  Future<void> dispose() async {
    await stopAllTracks();
    logger.info(_tag, 'MediaService disposed');
  }
}
