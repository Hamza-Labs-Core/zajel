import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:path_provider/path_provider.dart';

import '../logging/logger_service.dart';

/// Status of a file transfer.
enum FileTransferStatus {
  receiving,
  complete,
  failed,
}

/// Represents an in-progress or completed file transfer.
class FileTransfer {
  final String fileId;
  final String peerId;
  final String fileName;
  final int totalSize;
  final int totalChunks;
  final DateTime startTime;
  final Map<int, Uint8List> receivedChunks;
  FileTransferStatus status;
  String? savedPath;
  String? error;
  DateTime lastChunkTime;

  FileTransfer({
    required this.fileId,
    required this.peerId,
    required this.fileName,
    required this.totalSize,
    required this.totalChunks,
  })  : startTime = DateTime.now(),
        lastChunkTime = DateTime.now(),
        receivedChunks = {},
        status = FileTransferStatus.receiving;

  /// Number of chunks received.
  int get receivedCount => receivedChunks.length;

  /// Progress as a fraction (0.0 to 1.0).
  double get progress => totalChunks > 0 ? receivedCount / totalChunks : 0.0;

  /// Whether all chunks have been received.
  bool get isComplete => receivedCount >= totalChunks;

  /// Copy with updated fields.
  FileTransfer copyWith({
    FileTransferStatus? status,
    String? savedPath,
    String? error,
  }) {
    final copy = FileTransfer(
      fileId: fileId,
      peerId: peerId,
      fileName: fileName,
      totalSize: totalSize,
      totalChunks: totalChunks,
    );
    copy.receivedChunks.addAll(receivedChunks);
    copy.status = status ?? this.status;
    copy.savedPath = savedPath ?? this.savedPath;
    copy.error = error ?? this.error;
    copy.lastChunkTime = lastChunkTime;
    return copy;
  }
}

/// Service for receiving and reassembling file transfers.
///
/// Collects chunks in memory, reassembles when complete,
/// and saves to the app's documents directory.
class FileReceiveService {
  final Map<String, FileTransfer> _activeTransfers = {};
  final _transferController = StreamController<FileTransfer>.broadcast();
  Timer? _timeoutTimer;

  /// Stream of transfer updates.
  Stream<FileTransfer> get transferUpdates => _transferController.stream;

  /// Get a specific transfer by ID.
  FileTransfer? getTransfer(String fileId) => _activeTransfers[fileId];

  /// Get all active transfers.
  List<FileTransfer> get activeTransfers => _activeTransfers.values.toList();

  /// Start a new file transfer.
  void startTransfer({
    required String peerId,
    required String fileId,
    required String fileName,
    required int totalSize,
    required int totalChunks,
  }) {
    final transfer = FileTransfer(
      fileId: fileId,
      peerId: peerId,
      fileName: fileName,
      totalSize: totalSize,
      totalChunks: totalChunks,
    );

    _activeTransfers[fileId] = transfer;
    _transferController.add(transfer);
    _ensureTimeoutTimer();

    logger.info('FileReceiveService',
        'Started transfer: $fileId ($fileName, $totalChunks chunks)');
  }

  /// Add a chunk to a transfer.
  void addChunk(String fileId, int chunkIndex, Uint8List chunk) {
    final transfer = _activeTransfers[fileId];
    if (transfer == null) {
      logger.warning(
          'FileReceiveService', 'Received chunk for unknown transfer: $fileId');
      return;
    }

    transfer.receivedChunks[chunkIndex] = chunk;
    transfer.lastChunkTime = DateTime.now();
    _transferController.add(transfer);

    logger.debug('FileReceiveService',
        'Chunk $chunkIndex/${transfer.totalChunks} for $fileId');
  }

