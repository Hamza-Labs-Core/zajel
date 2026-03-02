import 'dart:async';

import '../logging/logger_service.dart';

/// Duration options for auto-deleting messages.
enum AutoDeleteDuration {
  off,
  oneHour,
  oneDay,
  sevenDays,
  thirtyDays,
}

/// Extension to get human-readable labels and actual durations.
extension AutoDeleteDurationExt on AutoDeleteDuration {
  String get label => switch (this) {
        AutoDeleteDuration.off => 'Off',
        AutoDeleteDuration.oneHour => '1 hour',
        AutoDeleteDuration.oneDay => '1 day',
        AutoDeleteDuration.sevenDays => '7 days',
        AutoDeleteDuration.thirtyDays => '30 days',
      };

  Duration? get duration => switch (this) {
        AutoDeleteDuration.off => null,
        AutoDeleteDuration.oneHour => const Duration(hours: 1),
        AutoDeleteDuration.oneDay => const Duration(days: 1),
        AutoDeleteDuration.sevenDays => const Duration(days: 7),
        AutoDeleteDuration.thirtyDays => const Duration(days: 30),
      };
}

/// Service that periodically deletes messages older than a configured duration.
///
/// Uses closure-based DI for testability -- Riverpod stays in main.dart.
class AutoDeleteService {
  static const _tag = 'AutoDeleteService';
  static const _checkInterval = Duration(minutes: 5);

  final Future<void> Function(String peerId, DateTime before)
      deleteMessagesBefore;
  final Future<List<String>> Function() getActivePeerIds;
  final AutoDeleteDuration Function() getAutoDeleteDuration;

  Timer? _timer;

  AutoDeleteService({
    required this.deleteMessagesBefore,
    required this.getActivePeerIds,
    required this.getAutoDeleteDuration,
  });

  /// Start the periodic auto-delete check.
  void start() {
    _timer?.cancel();
    _timer = Timer.periodic(_checkInterval, (_) => runCleanup());
    logger.info(_tag, 'Auto-delete service started');
  }

  /// Stop the periodic auto-delete check.
  void stop() {
    _timer?.cancel();
    _timer = null;
    logger.info(_tag, 'Auto-delete service stopped');
  }

  /// Whether the service is currently running.
  bool get isRunning => _timer != null && _timer!.isActive;

  /// Run a single cleanup pass.
  ///
  /// Deletes messages older than the configured duration for all active peers.
  /// Returns the number of peers cleaned up.
  Future<int> runCleanup() async {
    final setting = getAutoDeleteDuration();
    if (setting == AutoDeleteDuration.off) return 0;

    final duration = setting.duration;
    if (duration == null) return 0;

    final cutoff = DateTime.now().subtract(duration);
    final peerIds = await getActivePeerIds();
    var cleaned = 0;

    for (final peerId in peerIds) {
      try {
        await deleteMessagesBefore(peerId, cutoff);
        cleaned++;
      } catch (e) {
        logger.error(_tag, 'Failed to auto-delete messages for $peerId', e);
      }
    }

    if (cleaned > 0) {
      logger.info(_tag,
          'Auto-delete cleanup: processed $cleaned peers (cutoff: $cutoff)');
    }

    return cleaned;
  }

  /// Dispose the service and cancel the timer.
  void dispose() {
    stop();
  }
}
