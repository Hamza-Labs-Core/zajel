/// Desktop-specific integration tests.
///
/// Tests privacy screen lifecycle, settings interactions, onboarding flow,
/// and navigation patterns that exercise desktop-relevant features.
///
/// These tests use provider overrides to supply mock data, avoiding the need
/// for real storage or network services. They run on all platforms via
/// `flutter test integration_test/desktop_test.dart -d linux --no-pub`.
library;

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'package:zajel/main.dart';
import 'package:zajel/core/providers/app_providers.dart';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Pump ZajelApp with overridden SharedPreferences and wait for initialization.
Future<void> _pumpApp(WidgetTester tester, SharedPreferences prefs) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
      child: const ZajelApp(),
    ),
  );
  await tester.pumpAndSettle(const Duration(seconds: 5));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  // Initialize sqflite FFI for desktop platforms so the app can fully
  // initialize its SQLite-backed storage (message, channel, group).
  if (Platform.isLinux || Platform.isWindows || Platform.isMacOS) {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  }

  // ── Privacy Screen Lifecycle ──────────────────────────────────

  group('Privacy Screen Lifecycle', () {
    testWidgets('overlay appears on hidden and disappears on resumed',
        (tester) async {
      SharedPreferences.setMockInitialValues({
        'displayName': 'Test User',
        'hasSeenOnboarding': true,
        'privacyScreenEnabled': true,
      });
      final prefs = await SharedPreferences.getInstance();

      await _pumpApp(tester, prefs);

      // Privacy overlay should NOT be visible initially
      expect(find.byIcon(Icons.lock_outline), findsNothing);

      // Simulate desktop minimize
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      await tester.pumpAndSettle();

      // Privacy overlay SHOULD be visible
      expect(find.byIcon(Icons.lock_outline), findsOneWidget);

      // Resume — overlay should disappear
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.lock_outline), findsNothing);
    });

    testWidgets('overlay appears on inactive (focus loss)', (tester) async {
      SharedPreferences.setMockInitialValues({
        'displayName': 'Test User',
        'hasSeenOnboarding': true,
        'privacyScreenEnabled': true,
      });
      final prefs = await SharedPreferences.getInstance();

      await _pumpApp(tester, prefs);

      // Simulate desktop focus loss
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.lock_outline), findsOneWidget);

      // Resume
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.lock_outline), findsNothing);
    });

    testWidgets('no overlay when privacy screen is disabled', (tester) async {
      SharedPreferences.setMockInitialValues({
        'displayName': 'Test User',
        'hasSeenOnboarding': true,
        'privacyScreenEnabled': false,
      });
      final prefs = await SharedPreferences.getInstance();

      await _pumpApp(tester, prefs);

      // Simulate lifecycle change
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      await tester.pumpAndSettle();

      // Privacy overlay should NOT appear when disabled
      expect(find.byIcon(Icons.lock_outline), findsNothing);

      // Also test inactive
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.lock_outline), findsNothing);
    });
  });

  // ── Settings Screen ───────────────────────────────────────────

  group('Settings Screen', () {
    testWidgets('all sections are visible', (tester) async {
      SharedPreferences.setMockInitialValues({
        'displayName': 'Test User',
        'hasSeenOnboarding': true,
      });
      final prefs = await SharedPreferences.getInstance();

      await _pumpApp(tester, prefs);

      // Navigate to settings
      await tester.tap(find.byIcon(Icons.settings));
      await tester.pumpAndSettle();

      expect(find.text('Settings'), findsOneWidget);
      expect(find.text('Profile'), findsOneWidget);
      expect(find.text('Appearance'), findsOneWidget);
      expect(find.text('Privacy & Security'), findsOneWidget);
      expect(find.text('External Connections'), findsOneWidget);
    });

    testWidgets('theme toggle shows all options', (tester) async {
      SharedPreferences.setMockInitialValues({
        'displayName': 'Test User',
        'hasSeenOnboarding': true,
      });
      final prefs = await SharedPreferences.getInstance();

      await _pumpApp(tester, prefs);

      await tester.tap(find.byIcon(Icons.settings));
      await tester.pumpAndSettle();

      // Theme segmented button should show all three options
      expect(find.text('Light'), findsOneWidget);
      expect(find.text('Dark'), findsOneWidget);
      expect(find.text('System'), findsOneWidget);
    });

    testWidgets('privacy screen toggle is present', (tester) async {
      SharedPreferences.setMockInitialValues({
        'displayName': 'Test User',
        'hasSeenOnboarding': true,
        'privacyScreenEnabled': true,
      });
      final prefs = await SharedPreferences.getInstance();

      await _pumpApp(tester, prefs);

      await tester.tap(find.byIcon(Icons.settings));
      await tester.pumpAndSettle();

      // Privacy screen toggle should be visible
      expect(find.text('Privacy Screen'), findsOneWidget);
      expect(find.text('Hide app content in app switcher'), findsOneWidget);
    });
  });

  // ── Onboarding Flow ───────────────────────────────────────────

  group('Onboarding Flow', () {
    testWidgets('shows onboarding when not seen', (tester) async {
      // No hasSeenOnboarding → should redirect to onboarding
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();

      await _pumpApp(tester, prefs);

      expect(find.text('Welcome to Zajel'), findsOneWidget);
      expect(find.text('Skip'), findsOneWidget);
      expect(find.text('Next'), findsOneWidget);
    });

    testWidgets('skip onboarding reaches home screen', (tester) async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();

      await _pumpApp(tester, prefs);

      // Should be on onboarding
      expect(find.text('Welcome to Zajel'), findsOneWidget);

      // Tap Skip
      await tester.tap(find.text('Skip'));
      await tester.pumpAndSettle(const Duration(seconds: 3));

      // Should be on the home screen
      expect(find.text('Nearby Devices'), findsOneWidget);
    });

    testWidgets('complete full onboarding flow', (tester) async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();

      await _pumpApp(tester, prefs);

      // Page 1: Welcome
      expect(find.text('Welcome to Zajel'), findsOneWidget);
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();

      // Page 2: Username — Next is disabled until a valid username is entered
      expect(find.text('Choose a Username'), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'DesktopUser');
      await tester.pumpAndSettle();
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();

      // Page 3: Identity
      expect(find.text('Your Identity'), findsOneWidget);
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();

      // Page 4: How to Connect
      expect(find.text('How to Connect'), findsOneWidget);
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();

      // Page 5: Get Started
      expect(find.text("You're Ready"), findsOneWidget);
      await tester.tap(find.text('Get Started'));
      await tester.pumpAndSettle(const Duration(seconds: 3));

      // Should now be on home screen
      expect(find.text('Nearby Devices'), findsOneWidget);
    });
  });

  // ── Navigation Flow ───────────────────────────────────────────

  group('Navigation Flow', () {
    testWidgets('home to channels and back', (tester) async {
      SharedPreferences.setMockInitialValues({
        'displayName': 'Test User',
        'hasSeenOnboarding': true,
      });
      final prefs = await SharedPreferences.getInstance();

      await _pumpApp(tester, prefs);

      // Navigate to channels via app bar icon
      await tester.tap(find.byIcon(Icons.rss_feed));
      await tester.pumpAndSettle();

      // Verify channels screen
      expect(find.text('Channels'), findsOneWidget);

      // Navigate back
      await tester.tap(find.byType(BackButton).first);
      await tester.pumpAndSettle();

      expect(find.text('Nearby Devices'), findsOneWidget);
    });

    testWidgets('home to groups and back', (tester) async {
      SharedPreferences.setMockInitialValues({
        'displayName': 'Test User',
        'hasSeenOnboarding': true,
      });
      final prefs = await SharedPreferences.getInstance();

      await _pumpApp(tester, prefs);

      // Navigate to groups via app bar icon
      await tester.tap(find.byIcon(Icons.group));
      await tester.pumpAndSettle();

      // Verify groups screen
      expect(find.text('Groups'), findsOneWidget);

      // Navigate back
      await tester.tap(find.byType(BackButton).first);
      await tester.pumpAndSettle();

      expect(find.text('Nearby Devices'), findsOneWidget);
    });

    testWidgets('home to connect and switch tabs', (tester) async {
      SharedPreferences.setMockInitialValues({
        'displayName': 'Test User',
        'hasSeenOnboarding': true,
      });
      final prefs = await SharedPreferences.getInstance();

      await _pumpApp(tester, prefs);

      // Navigate to connect
      await tester.tap(find.byIcon(Icons.qr_code_scanner));
      await tester.pumpAndSettle();

      // Verify connect screen with tabs
      expect(find.text('My Code'), findsOneWidget);
      expect(find.text('Scan'), findsOneWidget);
      expect(find.text('Link Web'), findsOneWidget);

      // Switch tabs
      await tester.tap(find.text('Scan'));
      await tester.pumpAndSettle();
      expect(find.text('Scan a QR code to connect'), findsOneWidget);

      await tester.tap(find.text('Link Web'));
      await tester.pumpAndSettle();
      expect(find.text('Generate Link Code'), findsOneWidget);

      // Navigate back
      await tester.tap(find.byType(BackButton).first);
      await tester.pumpAndSettle();

      expect(find.text('Nearby Devices'), findsOneWidget);
    });

    testWidgets('home to settings and back', (tester) async {
      SharedPreferences.setMockInitialValues({
        'displayName': 'Test User',
        'hasSeenOnboarding': true,
      });
      final prefs = await SharedPreferences.getInstance();

      await _pumpApp(tester, prefs);

      // Navigate to settings
      await tester.tap(find.byIcon(Icons.settings));
      await tester.pumpAndSettle();

      expect(find.text('Settings'), findsOneWidget);

      // Navigate back
      await tester.tap(find.byType(BackButton).first);
      await tester.pumpAndSettle();

      expect(find.text('Nearby Devices'), findsOneWidget);
    });
  });
}
