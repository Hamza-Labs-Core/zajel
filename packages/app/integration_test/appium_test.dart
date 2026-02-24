/// Appium Flutter Integration Driver entry point.
///
/// This file starts the Zajel app with an embedded Shelf HTTP server
/// (appium_flutter_server) on port 9000. The server exposes W3C
/// WebDriver-like REST endpoints that let external test code (Python
/// pytest) find and interact with Flutter widgets without relying on
/// platform accessibility APIs (AT-SPI, UIA, etc.).
///
/// Used for Linux E2E tests on CI where AT-SPI doesn't work in
/// headless Xvfb. The test code communicates over HTTP instead.
///
/// Build:
///   flutter build linux --target integration_test/appium_test.dart
///
/// Or run directly:
///   flutter test integration_test/appium_test.dart -d linux
library;

import 'dart:io';

import 'package:appium_flutter_server/appium_flutter_server.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'package:zajel/core/notifications/notification_service.dart';
import 'package:zajel/core/providers/app_providers.dart';
import 'package:zajel/main.dart';

/// No-op notification service for integration tests.
///
/// On headless Linux CI, the real NotificationService hangs forever in
/// `_plugin.initialize()` because flutter_local_notifications_linux tries
/// to connect to the freedesktop notification daemon over D-Bus, and no
/// daemon is running under Xvfb.
class _TestNotificationService extends NotificationService {
  @override
  Future<void> initialize() async {
    // No-op: skip D-Bus notification daemon connection in tests.
  }

  @override
  Future<bool> requestPermission() async => false;
}

void main() async {
  // Initialize sqflite FFI for desktop platforms — without this,
  // openDatabase throws "databaseFactory not initialized".
  if (Platform.isLinux || Platform.isWindows || Platform.isMacOS) {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  }

  // Initialize SharedPreferences before passing the app to initializeTest.
  // Include displayName so the app doesn't show any first-run dialogs.
  SharedPreferences.setMockInitialValues({
    'displayName': 'Test User',
    'hasSeenOnboarding': true,
  });
  final prefs = await SharedPreferences.getInstance();

  final app = ProviderScope(
    overrides: [
      sharedPreferencesProvider.overrideWithValue(prefs),
      // Override notification service to prevent D-Bus hangs on headless Linux.
      notificationServiceProvider.overrideWithValue(_TestNotificationService()),
    ],
    child: const ZajelApp(),
  );

  // Use the callback variant of initializeTest so we can set the surface
  // size INSIDE the testWidgets context (setSurfaceSize requires it).
  // The default test surface is tiny (10x10) on desktop, which prevents
  // widgets from rendering and makes element finding impossible.
  initializeTest(
    callback: (WidgetTester tester) async {
      // Set desktop-sized surface before pumping the widget tree.
      await tester.binding.setSurfaceSize(const Size(1280, 720));

      // Ensure semantics tree so Shelf can find widgets by tooltip/label.
      tester.binding.ensureSemantics();

      await tester.pumpWidget(app);

      // Pump frames so ZajelApp._initialize() completes and the home screen
      // renders. After pumpWidget, only the first frame (loading screen) is
      // built. The async _initialize() runs in the background (crypto init,
      // SQLite database creation, etc.); when it finishes and calls setState,
      // the rebuild won't execute until someone pumps the widget tree.
      //
      // IMPORTANT: After this callback returns, appium_flutter_server blocks
      // on `await Completer<void>().future` — no more frames are ever pumped.
      // On non-Android, find_element does NOT pump. So the widget tree MUST
      // be fully initialized before this loop ends.
      //
      // pump(Duration) advances the fake clock but doesn't wait real time.
      // _initialize()'s async operations (FFI calls, IO) need real event loop
      // time. We interleave Future.delayed with pump to allow both the async
      // init and the frame rebuild to proceed.
      bool homeScreenReady = false;
      for (int i = 0; i < 300; i++) {
        await tester.pump(const Duration(milliseconds: 100));
        // Yield to the event loop so real async operations can complete
        await Future<void>.delayed(const Duration(milliseconds: 100));

        // Diagnostic: check if the home screen has rendered.
        if (!homeScreenReady && i % 20 == 0) {
          final hasLoader =
              find.byType(CircularProgressIndicator).evaluate().isNotEmpty;
          final hasHome = find.text('Nearby Devices').evaluate().isNotEmpty;
          final hasSettings = find.byTooltip('Settings').evaluate().isNotEmpty;
          // ignore: avoid_print
          print('[appium_test pump $i] '
              'loader=$hasLoader home=$hasHome settings=$hasSettings');
          if (hasHome || hasSettings) {
            homeScreenReady = true;
            // ignore: avoid_print
            print('[appium_test] Home screen ready at pump $i — '
                'pumping 20 more frames for stability');
            // Pump a few more frames for stability then break
            for (int j = 0; j < 20; j++) {
              await tester.pump(const Duration(milliseconds: 100));
              await Future<void>.delayed(const Duration(milliseconds: 50));
            }
            break;
          }
        }
      }
      if (!homeScreenReady) {
        // ignore: avoid_print
        print('[appium_test] WARNING: Home screen did not appear after 300 '
            'pump iterations (~60s). Widget tree may be stuck on loading '
            'screen. Continuing anyway — Shelf server will start but '
            'element finding may fail.');
      }
    },
  );
}
