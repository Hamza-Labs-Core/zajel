import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:zajel/features/updater/providers/auto_update_providers.dart';

void main() {
  group('AutoInstallUpdatesNotifier', () {
    late SharedPreferences prefs;

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      prefs = await SharedPreferences.getInstance();
    });

    test('defaults to false', () {
      final notifier = AutoInstallUpdatesNotifier(prefs);
      expect(notifier.state, isFalse);
    });

    test('loads saved state from prefs', () async {
      await prefs.setBool('autoInstallUpdates', true);
      final notifier = AutoInstallUpdatesNotifier(prefs);
      expect(notifier.state, isTrue);
    });

    test('setEnabled persists true to prefs', () async {
      final notifier = AutoInstallUpdatesNotifier(prefs);
      await notifier.setEnabled(true);

      expect(notifier.state, isTrue);
      expect(prefs.getBool('autoInstallUpdates'), isTrue);
    });

    test('setEnabled persists false to prefs', () async {
      final notifier = AutoInstallUpdatesNotifier(prefs);
      await notifier.setEnabled(true);
      await notifier.setEnabled(false);

      expect(notifier.state, isFalse);
      expect(prefs.getBool('autoInstallUpdates'), isFalse);
    });

    test('toggle on and off', () async {
      final notifier = AutoInstallUpdatesNotifier(prefs);
      expect(notifier.state, isFalse);

      await notifier.setEnabled(true);
      expect(notifier.state, isTrue);

      await notifier.setEnabled(false);
      expect(notifier.state, isFalse);
    });
  });

  group('BackgroundDownloadSettingsNotifier', () {
    late SharedPreferences prefs;

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      prefs = await SharedPreferences.getInstance();
    });

    test('defaults to true', () {
      final notifier = BackgroundDownloadSettingsNotifier(prefs);
      expect(notifier.state, isTrue);
    });

    test('loads saved state from prefs', () async {
      await prefs.setBool('backgroundDownloadEnabled', false);
      final notifier = BackgroundDownloadSettingsNotifier(prefs);
      expect(notifier.state, isFalse);
    });

    test('setEnabled persists false to prefs', () async {
      final notifier = BackgroundDownloadSettingsNotifier(prefs);
      await notifier.setEnabled(false);

      expect(notifier.state, isFalse);
      expect(prefs.getBool('backgroundDownloadEnabled'), isFalse);
    });

    test('setEnabled persists true to prefs', () async {
      final notifier = BackgroundDownloadSettingsNotifier(prefs);
      await notifier.setEnabled(false);
      await notifier.setEnabled(true);

      expect(notifier.state, isTrue);
      expect(prefs.getBool('backgroundDownloadEnabled'), isTrue);
    });

    test('toggle off and on', () async {
      final notifier = BackgroundDownloadSettingsNotifier(prefs);
      expect(notifier.state, isTrue);

      await notifier.setEnabled(false);
      expect(notifier.state, isFalse);

      await notifier.setEnabled(true);
      expect(notifier.state, isTrue);
    });
  });
}
