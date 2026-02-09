/// Represents a media device (microphone, speaker, or camera).
class MediaDevice {
  /// Unique identifier for the device.
  final String deviceId;

  /// Human-readable label (e.g. "Built-in Microphone").
  final String label;

  /// Device kind: 'audioinput', 'audiooutput', or 'videoinput'.
  final String kind;

  const MediaDevice({
    required this.deviceId,
    required this.label,
    required this.kind,
  });

  /// Whether this is an audio input device (microphone).
  bool get isAudioInput => kind == 'audioinput';

  /// Whether this is an audio output device (speaker).
  bool get isAudioOutput => kind == 'audiooutput';

  /// Whether this is a video input device (camera).
  bool get isVideoInput => kind == 'videoinput';

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    return other is MediaDevice && other.deviceId == deviceId;
  }

  @override
  int get hashCode => deviceId.hashCode;

  @override
  String toString() => 'MediaDevice($kind: $label [$deviceId])';
}
