import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:uuid/uuid.dart';

import '../models/channel.dart';
import '../models/chunk.dart';
import '../models/live_stream.dart';
import 'channel_crypto_service.dart';
import 'channel_service.dart';

/// Callback type for sending messages over WebSocket.
typedef StreamWebSocketSender = void Function(Map<String, dynamic> message);

/// Callback type for receiving live stream frames.
typedef LiveStreamFrameHandler = void Function(LiveStreamFrame frame);

/// Callback type for stream state changes.
typedef LiveStreamStateHandler = void Function(LiveStreamMetadata metadata);

/// Service for live streaming over channels.
///
/// The live stream flow:
/// 1. Owner starts a live stream (sends stream-start via WebSocket)
/// 2. VPS notifies all connected subscribers
/// 3. Owner sends encrypted frames (stream-frame messages)
/// 4. VPS fans out frames to all subscribers in real-time (SFU pattern)
/// 5. Owner ends the stream (stream-end message)
/// 6. Optionally, recorded frames are converted to chunks for VOD
class LiveStreamService {
  final ChannelCryptoService _cryptoService;
  final ChannelService _channelService;
  final _uuid = const Uuid();

  /// The currently active stream (if any).
  LiveStreamMetadata? _activeStream;

  /// Frames collected during the stream for VOD conversion.
  final List<LiveStreamFrame> _recordedFrames = [];

  /// Maximum recorded frames before discarding oldest (memory protection).
  static const int maxRecordedFrames = 10000;

  /// WebSocket sender function.
  StreamWebSocketSender? _sender;

  /// Handler for incoming stream frames (subscriber side).
  LiveStreamFrameHandler? onFrame;

  /// Handler for stream state changes.
  LiveStreamStateHandler? onStateChange;

  LiveStreamService({
    required ChannelCryptoService cryptoService,
    required ChannelService channelService,
  })  : _cryptoService = cryptoService,
        _channelService = channelService;

  /// Set the WebSocket sender.
  void setSender(StreamWebSocketSender sender) {
    _sender = sender;
  }

  /// Clear the WebSocket sender.
  void clearSender() {
    _sender = null;
  }

  /// Get the currently active stream metadata.
  LiveStreamMetadata? get activeStream => _activeStream;

  /// Get the number of recorded frames.
  int get recordedFrameCount => _recordedFrames.length;

  // ---------------------------------------------------------------------------
  // Owner side: starting and sending frames
  // ---------------------------------------------------------------------------

  /// Start a new live stream.
  ///
  /// [channel] must be an owned channel.
  /// [title] is the human-readable title for the stream.
  ///
  /// Returns the stream metadata. Sends a stream-start message via WebSocket.
  LiveStreamMetadata startStream({
    required Channel channel,
    required String title,
  }) {
    if (channel.role != ChannelRole.owner) {
      throw LiveStreamServiceException(
        'Only the channel owner can start a live stream',
      );
    }

    if (_activeStream != null &&
        _activeStream!.state != LiveStreamState.ended) {
      throw LiveStreamServiceException(
        'A stream is already active for this channel',
      );
    }

    final streamId = 'stream_${_uuid.v4().substring(0, 8)}';

    _activeStream = LiveStreamMetadata(
      streamId: streamId,
      channelId: channel.id,
      title: title,
      state: LiveStreamState.live,
      startedAt: DateTime.now(),
    );

    _recordedFrames.clear();

    // Notify VPS
    _sender?.call({
      'type': 'stream-start',
      'streamId': streamId,
      'channelId': channel.id,
      'title': title,
    });

    onStateChange?.call(_activeStream!);

    return _activeStream!;
  }

  /// Send a frame in the active live stream.
  ///
  /// [data] is the raw frame data (e.g., audio/video bytes).
  /// [channel] is the owned channel.
  ///
  /// Encrypts the data with the channel's encryption key and signs it.
  Future<LiveStreamFrame> sendFrame({
    required Uint8List data,
    required Channel channel,
  }) async {
    if (_activeStream == null ||
        _activeStream!.state != LiveStreamState.live) {
      throw LiveStreamServiceException('No active live stream');
    }
    if (channel.encryptionKeyPrivate == null) {
      throw LiveStreamServiceException(
        'Cannot send frame: no encryption private key',
      );
    }
    if (channel.ownerSigningKeyPrivate == null) {
      throw LiveStreamServiceException(
        'Cannot send frame: no signing private key',
      );
    }

    final frameIndex = _activeStream!.frameCount;
    final timestampMs = DateTime.now()
        .difference(_activeStream!.startedAt)
        .inMilliseconds;

    // Encrypt the frame data using the channel's content key
    final payload = ChunkPayload(
      type: ContentType.audio,
      payload: data,
      timestamp: DateTime.now(),
    );

    final encryptedData = await _cryptoService.encryptPayload(
      payload,
      channel.encryptionKeyPrivate!,
      channel.manifest.keyEpoch,
    );

    // Sign the encrypted data
    final signature = await _cryptoService.signChunk(
      encryptedData,
      channel.ownerSigningKeyPrivate!,
    );

    final frame = LiveStreamFrame(
      streamId: _activeStream!.streamId,
      frameIndex: frameIndex,
      encryptedData: encryptedData,
      signature: signature,
      authorPubkey: channel.manifest.ownerKey,
      timestampMs: timestampMs,
    );

    // Update metadata
    _activeStream = _activeStream!.copyWith(
      frameCount: frameIndex + 1,
    );

    // Record for VOD conversion
    if (_recordedFrames.length < maxRecordedFrames) {
      _recordedFrames.add(frame);
    }

    // Send via WebSocket
    _sender?.call({
      'type': 'stream-frame',
      'streamId': _activeStream!.streamId,
      'channelId': channel.id,
      'frame': frame.toJson(),
    });

    return frame;
  }

