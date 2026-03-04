import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:zajel/core/providers/app_providers.dart';

void main() {
  group('AutoDeleteSettings', () {
    test('default values are disabled with 24 hour duration', () {
      const settings = AutoDeleteSettings();
      expect(settings.enabled, isFalse);
      expect(settings.duration, const Duration(hours: 24));
    });

    test('copyWith preserves unchanged values', () {
      const original = AutoDeleteSettings(
        enabled: true,
        duration: Duration(hours: 6),
      );

      final copy = original.copyWith(enabled: false);
      expect(copy.enabled, isFalse);
      expect(copy.duration, const Duration(hours: 6));
    });

    test('durations map has expected entries', () {
      expect(AutoDeleteSettings.durations, hasLength(5));
      expect(AutoDeleteSettings.durations.containsKey(60), isTrue); // 1 hour
      expect(
          AutoDeleteSettings.durations.containsKey(1440), isTrue); // 24 hours
      expect(
          AutoDeleteSettings.durations.containsKey(43200), isTrue); // 30 days
    });
  });

  group('AutoDeleteSettingsNotifier', () {
    late SharedPreferences prefs;

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      prefs = await SharedPreferences.getInstance();
    });

    test('loads default settings when prefs are empty', () {
      final notifier = AutoDeleteSettingsNotifier(prefs);
      expect(notifier.state.enabled, isFalse);
      expect(notifier.state.duration, const Duration(hours: 24));
    });

    test('loads saved settings from prefs', () async {
      await prefs.setBool('autoDeleteEnabled', true);
      await prefs.setInt('autoDeleteDurationMinutes', 60);

      final notifier = AutoDeleteSettingsNotifier(prefs);
      expect(notifier.state.enabled, isTrue);
      expect(notifier.state.duration, const Duration(hours: 1));
    });

    test('setEnabled persists to prefs', () async {
      final notifier = AutoDeleteSettingsNotifier(prefs);
      await notifier.setEnabled(true);

      expect(notifier.state.enabled, isTrue);
      expect(prefs.getBool('autoDeleteEnabled'), isTrue);
    });

    test('setDuration persists to prefs', () async {
      final notifier = AutoDeleteSettingsNotifier(prefs);
      await notifier.setDuration(const Duration(days: 7));

      expect(notifier.state.duration, const Duration(days: 7));
      expect(prefs.getInt('autoDeleteDurationMinutes'), 7 * 24 * 60);
    });

    test('toggle enabled off and on preserves duration', () async {
      final notifier = AutoDeleteSettingsNotifier(prefs);
      await notifier.setDuration(const Duration(hours: 6));
      await notifier.setEnabled(true);
      await notifier.setEnabled(false);
      await notifier.setEnabled(true);

      expect(notifier.state.enabled, isTrue);
      expect(notifier.state.duration, const Duration(hours: 6));
    });
  });
}
