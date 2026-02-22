import 'dart:convert';
import 'dart:typed_data';

import 'package:equatable/equatable.dart';

/// Content type for group messages.
enum GroupMessageType {
  text,
  file,
  image,
  system; // For join/leave/key rotation notifications

  static GroupMessageType fromString(String value) {
    return GroupMessageType.values.firstWhere(
      (e) => e.name == value,
      orElse: () => GroupMessageType.text,
    );
  }
}

/// Delivery status of a group message.
enum GroupMessageStatus {
  /// Message created locally, not yet sent.
  pending,

  /// Message sent (encrypted and broadcast to connected peers).
  sent,

  /// Message delivery confirmed by at least one peer.
  delivered,

  /// Sending failed (no connected peers, encryption error, etc.).
  failed,
}

/// A message within a group conversation.
///
/// Each message is uniquely identified by {authorDeviceId}:{sequenceNumber}.
/// Messages are encrypted with the author's sender key before broadcast.
class GroupMessage extends Equatable {
  /// The message's unique composite identifier.
  ///
  /// Format: "{authorDeviceId}:{sequenceNumber}"
  String get id => '$authorDeviceId:$sequenceNumber';

  /// The group this message belongs to.
  final String groupId;

  /// Device ID of the message author.
  final String authorDeviceId;

  /// Monotonically increasing sequence number from this author.
  ///
  /// Each author maintains their own sequence counter.
  final int sequenceNumber;

  /// The type of content in this message.
  final GroupMessageType type;

  /// The message content (plaintext after decryption).
  final String content;

  /// Optional metadata (filename, dimensions, etc.).
  final Map<String, dynamic> metadata;

  /// When the message was created by the author.
  final DateTime timestamp;

  /// Local delivery status.
  final GroupMessageStatus status;

  /// Whether this message was sent by us.
  final bool isOutgoing;

  const GroupMessage({
    required this.groupId,
    required this.authorDeviceId,
    required this.sequenceNumber,
    this.type = GroupMessageType.text,
    required this.content,
    this.metadata = const {},
    required this.timestamp,
    this.status = GroupMessageStatus.pending,
    this.isOutgoing = false,
  });

  GroupMessage copyWith({
    String? groupId,
    String? authorDeviceId,
    int? sequenceNumber,
    GroupMessageType? type,
    String? content,
    Map<String, dynamic>? metadata,
    DateTime? timestamp,
    GroupMessageStatus? status,
    bool? isOutgoing,
  }) {
    return GroupMessage(
      groupId: groupId ?? this.groupId,
      authorDeviceId: authorDeviceId ?? this.authorDeviceId,
      sequenceNumber: sequenceNumber ?? this.sequenceNumber,
      type: type ?? this.type,
      content: content ?? this.content,
      metadata: metadata ?? this.metadata,
      timestamp: timestamp ?? this.timestamp,
      status: status ?? this.status,
      isOutgoing: isOutgoing ?? this.isOutgoing,
    );
  }

  /// Serialize the message content to bytes for encryption.
  ///
  /// Only the content fields are serialized (not status/isOutgoing which are local).
  Uint8List toBytes() {
    final json = <String, dynamic>{
      'author_device_id': authorDeviceId,
      'sequence_number': sequenceNumber,
      'type': type.name,
      'content': content,
      'metadata': metadata,
      'timestamp': timestamp.toIso8601String(),
    };
    return Uint8List.fromList(utf8.encode(jsonEncode(json)));
  }

  /// Deserialize message content from decrypted bytes.
  ///
  /// The [groupId], [status], and [isOutgoing] must be set by the caller.
  factory GroupMessage.fromBytes(
    Uint8List bytes, {
    required String groupId,
    GroupMessageStatus status = GroupMessageStatus.delivered,
    bool isOutgoing = false,
  }) {
    final Map<String, dynamic> json;
    try {
      json = jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>;
    } catch (e) {
      throw FormatException('Invalid group message format: $e');
    }

    return GroupMessage(
      groupId: groupId,
      authorDeviceId: json['author_device_id'] as String,
      sequenceNumber: json['sequence_number'] as int,
      type: GroupMessageType.fromString(json['type'] as String),
      content: json['content'] as String,
      metadata: (json['metadata'] as Map<String, dynamic>?) ?? {},
      timestamp: DateTime.parse(json['timestamp'] as String),
      status: status,
      isOutgoing: isOutgoing,
    );
  }

  /// Serialize for local storage.
  Map<String, dynamic> toJson() => {
        'group_id': groupId,
        'author_device_id': authorDeviceId,
        'sequence_number': sequenceNumber,
        'type': type.name,
        'content': content,
        'metadata': jsonEncode(metadata),
        'timestamp': timestamp.toIso8601String(),
        'status': status.name,
        'is_outgoing': isOutgoing ? 1 : 0,
      };

  /// Deserialize from local storage.
  factory GroupMessage.fromJson(Map<String, dynamic> json) {
    return GroupMessage(
      groupId: json['group_id'] as String,
      authorDeviceId: json['author_device_id'] as String,
      sequenceNumber: json['sequence_number'] as int,
      type: GroupMessageType.fromString(json['type'] as String),
      content: json['content'] as String,
      metadata: json['metadata'] is String
          ? (jsonDecode(json['metadata'] as String) as Map<String, dynamic>)
          : (json['metadata'] as Map<String, dynamic>?) ?? {},
      timestamp: DateTime.parse(json['timestamp'] as String),
      status: GroupMessageStatus.values.firstWhere(
        (e) => e.name == json['status'],
        orElse: () => GroupMessageStatus.pending,
      ),
      isOutgoing: json['is_outgoing'] == 1,
    );
  }

  @override
  List<Object?> get props => [groupId, authorDeviceId, sequenceNumber];
}
