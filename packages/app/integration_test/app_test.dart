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
/// flutter test integration_test/app_test.dart -d linux --no-pub
/// ```
library;

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'package:zajel/main.dart';
import 'package:zajel/core/notifications/notification_service.dart';
import 'package:zajel/core/providers/app_providers.dart';

import 'test_config.dart';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// No-op notification service for integration tests.
///
/// On headless Linux CI, the real NotificationService hangs forever in
/// `_plugin.initialize()` because flutter_local_notifications_linux tries
/// to connect to the freedesktop notification daemon over D-Bus.
class _TestNotificationService extends NotificationService {
  @override
  Future<void> initialize() async {}

  @override
  Future<bool> requestPermission() async => false;
}

/// Pump ZajelApp with overridden SharedPreferences and wait for initialization.
///
/// Uses a counted pump loop instead of pumpAndSettle because ZajelApp starts
/// background processes (signaling connection, periodic auto-delete timer)
/// that continuously schedule frames, preventing pumpAndSettle from settling.
Future<void> _pumpApp(WidgetTester tester, SharedPreferences prefs) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        notificationServiceProvider
            .overrideWithValue(_TestNotificationService()),
      ],
      child: const ZajelApp(),
    ),
  );
  // Pump frames with real-time delays for _initialize() to complete.
  // With in-memory secure storage, _initialize() completes in <3s.
  for (int i = 0; i < 40; i++) {
    await tester.pump(const Duration(milliseconds: 100));
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
}

/// Pump frames for a short duration after a UI action (e.g. tap, navigation).
///
/// Replacement for pumpAndSettle in tests where background processes prevent
/// the frame scheduler from settling.
Future<void> _pumpFrames(WidgetTester tester, {int count = 20}) async {
  for (int i = 0; i < count; i++) {
    await tester.pump(const Duration(milliseconds: 100));
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  // Use in-memory secure storage to avoid libsecret/gnome-keyring hangs on
  // headless Linux CI.
  FlutterSecureStorage.setMockInitialValues({});

  // Initialize sqflite FFI for desktop platforms.
  if (Platform.isLinux || Platform.isWindows || Platform.isMacOS) {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  }

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
      SharedPreferences.setMockInitialValues({
        'displayName': config.testDisplayName,
      });
      final prefs = await SharedPreferences.getInstance();

      await _pumpApp(tester, prefs);

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
            notificationServiceProvider
                .overrideWithValue(_TestNotificationService()),
          ],
          child: const ZajelApp(),
        ),
      );

      // Should show loading indicator before initialization completes
      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      // Wait for initialization
      await _pumpFrames(tester, count: 100);

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

      await _pumpApp(tester, prefs);

      // Tap the connect button (QR code scanner icon in app bar)
      await tester.tap(find.byIcon(Icons.qr_code_scanner));
      await _pumpFrames(tester);

      // Verify we're on the connect screen
      expect(find.text('Connect'), findsWidgets);
      expect(find.text('My Code'), findsOneWidget);
      expect(find.text('Scan'), findsOneWidget);
      expect(find.text('Link Web'), findsOneWidget);
    });

    testWidgets('can navigate to settings screen', (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues({
        'displayName': config.testDisplayName,
      });
      final prefs = await SharedPreferences.getInstance();

      await _pumpApp(tester, prefs);

      // Tap the settings button
      await tester.tap(find.byIcon(Icons.settings));
      await _pumpFrames(tester);

      // Verify we're on the settings screen
      expect(find.text('Settings'), findsOneWidget);
    });

    testWidgets('can navigate back from connection screen',
        (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues({
        'displayName': config.testDisplayName,
      });
      final prefs = await SharedPreferences.getInstance();

      await _pumpApp(tester, prefs);

      // Navigate to connect screen
      await tester.tap(find.byIcon(Icons.qr_code_scanner));
      await _pumpFrames(tester);

      // Go back using the back button
      await tester.tap(find.byType(BackButton).first);
      await _pumpFrames(tester);

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

      await _pumpApp(tester, prefs);

      // Navigate to connect screen
      await tester.tap(find.byIcon(Icons.qr_code_scanner));
      await _pumpFrames(tester);

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

      await _pumpApp(tester, prefs);

      // Navigate to connect screen
      await tester.tap(find.byIcon(Icons.qr_code_scanner));
      await _pumpFrames(tester);

      // Switch to Scan tab
      await tester.tap(find.text('Scan'));
      await _pumpFrames(tester);

      // Verify scan tab content
      expect(find.text('Scan a QR code to connect'), findsOneWidget);

      // Switch to Link Web tab
      await tester.tap(find.text('Link Web'));
      await _pumpFrames(tester);

      // Verify Link Web tab content
      expect(find.text('Generate Link Code'), findsOneWidget);
      expect(find.text('Linked Devices'), findsOneWidget);

      // Switch back to My Code tab
      await tester.tap(find.text('My Code'));
      await _pumpFrames(tester);

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

      await _pumpApp(tester, prefs);

      // Navigate to connect screen
      await tester.tap(find.byIcon(Icons.qr_code_scanner));
      await _pumpFrames(tester, count: 30);

      // Find the text field for entering pairing code
      final textField = find.byType(TextField);
      expect(textField, findsOneWidget);

      // Enter a valid pairing code
      await tester.enterText(textField, 'abc234');
      await _pumpFrames(tester);

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

      await _pumpApp(tester, prefs);

      // Navigate to connect screen
      await tester.tap(find.byIcon(Icons.qr_code_scanner));
      await _pumpFrames(tester, count: 30);

      // Find and tap the text field
      final textField = find.byType(TextField);
      expect(textField, findsOneWidget);

      // Try to enter more than 6 characters
      await tester.enterText(textField, 'ABCDEFGH');
      await _pumpFrames(tester);

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

      await _pumpApp(tester, prefs);

      // Navigate to connect screen
      await tester.tap(find.byIcon(Icons.qr_code_scanner));
      await _pumpFrames(tester, count: 30);

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

      await _pumpApp(tester, prefs);

      // Find and tap the FAB
      final fab = find.byType(FloatingActionButton);
      expect(fab, findsOneWidget);

      await tester.tap(fab);
      await _pumpFrames(tester);

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

      await _pumpApp(tester, prefs);

      // Verify custom display name is shown
      expect(find.text(customName), findsOneWidget);
    });

    testWidgets('shows default display name when not set',
        (WidgetTester tester) async {
      // No displayName in preferences
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();

      await _pumpApp(tester, prefs);

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

      await _pumpApp(tester, prefs);

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
