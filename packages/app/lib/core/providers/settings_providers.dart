import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'preferences_providers.dart';

// ── Auto-Delete Messages ──────────────────────────────────

/// Settings for automatic message deletion.
class AutoDeleteSettings {
  final bool enabled;
  final Duration duration;

  const AutoDeleteSettings({
    this.enabled = false,
    this.duration = const Duration(hours: 24),
  });

  AutoDeleteSettings copyWith({bool? enabled, Duration? duration}) {
    return AutoDeleteSettings(
      enabled: enabled ?? this.enabled,
      duration: duration ?? this.duration,
    );
  }

  /// Available auto-delete duration options (minutes -> label).
  static const durations = <int, String>{
    60: '1 hour',
    360: '6 hours',
    1440: '24 hours',
    10080: '7 days',
    43200: '30 days',
  };
}

final autoDeleteSettingsProvider =
    StateNotifierProvider<AutoDeleteSettingsNotifier, AutoDeleteSettings>(
        (ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return AutoDeleteSettingsNotifier(prefs);
});

class AutoDeleteSettingsNotifier extends StateNotifier<AutoDeleteSettings> {
  final SharedPreferences _prefs;
  static const _enabledKey = 'autoDeleteEnabled';
  static const _durationKey = 'autoDeleteDurationMinutes';

  AutoDeleteSettingsNotifier(this._prefs) : super(_load(_prefs));

  static AutoDeleteSettings _load(SharedPreferences prefs) {
    final enabled = prefs.getBool(_enabledKey) ?? false;
    final minutes = prefs.getInt(_durationKey) ?? 1440; // 24 hours
    return AutoDeleteSettings(
      enabled: enabled,
      duration: Duration(minutes: minutes),
    );
  }

  Future<void> setEnabled(bool enabled) async {
    state = state.copyWith(enabled: enabled);
    await _prefs.setBool(_enabledKey, enabled);
  }

  Future<void> setDuration(Duration duration) async {
    state = state.copyWith(duration: duration);
    await _prefs.setInt(_durationKey, duration.inMinutes);
  }
}

// ── Privacy Screen ──────────────────────────────────

/// Whether the app-switcher privacy screen is enabled.
/// When enabled, the app content is obscured when the app goes to background,
/// preventing sensitive content from appearing in the app switcher / recent apps.
final privacyScreenProvider =
    StateNotifierProvider<PrivacyScreenNotifier, bool>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return PrivacyScreenNotifier(prefs);
});

class PrivacyScreenNotifier extends StateNotifier<bool> {
  final SharedPreferences _prefs;
  static const _key = 'privacyScreenEnabled';

  PrivacyScreenNotifier(this._prefs)
      : super(_prefs.getBool(_key) ?? true); // enabled by default

  Future<void> setEnabled(bool enabled) async {
    state = enabled;
    await _prefs.setBool(_key, enabled);
  }
}

// ---------------------------------------------------------------------------
// Active screen tracking (for notification suppression)
// ---------------------------------------------------------------------------

/// Describes which screen the user is currently viewing.
///
/// Used by the notification listener to suppress notifications when the user
/// is already looking at the relevant chat, channel, or group.
class ActiveScreen {
  final String type; // 'chat', 'channel', 'group', or 'other'
  final String? id; // peerId, channelId, or groupId

  const ActiveScreen({required this.type, this.id});
  static const other = ActiveScreen(type: 'other');
}

/// Tracks the currently visible screen so notifications can be suppressed
/// when the user is already viewing the relevant conversation.
final activeScreenProvider = StateProvider<ActiveScreen>((ref) {
  return ActiveScreen.other;
});

/// Tracks whether the app is in the foreground (resumed).
final appInForegroundProvider = StateProvider<bool>((ref) => true);
