import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/config/environment.dart';
import '../../../core/providers/app_providers.dart';
import '../models/update_state.dart';
import '../services/auto_update_service.dart';
import '../services/idle_detector.dart';
import '../services/updater_launcher.dart';

// ── Auto-Install Updates ──────────────────────────────────

/// Whether the user has opted in to automatic silent update installation.
///
/// Default: false (opt-in). Only effective on desktop platforms where
/// [UpdatePackageDetector.supportsAutoUpdate()] returns true.
///
/// Persisted to SharedPreferences under the key `autoInstallUpdates`.
final autoInstallUpdatesProvider =
    StateNotifierProvider<AutoInstallUpdatesNotifier, bool>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return AutoInstallUpdatesNotifier(prefs);
});

/// StateNotifier for the auto-install updates preference.
class AutoInstallUpdatesNotifier extends StateNotifier<bool> {
  final SharedPreferences _prefs;
  static const _key = 'autoInstallUpdates';

  AutoInstallUpdatesNotifier(this._prefs)
      : super(_prefs.getBool(_key) ?? false);

  /// Enable or disable auto-install updates.
  Future<void> setEnabled(bool enabled) async {
    state = enabled;
    await _prefs.setBool(_key, enabled);
  }
}

// ── Background Download ──────────────────────────────────

/// Whether the app should download updates in the background.
///
/// Default: true (enabled by default). When disabled, updates must be
/// downloaded manually from Settings > Updates.
///
/// Persisted to SharedPreferences under the key `backgroundDownloadEnabled`.
final backgroundDownloadEnabledProvider =
    StateNotifierProvider<BackgroundDownloadSettingsNotifier, bool>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return BackgroundDownloadSettingsNotifier(prefs);
});

/// StateNotifier for the background download preference.
class BackgroundDownloadSettingsNotifier extends StateNotifier<bool> {
  final SharedPreferences _prefs;
  static const _key = 'backgroundDownloadEnabled';

  BackgroundDownloadSettingsNotifier(this._prefs)
      : super(_prefs.getBool(_key) ?? true); // Default ON

  /// Enable or disable background downloads.
  Future<void> setEnabled(bool enabled) async {
    state = enabled;
    await _prefs.setBool(_key, enabled);
  }
}

// ── Idle Detector ──────────────────────────────────

/// Provider for the [IdleDetector] singleton.
///
/// The idle detector tracks user activity and determines when the app
/// has been idle long enough for an auto-update to proceed.
final idleDetectorProvider = ChangeNotifierProvider<IdleDetector>((ref) {
  // ChangeNotifierProvider automatically disposes the ChangeNotifier —
  // do NOT add ref.onDispose(() => detector.dispose()) here as that
  // causes a double-dispose assertion error.
  return IdleDetector();
});

// ── Updater Launcher ──────────────────────────────────

/// Provides a singleton [UpdaterLauncher] instance.
final updaterLauncherProvider = Provider<UpdaterLauncher>((ref) {
  return UpdaterLauncher();
});

// ── Auto-Update Service ──────────────────────────────────

/// Provides the [AutoUpdateService] that coordinates silent auto-updates.
///
/// The service monitors idle state, VoIP calls, file transfers, and update
/// readiness before launching an update. It calls [exit(0)] after launching
/// the updater binary.
final autoUpdateServiceProvider = Provider<AutoUpdateService>((ref) {
  final idleDetector = ref.read(idleDetectorProvider);
  final updateState = ref.read(updateStateProvider);
  final orchestrator = ref.read(updateOrchestratorProvider);
  final launcher = ref.read(updaterLauncherProvider);

  final service = AutoUpdateService(
    idleDetector: idleDetector,
    hasActiveCall: () {
      // VoipService is nullable (null when signaling isn't connected)
      try {
        final voip = ref.read(voipServiceProvider);
        return voip?.hasActiveCall ?? false;
      } catch (_) {
        return false;
      }
    },
    hasActiveTransfer: () {
      try {
        return ref.read(fileReceiveServiceProvider).activeTransfers.isNotEmpty;
      } catch (_) {
        return false;
      }
    },
    isUpdateReady: () {
      return ref.read(updateStateProvider).status == UpdateStatus.ready;
    },
    launchUpdate: () async {
      final state = ref.read(updateStateProvider);
      if (state.status != UpdateStatus.ready ||
          state.availableVersion == null) {
        return;
      }
      final stagingDir = await orchestrator.getStagingDir();
      final platformName = Platform.isWindows
          ? 'windows'
          : Platform.isMacOS
              ? 'macos'
              : 'linux';
      final versionDir =
          '$stagingDir/zajel-${state.availableVersion}-$platformName';
      await launcher.launchUpdate(
        targetVersion: state.availableVersion!,
        currentVersion: Environment.version,
        stagingDir: versionDir,
        checksumSha256: orchestrator.verifiedChecksum ?? '',
      );
      exit(0);
    },
  );

  // Sync enabled state from preference
  service.setEnabled(ref.read(autoInstallUpdatesProvider));

  // React to update state changes
  if (updateState.status == UpdateStatus.ready) {
    service.onUpdateReady();
  }

  ref.onDispose(() => service.dispose());
  return service;
});
