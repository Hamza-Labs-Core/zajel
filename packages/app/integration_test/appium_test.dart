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

import 'package:appium_flutter_server/appium_flutter_server.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:zajel/core/providers/app_providers.dart';
import 'package:zajel/main.dart';

void main() async {
  // Initialize SharedPreferences before passing the app to initializeTest.
  // The mock values give us an empty but valid prefs instance.
  SharedPreferences.setMockInitialValues({});
  final prefs = await SharedPreferences.getInstance();

  // Ensure semantics tree so the Shelf server can find widgets.
  SemanticsBinding.instance.ensureSemantics();

  initializeTest(
    app: ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
      ],
      child: const ZajelApp(),
    ),
  );
}
