import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/providers/app_providers.dart';
import 'package:zajel/features/settings/settings_screen.dart';

import '../mocks/mocks.dart';
import 'home_screen_test.dart';

void main() {
  late MockCryptoService mockCryptoService;

  setUp(() {
    mockCryptoService = MockCryptoService();
  });

  Widget createTestWidget({
    bool diagnosticsEnabled = false,
  }) {
    final fakePrefs = FakeSharedPreferences();
    if (diagnosticsEnabled) {
      fakePrefs.setBool('diagnosticsEnabled', true);
    }

    return ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(fakePrefs),
        usernameProvider.overrideWith((ref) => 'TestUser'),
        userIdentityProvider.overrideWith((ref) => 'TestUser#1234'),
        bootstrapServerUrlProvider
            .overrideWith((ref) => 'https://test.example.com'),
        signalingConnectedProvider.overrideWith((ref) => false),
        pairingCodeProvider.overrideWith((ref) => 'TEST42'),
        selectedServerProvider.overrideWith((ref) => null),
        cryptoServiceProvider.overrideWithValue(mockCryptoService),
      ],
      child: const MaterialApp(
        home: SettingsScreen(),
      ),
    );
  }

  /// Helper to find the diagnostics SwitchListTile by its subtitle content.
  Finder findDiagnosticsTile() {
    return find.byWidgetPredicate(
      (widget) =>
          widget is SwitchListTile &&
          widget.subtitle is Text &&
          (widget.subtitle as Text).data != null &&
          (widget.subtitle as Text).data!.contains('anonymous crash reports'),
    );
  }

  /// Helper to scroll the diagnostics tile into view.
  Future<void> scrollToDiagnostics(WidgetTester tester) async {
    await tester.scrollUntilVisible(
      find.text('Send Anonymous Diagnostics'),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();
  }

  group('SettingsScreen - Diagnostics toggle', () {
    testWidgets('diagnostics toggle is visible in the settings screen',
        (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pumpAndSettle();
      await scrollToDiagnostics(tester);

      expect(find.text('Send Anonymous Diagnostics'), findsOneWidget);
      expect(
        find.text(
          'Help improve Zajel by sharing anonymous crash reports and performance data',
        ),
        findsOneWidget,
      );
    });

    testWidgets('diagnostics toggle defaults to off', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pumpAndSettle();
      await scrollToDiagnostics(tester);

      final diagnosticsTile = findDiagnosticsTile();
      expect(diagnosticsTile, findsOneWidget);

      final switchWidget = tester.widget<SwitchListTile>(diagnosticsTile);
      expect(switchWidget.value, isFalse);
    });

    testWidgets('toggling the switch updates the state', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pumpAndSettle();
      await scrollToDiagnostics(tester);

      final diagnosticsTile = findDiagnosticsTile();
      expect(diagnosticsTile, findsOneWidget);

      // Verify initially off
      final switchWidget = tester.widget<SwitchListTile>(diagnosticsTile);
      expect(switchWidget.value, isFalse);

      // Tap the tile to toggle it on
      await tester.tap(diagnosticsTile);
      await tester.pumpAndSettle();

      // Verify it's now on
      final updatedSwitch = tester.widget<SwitchListTile>(diagnosticsTile);
      expect(updatedSwitch.value, isTrue);
    });

    testWidgets('info icon is present with Learn more tooltip', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pumpAndSettle();
      await scrollToDiagnostics(tester);

      // The info icon button should have a 'Learn more' tooltip
      final infoButton = find.byTooltip('Learn more');
      expect(infoButton, findsOneWidget);
    });

    testWidgets('tapping info icon shows diagnostics info dialog',
        (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pumpAndSettle();
      await scrollToDiagnostics(tester);

      // Find and tap the info IconButton by its tooltip
      final infoButton = find.byTooltip('Learn more');
      expect(infoButton, findsOneWidget);

      await tester.tap(infoButton);
      await tester.pumpAndSettle();

      // Verify the dialog is shown with the expected title
      expect(find.text('About Diagnostics'), findsOneWidget);

      // Verify dialog content mentions key phrases.
      // The dialog text is a single Text widget containing all of these.
      expect(
        find.textContaining('No personal data'),
        findsOneWidget,
      );
      expect(
        find.textContaining('random session ID'),
        findsOneWidget,
      );
      expect(
        find.textContaining('cannot be linked to you'),
        findsOneWidget,
      );

      // Verify the OK button is present
      expect(find.text('OK'), findsOneWidget);

      // Dismiss the dialog
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();

      // Dialog should be gone
      expect(find.text('About Diagnostics'), findsNothing);
    });

    testWidgets('diagnostics toggle shows enabled when set to true',
        (tester) async {
      await tester.pumpWidget(createTestWidget(diagnosticsEnabled: true));
      await tester.pumpAndSettle();
      await scrollToDiagnostics(tester);

      final diagnosticsTile = findDiagnosticsTile();
      expect(diagnosticsTile, findsOneWidget);

      final switchWidget = tester.widget<SwitchListTile>(diagnosticsTile);
      expect(switchWidget.value, isTrue);
    });

    testWidgets('subtitle text includes "anonymous" and "crash reports"',
        (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pumpAndSettle();
      await scrollToDiagnostics(tester);

      // Find the subtitle text
      final subtitle = find.text(
        'Help improve Zajel by sharing anonymous crash reports and performance data',
      );
      expect(subtitle, findsOneWidget);

      // Verify it contains the required words
      final subtitleWidget = tester.widget<Text>(subtitle);
      expect(subtitleWidget.data, contains('anonymous'));
      expect(subtitleWidget.data, contains('crash reports'));
    });
  });
}
