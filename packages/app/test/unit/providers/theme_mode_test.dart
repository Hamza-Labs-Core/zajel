import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:zajel/core/providers/app_providers.dart';

void main() {
  group('ThemeModeNotifier', () {
    test('defaults to ThemeMode.system when no preference is stored', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final notifier = ThemeModeNotifier(prefs);

      expect(notifier.state, ThemeMode.system);
    });

    test('loads saved light preference correctly', () async {
      SharedPreferences.setMockInitialValues({'themeMode': 'light'});
      final prefs = await SharedPreferences.getInstance();
      final notifier = ThemeModeNotifier(prefs);

      expect(notifier.state, ThemeMode.light);
    });

    test('loads saved dark preference correctly', () async {
      SharedPreferences.setMockInitialValues({'themeMode': 'dark'});
      final prefs = await SharedPreferences.getInstance();
      final notifier = ThemeModeNotifier(prefs);

      expect(notifier.state, ThemeMode.dark);
    });

    test('setThemeMode updates state and persists to SharedPreferences',
        () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final notifier = ThemeModeNotifier(prefs);

      expect(notifier.state, ThemeMode.system);

      await notifier.setThemeMode(ThemeMode.dark);
      expect(notifier.state, ThemeMode.dark);
      expect(prefs.getString('themeMode'), 'dark');

      await notifier.setThemeMode(ThemeMode.light);
      expect(notifier.state, ThemeMode.light);
      expect(prefs.getString('themeMode'), 'light');

      await notifier.setThemeMode(ThemeMode.system);
      expect(notifier.state, ThemeMode.system);
      expect(prefs.getString('themeMode'), 'system');
    });

    test('unknown or invalid value falls back to ThemeMode.system', () async {
      SharedPreferences.setMockInitialValues({'themeMode': 'invalid_value'});
      final prefs = await SharedPreferences.getInstance();
      final notifier = ThemeModeNotifier(prefs);

      expect(notifier.state, ThemeMode.system);
    });
  });
}
