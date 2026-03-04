import 'dart:typed_data';

import '../../../core/logging/logger_service.dart';
import '../models/channel.dart';
import '../models/live_stream.dart';
import 'live_stream_service.dart';

/// RTMP FLV tag types.
enum RtmpTagType {
  /// Audio data (FLV tag type 8).
  audio(8),

  /// Video data (FLV tag type 9).
  video(9),

  /// Script data / metadata (FLV tag type 18).
  scriptData(18);

  final int value;
  const RtmpTagType(this.value);

  static RtmpTagType? fromValue(int value) {
    for (final type in values) {
      if (type.value == value) return type;
    }
    return null;
  }
}

/// Represents an RTMP-style frame (FLV tag) received from an external source.
///
/// This mirrors the structure of an FLV tag as used in RTMP streams:
/// - [tagType]: audio (8), video (9), or script data (18)
/// - [timestampMs]: presentation timestamp in milliseconds
/// - [data]: raw tag body (codec-specific payload)
class RtmpFrame {
  /// The type of this tag (audio, video, or script data).
  final RtmpTagType tagType;

  /// Presentation timestamp in milliseconds relative to stream start.
  final int timestampMs;

  /// Raw payload bytes (codec-specific: H.264 NALUs, AAC frames, etc.).
  final Uint8List data;

  const RtmpFrame({
    required this.tagType,
    required this.timestampMs,
    required this.data,
  });

  /// Parse an RTMP frame from a raw FLV tag byte buffer.
  ///
  /// Expects the buffer to contain at least an 11-byte FLV tag header:
  ///   - byte 0: tag type (8=audio, 9=video, 18=script)
  ///   - bytes 1-3: data size (big-endian, 24-bit)
  ///   - bytes 4-6: timestamp low 24 bits (big-endian)
  ///   - byte 7: timestamp high 8 bits (extension)
  ///   - bytes 8-10: stream ID (always 0)
  ///   - bytes 11+: tag body
  ///
  /// Throws [FormatException] if the buffer is too short or the tag type
  /// is unrecognized.
  factory RtmpFrame.fromFlvTag(Uint8List bytes) {
    if (bytes.length < 11) {
      throw FormatException(
        'FLV tag too short: expected at least 11 bytes, got ${bytes.length}',
      );
    }

    final tagTypeValue = bytes[0];
    final tagType = RtmpTagType.fromValue(tagTypeValue);
    if (tagType == null) {
      throw FormatException('Unknown FLV tag type: $tagTypeValue');
    }

    // Parse 24-bit big-endian data size
    final dataSize = (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];

    // Parse timestamp: 24-bit low + 8-bit high extension
    final timestampLow = (bytes[4] << 16) | (bytes[5] << 8) | bytes[6];
    final timestampHigh = bytes[7];
    final timestampMs = (timestampHigh << 24) | timestampLow;

    // Extract tag body
    final headerSize = 11;
    final availableData = bytes.length - headerSize;
    final bodySize = dataSize.clamp(0, availableData);
    final data = bytes.sublist(headerSize, headerSize + bodySize);

    return RtmpFrame(
      tagType: tagType,
      timestampMs: timestampMs,
      data: Uint8List.fromList(data),
    );
  }

  /// Create an RtmpFrame directly from raw data with explicit parameters.
  ///
  /// Use this when receiving pre-parsed frame data from a transport layer
  /// that has already extracted the tag type and timestamp.
  factory RtmpFrame.raw({
    required RtmpTagType tagType,
    required int timestampMs,
    required Uint8List data,
  }) {
    return RtmpFrame(tagType: tagType, timestampMs: timestampMs, data: data);
  }
}

/// Protocol adapter that converts RTMP-style binary frame data into the
/// internal [LiveStreamFrame] format and feeds it into the existing
/// stream relay pipeline.
///
/// This service does not implement a full RTMP server. Instead, it acts as
/// a data format converter: external code (e.g., a native plugin or FFI
/// bridge) delivers raw RTMP/FLV frames, and this service encrypts and
/// signs them using the channel's keys, then hands them to
/// [LiveStreamService] for relay.
///
/// Usage:
/// ```dart
/// final ingest = RtmpIngestService(liveStreamService: liveStream);
/// ingest.start(channel: myChannel);
///
/// // Feed raw FLV tags from an external RTMP source:
/// ingest.ingestFlvTag(flvTagBytes);
///
/// // Or feed pre-parsed frames:
/// ingest.ingestFrame(RtmpFrame.raw(
///   tagType: RtmpTagType.video,
///   timestampMs: 1234,
///   data: h264NaluBytes,
/// ));
///
/// ingest.stop();
/// ```
class RtmpIngestService {
  final LiveStreamService _liveStreamService;
  final _logger = LoggerService.instance;

