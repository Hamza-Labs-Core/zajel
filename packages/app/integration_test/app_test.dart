/// Integration tests for the Zajel app.
///
/// These tests launch the real app and verify:
/// - App launches successfully
/// - Navigation to connection screen works
/// - External connections can be enabled
/// - Pairing code is displayed
/// - Can enter peer code
///
/// Run with:
/// ```bash
/// flutter test integration_test/app_test.dart
/// ```
///
/// Or with flutter drive:
/// ```bash
/// flutter drive --target=integration_test/app_test.dart
/// ```
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:zajel/main.dart';
import 'package:zajel/core/providers/app_providers.dart';

import 'test_config.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  late TestConfig config;

  setUpAll(() {
    config = TestConfig.auto();
    if (config.verboseLogging) {
      debugPrint('Integration Test Config: $config');
    }
  });

  group('App Launch Tests', () {
    testWidgets('app launches successfully and shows home screen',
        (WidgetTester tester) async {
      // Set up shared preferences for testing
      SharedPreferences.setMockInitialValues({
        'displayName': config.testDisplayName,
      });
      final prefs = await SharedPreferences.getInstance();

      // Build the app
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sharedPreferencesProvider.overrideWithValue(prefs),
          ],
          child: const ZajelApp(),
        ),
      );

      // Wait for app initialization (shows loading spinner first)
      await tester.pumpAndSettle(const Duration(seconds: 5));

      // Verify app title is shown
      expect(find.text('Zajel'), findsOneWidget);

      // Verify home screen elements are present
      expect(find.text('Nearby Devices'), findsOneWidget);

      // Verify connect button is present
      expect(find.byIcon(Icons.qr_code_scanner), findsOneWidget);

      // Verify settings button is present
      expect(find.byIcon(Icons.settings), findsOneWidget);

      // Verify display name is shown
      expect(find.text(config.testDisplayName), findsOneWidget);
    });

    testWidgets('app shows loading indicator during initialization',
        (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sharedPreferencesProvider.overrideWithValue(prefs),
          ],
          child: const ZajelApp(),
        ),
      );

      // Should show loading indicator before initialization completes
      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      // Wait for initialization
      await tester.pumpAndSettle(const Duration(seconds: 5));

      // Loading indicator should be gone
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });
  });

  group('Navigation Tests', () {
    testWidgets('can navigate to connection screen',
        (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues({
        'displayName': config.testDisplayName,
      });
      final prefs = await SharedPreferences.getInstance();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sharedPreferencesProvider.overrideWithValue(prefs),
          ],
          child: const ZajelApp(),
        ),
      );

      await tester.pumpAndSettle(const Duration(seconds: 5));

      // Tap the connect button (QR code scanner icon in app bar)
      await tester.tap(find.byIcon(Icons.qr_code_scanner));
      await tester.pumpAndSettle();

      // Verify we're on the connect screen
      expect(find.text('Connect'), findsWidgets);
      expect(find.text('My Code'), findsOneWidget);
      expect(find.text('Scan'), findsOneWidget);
      expect(find.text('Link Web'), findsOneWidget);
    });

    testWidgets('can navigate to settings screen',
        (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues({
        'displayName': config.testDisplayName,
      });
      final prefs = await SharedPreferences.getInstance();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sharedPreferencesProvider.overrideWithValue(prefs),
          ],
          child: const ZajelApp(),
        ),
      );

      await tester.pumpAndSettle(const Duration(seconds: 5));

      // Tap the settings button
      await tester.tap(find.byIcon(Icons.settings));
      await tester.pumpAndSettle();

      // Verify we're on the settings screen
      expect(find.text('Settings'), findsOneWidget);
    });

    testWidgets('can navigate back from connection screen',
        (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues({
        'displayName': config.testDisplayName,
      });
      final prefs = await SharedPreferences.getInstance();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sharedPreferencesProvider.overrideWithValue(prefs),
          ],
          child: const ZajelApp(),
        ),
      );

      await tester.pumpAndSettle(const Duration(seconds: 5));

      // Navigate to connect screen
      await tester.tap(find.byIcon(Icons.qr_code_scanner));
      await tester.pumpAndSettle();

      // Go back using the back button
      await tester.tap(find.byType(BackButton).first);
      await tester.pumpAndSettle();

      // Verify we're back on home screen
      expect(find.text('Nearby Devices'), findsOneWidget);
    });
  });

  group('Connection Screen Tests', () {
    testWidgets('My Code tab shows loading initially',
        (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues({
        'displayName': config.testDisplayName,
      });
      final prefs = await SharedPreferences.getInstance();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sharedPreferencesProvider.overrideWithValue(prefs),
          ],
          child: const ZajelApp(),
        ),
      );

      await tester.pumpAndSettle(const Duration(seconds: 5));

      // Navigate to connect screen
      await tester.tap(find.byIcon(Icons.qr_code_scanner));
      await tester.pumpAndSettle();

      // Should show loading or code (depending on server availability)
      final loadingIndicator = find.byType(CircularProgressIndicator);
      final codeText = find.textContaining(RegExp(r'^[A-Z0-9]{6}$'));

      // Either loading or code should be present
      expect(
        loadingIndicator.evaluate().isNotEmpty ||
            codeText.evaluate().isNotEmpty,
        isTrue,
        reason: 'Should show loading indicator or pairing code',
      );
    });

    testWidgets('can switch between My Code, Scan, and Link Web tabs',
        (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues({
        'displayName': config.testDisplayName,
      });
      final prefs = await SharedPreferences.getInstance();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sharedPreferencesProvider.overrideWithValue(prefs),
          ],
          child: const ZajelApp(),
        ),
      );

      await tester.pumpAndSettle(const Duration(seconds: 5));

      // Navigate to connect screen
      await tester.tap(find.byIcon(Icons.qr_code_scanner));
      await tester.pumpAndSettle();

      // Switch to Scan tab
      await tester.tap(find.text('Scan'));
      await tester.pumpAndSettle();

      // Verify scan tab content
      expect(find.text('Scan a QR code to connect'), findsOneWidget);

      // Switch to Link Web tab
      await tester.tap(find.text('Link Web'));
      await tester.pumpAndSettle();

      // Verify Link Web tab content
      expect(find.text('Generate Link Code'), findsOneWidget);
      expect(find.text('Linked Devices'), findsOneWidget);

      // Switch back to My Code tab
      await tester.tap(find.text('My Code'));
      await tester.pumpAndSettle();

      // Verify My Code tab is shown
      expect(
        find.text('Share this code with others to connect'),
        findsOneWidget,
      );
    });

    testWidgets('peer code input field accepts valid characters',
        (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues({
        'displayName': config.testDisplayName,
      });
      final prefs = await SharedPreferences.getInstance();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sharedPreferencesProvider.overrideWithValue(prefs),
          ],
          child: const ZajelApp(),
        ),
      );

      await tester.pumpAndSettle(const Duration(seconds: 5));

      // Navigate to connect screen
      await tester.tap(find.byIcon(Icons.qr_code_scanner));
      await tester.pumpAndSettle(const Duration(seconds: 3));

      // Find the text field for entering pairing code
      final textField = find.byType(TextField);
      expect(textField, findsOneWidget);

      // Enter a valid pairing code
      await tester.enterText(textField, 'abc234');
      await tester.pumpAndSettle();

      // Verify text is uppercased (input formatter converts to uppercase)
      final textFieldWidget = tester.widget<TextField>(textField);
      expect(textFieldWidget.controller?.text, equals('ABC234'));
    });

    testWidgets('peer code input field limits to 6 characters',
        (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues({
        'displayName': config.testDisplayName,
      });
      final prefs = await SharedPreferences.getInstance();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sharedPreferencesProvider.overrideWithValue(prefs),
          ],
          child: const ZajelApp(),
        ),
      );

      await tester.pumpAndSettle(const Duration(seconds: 5));

      // Navigate to connect screen
      await tester.tap(find.byIcon(Icons.qr_code_scanner));
      await tester.pumpAndSettle(const Duration(seconds: 3));

      // Find and tap the text field
      final textField = find.byType(TextField);
      expect(textField, findsOneWidget);

      // Try to enter more than 6 characters
      await tester.enterText(textField, 'ABCDEFGH');
      await tester.pumpAndSettle();

      // Verify only 6 characters are accepted
      final textFieldWidget = tester.widget<TextField>(textField);
      expect(textFieldWidget.controller?.text.length, lessThanOrEqualTo(6));
    });

    testWidgets('Connect button is present and tappable',
        (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues({
        'displayName': config.testDisplayName,
      });
      final prefs = await SharedPreferences.getInstance();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sharedPreferencesProvider.overrideWithValue(prefs),
          ],
          child: const ZajelApp(),
        ),
      );

      await tester.pumpAndSettle(const Duration(seconds: 5));

      // Navigate to connect screen
      await tester.tap(find.byIcon(Icons.qr_code_scanner));
      await tester.pumpAndSettle(const Duration(seconds: 3));

      // Find Connect button (ElevatedButton with "Connect" text)
      final connectButton = find.widgetWithText(ElevatedButton, 'Connect');
      expect(connectButton, findsOneWidget);
    });
  });

  group('FAB Tests', () {
    testWidgets('floating action button navigates to connect screen',
        (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues({
        'displayName': config.testDisplayName,
      });
      final prefs = await SharedPreferences.getInstance();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sharedPreferencesProvider.overrideWithValue(prefs),
          ],
          child: const ZajelApp(),
        ),
      );

      await tester.pumpAndSettle(const Duration(seconds: 5));

      // Find and tap the FAB
      final fab = find.byType(FloatingActionButton);
      expect(fab, findsOneWidget);

      await tester.tap(fab);
      await tester.pumpAndSettle();

      // Verify we're on the connect screen
      expect(find.text('My Code'), findsOneWidget);
    });
  });

  group('Display Name Tests', () {
    testWidgets('shows correct display name from preferences',
        (WidgetTester tester) async {
      const customName = 'Custom User Name';
      SharedPreferences.setMockInitialValues({
        'displayName': customName,
      });
      final prefs = await SharedPreferences.getInstance();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sharedPreferencesProvider.overrideWithValue(prefs),
          ],
          child: const ZajelApp(),
        ),
      );

      await tester.pumpAndSettle(const Duration(seconds: 5));

      // Verify custom display name is shown
      expect(find.text(customName), findsOneWidget);
    });

    testWidgets('shows default display name when not set',
        (WidgetTester tester) async {
      // No displayName in preferences
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sharedPreferencesProvider.overrideWithValue(prefs),
          ],
          child: const ZajelApp(),
        ),
      );

      await tester.pumpAndSettle(const Duration(seconds: 5));

      // Verify default name is shown
      expect(find.text('Anonymous'), findsOneWidget);
    });
  });

  group('Empty State Tests', () {
    testWidgets('shows empty state when no peers are found',
        (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues({
        'displayName': config.testDisplayName,
      });
      final prefs = await SharedPreferences.getInstance();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sharedPreferencesProvider.overrideWithValue(prefs),
          ],
          child: const ZajelApp(),
        ),
      );

      await tester.pumpAndSettle(const Duration(seconds: 5));

      // Verify empty state message
      expect(find.text('No devices found'), findsOneWidget);
      expect(
        find.text('Make sure other devices with Zajel are on the same network'),
        findsOneWidget,
      );

      // Verify connect via QR code button in empty state
      expect(find.text('Connect via QR code'), findsOneWidget);
    });
  });
}
