# CI Test Limitations

This document explains why certain tests are skipped in CI and how to run them locally.

## Flutter Integration Tests

Flutter integration tests (`integration_test/`) are currently **skipped in CI** for the following reasons:

### Platform-Specific Issues

#### Linux Desktop
**Status**: Skipped in CI

**Issue**: `VmServiceDisappearedException` crashes during headless integration test execution.

Flutter integration tests on Linux desktop in CI environments frequently encounter crashes with the Dart VM service disconnecting unexpectedly. This appears to be related to headless execution and VM stability issues.

**Related Issues**:
- [flutter/flutter#101031](https://github.com/flutter/flutter/issues/101031) - VmServiceDisappearedException in CI
- [flutter/flutter#125231](https://github.com/flutter/flutter/issues/125231) - Integration test stability on Linux

**Workaround**: Run integration tests locally on Linux desktop with a display server.

#### Web Platform
**Status**: Not supported by Flutter

**Issue**: Flutter integration tests do not support web targets.

Flutter's integration test framework uses `flutter_driver` and `integration_test` packages which rely on native platform capabilities. The web platform does not support the VM service protocol required for integration tests.

**Error Message**: `"Web devices are not supported for integration tests yet"`

**Alternative**: Widget tests run on web in CI and provide UI testing coverage.

#### macOS Desktop
**Status**: Available but skipped to reduce costs

**Reason**: macOS runners on GitHub Actions are significantly more expensive than Linux runners (10x cost multiplier). Since we already test on iOS (which shares the same macOS runner cost), we skip redundant macOS desktop tests.

**Note**: Integration tests work reliably on macOS and can be run locally.

#### Android & iOS
**Status**: Skipped in CI due to emulator/simulator complexity

**Reason**: Running Android emulators and iOS simulators in CI requires:
- Significant setup time (2-5 minutes per test run)
- Hardware acceleration (KVM for Android, nested virtualization)
- Large disk space for emulator images
- Increased CI runtime and costs

**Current Approach**: We rely on:
- Extensive widget tests (run in CI)
- Local integration testing during development
- Manual QA on physical devices before releases

## Running Integration Tests Locally

Integration tests work reliably when run locally with the following commands:

### Linux Desktop
```bash
cd packages/app
flutter test integration_test/ -d linux
```

Requirements:
- Linux desktop environment with X11 or Wayland
- Flutter desktop dependencies installed

### macOS Desktop
```bash
cd packages/app
flutter test integration_test/ -d macos
```

Requirements:
- macOS development environment
- Xcode and command-line tools installed

### Android
```bash
cd packages/app
flutter test integration_test/ -d <device-id>
```

Requirements:
- Android device connected via USB with USB debugging enabled, OR
- Android emulator running (use `flutter emulators --launch <emulator-id>`)

### iOS
```bash
cd packages/app
flutter test integration_test/ -d <device-id>
```

Requirements:
- iOS device connected with developer profile, OR
- iOS simulator running (use `xcrun simctl list` to see available simulators)

## Using the Test Runner Script

The project includes a helper script at `packages/app/run_integration_tests.sh` for running integration tests with various configurations:

```bash
# Run all integration tests
./run_integration_tests.sh

# Start a local VPS server and run tests
./run_integration_tests.sh --with-server

# Run with mock server (no network required)
./run_integration_tests.sh --mock

# Run specific test file
./run_integration_tests.sh app              # Run app_test.dart
./run_integration_tests.sh connection       # Run connection_test.dart

# Enable verbose output
./run_integration_tests.sh --verbose

# Show all options
./run_integration_tests.sh --help
```

See the script documentation for more advanced usage and environment variables.

## Widget Tests

Widget tests (`test/`) **DO run in CI** and provide comprehensive UI testing coverage:

```bash
cd packages/app
flutter test test/
```

Widget tests:
- Run in CI on every push and PR
- Execute quickly without platform-specific dependencies
- Test UI components, state management, and business logic
- Support all platforms including web

## Summary

| Test Type | CI Status | Reason | Local Testing |
|-----------|-----------|--------|---------------|
| Unit/Widget Tests | ✅ Running | Fast, reliable, platform-independent | `flutter test test/` |
| Integration - Linux | ❌ Skipped | VmServiceDisappearedException | `flutter test integration_test/ -d linux` |
| Integration - Web | ❌ Not Supported | Flutter limitation | N/A |
| Integration - macOS | ❌ Skipped | Cost optimization | `flutter test integration_test/ -d macos` |
| Integration - Android | ❌ Skipped | Emulator complexity | `flutter test integration_test/ -d <device>` |
| Integration - iOS | ❌ Skipped | Simulator complexity | `flutter test integration_test/ -d <device>` |

## Recommendations

1. **Run integration tests locally** before submitting PRs
2. **Focus on widget tests** for CI coverage
3. **Use the test runner script** for consistent local testing
4. **Test on physical devices** before major releases
5. **Monitor Flutter issues** for integration test stability improvements

## Future Improvements

We are tracking the following improvements:

1. **Enable Android integration tests in CI** once we have a stable emulator setup
2. **Add iOS integration tests** when GitHub Actions improves simulator support
3. **Investigate Linux headless testing** with xvfb or other virtual display solutions
4. **Expand widget test coverage** to reduce reliance on integration tests

## References

- [Flutter Integration Testing Documentation](https://docs.flutter.dev/testing/integration-tests)
- [GitHub Actions Flutter Documentation](https://docs.flutter.dev/deployment/cd#github-actions)
- [Flutter CI/CD Best Practices](https://docs.flutter.dev/testing/debugging)
- Project test runner: `packages/app/run_integration_tests.sh`
- CI workflow: `.github/workflows/flutter-tests.yml`
