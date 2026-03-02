import 'dart:convert';
import 'dart:typed_data';

import 'package:equatable/equatable.dart';

/// Types of upstream messages that subscribers can send to the channel owner.
///
/// Upstream messages travel: subscriber -> VPS -> owner.
/// Neither party sees the other's IP address.
enum UpstreamMessageType {
  /// A text reply to a specific broadcast message.
  reply,

  /// A vote on a poll (references a poll_id).
  vote,

  /// An emoji reaction to a specific broadcast message.
  reaction,
}

/// An upstream message from a subscriber to the channel owner.
///
/// Upstream messages are encrypted with the owner's public key so that
/// only the owner can read them. The VPS acts as a blind relay.
class UpstreamMessage extends Equatable {
  /// Unique identifier for this upstream message.
  final String id;

  /// The channel this message belongs to.
  final String channelId;

  /// The type of upstream message.
  final UpstreamMessageType type;

  /// The encrypted payload bytes (encrypted with owner's public key).
  final Uint8List encryptedPayload;

  /// Ed25519 signature over the encrypted payload, base64-encoded.
  /// Proves the sender authored this message without revealing identity to VPS.
  final String signature;

  /// Sender's ephemeral public key for this message, base64-encoded.
  /// Used by the owner to verify the signature. Ephemeral to prevent
  /// the VPS from correlating messages by the same sender.
  final String senderEphemeralKey;

  /// When this message was created.
  final DateTime timestamp;

  const UpstreamMessage({
    required this.id,
    required this.channelId,
    required this.type,
    required this.encryptedPayload,
    required this.signature,
    required this.senderEphemeralKey,
    required this.timestamp,
  });

  Map<String, dynamic> toJson() => {
        'id': id,
        'channel_id': channelId,
        'type': type.name,
        'encrypted_payload': base64Encode(encryptedPayload),
        'signature': signature,
        'sender_ephemeral_key': senderEphemeralKey,
        'timestamp': timestamp.toIso8601String(),
      };

  factory UpstreamMessage.fromJson(Map<String, dynamic> json) {
    return UpstreamMessage(
      id: json['id'] as String,
      channelId: json['channel_id'] as String,
      type: UpstreamMessageType.values.firstWhere(
        (e) => e.name == json['type'],
        orElse: () => UpstreamMessageType.reply,
      ),
      encryptedPayload: base64Decode(json['encrypted_payload'] as String),
      signature: json['signature'] as String,
      senderEphemeralKey: json['sender_ephemeral_key'] as String,
      timestamp: DateTime.parse(json['timestamp'] as String),
    );
  }

  @override
  List<Object?> get props => [
        id,
        channelId,
        type,
        encryptedPayload,
        signature,
        senderEphemeralKey,
        timestamp,
      ];
}

/// The decrypted content of an upstream message, visible only to the owner.
class UpstreamPayload extends Equatable {
  /// The type of upstream message.
  final UpstreamMessageType type;

  /// For replies: the text content.
  /// For reactions: the emoji/reaction identifier.
  /// For votes: empty (vote details are in [voteOptionIndex]).
  final String content;

  /// For replies and reactions: the message ID being replied to or reacted to.
  final String? replyTo;

  /// For votes: the poll ID being voted on.
  final String? pollId;

  /// For votes: the index of the selected option.
  final int? voteOptionIndex;

  /// When this upstream message was created.
  final DateTime timestamp;

  const UpstreamPayload({
    required this.type,
    required this.content,
    this.replyTo,
    this.pollId,
    this.voteOptionIndex,
    required this.timestamp,
  });

  /// Serialize to bytes for encryption.
  Uint8List toBytes() {
    final json = <String, dynamic>{
      'type': type.name,
      'content': content,
      'timestamp': timestamp.toIso8601String(),
    };
    if (replyTo != null) json['reply_to'] = replyTo;
    if (pollId != null) json['poll_id'] = pollId;
    if (voteOptionIndex != null) json['vote_option_index'] = voteOptionIndex;
    return Uint8List.fromList(utf8.encode(jsonEncode(json)));
  }

  /// Deserialize from decrypted bytes.
  factory UpstreamPayload.fromBytes(Uint8List bytes) {
    final Map<String, dynamic> json;
    try {
      json = jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>;
    } catch (e) {
      throw FormatException('Invalid upstream payload format: $e');
    }

    return UpstreamPayload(
      type: UpstreamMessageType.values.firstWhere(
        (e) => e.name == json['type'],
        orElse: () => UpstreamMessageType.reply,
      ),
      content: json['content'] as String? ?? '',
      replyTo: json['reply_to'] as String?,
      pollId: json['poll_id'] as String?,
      voteOptionIndex: json['vote_option_index'] as int?,
      timestamp: DateTime.parse(json['timestamp'] as String),
    );
  }

  @override
  List<Object?> get props =>
      [type, content, replyTo, pollId, voteOptionIndex, timestamp];
}

/// A reply thread — groups replies by the parent message they reference.
class ReplyThread extends Equatable {
  /// The message ID of the parent broadcast message.
  final String parentMessageId;

  /// Decrypted reply payloads, ordered by timestamp.
  final List<UpstreamPayload> replies;

  const ReplyThread({
    required this.parentMessageId,
    this.replies = const [],
  });

  ReplyThread addReply(UpstreamPayload reply) {
    final updated = List<UpstreamPayload>.from(replies)..add(reply);
    updated.sort((a, b) => a.timestamp.compareTo(b.timestamp));
    return ReplyThread(
      parentMessageId: parentMessageId,
      replies: updated,
    );
  }

  int get replyCount => replies.length;

  @override
  List<Object?> get props => [parentMessageId, replies];
}
