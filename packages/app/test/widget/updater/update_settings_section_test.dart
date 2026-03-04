import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:zajel/features/updater/models/update_check_result.dart';
import 'package:zajel/features/updater/providers/update_providers.dart';
import 'package:zajel/features/updater/services/github_release_service.dart';
import 'package:zajel/features/updater/services/update_package_detector.dart';
import 'package:zajel/features/updater/widgets/update_settings_section.dart';

/// Creates a test widget with the given provider overrides.
Widget _createTestWidget({
  UpdateCheckResult? checkResult,
  bool isChecking = false,
  bool supportsAutoUpdate = true,
  String? storeName,
}) {
  return ProviderScope(
    overrides: [
      updateCheckResultProvider.overrideWith((ref) => checkResult),
      updateCheckInProgressProvider.overrideWith((ref) => isChecking),
      supportsAutoUpdateProvider.overrideWithValue(supportsAutoUpdate),
      storeNameProvider.overrideWithValue(storeName),
      // Provide a detector that matches the supportsAutoUpdate value
      updatePackageDetectorProvider.overrideWithValue(
        UpdatePackageDetector(
          isWindows: false,
          isMacOS: false,
          isLinux: true,
          environment: {},
          resolvedExecutablePath: '/usr/bin/zajel',
        ),
      ),
      // Override the service to avoid real HTTP calls
      githubReleaseServiceProvider.overrideWithValue(
        _FakeGitHubReleaseService(),
      ),
    ],
    child: const MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(
          child: UpdateSettingsSection(),
        ),
      ),
    ),
  );
}

