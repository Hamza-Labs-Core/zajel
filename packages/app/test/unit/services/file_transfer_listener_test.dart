import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/models/models.dart';
import 'package:zajel/core/services/file_transfer_listener.dart';

void main() {
  group('FileTransferListener', () {
    late StreamController<(String, String, String, int, int)> fileStartCtrl;
    late StreamController<(String, String, dynamic, int, int)> fileChunkCtrl;
    late StreamController<(String, String)> fileCompleteCtrl;

    // Tracking variables for closure calls
    late List<Map<String, dynamic>> startTransferCalls;
    late List<Map<String, dynamic>> addChunkCalls;
    late List<String> completeTransferCalls;
    late List<String> getTransferCalls;
    late List<(String, Message)> addMessageCalls;

    // Configurable stubs
    late Future<String?> Function(String) completeTransferStub;
    late ({String fileName, int totalSize})? Function(String) getTransferStub;

    late FileTransferListener listener;

    setUp(() {
      fileStartCtrl = StreamController.broadcast();
      fileChunkCtrl = StreamController.broadcast();
      fileCompleteCtrl = StreamController.broadcast();

      startTransferCalls = [];
      addChunkCalls = [];
      completeTransferCalls = [];
      getTransferCalls = [];
      addMessageCalls = [];

      completeTransferStub = (fileId) async => '/saved/$fileId.bin';
      getTransferStub = (fileId) => (fileName: 'test.txt', totalSize: 1024);

      listener = FileTransferListener(
        fileStarts: fileStartCtrl.stream,
        fileChunks: fileChunkCtrl.stream,
        fileCompletes: fileCompleteCtrl.stream,
        startTransfer: ({
          required String peerId,
          required String fileId,
          required String fileName,
          required int totalSize,
          required int totalChunks,
        }) {
          startTransferCalls.add({
            'peerId': peerId,
            'fileId': fileId,
            'fileName': fileName,
            'totalSize': totalSize,
            'totalChunks': totalChunks,
          });
        },
        addChunk: (fileId, index, chunk) {
          addChunkCalls.add({
            'fileId': fileId,
            'index': index,
            'chunk': chunk,
          });
        },
        completeTransfer: (fileId) {
          completeTransferCalls.add(fileId);
          return completeTransferStub(fileId);
        },
        getTransfer: (fileId) {
          getTransferCalls.add(fileId);
          return getTransferStub(fileId);
        },
        addMessage: (peerId, message) {
          addMessageCalls.add((peerId, message));
        },
      );
    });

    tearDown(() {
      listener.dispose();
      fileStartCtrl.close();
      fileChunkCtrl.close();
      fileCompleteCtrl.close();
    });

    test('listen() forwards file start events to startTransfer', () async {
      listener.listen();

      fileStartCtrl.add(('peer1', 'file1', 'photo.jpg', 2048, 4));
      await Future<void>.delayed(Duration.zero);

      expect(startTransferCalls, hasLength(1));
      expect(startTransferCalls[0]['peerId'], 'peer1');
      expect(startTransferCalls[0]['fileId'], 'file1');
      expect(startTransferCalls[0]['fileName'], 'photo.jpg');
      expect(startTransferCalls[0]['totalSize'], 2048);
      expect(startTransferCalls[0]['totalChunks'], 4);
    });

    test('listen() forwards file chunk events to addChunk', () async {
      listener.listen();

      final chunkData = [1, 2, 3, 4];
      fileChunkCtrl.add(('peer1', 'file1', chunkData, 0, 4));
      await Future<void>.delayed(Duration.zero);

      expect(addChunkCalls, hasLength(1));
      expect(addChunkCalls[0]['fileId'], 'file1');
      expect(addChunkCalls[0]['index'], 0);
      expect(addChunkCalls[0]['chunk'], chunkData);
    });

    test('listen() calls completeTransfer and adds file message on completion',
        () async {
      listener.listen();

      fileCompleteCtrl.add(('peer1', 'file1'));
      // Allow async listener to complete
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(completeTransferCalls, ['file1']);
      expect(getTransferCalls, ['file1']);
      expect(addMessageCalls, hasLength(1));

      final (peerId, msg) = addMessageCalls[0];
      expect(peerId, 'peer1');
      expect(msg.localId, 'file1');
      expect(msg.peerId, 'peer1');
      expect(msg.type, MessageType.file);
      expect(msg.isOutgoing, false);
      expect(msg.status, MessageStatus.delivered);
      expect(msg.attachmentPath, '/saved/file1.bin');
      expect(msg.attachmentName, 'test.txt');
      expect(msg.attachmentSize, 1024);
      expect(msg.content, 'Received file: test.txt');
    });

    test('does not add message when completeTransfer returns null', () async {
      completeTransferStub = (fileId) async => null;
      listener.listen();

      fileCompleteCtrl.add(('peer1', 'file1'));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(completeTransferCalls, ['file1']);
      expect(addMessageCalls, isEmpty);
    });

    test('does not add message when getTransfer returns null', () async {
      getTransferStub = (fileId) => null;
      listener.listen();

      fileCompleteCtrl.add(('peer1', 'file1'));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(completeTransferCalls, ['file1']);
      expect(getTransferCalls, ['file1']);
      expect(addMessageCalls, isEmpty);
    });

    test('dispose cancels all subscriptions', () async {
      listener.listen();
      listener.dispose();

      // Events after dispose should not trigger callbacks
      fileStartCtrl.add(('peer1', 'file1', 'photo.jpg', 2048, 4));
      fileChunkCtrl.add(('peer1', 'file1', [1], 0, 1));
      fileCompleteCtrl.add(('peer1', 'file1'));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(startTransferCalls, isEmpty);
      expect(addChunkCalls, isEmpty);
      expect(completeTransferCalls, isEmpty);
    });

    test('handles multiple file transfers concurrently', () async {
      listener.listen();

      fileStartCtrl.add(('peer1', 'f1', 'a.txt', 100, 1));
      fileStartCtrl.add(('peer2', 'f2', 'b.txt', 200, 2));
      await Future<void>.delayed(Duration.zero);

      expect(startTransferCalls, hasLength(2));
      expect(startTransferCalls[0]['fileId'], 'f1');
      expect(startTransferCalls[1]['fileId'], 'f2');
    });
  });
}
