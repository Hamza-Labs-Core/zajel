/// Combined integration test entry point for CI.
///
/// Runs all integration test suites in a single binary to avoid
/// recompiling the Flutter app for each test file separately.
/// On Linux desktop, each `flutter test -d linux` invocation builds
/// a fresh native binary (~7 min). Running 4 files sequentially takes
/// ~28 min of build time. This combined entry point reduces it to one
/// build (~7 min) + all tests (~5 min).
///
/// Run with:
/// ```bash
/// flutter test integration_test/all_tests.dart -d linux --no-pub \
///   --dart-define=INTEGRATION_TEST=true
/// ```
library;

import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:integration_test/integration_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'app_test.dart' as app_tests;
import 'channels_test.dart' as channels_tests;
import 'desktop_test.dart' as desktop_tests;
import 'groups_test.dart' as groups_tests;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  // Shared setup — each sub-file also calls these, but they're idempotent.
  FlutterSecureStorage.setMockInitialValues({});

  if (Platform.isLinux || Platform.isWindows || Platform.isMacOS) {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  }

  // Register all test suites.
  // Each file's main() calls ensureInitialized() again (safe — idempotent)
  // and registers its testWidgets/group calls with the test framework.
  desktop_tests.main();
  app_tests.main();
  channels_tests.main();
  groups_tests.main();
}
