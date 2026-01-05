import 'dart:convert';
import 'dart:typed_data';

/// Protocol for encoding/decoding messages for transmission.
///
/// Wire format is designed for maximum privacy:
/// - Minimal metadata in the envelope
/// - Content is always encrypted
/// - No persistent identifiers
///
/// Message structure:
/// [1 byte: version][1 byte: type][2 bytes: flags][payload]
class MessageProtocol {
  static const int protocolVersion = 1;

  /// Encode a text message for transmission.
  static Uint8List encodeTextMessage(String encryptedContent) {
    final contentBytes = utf8.encode(encryptedContent);
    final buffer = ByteData(4 + contentBytes.length);

    buffer.setUint8(0, protocolVersion);
    buffer.setUint8(1, WireMessageType.text.value);
    buffer.setUint16(2, 0); // Reserved flags

    final result = Uint8List(buffer.lengthInBytes);
    result.setRange(0, 4, buffer.buffer.asUint8List());
    result.setRange(4, result.length, contentBytes);

    return result;
  }

  /// Decode a received message.
  static DecodedMessage decode(Uint8List data) {
    if (data.length < 4) {
      throw ProtocolException('Message too short');
    }

    final buffer = ByteData.sublistView(data);
    final version = buffer.getUint8(0);

    if (version != protocolVersion) {
      throw ProtocolException('Unsupported protocol version: $version');
    }

    final typeValue = buffer.getUint8(1);
    final type = WireMessageType.fromValue(typeValue);
    final payload = data.sublist(4);

    return DecodedMessage(
      type: type,
      payload: payload,
    );
  }

  /// Create a handshake request message.
  static Uint8List encodeHandshakeRequest(String publicKey) {
    final payload = jsonEncode({'publicKey': publicKey});
    final payloadBytes = utf8.encode(payload);

    final buffer = ByteData(4 + payloadBytes.length);
    buffer.setUint8(0, protocolVersion);
    buffer.setUint8(1, WireMessageType.handshakeRequest.value);
    buffer.setUint16(2, 0);

    final result = Uint8List(buffer.lengthInBytes);
    result.setRange(0, 4, buffer.buffer.asUint8List());
    result.setRange(4, result.length, payloadBytes);

    return result;
  }

  /// Create a handshake response message.
  static Uint8List encodeHandshakeResponse(String publicKey) {
    final payload = jsonEncode({'publicKey': publicKey});
    final payloadBytes = utf8.encode(payload);

    final buffer = ByteData(4 + payloadBytes.length);
    buffer.setUint8(0, protocolVersion);
    buffer.setUint8(1, WireMessageType.handshakeResponse.value);
    buffer.setUint16(2, 0);

    final result = Uint8List(buffer.lengthInBytes);
    result.setRange(0, 4, buffer.buffer.asUint8List());
    result.setRange(4, result.length, payloadBytes);

    return result;
  }

  /// Encode a file chunk for transmission.
  static Uint8List encodeFileChunk({
    required String fileId,
    required int chunkIndex,
    required int totalChunks,
    required Uint8List encryptedData,
  }) {
    final header = jsonEncode({
      'fileId': fileId,
      'chunk': chunkIndex,
      'total': totalChunks,
    });
    final headerBytes = utf8.encode(header);

    // [4 bytes: protocol header][2 bytes: header length][header][data]
    final totalLength = 4 + 2 + headerBytes.length + encryptedData.length;
    final result = Uint8List(totalLength);

    final buffer = ByteData.sublistView(result);
    buffer.setUint8(0, protocolVersion);
    buffer.setUint8(1, WireMessageType.fileChunk.value);
    buffer.setUint16(2, 0);
    buffer.setUint16(4, headerBytes.length);

    result.setRange(6, 6 + headerBytes.length, headerBytes);
    result.setRange(6 + headerBytes.length, totalLength, encryptedData);

    return result;
  }

  /// Parse a file chunk message.
  static FileChunkMessage decodeFileChunk(Uint8List payload) {
    final buffer = ByteData.sublistView(payload);
    final headerLength = buffer.getUint16(0);
    final headerBytes = payload.sublist(2, 2 + headerLength);
    final data = payload.sublist(2 + headerLength);

    final header = jsonDecode(utf8.decode(headerBytes)) as Map<String, dynamic>;

    return FileChunkMessage(
      fileId: header['fileId'] as String,
      chunkIndex: header['chunk'] as int,
      totalChunks: header['total'] as int,
      data: data,
    );
  }

  /// Create an acknowledgment message.
  static Uint8List encodeAck(String messageId) {
    final payloadBytes = utf8.encode(messageId);
    final buffer = ByteData(4 + payloadBytes.length);

    buffer.setUint8(0, protocolVersion);
    buffer.setUint8(1, WireMessageType.ack.value);
    buffer.setUint16(2, 0);

    final result = Uint8List(buffer.lengthInBytes);
    result.setRange(0, 4, buffer.buffer.asUint8List());
    result.setRange(4, result.length, payloadBytes);

    return result;
  }
}

/// Wire message types.
enum WireMessageType {
  text(1),
  handshakeRequest(2),
  handshakeResponse(3),
  fileChunk(4),
  fileStart(5),
  fileComplete(6),
  ack(7),
  ping(8),
  pong(9);

  final int value;
  const WireMessageType(this.value);

  static WireMessageType fromValue(int value) {
    return WireMessageType.values.firstWhere(
      (e) => e.value == value,
      orElse: () => throw ProtocolException('Unknown message type: $value'),
    );
  }
}

/// Decoded message from wire format.
class DecodedMessage {
  final WireMessageType type;
  final Uint8List payload;

  const DecodedMessage({
    required this.type,
    required this.payload,
  });

  /// Get payload as string (for text messages).
  String get payloadAsString => utf8.decode(payload);

  /// Parse payload as JSON.
  Map<String, dynamic> get payloadAsJson =>
      jsonDecode(payloadAsString) as Map<String, dynamic>;
}

/// File chunk message data.
class FileChunkMessage {
  final String fileId;
  final int chunkIndex;
  final int totalChunks;
  final Uint8List data;

  const FileChunkMessage({
    required this.fileId,
    required this.chunkIndex,
    required this.totalChunks,
    required this.data,
  });
}

class ProtocolException implements Exception {
  final String message;
  ProtocolException(this.message);

  @override
  String toString() => 'ProtocolException: $message';
}
