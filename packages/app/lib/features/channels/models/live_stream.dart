import 'dart:convert';
import 'dart:typed_data';

import 'package:equatable/equatable.dart';

/// State of a live stream.
enum LiveStreamState {
  /// Stream is being set up but not yet broadcasting.
  starting,

  /// Stream is actively broadcasting frames.
  live,

  /// Stream has ended (either by owner or timeout).
  ended,
}

/// Metadata for a live stream session.
class LiveStreamMetadata extends Equatable {
  /// Unique identifier for this stream session.
  final String streamId;

  /// The channel this stream belongs to.
  final String channelId;

  /// Human-readable title for the stream.
  final String title;

  /// Current state of the stream.
  final LiveStreamState state;

  /// When the stream was started.
  final DateTime startedAt;

  /// When the stream ended (null if still live or starting).
  final DateTime? endedAt;

  /// Current number of viewers.
  final int viewerCount;

  /// Total number of frames sent so far.
  final int frameCount;

  const LiveStreamMetadata({
    required this.streamId,
    required this.channelId,
    required this.title,
    required this.state,
    required this.startedAt,
    this.endedAt,
    this.viewerCount = 0,
    this.frameCount = 0,
  });

  Map<String, dynamic> toJson() => {
        'stream_id': streamId,
        'channel_id': channelId,
        'title': title,
        'state': state.name,
        'started_at': startedAt.toIso8601String(),
        'ended_at': endedAt?.toIso8601String(),
        'viewer_count': viewerCount,
        'frame_count': frameCount,
      };

  factory LiveStreamMetadata.fromJson(Map<String, dynamic> json) {
    return LiveStreamMetadata(
      streamId: json['stream_id'] as String,
      channelId: json['channel_id'] as String,
      title: json['title'] as String,
      state: LiveStreamState.values.firstWhere(
        (e) => e.name == json['state'],
        orElse: () => LiveStreamState.ended,
      ),
      startedAt: DateTime.parse(json['started_at'] as String),
      endedAt: json['ended_at'] != null
          ? DateTime.parse(json['ended_at'] as String)
          : null,
      viewerCount: json['viewer_count'] as int? ?? 0,
      frameCount: json['frame_count'] as int? ?? 0,
    );
  }

  LiveStreamMetadata copyWith({
    String? streamId,
    String? channelId,
    String? title,
    LiveStreamState? state,
    DateTime? startedAt,
    DateTime? endedAt,
    int? viewerCount,
    int? frameCount,
  }) {
    return LiveStreamMetadata(
      streamId: streamId ?? this.streamId,
      channelId: channelId ?? this.channelId,
      title: title ?? this.title,
      state: state ?? this.state,
      startedAt: startedAt ?? this.startedAt,
      endedAt: endedAt ?? this.endedAt,
      viewerCount: viewerCount ?? this.viewerCount,
      frameCount: frameCount ?? this.frameCount,
    );
  }

  @override
  List<Object?> get props => [
        streamId,
        channelId,
        title,
        state,
        startedAt,
        endedAt,
        viewerCount,
        frameCount,
      ];
}

/// A single encrypted frame in a live stream.
///
/// Frames are encrypted with the channel's encryption key and signed
/// by the owner. The VPS fans out frames to all connected subscribers
/// without storing them (pure streaming relay, no store-and-forward).
class LiveStreamFrame extends Equatable {
  /// The stream this frame belongs to.
  final String streamId;

  /// Monotonically increasing frame sequence number.
  final int frameIndex;

  /// The encrypted frame data (ChaCha20-Poly1305 ciphertext).
  final Uint8List encryptedData;

  /// Ed25519 signature over the encrypted data, base64-encoded.
  final String signature;

  /// The signer's Ed25519 public key, base64-encoded.
  final String authorPubkey;

  /// Frame timestamp (milliseconds since stream start).
  final int timestampMs;

  const LiveStreamFrame({
    required this.streamId,
    required this.frameIndex,
    required this.encryptedData,
    required this.signature,
    required this.authorPubkey,
    required this.timestampMs,
  });

  Map<String, dynamic> toJson() => {
        'stream_id': streamId,
        'frame_index': frameIndex,
        'encrypted_data': base64Encode(encryptedData),
        'signature': signature,
        'author_pubkey': authorPubkey,
        'timestamp_ms': timestampMs,
      };

  factory LiveStreamFrame.fromJson(Map<String, dynamic> json) {
    return LiveStreamFrame(
      streamId: json['stream_id'] as String,
      frameIndex: json['frame_index'] as int,
      encryptedData: base64Decode(json['encrypted_data'] as String),
      signature: json['signature'] as String,
      authorPubkey: json['author_pubkey'] as String,
      timestampMs: json['timestamp_ms'] as int,
    );
  }

  @override
  List<Object?> get props => [
        streamId,
        frameIndex,
        encryptedData,
        signature,
        authorPubkey,
        timestampMs,
      ];
}
