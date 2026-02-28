import 'dart:async';

import '../logging/logger_service.dart';
import '../models/models.dart';

/// Listens to file transfer streams and coordinates file reception.
///
/// Uses closure-based DI for testability -- Riverpod stays in main.dart.
class FileTransferListener {
  final Stream<(String, String, String, int, int)> fileStarts;
  final Stream<(String, String, dynamic, int, int)> fileChunks;
  final Stream<(String, String)> fileCompletes;

  final void Function({
    required String peerId,
    required String fileId,
    required String fileName,
    required int totalSize,
    required int totalChunks,
  }) startTransfer;

  final void Function(String fileId, int index, dynamic chunk) addChunk;
  final Future<String?> Function(String fileId) completeTransfer;
  final ({String fileName, int totalSize})? Function(String fileId) getTransfer;
  final void Function(String peerId, Message message) addMessage;

  StreamSubscription? _fileStartSubscription;
  StreamSubscription? _fileChunkSubscription;
  StreamSubscription? _fileCompleteSubscription;

  FileTransferListener({
    required this.fileStarts,
    required this.fileChunks,
    required this.fileCompletes,
    required this.startTransfer,
    required this.addChunk,
    required this.completeTransfer,
    required this.getTransfer,
    required this.addMessage,
  });

  /// Start listening to file transfer events.
  void listen() {
    _fileStartSubscription = fileStarts.listen((event) {
      final (peerId, fileId, fileName, totalSize, totalChunks) = event;
      startTransfer(
        peerId: peerId,
        fileId: fileId,
        fileName: fileName,
        totalSize: totalSize,
        totalChunks: totalChunks,
      );
    });

    _fileChunkSubscription = fileChunks.listen((event) {
      final (_, fileId, chunk, index, _) = event;
      addChunk(fileId, index, chunk);
    });

    _fileCompleteSubscription = fileCompletes.listen((event) async {
      final (peerId, fileId) = event;
      final savedPath = await completeTransfer(fileId);

      if (savedPath != null) {
        final transfer = getTransfer(fileId);
        if (transfer != null) {
          addMessage(
            peerId,
            Message(
              localId: fileId,
              peerId: peerId,
              content: 'Received file: ${transfer.fileName}',
              type: MessageType.file,
              timestamp: DateTime.now(),
              isOutgoing: false,
              status: MessageStatus.delivered,
              attachmentPath: savedPath,
              attachmentName: transfer.fileName,
              attachmentSize: transfer.totalSize,
            ),
          );
        }
      }
    });

    logger.info('FileTransferListener', 'File transfer listeners started');
  }

  /// Cancel all subscriptions.
  void dispose() {
    _fileStartSubscription?.cancel();
    _fileChunkSubscription?.cancel();
    _fileCompleteSubscription?.cancel();
  }
}
