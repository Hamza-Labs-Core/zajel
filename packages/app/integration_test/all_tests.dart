/// Combined integration test entry point for CI.
///
/// Runs all integration tests in a single binary to avoid separate
/// compilations (~7 min each). Includes both isolated-widget tests
/// (channels, groups) and full-app tests (app, desktop).
///
/// Run with:
/// ```bash
/// flutter test integration_test/all_tests.dart -d linux --no-pub
/// ```
library;

import 'dart:io';
import 'dart:ui';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'app_test.dart' as app_tests;
import 'channels_test.dart' as channels_tests;
import 'desktop_test.dart' as desktop_tests;
import 'groups_test.dart' as groups_tests;

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  // Use in-memory secure storage to avoid libsecret/gnome-keyring hangs on
  // headless Linux CI.
  FlutterSecureStorage.setMockInitialValues({});

  // Initialize sqflite FFI for desktop platforms.
  if (Platform.isLinux || Platform.isWindows || Platform.isMacOS) {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  }

  // ── Isolated widget tests (channels/groups) ──────────────────
  // These use _buildTestWidget() with provider overrides. They need
  // a wider surface so dialogs and list items render correctly.
  group('Widget Tests', () {
    setUp(() {
      binding.platformDispatcher.views.first.physicalSize =
          const Size(1280, 720);
      binding.platformDispatcher.views.first.devicePixelRatio = 1.0;
    });

    channels_tests.main();
    groups_tests.main();
  });

  // ── Full-app tests (app/desktop) ─────────────────────────────
  // These create the complete ZajelApp with real initialization.
  // Narrow surface (< 720px wide) forces the mobile HomeScreen layout
  // instead of the wide desktop sidebar layout.
  group('Full App Tests', () {
    setUp(() {
      binding.platformDispatcher.views.first.physicalSize =
          const Size(400, 800);
      binding.platformDispatcher.views.first.devicePixelRatio = 1.0;
    });

    app_tests.main();
    desktop_tests.main();
  });
}
