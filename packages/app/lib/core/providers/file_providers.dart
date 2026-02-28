import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../storage/file_receive_service.dart';
import 'network_providers.dart';

/// Provider for file receive service.
final fileReceiveServiceProvider = Provider<FileReceiveService>((ref) {
  final service = FileReceiveService();
  ref.onDispose(() => service.dispose());
  return service;
});

/// Provider for active file transfers stream.
final fileTransfersStreamProvider = StreamProvider<FileTransfer>((ref) {
  final service = ref.watch(fileReceiveServiceProvider);
  return service.transferUpdates;
});

/// Provider for file transfer starts.
final fileStartsStreamProvider =
    StreamProvider<(String, String, String, int, int)>((ref) {
  final connectionManager = ref.watch(connectionManagerProvider);
  return connectionManager.fileStarts;
});

/// Provider for file transfer chunks.
final fileChunksStreamProvider =
    StreamProvider<(String, String, dynamic, int, int)>((ref) {
  final connectionManager = ref.watch(connectionManagerProvider);
  return connectionManager.fileChunks;
});

/// Provider for file transfer completions.
final fileCompletesStreamProvider = StreamProvider<(String, String)>((ref) {
  final connectionManager = ref.watch(connectionManagerProvider);
  return connectionManager.fileCompletes;
});
