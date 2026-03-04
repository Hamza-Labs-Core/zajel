import 'dart:async';

import '../../../core/logging/logger_service.dart';
import 'idle_detector.dart';

/// Coordinates automatic silent updates when all conditions are met.
///
/// Monitors the [IdleDetector] and checks that no active VoIP calls or
/// file transfers are in progress before triggering an auto-install.
///
/// The service is enabled/disabled via [setEnabled] and begins monitoring
/// when [onUpdateReady] is called (update state machine reaches READY).
///
/// When all conditions are satisfied:
/// 1. User is idle (no activity for 5 minutes)
/// 2. No active VoIP call
/// 3. No active file transfer
/// 4. Auto-install is enabled
/// 5. Update is ready
///
/// The service starts a grace period. If conditions remain met after the
/// grace period, [_launchUpdate] is invoked.
class AutoUpdateService {
  static const String _tag = 'AutoUpdate';

  final IdleDetector _idleDetector;

  /// Returns true if there is an active VoIP call.
  final bool Function() _hasActiveCall;

  /// Returns true if there is an active file transfer (receiving).
  final bool Function() _hasActiveTransfer;

  /// Returns true if an update is verified and ready to install.
  final bool Function() _isUpdateReady;

  /// Launches the update (writes manifest, launches updater, exits app).
  final Future<void> Function() _launchUpdate;

  bool _enabled = false;
  bool _updateReady = false;
  bool _disposed = false;

  /// Creates an [AutoUpdateService].
  ///
  /// [idleDetector] tracks user activity and idle state.
  /// [hasActiveCall] checks VoIP call status.
  /// [hasActiveTransfer] checks file transfer status.
  /// [isUpdateReady] checks update state machine.
  /// [launchUpdate] performs the actual update launch.
  AutoUpdateService({
    required IdleDetector idleDetector,
    required bool Function() hasActiveCall,
    required bool Function() hasActiveTransfer,
    required bool Function() isUpdateReady,
    required Future<void> Function() launchUpdate,
  })  : _idleDetector = idleDetector,
        _hasActiveCall = hasActiveCall,
        _hasActiveTransfer = hasActiveTransfer,
        _isUpdateReady = isUpdateReady,
        _launchUpdate = launchUpdate;

  /// Whether auto-update is currently enabled by user preference.
  bool get isEnabled => _enabled;

  /// Whether an update is ready and being monitored.
  bool get isUpdateReadyForAutoInstall => _updateReady && _enabled;

  /// Enable or disable auto-update.
  void setEnabled(bool enabled) {
    _enabled = enabled;
    if (!enabled) {
      _stopMonitoring();
    } else if (_updateReady) {
      _startMonitoring();
    }
  }

  /// Called when the update state machine reaches READY.
  ///
  /// If auto-update is enabled, starts monitoring idle conditions.
  void onUpdateReady() {
    _updateReady = true;
    if (_enabled) {
      _startMonitoring();
    }
  }

  /// Called when the update state machine leaves READY (e.g., FAILED, IDLE).
  void onUpdateNotReady() {
    _updateReady = false;
    _stopMonitoring();
  }

  void _startMonitoring() {
    _idleDetector.startMonitoring();
    _idleDetector.addListener(_checkConditions);
  }

  void _stopMonitoring() {
    _idleDetector.removeListener(_checkConditions);
    _idleDetector.stopMonitoring();
  }

  void _checkConditions() {
    if (_disposed) return;
    if (!_enabled) return;
    if (!_idleDetector.isIdle) return;
    if (_idleDetector.isInGracePeriod) return;
    if (_hasActiveCall()) return;
    if (_hasActiveTransfer()) return;
    if (!_isUpdateReady()) return;

    // All conditions met -- start grace period
    logger.info(_tag, 'Idle conditions met, starting grace period');
    _idleDetector.startGracePeriod(() {
      if (_disposed) return;
      // Re-check all conditions after grace period completes
      if (!_enabled) {
        logger.info(_tag, 'Auto-update disabled during grace period');
        return;
      }
      if (_hasActiveCall()) {
        logger.info(_tag, 'Call started during grace period, deferring update');
        return;
      }
      if (_hasActiveTransfer()) {
        logger.info(_tag,
            'File transfer started during grace period, deferring update');
        return;
      }
      if (!_isUpdateReady()) {
        logger.info(_tag, 'Update no longer ready after grace period');
        return;
      }
      if (!_idleDetector.isIdle) {
        logger.info(
            _tag, 'User became active during grace period, deferring update');
        return;
      }

      logger.info(
          _tag, 'All conditions met after grace period, launching update');
      unawaited(_launchUpdate().catchError((Object e, StackTrace stack) {
        logger.error(_tag, 'Failed to launch update', e, stack);
      }));
    });
  }

  /// Dispose resources.
  void dispose() {
    _disposed = true;
    _stopMonitoring();
  }
}
