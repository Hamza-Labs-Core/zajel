import 'dart:io';

import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/logging/logger_service.dart';
import '../models/update_result.dart';
import 'updater_launcher.dart';

/// Actions the app should take based on update verification state.
enum RollbackAction {
  /// No pending update — proceed with normal startup.
  none,

  /// An update is pending verification (first launch attempt).
  /// Proceed with startup; [markVerified] will be called after successful init.
  verifying,

  /// The updated version has crashed repeatedly. Trigger rollback.
  rollback,

  /// A lock file was found, indicating an interrupted update operation.
  /// Trigger rollback via the updater to restore from backup.
  powerLossRecovery,
}

/// App-side rollback detection and verification service.
///
/// This service manages the update launch verification flow:
/// 1. On startup, checks for pending update verification or error conditions.
/// 2. Tracks launch attempts via SharedPreferences.
/// 3. Triggers rollback if the new version crashes repeatedly.
/// 4. Marks updates as verified after successful initialization.
///
/// The service uses two persistence mechanisms:
/// - SharedPreferences for the launch attempt counter (survives app crashes).
/// - `update-result.json` file for the update status (written by the Go updater,
///   read and updated by the Dart app).
class UpdateRollbackService {
  static const _tag = 'UpdateRollbackService';
  static const _launchAttemptKey = 'update_launch_attempt';
  static const _maxAttempts = 2;

  UpdateRollbackService._();

  /// Called early in app startup (before runApp) to check whether we need
  /// to rollback.
  ///
  /// This must be called before any UI or heavy initialization, using only
  /// SharedPreferences and file I/O.
  ///
  /// Returns the action the app should take:
  /// - [RollbackAction.none]: No pending update. Proceed normally.
  /// - [RollbackAction.verifying]: First launch after update. Proceed, then
  ///   call [markVerified] after successful init.
  /// - [RollbackAction.rollback]: Too many failed attempts. Trigger rollback.
  /// - [RollbackAction.powerLossRecovery]: Lock file found. Trigger rollback.
  static Future<RollbackAction> checkOnStartup({
    required SharedPreferences prefs,
    required UpdaterLauncher launcher,
  }) async {
    // 1. Check for lock file (power loss recovery)
    final lockPath = launcher.getLockFilePath();
    if (File(lockPath).existsSync()) {
      logger.warning(
          _tag, 'Lock file found at $lockPath — interrupted update detected');
      return RollbackAction.powerLossRecovery;
    }

    // 2. Check for update-result.json
    final resultPath = launcher.getResultPath();
    final result = UpdateResult.fromFile(resultPath);
    if (result == null) {
      // No result file — no update in progress
      return RollbackAction.none;
    }

    switch (result.status) {
      case 'pending_verification':
        return _handlePendingVerification(prefs, result);

      case 'verified':
      case 'acknowledged':
        // Already handled — proceed normally
        return RollbackAction.none;

      case 'rolled_back':
      case 'interrupted_recovery':
        // Will show notification after app starts — proceed normally
        return RollbackAction.none;

      case 'rollback_failed':
        // Critical — log and let the app try to start anyway
        logger.error(
          _tag,
          'Previous rollback failed: ${result.errorMessage}',
        );
        return RollbackAction.none;

      default:
        // Unknown status — proceed normally
        logger.warning(_tag, 'Unknown update result status: ${result.status}');
        return RollbackAction.none;
    }
  }

  static Future<RollbackAction> _handlePendingVerification(
    SharedPreferences prefs,
    UpdateResult result,
  ) async {
    final attempts = prefs.getInt(_launchAttemptKey) ?? 0;
    final newAttempts = attempts + 1;
    await prefs.setInt(_launchAttemptKey, newAttempts);

    logger.info(
      _tag,
      'Launch attempt $newAttempts for version ${result.targetVersion}',
    );

    if (newAttempts >= _maxAttempts) {
      logger.error(
        _tag,
        'Version ${result.targetVersion} failed $newAttempts launch attempts '
        '— triggering rollback',
      );
      return RollbackAction.rollback;
    }

    // First attempt — proceed with launch, will verify after init
    return RollbackAction.verifying;
  }

  /// Called after successful app initialization.
  ///
  /// Resets the launch attempt counter and marks the update as verified.
  /// Optionally schedules backup directory cleanup.
  static Future<void> markVerified({
    required SharedPreferences prefs,
    required UpdaterLauncher launcher,
  }) async {
    final resultPath = launcher.getResultPath();
    final result = UpdateResult.fromFile(resultPath);

    if (result == null) return;
    if (result.status != 'pending_verification') return;

    // Reset launch counter
    await prefs.setInt(_launchAttemptKey, 0);

    // Update status to verified
    final verified = result.copyWith(
      status: 'verified',
      timestamp: DateTime.now().toUtc(),
    );
    verified.writeToFile(resultPath);

    logger.info(
        _tag, 'Update to ${result.targetVersion} verified successfully');

    // Schedule backup cleanup (async, non-blocking)
    _scheduleBackupCleanup(launcher);
  }

  /// Checks whether the app was rolled back and should show a notification.
  ///
  /// Returns `true` if the update result shows `rolled_back` or
  /// `interrupted_recovery` status.
  static bool wasRolledBack({
    required UpdaterLauncher launcher,
  }) {
    final resultPath = launcher.getResultPath();
    final result = UpdateResult.fromFile(resultPath);
    if (result == null) return false;

    return result.status == 'rolled_back' ||
        result.status == 'interrupted_recovery';
  }

  /// Returns the [UpdateResult] if the status indicates a rollback occurred.
  /// Returns `null` if no rollback happened.
  static UpdateResult? getRollbackResult({
    required UpdaterLauncher launcher,
  }) {
    final resultPath = launcher.getResultPath();
    final result = UpdateResult.fromFile(resultPath);
    if (result == null) return null;

    if (result.status == 'rolled_back' ||
        result.status == 'interrupted_recovery') {
      return result;
    }
    return null;
  }

  /// Clears the rollback notification flag by updating the result status
  /// to `acknowledged`.
  static Future<void> clearRollbackFlag({
    required UpdaterLauncher launcher,
  }) async {
    final resultPath = launcher.getResultPath();
    final result = UpdateResult.fromFile(resultPath);
    if (result == null) return;

    if (result.status == 'rolled_back' ||
        result.status == 'interrupted_recovery') {
      final acknowledged = result.copyWith(
        status: 'acknowledged',
        timestamp: DateTime.now().toUtc(),
      );
      acknowledged.writeToFile(resultPath);
      logger.info(_tag, 'Rollback notification cleared');
    }
  }

  /// Cleans up the backup directory asynchronously.
  ///
  /// This is best-effort; failure is logged but does not affect the app.
  static void _scheduleBackupCleanup(UpdaterLauncher launcher) {
    final backupDir = launcher.getBackupDir();
    final dir = Directory(backupDir);

    if (!dir.existsSync()) return;

    // Run cleanup asynchronously
    Future<void>.microtask(() async {
      try {
        await dir.delete(recursive: true);
        logger.info(_tag, 'Backup directory cleaned up: $backupDir');
      } catch (e) {
        // Cleanup failure is not critical — will be retried on next launch
        logger.warning(_tag, 'Failed to clean up backup directory: $e');
      }
    });
  }
}