  /// Complete a transfer - reassemble and save to disk.
  Future<String?> completeTransfer(String fileId) async {
    final transfer = _activeTransfers[fileId];
    if (transfer == null) {
      logger.warning('FileReceiveService',
          'Complete called for unknown transfer: $fileId');
      return null;
    }

    // Check if all chunks received
    if (!transfer.isComplete) {
      final missing = transfer.totalChunks - transfer.receivedCount;
      transfer.status = FileTransferStatus.failed;
      transfer.error = 'Missing $missing chunks';
      _transferController.add(transfer);
      logger.warning('FileReceiveService',
          'Transfer incomplete: $fileId ($missing missing)');
      return null;
    }

    try {
      // Reassemble file
      final chunks = <Uint8List>[];
      for (var i = 0; i < transfer.totalChunks; i++) {
        final chunk = transfer.receivedChunks[i];
        if (chunk == null) {
          throw Exception('Missing chunk $i');
        }
        chunks.add(chunk);
      }

      final totalLength = chunks.fold<int>(0, (sum, c) => sum + c.length);
      final assembled = Uint8List(totalLength);
      var offset = 0;
      for (final chunk in chunks) {
        assembled.setRange(offset, offset + chunk.length, chunk);
        offset += chunk.length;
      }

      // Save to documents directory
      final directory = await getApplicationDocumentsDirectory();
      final zajlDir = Directory('${directory.path}/Zajel');
      if (!await zajlDir.exists()) {
        await zajlDir.create(recursive: true);
      }

      // Ensure unique filename
      var fileName = transfer.fileName;
      var filePath = '${zajlDir.path}/$fileName';
      var counter = 1;
      while (await File(filePath).exists()) {
        final ext =
            fileName.contains('.') ? '.${fileName.split('.').last}' : '';
        final base = fileName.contains('.')
            ? fileName.substring(0, fileName.lastIndexOf('.'))
            : fileName;
        fileName = '$base ($counter)$ext';
        filePath = '${zajlDir.path}/$fileName';
        counter++;
      }

      await File(filePath).writeAsBytes(assembled);

      transfer.status = FileTransferStatus.complete;
      transfer.savedPath = filePath;
      transfer.receivedChunks.clear(); // Free memory
      _transferController.add(transfer);

      logger.info(
          'FileReceiveService', 'Transfer complete: $fileId -> $filePath');
      return filePath;
    } catch (e) {
      transfer.status = FileTransferStatus.failed;
      transfer.error = e.toString();
      _transferController.add(transfer);
      logger.error('FileReceiveService', 'Transfer failed: $fileId', e);
      return null;
    }
  }

  /// Check for stalled transfers and mark as failed.
  void _checkTimeouts() {
    final now = DateTime.now();
    final timeout = const Duration(minutes: 2);

    for (final transfer in _activeTransfers.values) {
      if (transfer.status == FileTransferStatus.receiving) {
        final elapsed = now.difference(transfer.lastChunkTime);
        if (elapsed > timeout) {
          transfer.status = FileTransferStatus.failed;
          transfer.error = 'Transfer timed out';
          _transferController.add(transfer);
          logger.warning(
              'FileReceiveService', 'Transfer timed out: ${transfer.fileId}');
        }
      }
    }

    // Clean up old completed/failed transfers (keep for 5 minutes)
    final expiry = const Duration(minutes: 5);
    _activeTransfers.removeWhere((id, transfer) {
      if (transfer.status != FileTransferStatus.receiving) {
        final elapsed = now.difference(transfer.lastChunkTime);
        return elapsed > expiry;
      }
      return false;
    });
  }

  void _ensureTimeoutTimer() {
    _timeoutTimer ??= Timer.periodic(
      const Duration(seconds: 30),
      (_) => _checkTimeouts(),
    );
  }

  /// Clean up a specific transfer.
  void removeTransfer(String fileId) {
    _activeTransfers.remove(fileId);
  }

  /// Dispose resources.
  void dispose() {
    _timeoutTimer?.cancel();
    _transferController.close();
    _activeTransfers.clear();
  }
}
