/// Combined integration test entry point for CI.
///
/// Runs lightweight (isolated-widget) integration tests in a single binary.
/// Only includes channels_test and groups_test, which use _buildTestWidget()
/// with provider overrides — no full ZajelApp initialization needed.
///
/// Full-app tests (desktop_test, app_test) are excluded because they create
/// the complete ZajelApp per test, including crypto/WebRTC initialization,
/// which takes ~45s per test on headless CI with LiveTestWidgetsFlutterBinding.
/// That functionality is already covered by:
///   - Desktop E2E UI tests (real cursor, 5 tests, 14s)
///   - Flutter unit tests (1451 tests, <60s)
///
/// Run with:
/// ```bash
/// flutter test integration_test/all_tests.dart -d linux --no-pub \
///   --dart-define=INTEGRATION_TEST=true
/// ```
library;

import 'package:integration_test/integration_test.dart';

import 'channels_test.dart' as channels_tests;
import 'groups_test.dart' as groups_tests;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  // Register lightweight test suites.
  // These use isolated widgets with provider overrides — fast on CI.
  channels_tests.main();
  groups_tests.main();
}