  /// The channel being ingested into.
  Channel? _channel;

  /// Whether the ingest pipeline is active.
  bool _active = false;

  /// Number of frames ingested in the current session.
  int _ingestedFrameCount = 0;

  /// Number of frames that failed to ingest.
  int _droppedFrameCount = 0;

  /// Whether the ingest pipeline is currently active.
  bool get isActive => _active;

  /// Number of frames successfully ingested in the current session.
  int get ingestedFrameCount => _ingestedFrameCount;

  /// Number of frames dropped due to errors in the current session.
  int get droppedFrameCount => _droppedFrameCount;

  RtmpIngestService({
    required LiveStreamService liveStreamService,
  }) : _liveStreamService = liveStreamService;

  /// Start the RTMP ingest pipeline.
  ///
  /// Ensures a live stream is active on [_liveStreamService] for the given
  /// [channel]. If no stream is active, starts one with the given [title].
  /// If a stream is already active, joins it.
  void start({
    required Channel channel,
    String title = 'RTMP Ingest Stream',
  }) {
    if (_active) {
      throw LiveStreamServiceException(
        'RTMP ingest is already active',
      );
    }

    _channel = channel;
    _ingestedFrameCount = 0;
    _droppedFrameCount = 0;
    _active = true;

    // Start a live stream if one is not already active
    if (_liveStreamService.activeStream == null ||
        _liveStreamService.activeStream!.state != LiveStreamState.live) {
      _liveStreamService.startStream(channel: channel, title: title);
    }

    _logger.debug(
        'RtmpIngestService', 'RTMP ingest started for channel ${channel.id}');
  }

  /// Stop the RTMP ingest pipeline.
  ///
  /// Does NOT end the live stream -- call [LiveStreamService.endStream]
  /// separately if you also want to end the broadcast.
  void stop() {
    _active = false;
    _channel = null;
    _logger.debug(
      'RtmpIngestService',
      'RTMP ingest stopped '
          '(ingested: $_ingestedFrameCount, dropped: $_droppedFrameCount)',
    );
  }

  /// Ingest a raw FLV tag byte buffer.
  ///
  /// Parses the FLV tag header, extracts the payload, and feeds it into
  /// the live stream relay pipeline. Script data tags (type 18) are
  /// silently skipped as they contain metadata, not A/V frames.
  ///
  /// Errors during parsing or encryption are logged at debug level and
  /// the frame is dropped (the stream continues).
  Future<void> ingestFlvTag(Uint8List flvTagBytes) async {
    if (!_active || _channel == null) return;

    try {
      final rtmpFrame = RtmpFrame.fromFlvTag(flvTagBytes);
      await ingestFrame(rtmpFrame);
    } catch (e) {
      _droppedFrameCount++;
      _logger.debug(
        'RtmpIngestService',
        'Failed to parse FLV tag (${flvTagBytes.length} bytes): $e',
      );
    }
  }

  /// Ingest a pre-parsed RTMP frame.
  ///
  /// Converts the frame to the internal format and sends it through the
  /// live stream service for encryption, signing, and relay.
  ///
  /// Script data frames are silently skipped.
  Future<void> ingestFrame(RtmpFrame frame) async {
    if (!_active || _channel == null) return;

    // Skip script data tags -- they're metadata, not A/V content
    if (frame.tagType == RtmpTagType.scriptData) return;

    try {
      await _liveStreamService.sendFrame(
        data: frame.data,
        channel: _channel!,
      );
      _ingestedFrameCount++;
    } catch (e) {
      _droppedFrameCount++;
      _logger.debug(
        'RtmpIngestService',
        'Failed to ingest ${frame.tagType.name} frame '
            'at ${frame.timestampMs}ms (${frame.data.length} bytes): $e',
      );
    }
  }
}