  /// End the active live stream.
  ///
  /// Sends a stream-end message and updates the metadata.
  LiveStreamMetadata endStream() {
    if (_activeStream == null ||
        _activeStream!.state != LiveStreamState.live) {
      throw LiveStreamServiceException('No active live stream to end');
    }

    _activeStream = _activeStream!.copyWith(
      state: LiveStreamState.ended,
      endedAt: DateTime.now(),
    );

    // Notify VPS
    _sender?.call({
      'type': 'stream-end',
      'streamId': _activeStream!.streamId,
      'channelId': _activeStream!.channelId,
    });

    onStateChange?.call(_activeStream!);

    return _activeStream!;
  }

  // ---------------------------------------------------------------------------
  // Subscriber side: receiving frames
  // ---------------------------------------------------------------------------

  /// Handle an incoming stream-start message.
  void handleStreamStart(Map<String, dynamic> data) {
    _activeStream = LiveStreamMetadata(
      streamId: data['streamId'] as String,
      channelId: data['channelId'] as String,
      title: data['title'] as String? ?? 'Live Stream',
      state: LiveStreamState.live,
      startedAt: DateTime.now(),
    );

    onStateChange?.call(_activeStream!);
  }

  /// Handle an incoming stream-frame message.
  void handleStreamFrame(Map<String, dynamic> data) {
    try {
      final frameJson = data['frame'] as Map<String, dynamic>;
      final frame = LiveStreamFrame.fromJson(frameJson);
      onFrame?.call(frame);
    } catch (e) {
      // Silently drop malformed frames
    }
  }

  /// Handle an incoming stream-end message.
  void handleStreamEnd(Map<String, dynamic> data) {
    if (_activeStream != null) {
      _activeStream = _activeStream!.copyWith(
        state: LiveStreamState.ended,
        endedAt: DateTime.now(),
      );
      onStateChange?.call(_activeStream!);
    }
  }

  /// Update the viewer count (received from VPS).
  void updateViewerCount(int count) {
    if (_activeStream != null) {
      _activeStream = _activeStream!.copyWith(viewerCount: count);
      onStateChange?.call(_activeStream!);
    }
  }

  // ---------------------------------------------------------------------------
  // VOD conversion: convert recorded frames to chunks
  // ---------------------------------------------------------------------------

  /// Convert recorded stream frames to chunks for VOD distribution.
  ///
  /// After a stream ends, this packages all recorded frames into the
  /// normal chunk distribution system. Subscribers who watched live
  /// already have the data and can register chunks locally.
  ///
  /// Returns the list of chunks ready for distribution.
  Future<List<Chunk>> convertToVod({
    required Channel channel,
    required int startSequence,
    required String routingHash,
  }) async {
    if (_activeStream == null ||
        _activeStream!.state != LiveStreamState.ended) {
      throw LiveStreamServiceException(
        'Cannot convert to VOD: stream is not ended',
      );
    }
    if (_recordedFrames.isEmpty) {
      throw LiveStreamServiceException(
        'Cannot convert to VOD: no recorded frames',
      );
    }
    if (channel.role != ChannelRole.owner) {
      throw LiveStreamServiceException(
        'Only the channel owner can convert streams to VOD',
      );
    }

    final allChunks = <Chunk>[];
    var currentSequence = startSequence;

    // Package frames in batches to keep chunk sizes manageable
    const framesPerChunk = 50;

    for (var i = 0; i < _recordedFrames.length; i += framesPerChunk) {
      final end =
          (i + framesPerChunk).clamp(0, _recordedFrames.length);
      final batch = _recordedFrames.sublist(i, end);

      // Serialize the batch of frames
      final framesJson = batch.map((f) => f.toJson()).toList();
      final batchBytes =
          Uint8List.fromList(utf8.encode(jsonEncode(framesJson)));

      final payload = ChunkPayload(
        type: ContentType.video,
        payload: batchBytes,
        metadata: {
          'stream_id': _activeStream!.streamId,
          'batch_index': i ~/ framesPerChunk,
          'frame_start': i,
          'frame_end': end,
          'is_vod': true,
        },
        timestamp: DateTime.now(),
      );

      final chunks = await _channelService.splitIntoChunks(
        payload: payload,
        channel: channel,
        sequence: currentSequence,
        routingHash: routingHash,
      );

      allChunks.addAll(chunks);
      currentSequence++;
    }

    return allChunks;
  }

  /// Check if a subscriber already has live stream data that matches VOD chunks.
  ///
  /// Subscribers who watched the stream live already have the encrypted frame
  /// data. This returns the frame indices that the subscriber has cached,
  /// so they can be registered as chunks without re-downloading.
  List<int> getLocalFrameIndices() {
    return _recordedFrames.map((f) => f.frameIndex).toList();
  }

  /// Clear recorded frames (after VOD conversion or to free memory).
  void clearRecordedFrames() {
    _recordedFrames.clear();
  }

  /// Reset the stream state.
  void reset() {
    _activeStream = null;
    _recordedFrames.clear();
  }
}

/// Exception thrown by live stream service operations.
class LiveStreamServiceException implements Exception {
  final String message;
  LiveStreamServiceException(this.message);

  @override
  String toString() => 'LiveStreamServiceException: $message';
}
