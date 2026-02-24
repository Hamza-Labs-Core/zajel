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
import 'dart:ui';

import 'package:appium_flutter_server/appium_flutter_server.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'package:zajel/core/providers/app_providers.dart';
import 'package:zajel/main.dart';

void main() async {
  // Initialize sqflite FFI for desktop platforms — without this,
  // openDatabase throws "databaseFactory not initialized".
  if (Platform.isLinux || Platform.isWindows || Platform.isMacOS) {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  }

  // Initialize SharedPreferences before passing the app to initializeTest.
  SharedPreferences.setMockInitialValues({
    'hasSeenOnboarding': true,
  });
  final prefs = await SharedPreferences.getInstance();

  final app = ProviderScope(
    overrides: [
      sharedPreferencesProvider.overrideWithValue(prefs),
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
      // pump(Duration) advances the fake clock but doesn't wait real time.
      // _initialize()'s async operations (FFI calls, IO) need real event loop
      // time. We interleave Future.delayed with pump to allow both the async
      // init and the frame rebuild to proceed.
      for (int i = 0; i < 150; i++) {
        await tester.pump(const Duration(milliseconds: 100));
        // Yield to the event loop so real async operations can complete
        await Future<void>.delayed(const Duration(milliseconds: 100));
      }
    },
  );
}
