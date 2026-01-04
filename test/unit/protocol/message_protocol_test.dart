import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/protocol/message_protocol.dart';

void main() {
  group('MessageProtocol', () {
    group('encodeTextMessage', () {
      test('encodes text message with correct header', () {
        final encoded = MessageProtocol.encodeTextMessage('Hello, World!');

        expect(encoded[0], MessageProtocol.protocolVersion);
        expect(encoded[1], WireMessageType.text.value);
        expect(encoded[2], 0); // Flags high byte
        expect(encoded[3], 0); // Flags low byte
      });

      test('encodes text message with correct payload', () {
        const content = 'Test message';
        final encoded = MessageProtocol.encodeTextMessage(content);
        final payload = encoded.sublist(4);

        expect(utf8.decode(payload), content);
      });

      test('handles empty content', () {
        final encoded = MessageProtocol.encodeTextMessage('');

        expect(encoded.length, 4); // Just header, no payload
      });

      test('handles unicode content', () {
        const content = 'Hello 👋 مرحبا';
        final encoded = MessageProtocol.encodeTextMessage(content);
        final payload = encoded.sublist(4);

        expect(utf8.decode(payload), content);
      });
    });

    group('decode', () {
      test('decodes valid text message', () {
        final encoded = MessageProtocol.encodeTextMessage('Hello');
        final decoded = MessageProtocol.decode(encoded);

        expect(decoded.type, WireMessageType.text);
        expect(decoded.payloadAsString, 'Hello');
      });

      test('throws on message too short', () {
        final shortData = Uint8List(3); // Less than 4 bytes

        expect(
          () => MessageProtocol.decode(shortData),
          throwsA(isA<ProtocolException>()),
        );
      });

      test('throws on unsupported protocol version', () {
        final data = Uint8List(4);
        data[0] = 99; // Invalid version
        data[1] = WireMessageType.text.value;

        expect(
          () => MessageProtocol.decode(data),
          throwsA(isA<ProtocolException>().having(
            (e) => e.message,
            'message',
            contains('Unsupported protocol version'),
          )),
        );
      });

      test('throws on unknown message type', () {
        final data = Uint8List(4);
        data[0] = MessageProtocol.protocolVersion;
        data[1] = 255; // Invalid type

        expect(
          () => MessageProtocol.decode(data),
          throwsA(isA<ProtocolException>().having(
            (e) => e.message,
            'message',
            contains('Unknown message type'),
          )),
        );
      });
    });

    group('encodeHandshakeRequest', () {
      test('encodes handshake request with public key', () {
        const publicKey = 'base64EncodedPublicKey123';
        final encoded = MessageProtocol.encodeHandshakeRequest(publicKey);

        expect(encoded[0], MessageProtocol.protocolVersion);
        expect(encoded[1], WireMessageType.handshakeRequest.value);

        final decoded = MessageProtocol.decode(encoded);
        expect(decoded.type, WireMessageType.handshakeRequest);
        expect(decoded.payloadAsJson['publicKey'], publicKey);
      });
    });

    group('encodeHandshakeResponse', () {
      test('encodes handshake response with public key', () {
        const publicKey = 'responsePublicKey456';
        final encoded = MessageProtocol.encodeHandshakeResponse(publicKey);

        expect(encoded[0], MessageProtocol.protocolVersion);
        expect(encoded[1], WireMessageType.handshakeResponse.value);

        final decoded = MessageProtocol.decode(encoded);
        expect(decoded.type, WireMessageType.handshakeResponse);
        expect(decoded.payloadAsJson['publicKey'], publicKey);
      });
    });

    group('encodeAck', () {
      test('encodes acknowledgment with message ID', () {
        const messageId = 'msg-123-456';
        final encoded = MessageProtocol.encodeAck(messageId);

        expect(encoded[0], MessageProtocol.protocolVersion);
        expect(encoded[1], WireMessageType.ack.value);

        final decoded = MessageProtocol.decode(encoded);
        expect(decoded.type, WireMessageType.ack);
        expect(decoded.payloadAsString, messageId);
      });
    });

    group('encodeFileChunk', () {
      test('encodes file chunk with metadata', () {
        final chunkData = Uint8List.fromList([1, 2, 3, 4, 5]);
        final encoded = MessageProtocol.encodeFileChunk(
          fileId: 'file-123',
          chunkIndex: 0,
          totalChunks: 10,
          encryptedData: chunkData,
        );

        expect(encoded[0], MessageProtocol.protocolVersion);
        expect(encoded[1], WireMessageType.fileChunk.value);
      });

      test('decodes file chunk correctly', () {
        final chunkData = Uint8List.fromList([10, 20, 30, 40, 50]);
        final encoded = MessageProtocol.encodeFileChunk(
          fileId: 'file-456',
          chunkIndex: 5,
          totalChunks: 20,
          encryptedData: chunkData,
        );

        final decoded = MessageProtocol.decode(encoded);
        expect(decoded.type, WireMessageType.fileChunk);

        final fileChunk = MessageProtocol.decodeFileChunk(decoded.payload);
        expect(fileChunk.fileId, 'file-456');
        expect(fileChunk.chunkIndex, 5);
        expect(fileChunk.totalChunks, 20);
        expect(fileChunk.data, chunkData);
      });
    });

    group('roundtrip encoding/decoding', () {
      test('text message roundtrip preserves content', () {
        const original = 'This is a test message with special chars: émoji 🎉';
        final encoded = MessageProtocol.encodeTextMessage(original);
        final decoded = MessageProtocol.decode(encoded);

        expect(decoded.payloadAsString, original);
      });

      test('handshake request roundtrip preserves public key', () {
        const publicKey = 'VeryLongBase64EncodedPublicKeyHere==';
        final encoded = MessageProtocol.encodeHandshakeRequest(publicKey);
        final decoded = MessageProtocol.decode(encoded);

        expect(decoded.payloadAsJson['publicKey'], publicKey);
      });

      test('file chunk roundtrip preserves all data', () {
        final originalData = Uint8List.fromList(
          List.generate(1000, (i) => i % 256),
        );

        final encoded = MessageProtocol.encodeFileChunk(
          fileId: 'test-file',
          chunkIndex: 42,
          totalChunks: 100,
          encryptedData: originalData,
        );

        final decoded = MessageProtocol.decode(encoded);
        final fileChunk = MessageProtocol.decodeFileChunk(decoded.payload);

        expect(fileChunk.fileId, 'test-file');
        expect(fileChunk.chunkIndex, 42);
        expect(fileChunk.totalChunks, 100);
        expect(fileChunk.data, originalData);
      });
    });

    group('WireMessageType', () {
      test('fromValue returns correct type for valid values', () {
        expect(WireMessageType.fromValue(1), WireMessageType.text);
        expect(WireMessageType.fromValue(2), WireMessageType.handshakeRequest);
        expect(WireMessageType.fromValue(3), WireMessageType.handshakeResponse);
        expect(WireMessageType.fromValue(4), WireMessageType.fileChunk);
        expect(WireMessageType.fromValue(7), WireMessageType.ack);
        expect(WireMessageType.fromValue(8), WireMessageType.ping);
        expect(WireMessageType.fromValue(9), WireMessageType.pong);
      });

      test('fromValue throws for invalid value', () {
        expect(
          () => WireMessageType.fromValue(0),
          throwsA(isA<ProtocolException>()),
        );
        expect(
          () => WireMessageType.fromValue(100),
          throwsA(isA<ProtocolException>()),
        );
      });

      test('all types have unique values', () {
        final values = WireMessageType.values.map((t) => t.value).toSet();
        expect(values.length, WireMessageType.values.length);
      });
    });

    group('DecodedMessage', () {
      test('payloadAsString returns decoded string', () {
        final encoded = MessageProtocol.encodeTextMessage('Test content');
        final decoded = MessageProtocol.decode(encoded);

        expect(decoded.payloadAsString, 'Test content');
      });

      test('payloadAsJson returns parsed JSON', () {
        final encoded = MessageProtocol.encodeHandshakeRequest('key123');
        final decoded = MessageProtocol.decode(encoded);

        final json = decoded.payloadAsJson;
        expect(json, isA<Map<String, dynamic>>());
        expect(json['publicKey'], 'key123');
      });
    });

    group('ProtocolException', () {
      test('toString includes message', () {
        final exception = ProtocolException('Test error');
        expect(exception.toString(), contains('Test error'));
        expect(exception.toString(), contains('ProtocolException'));
      });
    });

    group('edge cases', () {
      test('handles minimum valid message (empty payload)', () {
        final data = Uint8List(4);
        data[0] = MessageProtocol.protocolVersion;
        data[1] = WireMessageType.text.value;
        data[2] = 0;
        data[3] = 0;

        final decoded = MessageProtocol.decode(data);
        expect(decoded.type, WireMessageType.text);
        expect(decoded.payload.length, 0);
      });

      test('handles large payload', () {
        final largeContent = 'X' * 100000;
        final encoded = MessageProtocol.encodeTextMessage(largeContent);
        final decoded = MessageProtocol.decode(encoded);

        expect(decoded.payloadAsString, largeContent);
      });
    });
  });
}
