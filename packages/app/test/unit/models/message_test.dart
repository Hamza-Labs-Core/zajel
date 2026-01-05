import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/models/message.dart';

void main() {
  group('Message', () {
    final testDate = DateTime(2024, 1, 15, 10, 30);

    group('constructor', () {
      test('creates message with required fields', () {
        final message = Message(
          localId: 'msg-123',
          peerId: 'peer-456',
          content: 'Hello, World!',
          timestamp: testDate,
          isOutgoing: true,
        );

        expect(message.localId, 'msg-123');
        expect(message.peerId, 'peer-456');
        expect(message.content, 'Hello, World!');
        expect(message.timestamp, testDate);
        expect(message.isOutgoing, true);
        expect(message.type, MessageType.text);
        expect(message.status, MessageStatus.pending);
        expect(message.attachmentPath, isNull);
        expect(message.attachmentSize, isNull);
        expect(message.attachmentName, isNull);
      });

      test('creates message with all fields', () {
        final message = Message(
          localId: 'msg-123',
          peerId: 'peer-456',
          content: 'Check out this file',
          type: MessageType.file,
          status: MessageStatus.delivered,
          timestamp: testDate,
          isOutgoing: true,
          attachmentPath: '/path/to/file.pdf',
          attachmentSize: 1024,
          attachmentName: 'document.pdf',
        );

        expect(message.type, MessageType.file);
        expect(message.status, MessageStatus.delivered);
        expect(message.attachmentPath, '/path/to/file.pdf');
        expect(message.attachmentSize, 1024);
        expect(message.attachmentName, 'document.pdf');
      });
    });

    group('copyWith', () {
      test('creates copy with modified fields', () {
        final original = Message(
          localId: 'msg-123',
          peerId: 'peer-456',
          content: 'Original message',
          status: MessageStatus.pending,
          timestamp: testDate,
          isOutgoing: true,
        );

        final copy = original.copyWith(
          content: 'Modified message',
          status: MessageStatus.sent,
        );

        expect(copy.localId, original.localId);
        expect(copy.peerId, original.peerId);
        expect(copy.content, 'Modified message');
        expect(copy.status, MessageStatus.sent);
        expect(copy.timestamp, original.timestamp);
        expect(copy.isOutgoing, original.isOutgoing);
      });

      test('creates identical copy when no fields specified', () {
        final original = Message(
          localId: 'msg-123',
          peerId: 'peer-456',
          content: 'Test message',
          type: MessageType.image,
          status: MessageStatus.read,
          timestamp: testDate,
          isOutgoing: false,
          attachmentPath: '/path/to/image.png',
        );

        final copy = original.copyWith();

        expect(copy.localId, original.localId);
        expect(copy.peerId, original.peerId);
        expect(copy.content, original.content);
        expect(copy.type, original.type);
        expect(copy.status, original.status);
        expect(copy.attachmentPath, original.attachmentPath);
      });
    });

    group('JSON serialization', () {
      test('toJson produces valid JSON', () {
        final message = Message(
          localId: 'msg-123',
          peerId: 'peer-456',
          content: 'Hello!',
          type: MessageType.text,
          status: MessageStatus.sent,
          timestamp: testDate,
          isOutgoing: true,
        );

        final json = message.toJson();

        expect(json['localId'], 'msg-123');
        expect(json['peerId'], 'peer-456');
        expect(json['content'], 'Hello!');
        expect(json['type'], 'text');
        expect(json['status'], 'sent');
        expect(json['timestamp'], testDate.toIso8601String());
        expect(json['isOutgoing'], true);
      });

      test('toJson includes attachment fields', () {
        final message = Message(
          localId: 'msg-123',
          peerId: 'peer-456',
          content: 'File attached',
          type: MessageType.file,
          status: MessageStatus.pending,
          timestamp: testDate,
          isOutgoing: true,
          attachmentPath: '/path/to/file.pdf',
          attachmentSize: 2048,
          attachmentName: 'report.pdf',
        );

        final json = message.toJson();

        expect(json['attachmentPath'], '/path/to/file.pdf');
        expect(json['attachmentSize'], 2048);
        expect(json['attachmentName'], 'report.pdf');
      });

      test('fromJson creates valid message', () {
        final json = {
          'localId': 'msg-123',
          'peerId': 'peer-456',
          'content': 'Hello!',
          'type': 'text',
          'status': 'sent',
          'timestamp': testDate.toIso8601String(),
          'isOutgoing': true,
        };

        final message = Message.fromJson(json);

        expect(message.localId, 'msg-123');
        expect(message.peerId, 'peer-456');
        expect(message.content, 'Hello!');
        expect(message.type, MessageType.text);
        expect(message.status, MessageStatus.sent);
        expect(message.timestamp, testDate);
        expect(message.isOutgoing, true);
      });

      test('fromJson handles null attachment fields', () {
        final json = {
          'localId': 'msg-123',
          'peerId': 'peer-456',
          'content': 'Text message',
          'type': 'text',
          'status': 'pending',
          'timestamp': testDate.toIso8601String(),
          'isOutgoing': true,
          'attachmentPath': null,
          'attachmentSize': null,
          'attachmentName': null,
        };

        final message = Message.fromJson(json);

        expect(message.attachmentPath, isNull);
        expect(message.attachmentSize, isNull);
        expect(message.attachmentName, isNull);
      });

      test('fromJson handles unknown type gracefully', () {
        final json = {
          'localId': 'msg-123',
          'peerId': 'peer-456',
          'content': 'Message',
          'type': 'unknown_type',
          'status': 'pending',
          'timestamp': testDate.toIso8601String(),
          'isOutgoing': true,
        };

        final message = Message.fromJson(json);

        expect(message.type, MessageType.text); // Default fallback
      });

      test('fromJson handles unknown status gracefully', () {
        final json = {
          'localId': 'msg-123',
          'peerId': 'peer-456',
          'content': 'Message',
          'type': 'text',
          'status': 'unknown_status',
          'timestamp': testDate.toIso8601String(),
          'isOutgoing': true,
        };

        final message = Message.fromJson(json);

        expect(message.status, MessageStatus.pending); // Default fallback
      });

      test('roundtrip serialization preserves data', () {
        final original = Message(
          localId: 'msg-123',
          peerId: 'peer-456',
          content: 'Full message with attachment',
          type: MessageType.image,
          status: MessageStatus.delivered,
          timestamp: testDate,
          isOutgoing: false,
          attachmentPath: '/path/to/photo.jpg',
          attachmentSize: 4096,
          attachmentName: 'vacation.jpg',
        );

        final json = original.toJson();
        final restored = Message.fromJson(json);

        expect(restored.localId, original.localId);
        expect(restored.peerId, original.peerId);
        expect(restored.content, original.content);
        expect(restored.type, original.type);
        expect(restored.status, original.status);
        expect(restored.timestamp, original.timestamp);
        expect(restored.isOutgoing, original.isOutgoing);
        expect(restored.attachmentPath, original.attachmentPath);
        expect(restored.attachmentSize, original.attachmentSize);
        expect(restored.attachmentName, original.attachmentName);
      });
    });

    group('equality', () {
      test('messages with same localId, peerId, timestamp are equal', () {
        final msg1 = Message(
          localId: 'msg-123',
          peerId: 'peer-456',
          content: 'Content 1',
          timestamp: testDate,
          isOutgoing: true,
        );

        final msg2 = Message(
          localId: 'msg-123',
          peerId: 'peer-456',
          content: 'Content 2', // Different content
          timestamp: testDate,
          isOutgoing: false, // Different direction
        );

        expect(msg1, equals(msg2));
      });

      test('messages with different localId are not equal', () {
        final msg1 = Message(
          localId: 'msg-1',
          peerId: 'peer-456',
          content: 'Same',
          timestamp: testDate,
          isOutgoing: true,
        );

        final msg2 = Message(
          localId: 'msg-2',
          peerId: 'peer-456',
          content: 'Same',
          timestamp: testDate,
          isOutgoing: true,
        );

        expect(msg1, isNot(equals(msg2)));
      });
    });

    group('MessageType', () {
      test('all types can be serialized and deserialized', () {
        for (final type in MessageType.values) {
          final message = Message(
            localId: 'test',
            peerId: 'peer',
            content: 'Content',
            type: type,
            timestamp: testDate,
            isOutgoing: true,
          );

          final json = message.toJson();
          final restored = Message.fromJson(json);

          expect(restored.type, type);
        }
      });
    });

    group('MessageStatus', () {
      test('all statuses can be serialized and deserialized', () {
        for (final status in MessageStatus.values) {
          final message = Message(
            localId: 'test',
            peerId: 'peer',
            content: 'Content',
            status: status,
            timestamp: testDate,
            isOutgoing: true,
          );

          final json = message.toJson();
          final restored = Message.fromJson(json);

          expect(restored.status, status);
        }
      });
    });

    group('edge cases', () {
      test('handles empty content', () {
        final message = Message(
          localId: 'msg-123',
          peerId: 'peer-456',
          content: '',
          timestamp: testDate,
          isOutgoing: true,
        );

        expect(message.content, '');

        final json = message.toJson();
        final restored = Message.fromJson(json);
        expect(restored.content, '');
      });

      test('handles unicode content', () {
        const unicodeContent = 'Hello 👋 مرحبا 你好 🌍';
        final message = Message(
          localId: 'msg-123',
          peerId: 'peer-456',
          content: unicodeContent,
          timestamp: testDate,
          isOutgoing: true,
        );

        final json = message.toJson();
        final restored = Message.fromJson(json);
        expect(restored.content, unicodeContent);
      });

      test('handles very long content', () {
        final longContent = 'A' * 10000;
        final message = Message(
          localId: 'msg-123',
          peerId: 'peer-456',
          content: longContent,
          timestamp: testDate,
          isOutgoing: true,
        );

        final json = message.toJson();
        final restored = Message.fromJson(json);
        expect(restored.content, longContent);
        expect(restored.content.length, 10000);
      });
    });
  });
}
