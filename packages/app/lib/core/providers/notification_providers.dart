import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/models.dart';
import '../notifications/notification_service.dart';
import 'preferences_providers.dart';

/// Provider for notification settings with SharedPreferences persistence.
final notificationSettingsProvider =
    StateNotifierProvider<NotificationSettingsNotifier, NotificationSettings>(
        (ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return NotificationSettingsNotifier(prefs);
});

/// Notifier for managing notification settings with persistence.
class NotificationSettingsNotifier extends StateNotifier<NotificationSettings> {
  final SharedPreferences _prefs;
  static const _key = 'notificationSettings';

  NotificationSettingsNotifier(this._prefs) : super(_load(_prefs));

  static NotificationSettings _load(SharedPreferences prefs) {
    final data = prefs.getString(_key);
    if (data == null) return const NotificationSettings();
    return NotificationSettings.deserialize(data);
  }

  Future<void> _save() async {
    await _prefs.setString(_key, state.serialize());
  }

  Future<void> setGlobalDnd(bool enabled, {DateTime? until}) async {
    state = state.copyWith(
        globalDnd: enabled,
        dndUntil: until,
        clearDndUntil: until == null && !enabled);
    await _save();
  }

  Future<void> setSoundEnabled(bool enabled) async {
    state = state.copyWith(soundEnabled: enabled);
    await _save();
  }

  Future<void> setPreviewEnabled(bool enabled) async {
    state = state.copyWith(previewEnabled: enabled);
    await _save();
  }

  Future<void> setMessageNotifications(bool enabled) async {
    state = state.copyWith(messageNotifications: enabled);
    await _save();
  }

  Future<void> setCallNotifications(bool enabled) async {
    state = state.copyWith(callNotifications: enabled);
    await _save();
  }

  Future<void> setPeerStatusNotifications(bool enabled) async {
    state = state.copyWith(peerStatusNotifications: enabled);
    await _save();
  }

  Future<void> setFileReceivedNotifications(bool enabled) async {
    state = state.copyWith(fileReceivedNotifications: enabled);
    await _save();
  }

  Future<void> mutePeer(String peerId) async {
    state = state.copyWith(mutedPeerIds: {...state.mutedPeerIds, peerId});
    await _save();
  }

  Future<void> unmutePeer(String peerId) async {
    state =
        state.copyWith(mutedPeerIds: {...state.mutedPeerIds}..remove(peerId));
    await _save();
  }

  bool isPeerMuted(String peerId) => state.mutedPeerIds.contains(peerId);
}

/// Provider for notification service.
final notificationServiceProvider = Provider<NotificationService>((ref) {
  return NotificationService();
});
