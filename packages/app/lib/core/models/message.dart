import 'package:equatable/equatable.dart';

/// Represents an encrypted message between peers.
///
/// Messages are end-to-end encrypted using X25519 + ChaCha20-Poly1305.
/// For maximum privacy:
/// - No persistent message IDs are sent over the network
/// - Timestamps are local only
/// - Message content is encrypted with a per-peer session key
class Message extends Equatable {
  final String localId; // Local-only identifier
  final String peerId;
  final String content;
  final MessageType type;
  final MessageStatus status;
  final DateTime timestamp;
  final bool isOutgoing;
  final String? attachmentPath;
  final int? attachmentSize;
  final String? attachmentName;

  const Message({
    required this.localId,
    required this.peerId,
    required this.content,
    this.type = MessageType.text,
    this.status = MessageStatus.pending,
    required this.timestamp,
    required this.isOutgoing,
    this.attachmentPath,
    this.attachmentSize,
    this.attachmentName,
  });

  Message copyWith({
    String? localId,
    String? peerId,
    String? content,
    MessageType? type,
    MessageStatus? status,
    DateTime? timestamp,
    bool? isOutgoing,
    String? attachmentPath,
    int? attachmentSize,
    String? attachmentName,
  }) {
    return Message(
      localId: localId ?? this.localId,
      peerId: peerId ?? this.peerId,
      content: content ?? this.content,
      type: type ?? this.type,
      status: status ?? this.status,
      timestamp: timestamp ?? this.timestamp,
      isOutgoing: isOutgoing ?? this.isOutgoing,
      attachmentPath: attachmentPath ?? this.attachmentPath,
      attachmentSize: attachmentSize ?? this.attachmentSize,
      attachmentName: attachmentName ?? this.attachmentName,
    );
  }

  Map<String, dynamic> toJson() => {
        'localId': localId,
        'peerId': peerId,
        'content': content,
        'type': type.name,
        'status': status.name,
        'timestamp': timestamp.toIso8601String(),
        'isOutgoing': isOutgoing,
        'attachmentPath': attachmentPath,
        'attachmentSize': attachmentSize,
        'attachmentName': attachmentName,
      };

  factory Message.fromJson(Map<String, dynamic> json) => Message(
        localId: json['localId'] as String,
        peerId: json['peerId'] as String,
        content: json['content'] as String,
        type: MessageType.values.firstWhere(
          (e) => e.name == json['type'],
          orElse: () => MessageType.text,
        ),
        status: MessageStatus.values.firstWhere(
          (e) => e.name == json['status'],
          orElse: () => MessageStatus.pending,
        ),
        timestamp: DateTime.parse(json['timestamp'] as String),
        isOutgoing: json['isOutgoing'] as bool,
        attachmentPath: json['attachmentPath'] as String?,
        attachmentSize: json['attachmentSize'] as int?,
        attachmentName: json['attachmentName'] as String?,
      );

  @override
  List<Object?> get props => [localId, peerId, timestamp];
}

enum MessageType {
  text,
  file,
  image,
  handshake, // Key exchange message
  ack, // Acknowledgment
}

enum MessageStatus {
  pending,
  sending,
  sent,
  delivered,
  read,
  failed,
}
