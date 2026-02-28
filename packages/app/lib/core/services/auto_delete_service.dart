import 'dart:async';
import 'dart:io';

import '../logging/logger_service.dart';
import '../providers/settings_providers.dart';
import '../storage/message_storage.dart';

/// Periodically deletes old messages and their attachment files
/// based on the user's auto-delete settings.
///
/// Runs immediately on start, then every hour.
class AutoDeleteService {
  final AutoDeleteSettings Function() _getSettings;
  final MessageStorage Function() _getStorage;
  Timer? _timer;

  AutoDeleteService({
    required AutoDeleteSettings Function() getSettings,
    required MessageStorage Function() getStorage,
  })  : _getSettings = getSettings,
        _getStorage = getStorage;

  void start() {
    _runCleanup();
    _timer = Timer.periodic(
      const Duration(hours: 1),
      (_) => _runCleanup(),
    );
  }

  Future<void> _runCleanup() async {
    try {
      final settings = _getSettings();
      if (!settings.enabled) return;

      final cutoff = DateTime.now().subtract(settings.duration);
      final storage = _getStorage();

      // Get attachment paths before deleting messages
      final attachmentPaths = await storage.getAttachmentPathsOlderThan(cutoff);

      // Delete messages from database
      final deleted = await storage.deleteMessagesOlderThan(cutoff);

      // Delete attachment files from disk
      var filesDeleted = 0;
      for (final path in attachmentPaths) {
        try {
          final file = File(path);
          if (await file.exists()) {
            await file.delete();
            filesDeleted++;
          }
        } catch (e) {
          logger.warning('AutoDelete', 'Failed to delete file $path: $e');
        }
      }

      if (deleted > 0 || filesDeleted > 0) {
        logger.info(
            'AutoDelete',
            'Cleaned up $deleted messages and $filesDeleted files '
                'older than ${settings.duration.inHours}h');
      }
    } catch (e) {
      logger.error('AutoDelete', 'Cleanup failed', e);
    }
  }

  void dispose() {
    _timer?.cancel();
    _timer = null;
  }
}
