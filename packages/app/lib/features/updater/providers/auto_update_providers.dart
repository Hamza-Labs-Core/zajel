import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/providers/preferences_providers.dart';
import '../services/idle_detector.dart';

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
  final detector = IdleDetector();
  ref.onDispose(() => detector.dispose());
  return detector;
});
