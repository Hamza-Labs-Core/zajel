import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/models/models.dart';
import 'package:zajel/core/services/notification_listener_service.dart';

void main() {
  group('NotificationListenerService', () {
    late StreamController<(String, String)> messageCtrl;
    late StreamController<(String, String)> fileCompleteCtrl;

    late List<(String, Message)> addMessageCalls;
    late List<String> resolveNameCalls;
    late List<Map<String, dynamic>> showMessageNotifCalls;
    late List<Map<String, dynamic>> showFileNotifCalls;

    // Configurable stubs
    late String Function(String) resolveNameStub;
    late NotificationSettings Function() getSettingsStub;
    late ({String? fileName})? Function(String) getFileTransferStub;

    late NotificationListenerService service;

    setUp(() {
      messageCtrl = StreamController.broadcast();
      fileCompleteCtrl = StreamController.broadcast();

      addMessageCalls = [];
      resolveNameCalls = [];
      showMessageNotifCalls = [];
      showFileNotifCalls = [];

      resolveNameStub = (peerId) {
        resolveNameCalls.add(peerId);
        return 'User_$peerId';
      };
      getSettingsStub = () => const NotificationSettings();
      getFileTransferStub = (fileId) => (fileName: 'document.pdf');

      service = NotificationListenerService(
        messages: messageCtrl.stream,
        fileCompletes: fileCompleteCtrl.stream,
        addMessage: (peerId, message) {
          addMessageCalls.add((peerId, message));
        },
        resolvePeerName: (peerId) => resolveNameStub(peerId),
        getNotificationSettings: () => getSettingsStub(),
        getFileTransfer: (fileId) => getFileTransferStub(fileId),
        showMessageNotification: ({
          required String peerId,
          required String peerName,
          required String content,
          required NotificationSettings settings,
        }) {
          showMessageNotifCalls.add({
            'peerId': peerId,
            'peerName': peerName,
            'content': content,
          });
        },
        showFileNotification: ({
          required String peerId,
          required String peerName,
          required String fileName,
          required NotificationSettings settings,
        }) {
          showFileNotifCalls.add({
            'peerId': peerId,
            'peerName': peerName,
            'fileName': fileName,
          });
        },
      );
    });

    tearDown(() {
      service.dispose();
      messageCtrl.close();
      fileCompleteCtrl.close();
    });

    test('stores incoming message and shows notification', () async {
      service.listen();

      messageCtrl.add(('peer1', 'Hello there'));
      await Future<void>.delayed(Duration.zero);

      // Message stored
      expect(addMessageCalls, hasLength(1));
      final (peerId, msg) = addMessageCalls[0];
      expect(peerId, 'peer1');
      expect(msg.peerId, 'peer1');
      expect(msg.content, 'Hello there');
      expect(msg.isOutgoing, false);
      expect(msg.status, MessageStatus.delivered);

      // Notification shown
      expect(showMessageNotifCalls, hasLength(1));
      expect(showMessageNotifCalls[0]['peerId'], 'peer1');
      expect(showMessageNotifCalls[0]['peerName'], 'User_peer1');
      expect(showMessageNotifCalls[0]['content'], 'Hello there');
    });

    test('shows file notification on file completion', () async {
      service.listen();

      fileCompleteCtrl.add(('peer2', 'file99'));
      await Future<void>.delayed(Duration.zero);

      expect(showFileNotifCalls, hasLength(1));
      expect(showFileNotifCalls[0]['peerId'], 'peer2');
      expect(showFileNotifCalls[0]['peerName'], 'User_peer2');
      expect(showFileNotifCalls[0]['fileName'], 'document.pdf');
    });

    test('uses fallback file name when getFileTransfer returns null', () async {
      getFileTransferStub = (fileId) => null;
      service.listen();

      fileCompleteCtrl.add(('peer1', 'unknownFile'));
      await Future<void>.delayed(Duration.zero);

      expect(showFileNotifCalls, hasLength(1));
      expect(showFileNotifCalls[0]['fileName'], 'File');
    });

    test('uses fallback when fileName is null', () async {
      getFileTransferStub = (fileId) => (fileName: null);
      service.listen();

      fileCompleteCtrl.add(('peer1', 'fileX'));
      await Future<void>.delayed(Duration.zero);

      expect(showFileNotifCalls, hasLength(1));
      expect(showFileNotifCalls[0]['fileName'], 'File');
    });

    test('dispose cancels all subscriptions', () async {
      service.listen();
      service.dispose();

      messageCtrl.add(('peer1', 'Should not appear'));
      fileCompleteCtrl.add(('peer1', 'file1'));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(addMessageCalls, isEmpty);
      expect(showMessageNotifCalls, isEmpty);
      expect(showFileNotifCalls, isEmpty);
    });

    test('each message gets a unique localId', () async {
      service.listen();

      messageCtrl.add(('peer1', 'msg1'));
      messageCtrl.add(('peer1', 'msg2'));
      await Future<void>.delayed(Duration.zero);

      expect(addMessageCalls, hasLength(2));
      final id1 = addMessageCalls[0].$2.localId;
      final id2 = addMessageCalls[1].$2.localId;
      expect(id1, isNot(equals(id2)));
    });

    test('resolves peer name for notifications', () async {
      service.listen();

      messageCtrl.add(('abc123', 'Hi'));
      await Future<void>.delayed(Duration.zero);

      expect(resolveNameCalls, contains('abc123'));
      expect(showMessageNotifCalls[0]['peerName'], 'User_abc123');
    });
  });
}
