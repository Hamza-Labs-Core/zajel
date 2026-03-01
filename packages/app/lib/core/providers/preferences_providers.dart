import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../crypto/crypto_service.dart';
import 'crypto_providers.dart';

/// Provider for shared preferences.
final sharedPreferencesProvider = Provider<SharedPreferences>((ref) {
  throw UnimplementedError('Must be overridden with actual instance');
});

/// Provider for theme mode selection (Light / Dark / System).
/// Persisted to SharedPreferences under 'themeMode'.
final themeModeProvider =
    StateNotifierProvider<ThemeModeNotifier, ThemeMode>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return ThemeModeNotifier(prefs);
});

class ThemeModeNotifier extends StateNotifier<ThemeMode> {
  final SharedPreferences _prefs;
  static const _key = 'themeMode';

  ThemeModeNotifier(this._prefs) : super(_load(_prefs));

  static ThemeMode _load(SharedPreferences prefs) {
    final value = prefs.getString(_key);
    return switch (value) {
      'light' => ThemeMode.light,
      'dark' => ThemeMode.dark,
      _ => ThemeMode.system,
    };
  }

  Future<void> setThemeMode(ThemeMode mode) async {
    state = mode;
    await _prefs.setString(
      _key,
      switch (mode) {
        ThemeMode.light => 'light',
        ThemeMode.dark => 'dark',
        ThemeMode.system => 'system',
      },
    );
  }
}

/// Provider for whether the user has seen the onboarding tutorial.
final hasSeenOnboardingProvider = StateProvider<bool>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return prefs.getBool('hasSeenOnboarding') ?? false;
});

/// Provider for the user's username (Discord-style, without tag).
/// Reads 'username' key first, falls back to 'displayName' for migration.
final usernameProvider = StateProvider<String>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return prefs.getString('username') ??
      prefs.getString('displayName') ??
      'Anonymous';
});

/// Provider for the user's full identity string: "Username#TAG".
/// The tag is derived deterministically from the stable ID (key-independent).
final userIdentityProvider = Provider<String>((ref) {
  final username = ref.watch(usernameProvider);
  try {
    final cryptoService = ref.watch(cryptoServiceProvider);
    final tag = CryptoService.tagFromStableId(cryptoService.stableId);
    return '$username#$tag';
  } on CryptoException catch (_) {
    // CryptoService not initialized yet
    return username;
  } catch (e) {
    // Unexpected error (e.g. ArgumentError from tagFromStableId)
    return username;
  }
});
