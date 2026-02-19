import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:zajel/core/providers/app_providers.dart';

void main() {
  group('PrivacyScreenNotifier', () {
    late SharedPreferences prefs;

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      prefs = await SharedPreferences.getInstance();
    });

    test('defaults to enabled', () {
      final notifier = PrivacyScreenNotifier(prefs);
      expect(notifier.debugState, isTrue);
    });

    test('loads saved state from prefs', () async {
      await prefs.setBool('privacyScreenEnabled', false);
      final notifier = PrivacyScreenNotifier(prefs);
      expect(notifier.debugState, isFalse);
    });

    test('setEnabled persists to prefs', () async {
      final notifier = PrivacyScreenNotifier(prefs);
      await notifier.setEnabled(false);

      expect(notifier.debugState, isFalse);
      expect(prefs.getBool('privacyScreenEnabled'), isFalse);
    });

    test('toggle on and off', () async {
      final notifier = PrivacyScreenNotifier(prefs);
      expect(notifier.debugState, isTrue);

      await notifier.setEnabled(false);
      expect(notifier.debugState, isFalse);

      await notifier.setEnabled(true);
      expect(notifier.debugState, isTrue);
    });
  });
}
