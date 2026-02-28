import 'dart:async';

import '../network/connection_manager.dart';
import '../storage/file_receive_service.dart';

/// Listens to file transfer events from ConnectionManager and coordinates
/// with FileReceiveService to assemble received files.
///
/// The [onFileReceived] callback is invoked after a file is successfully saved,
/// allowing the caller to update chat messages and show notifications.
class FileTransferListener {
  final ConnectionManager _connectionManager;
  final FileReceiveService _fileReceiveService;
  final void Function(String peerId, String fileId, String savedPath,
      FileTransfer transfer)? onFileReceived;

  StreamSubscription? _fileStartSubscription;
  StreamSubscription? _fileChunkSubscription;
  StreamSubscription? _fileCompleteSubscription;

  FileTransferListener({
    required ConnectionManager connectionManager,
    required FileReceiveService fileReceiveService,
    this.onFileReceived,
  })  : _connectionManager = connectionManager,
        _fileReceiveService = fileReceiveService;

  void start() {
    _fileStartSubscription = _connectionManager.fileStarts.listen((event) {
      final (peerId, fileId, fileName, totalSize, totalChunks) = event;
      _fileReceiveService.startTransfer(
        peerId: peerId,
        fileId: fileId,
        fileName: fileName,
        totalSize: totalSize,
        totalChunks: totalChunks,
      );
    });

    _fileChunkSubscription = _connectionManager.fileChunks.listen((event) {
      final (_, fileId, chunk, index, _) = event;
      _fileReceiveService.addChunk(fileId, index, chunk);
    });

    _fileCompleteSubscription =
        _connectionManager.fileCompletes.listen((event) async {
      final (peerId, fileId) = event;
      final savedPath = await _fileReceiveService.completeTransfer(fileId);

      if (savedPath != null) {
        final transfer = _fileReceiveService.getTransfer(fileId);
        if (transfer != null) {
          onFileReceived?.call(peerId, fileId, savedPath, transfer);
        }
      }
    });
  }

  void dispose() {
    _fileStartSubscription?.cancel();
    _fileChunkSubscription?.cancel();
    _fileCompleteSubscription?.cancel();
  }
}
