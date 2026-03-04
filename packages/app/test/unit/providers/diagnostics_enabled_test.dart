import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:zajel/core/providers/app_providers.dart';

void main() {
  group('DiagnosticsEnabledNotifier', () {
    late SharedPreferences prefs;

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      prefs = await SharedPreferences.getInstance();
    });

    test('defaults to false when pref is unset (production default)', () {
      // In test environment, Environment.isProduction is true by default
      // (ENV defaults to 'production'), so the default should be false.
      final notifier = DiagnosticsEnabledNotifier(prefs);
      expect(notifier.state, isFalse);
    });

    test('loads saved true state from prefs', () async {
      await prefs.setBool('diagnosticsEnabled', true);
      final notifier = DiagnosticsEnabledNotifier(prefs);
      expect(notifier.state, isTrue);
    });

    test('loads saved false state from prefs', () async {
      await prefs.setBool('diagnosticsEnabled', false);
      final notifier = DiagnosticsEnabledNotifier(prefs);
      expect(notifier.state, isFalse);
    });

    test('explicit user preference overrides environment default', () async {
      // Even though production defaults to false, an explicit true is honored
      await prefs.setBool('diagnosticsEnabled', true);
      final notifier = DiagnosticsEnabledNotifier(prefs);
      expect(notifier.state, isTrue);
    });

    test('setEnabled(true) updates state and persists to SharedPreferences',
        () async {
      final notifier = DiagnosticsEnabledNotifier(prefs);
      expect(notifier.state, isFalse);

      await notifier.setEnabled(true);

      expect(notifier.state, isTrue);
      expect(prefs.getBool('diagnosticsEnabled'), isTrue);
    });

    test('setEnabled(false) updates state and persists to SharedPreferences',
        () async {
      await prefs.setBool('diagnosticsEnabled', true);
      final notifier = DiagnosticsEnabledNotifier(prefs);
      expect(notifier.state, isTrue);

      await notifier.setEnabled(false);

      expect(notifier.state, isFalse);
      expect(prefs.getBool('diagnosticsEnabled'), isFalse);
    });

    test('toggle on and off', () async {
      final notifier = DiagnosticsEnabledNotifier(prefs);
      expect(notifier.state, isFalse);

      await notifier.setEnabled(true);
      expect(notifier.state, isTrue);

      await notifier.setEnabled(false);
      expect(notifier.state, isFalse);

      await notifier.setEnabled(true);
      expect(notifier.state, isTrue);
    });

    test('state change is observable by listeners', () async {
      final notifier = DiagnosticsEnabledNotifier(prefs);
      final states = <bool>[];

      notifier.addListener((state) {
        states.add(state);
      });

      // addListener fires immediately with the current state (false),
      // then fires on each subsequent change.
      expect(states, [false]);

      await notifier.setEnabled(true);
      await notifier.setEnabled(false);
      await notifier.setEnabled(true);

      expect(states, [false, true, false, true]);
    });
  });
}