void main() {
  group('UpdateSettingsSection', () {
    testWidgets('shows "Check Now" button in idle state', (tester) async {
      await tester.pumpWidget(_createTestWidget());
      await tester.pump();

      expect(find.text('Check Now'), findsOneWidget);
      expect(find.text('No update check performed yet'), findsOneWidget);
    });

    testWidgets('shows current version in idle state', (tester) async {
      await tester.pumpWidget(_createTestWidget());
      await tester.pump();

      // Environment.version is empty in test, so it shows 'dev'
      expect(find.textContaining('Version'), findsOneWidget);
    });

    testWidgets('shows spinner during check', (tester) async {
      await tester.pumpWidget(_createTestWidget(isChecking: true));
      await tester.pump();

      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Checking for updates...'), findsOneWidget);
      // No Check Now button while checking
      expect(find.text('Check Now'), findsNothing);
    });

    testWidgets('shows "You\'re up to date" on success', (tester) async {
      final result = UpdateCheckUpToDate(
        currentVersion: '1.0.0',
        checkedAt: DateTime.now(),
      );

      await tester.pumpWidget(_createTestWidget(checkResult: result));
      await tester.pump();

      expect(find.text("You're up to date"), findsOneWidget);
      expect(find.textContaining('Version 1.0.0'), findsOneWidget);
      expect(find.textContaining('Last checked:'), findsOneWidget);
      expect(find.byIcon(Icons.check_circle), findsOneWidget);
      expect(find.text('Check Now'), findsOneWidget);
    });

    testWidgets('shows update available details', (tester) async {
      final result = UpdateCheckAvailable(
        currentVersion: '1.0.0',
        latestVersion: '1.2.0',
        releaseName: 'Zajel v1.2.0',
        releaseNotes: 'Added feature X, fixed bug Y',
        publishedAt: DateTime(2026, 3, 1),
        releaseUrl:
            'https://github.com/Hamza-Labs-Core/zajel/releases/tag/v1.2.0',
        checkedAt: DateTime.now(),
      );

      await tester.pumpWidget(_createTestWidget(checkResult: result));
      await tester.pump();

      expect(find.text('Version 1.2.0 available'), findsOneWidget);
      expect(find.textContaining('Released Mar 1, 2026'), findsOneWidget);
      expect(find.textContaining('Added feature X'), findsOneWidget);
      expect(find.byIcon(Icons.system_update), findsOneWidget);
      expect(find.text('Check Now'), findsOneWidget);
    });

    testWidgets('shows error with retry button', (tester) async {
      final result = UpdateCheckError(
        message: 'Network error',
        checkedAt: DateTime.now(),
      );

      await tester.pumpWidget(_createTestWidget(checkResult: result));
      await tester.pump();

      expect(find.text('Could not check for updates'), findsOneWidget);
      expect(find.text('Network error'), findsOneWidget);
      expect(find.byIcon(Icons.error_outline), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
    });

    testWidgets('shows store-managed message when not supporting auto-update',
        (tester) async {
      await tester.pumpWidget(_createTestWidget(
        supportsAutoUpdate: false,
        storeName: 'Snap Store',
      ));
      await tester.pump();

      expect(find.textContaining('Managed by Snap Store'), findsOneWidget);
      expect(find.byIcon(Icons.store), findsOneWidget);
      // No Check Now button for store-managed
      expect(find.text('Check Now'), findsNothing);
    });

    testWidgets('shows store-managed with fallback name', (tester) async {
      await tester.pumpWidget(_createTestWidget(
        supportsAutoUpdate: false,
        storeName: null,
      ));
      await tester.pump();

      expect(
        find.textContaining('Managed by your app store'),
        findsOneWidget,
      );
    });

    testWidgets('shows "Updates" section title', (tester) async {
      await tester.pumpWidget(_createTestWidget());
      await tester.pump();

      expect(find.text('Updates'), findsOneWidget);
    });

    testWidgets('rate limit disables retry button', (tester) async {
      final result = UpdateCheckError(
        message: 'Rate limited',
        isRateLimited: true,
        rateLimitResetsAt: DateTime.now().add(const Duration(minutes: 30)),
        checkedAt: DateTime.now(),
      );

      await tester.pumpWidget(_createTestWidget(checkResult: result));
      await tester.pump();

      // The Retry button should be present but disabled
      final retryButton = find.text('Retry');
      expect(retryButton, findsOneWidget);

      // Find the OutlinedButton ancestor and check its onPressed
      final button = tester.widget<OutlinedButton>(
        find.ancestor(
          of: retryButton,
          matching: find.byType(OutlinedButton),
        ),
      );
      expect(button.onPressed, isNull); // Disabled
    });

    testWidgets('"just now" shown for recent check', (tester) async {
      final result = UpdateCheckUpToDate(
        currentVersion: '1.0.0',
        checkedAt: DateTime.now(),
      );

      await tester.pumpWidget(_createTestWidget(checkResult: result));
      await tester.pump();

      expect(find.textContaining('just now'), findsOneWidget);
    });
  });
}

/// Fake service to avoid real HTTP calls in widget tests.
class _FakeGitHubReleaseService extends GitHubReleaseService {
  _FakeGitHubReleaseService() : super(client: _NoOpClient());
}

/// HTTP client that never makes real requests.
class _NoOpClient implements http.Client {
  @override
  void close() {}

  @override
  Future<http.Response> get(Uri url, {Map<String, String>? headers}) async {
    throw UnimplementedError('Should not be called in widget tests');
  }

  @override
  Future<http.Response> head(Uri url, {Map<String, String>? headers}) async {
    throw UnimplementedError();
  }

  @override
  Future<http.Response> post(Uri url,
      {Map<String, String>? headers, Object? body, encoding}) async {
    throw UnimplementedError();
  }

  @override
  Future<http.Response> put(Uri url,
      {Map<String, String>? headers, Object? body, encoding}) async {
    throw UnimplementedError();
  }

  @override
  Future<http.Response> patch(Uri url,
      {Map<String, String>? headers, Object? body, encoding}) async {
    throw UnimplementedError();
  }

  @override
  Future<http.Response> delete(Uri url,
      {Map<String, String>? headers, Object? body, encoding}) async {
    throw UnimplementedError();
  }

  @override
  Future<String> read(Uri url, {Map<String, String>? headers}) async {
    throw UnimplementedError();
  }

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    throw UnimplementedError();
  }

  @override
  Future<Uint8List> readBytes(Uri url, {Map<String, String>? headers}) async {
    throw UnimplementedError();
  }
}
