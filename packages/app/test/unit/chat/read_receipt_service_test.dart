import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:zajel/features/chat/services/read_receipt_service.dart';

import '../../mocks/mocks.dart';

void main() {
  late MockConnectionManager mockCM;
  late MockMessageStorage mockStorage;
  late StreamController<(String, String)> receiptController;
  late ReadReceiptService service;

  setUp(() {
    mockCM = MockConnectionManager();
    mockStorage = MockMessageStorage();
    receiptController = StreamController<(String, String)>.broadcast();

    when(() => mockCM.receiptEvents)
        .thenAnswer((_) => receiptController.stream);

    service = ReadReceiptService(
      connectionManager: mockCM,
      messageStorage: mockStorage,
    );
  });

  tearDown(() {
    service.dispose();
    receiptController.close();
  });

  group('start()', () {
    test('subscribes to receiptEvents stream', () {
      expect(receiptController.hasListener, isFalse);
      service.start();
      expect(receiptController.hasListener, isTrue);
    });

    test('calling start() twice cancels previous subscription', () {
      service.start();
      service.start(); // Should not throw or leak
      expect(receiptController.hasListener, isTrue);
    });
  });

  group('sendReadReceipt()', () {
    test('sends rcpt:<timestamp> to correct peer', () async {
      when(() => mockCM.sendMessage(any(), any())).thenAnswer((_) async {});

      await service.sendReadReceipt('peer-1');

      // Verify the message was sent to the correct peer with rcpt: prefix
      // followed by a numeric timestamp
      verify(() => mockCM.sendMessage(
            'peer-1',
            any(that: matches(RegExp(r'^rcpt:\d+$'))),
          )).called(1);
    });

    test('silently catches errors when peer is offline', () async {
      when(() => mockCM.sendMessage(any(), any()))
          .thenThrow(Exception('peer offline'));

      // Should not throw
      await service.sendReadReceipt('peer-1');

      verify(() => mockCM.sendMessage('peer-1', any())).called(1);
    });
  });

  group('receiving receipts', () {
    test('valid receipt marks messages as read in storage', () async {
      final timestamp = DateTime.now().millisecondsSinceEpoch;

      when(() => mockStorage.markMessagesAsRead(any(), any()))
          .thenAnswer((_) async => 3);

      service.start();
      receiptController.add(('peer-1', timestamp.toString()));

      // Allow async handler to complete
      await Future<void>.delayed(Duration.zero);

      verify(() => mockStorage.markMessagesAsRead(
            'peer-1',
            DateTime.fromMillisecondsSinceEpoch(timestamp),
          )).called(1);
    });

    test('valid receipt calls onStatusUpdated when rows updated', () async {
      final timestamp = DateTime.now().millisecondsSinceEpoch;
      String? updatedPeerId;
      service.onStatusUpdated = (peerId) => updatedPeerId = peerId;

      when(() => mockStorage.markMessagesAsRead(any(), any()))
          .thenAnswer((_) async => 5);

      service.start();
      receiptController.add(('peer-1', timestamp.toString()));

      await Future<void>.delayed(Duration.zero);

      expect(updatedPeerId, 'peer-1');
    });

    test('valid receipt with 0 updated rows does NOT call onStatusUpdated',
        () async {
      final timestamp = DateTime.now().millisecondsSinceEpoch;
      bool callbackCalled = false;
      service.onStatusUpdated = (_) => callbackCalled = true;

      when(() => mockStorage.markMessagesAsRead(any(), any()))
          .thenAnswer((_) async => 0);

      service.start();
      receiptController.add(('peer-1', timestamp.toString()));

      await Future<void>.delayed(Duration.zero);

      expect(callbackCalled, isFalse);
    });

    test('invalid (non-numeric) payload does not update storage', () async {
      service.start();
      receiptController.add(('peer-1', 'not-a-number'));

      await Future<void>.delayed(Duration.zero);

      verifyNever(() => mockStorage.markMessagesAsRead(any(), any()));
    });

    test('multiple receipts from different peers handled independently',
        () async {
      final ts1 = DateTime.now().millisecondsSinceEpoch;
      final ts2 = ts1 + 1000;
      final updatedPeers = <String>[];
      service.onStatusUpdated = (peerId) => updatedPeers.add(peerId);

      when(() => mockStorage.markMessagesAsRead(any(), any()))
          .thenAnswer((_) async => 1);

      service.start();
      receiptController.add(('peer-1', ts1.toString()));
      receiptController.add(('peer-2', ts2.toString()));

      await Future<void>.delayed(Duration.zero);
      // Second event may need another microtask
      await Future<void>.delayed(Duration.zero);

      expect(updatedPeers, containsAll(['peer-1', 'peer-2']));
      verify(() => mockStorage.markMessagesAsRead('peer-1', any())).called(1);
      verify(() => mockStorage.markMessagesAsRead('peer-2', any())).called(1);
    });
  });

  group('dispose()', () {
    test('cancels the subscription', () {
      service.start();
      expect(receiptController.hasListener, isTrue);

      service.dispose();
      // After dispose, new events should not be processed
      // (no listener on controller)
      expect(receiptController.hasListener, isFalse);
    });

    test('dispose() is safe to call multiple times', () {
      service.start();
      service.dispose();
      service.dispose(); // Should not throw
    });
  });
}
