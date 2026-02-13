import 'dart:convert';
import 'dart:typed_data';

import 'package:equatable/equatable.dart';

/// Content type for chunk payloads.
enum ContentType {
  text,
  file,
  audio,
  video,
  document,
  poll;

  static ContentType fromString(String value) {
    return ContentType.values.firstWhere(
      (e) => e.name == value,
      orElse: () => ContentType.text,
    );
  }
}

/// The encrypted payload inside a chunk, visible only to channel members.
///
/// Contains the actual content along with metadata for display/playback.
class ChunkPayload extends Equatable {
  /// The type of content in this payload.
  final ContentType type;

  /// The raw content bytes (text encoded as UTF-8, files as raw bytes).
  final Uint8List payload;

  /// Optional metadata (filename, duration, mimetype, dimensions, etc.).
  final Map<String, dynamic> metadata;

  /// Reference to another message for threading (nullable).
  final String? replyTo;

  /// The admin ID who authored this content (for multi-admin channels).
  final String? author;

  /// Signed timestamp of when the content was created.
  final DateTime timestamp;

  const ChunkPayload({
    required this.type,
    required this.payload,
    this.metadata = const {},
    this.replyTo,
    this.author,
    required this.timestamp,
  });

  /// Serialize to bytes for encryption.
  Uint8List toBytes() {
    final json = <String, dynamic>{
      'type': type.name,
      'payload': base64Encode(payload),
      'metadata': metadata,
      'timestamp': timestamp.toIso8601String(),
    };
    if (replyTo != null) json['reply_to'] = replyTo;
    if (author != null) json['author'] = author;
    return Uint8List.fromList(utf8.encode(jsonEncode(json)));
  }

  /// Deserialize from decrypted bytes.
  ///
  /// Throws [FormatException] if the bytes cannot be decoded as valid JSON
  /// or if the payload field contains invalid base64.
  factory ChunkPayload.fromBytes(Uint8List bytes) {
    final Map<String, dynamic> json;
    try {
      json = jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>;
    } catch (e) {
      throw FormatException('Invalid chunk payload format: $e');
    }

    final Uint8List payloadBytes;
    try {
      payloadBytes = base64Decode(json['payload'] as String);
    } on FormatException {
      throw const FormatException('Invalid base64 in chunk payload content');
    }

    return ChunkPayload(
      type: ContentType.fromString(json['type'] as String),
      payload: payloadBytes,
      metadata: (json['metadata'] as Map<String, dynamic>?) ?? {},
      replyTo: json['reply_to'] as String?,
      author: json['author'] as String?,
      timestamp: DateTime.parse(json['timestamp'] as String),
    );
  }

  @override
  List<Object?> get props =>
      [type, payload, metadata, replyTo, author, timestamp];
}

/// A chunk — the atomic unit of content that flows through the VPS relay.
///
/// The plaintext header is visible to the VPS for routing. The signed envelope
/// prevents forgery. The encrypted payload is readable only by channel members.
class Chunk extends Equatable {
  // -- Plaintext header (VPS can see) --

  /// Unique identifier for this chunk.
  final String chunkId;

  /// Opaque routing hash for DHT lookup, derived from channel secret + epoch.
  final String routingHash;

  /// Sequence number within the channel (monotonically increasing).
  final int sequence;

  /// Index of this chunk within a multi-chunk message (0-based).
  final int chunkIndex;

  /// Total number of chunks in this message.
  final int totalChunks;

  /// Size of the encrypted payload in bytes.
  final int size;

  // -- Signed envelope (VPS cannot forge) --

  /// Ed25519 signature over the encrypted payload, base64-encoded.
  final String signature;

  /// The signer's Ed25519 public key, base64-encoded.
  final String authorPubkey;

  // -- Encrypted payload (VPS cannot read) --

  /// The encrypted payload bytes (ChaCha20-Poly1305 ciphertext).
  final Uint8List encryptedPayload;

  const Chunk({
    required this.chunkId,
    required this.routingHash,
    required this.sequence,
    required this.chunkIndex,
    required this.totalChunks,
    required this.size,
    required this.signature,
    required this.authorPubkey,
    required this.encryptedPayload,
  });

  /// The bytes that are signed: the encrypted payload.
  /// The signature covers the ciphertext so the VPS cannot swap payloads.
  Uint8List get signedData => encryptedPayload;

  Map<String, dynamic> toJson() => {
        'chunk_id': chunkId,
        'routing_hash': routingHash,
        'sequence': sequence,
        'chunk_index': chunkIndex,
        'total_chunks': totalChunks,
        'size': size,
        'signature': signature,
        'author_pubkey': authorPubkey,
        'encrypted_payload': base64Encode(encryptedPayload),
      };

  factory Chunk.fromJson(Map<String, dynamic> json) {
    final encryptedPayloadBase64 = json['encrypted_payload'] as String;
    final Uint8List encryptedPayload;
    try {
      encryptedPayload = base64Decode(encryptedPayloadBase64);
    } on FormatException {
      throw FormatException(
          'Invalid base64 in encrypted_payload for chunk ${json['chunk_id']}');
    }
    return Chunk(
      chunkId: json['chunk_id'] as String,
      routingHash: json['routing_hash'] as String,
      sequence: json['sequence'] as int,
      chunkIndex: json['chunk_index'] as int,
      totalChunks: json['total_chunks'] as int,
      size: json['size'] as int,
      signature: json['signature'] as String,
      authorPubkey: json['author_pubkey'] as String,
      encryptedPayload: encryptedPayload,
    );
  }

  Chunk copyWith({
    String? chunkId,
    String? routingHash,
    int? sequence,
    int? chunkIndex,
    int? totalChunks,
    int? size,
    String? signature,
    String? authorPubkey,
    Uint8List? encryptedPayload,
  }) {
    return Chunk(
      chunkId: chunkId ?? this.chunkId,
      routingHash: routingHash ?? this.routingHash,
      sequence: sequence ?? this.sequence,
      chunkIndex: chunkIndex ?? this.chunkIndex,
      totalChunks: totalChunks ?? this.totalChunks,
      size: size ?? this.size,
      signature: signature ?? this.signature,
      authorPubkey: authorPubkey ?? this.authorPubkey,
      encryptedPayload: encryptedPayload ?? this.encryptedPayload,
    );
  }

  @override
  List<Object?> get props => [
        chunkId,
        routingHash,
        sequence,
        chunkIndex,
        totalChunks,
        size,
        signature,
        authorPubkey,
        encryptedPayload,
      ];
}
