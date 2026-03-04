import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart' as http_testing;
import 'package:zajel/features/updater/models/github_release.dart';
import 'package:zajel/features/updater/models/update_state.dart';
import 'package:zajel/features/updater/services/update_download_service.dart';
import 'package:zajel/features/updater/services/update_orchestrator.dart';
import 'package:zajel/features/updater/services/update_package_detector.dart';

void main() {
  late Directory tempDir;
  late String stagingBaseDir;

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('orchestrator_test_');
    stagingBaseDir = '${tempDir.path}/staging';
    Directory(stagingBaseDir).createSync(recursive: true);
  });

  tearDown(() {
    if (tempDir.existsSync()) {
      tempDir.deleteSync(recursive: true);
    }
  });

  /// Helper to create a GitHubRelease with test data.
  GitHubRelease createTestRelease({
    String version = '1.2.0',
    String? checksumContent,
    bool includeLinuxAsset = true,
    bool includeChecksumsAsset = true,
  }) {
    final assets = <GitHubReleaseAsset>[];
    if (includeLinuxAsset) {
      assets.add(GitHubReleaseAsset(
        name: 'zajel-$version-linux.tar.gz',
        browserDownloadUrl:
            'https://github.com/example/releases/download/v$version/zajel-$version-linux.tar.gz',
        size: 1024,
        contentType: 'application/gzip',
      ));
    }
    if (includeChecksumsAsset) {
      assets.add(const GitHubReleaseAsset(
        name: 'checksums.txt',
        browserDownloadUrl:
            'https://github.com/example/releases/download/v1.2.0/checksums.txt',
        size: 256,
        contentType: 'text/plain',
      ));
    }

    return GitHubRelease(
      tagName: 'v$version',
      name: 'Zajel v$version',
      body: 'Release notes for $version',
      prerelease: false,
      draft: false,
      publishedAt: DateTime(2026, 3, 1),
      htmlUrl: 'https://github.com/example/releases/tag/v$version',
      assets: assets,
      checksumContent: checksumContent,
    );
  }

  /// Creates a mock HTTP client that serves download content and checksums.
  http.Client createMockClient({
    required Uint8List artifactContent,
    required String checksumContent,
  }) {
    return http_testing.MockClient.streaming(
      (request, bodyStream) async {
        final url = request.url.toString();

        if (request.method == 'HEAD') {
          return http.StreamedResponse(
            const Stream.empty(),
            200,
            headers: {
              'content-length': '${artifactContent.length}',
              'accept-ranges': 'bytes',
              'etag': '"test-etag"',
            },
          );
        }

        if (url.contains('checksums.txt')) {
          return http.StreamedResponse(
            Stream.value(checksumContent.codeUnits),
            200,
          );
        }

        // Artifact download
        return http.StreamedResponse(
          Stream.value(artifactContent),
          200,
          contentLength: artifactContent.length,
          headers: {'etag': '"test-etag"'},
        );
      },
    );
  }

  group('UpdateOrchestrator', () {
    group('checkAndPrepare', () {
      test('skips when package detector says no auto-update', () async {
        final detector = UpdatePackageDetector(
          isWindows: true,
          isMacOS: false,
          isLinux: false,
          resolvedExecutablePath:
              'C:\\Program Files\\WindowsApps\\Zajel\\zajel.exe',
        );

        final mockClient = http_testing.MockClient(
          (_) async => http.Response('', 200),
        );
        final downloadService = UpdateDownloadService(client: mockClient);
        final orchestrator = UpdateOrchestrator(
          downloadService: downloadService,
          packageDetector: detector,
          getStagingBaseDir: () async => stagingBaseDir,
        );

        final states = <UpdateState>[];
        orchestrator.stateStream.listen(states.add);

        await orchestrator.checkAndPrepare(
          release: createTestRelease(),
          platformName: 'windows',
        );

        // No state changes should occur
        expect(states, isEmpty);
        expect(orchestrator.state.status, UpdateStatus.idle);

        orchestrator.dispose();
      });

      test('skips when download is already in progress', () async {
        final detector = UpdatePackageDetector(
          isLinux: true,
          isWindows: false,
          isMacOS: false,
          resolvedExecutablePath: '/usr/bin/zajel',
          environment: {},
        );

        // Create a slow-responding client
        final completer = Completer<void>();
        final mockClient = http_testing.MockClient.streaming(
          (request, bodyStream) async {
            if (request.method == 'HEAD') {
              return http.StreamedResponse(
                const Stream.empty(),
                200,
                headers: {'content-length': '100'},
              );
            }
            // Block until completer completes
            await completer.future;
            return http.StreamedResponse(
              Stream.value(Uint8List(100)),
              200,
              contentLength: 100,
            );
          },
        );

        final content = Uint8List.fromList([1, 2, 3]);
        final hash = sha256.convert(content).toString();
        final release = createTestRelease(
          checksumContent: '$hash  zajel-1.2.0-linux.tar.gz',
        );

        final downloadService = UpdateDownloadService(client: mockClient);
        final orchestrator = UpdateOrchestrator(
          downloadService: downloadService,
          packageDetector: detector,
          getStagingBaseDir: () async => stagingBaseDir,
        );

        // Start first download (it will block)
        final firstDownload = orchestrator.checkAndPrepare(
          release: release,
          platformName: 'linux',
        );

        // Wait a tick for the first download to start
        await Future.delayed(Duration.zero);

        // Try to start another download — should be skipped
        final secondStates = <UpdateState>[];
        orchestrator.stateStream.listen(secondStates.add);

        await orchestrator.checkAndPrepare(
          release: createTestRelease(version: '1.3.0'),
          platformName: 'linux',
        );

        // Release the blocked download
        completer.complete();
        await firstDownload;

        orchestrator.dispose();
      });

      test('skips when already ready for same version', () async {
        final detector = UpdatePackageDetector(
          isLinux: true,
          isWindows: false,
          isMacOS: false,
          resolvedExecutablePath: '/usr/bin/zajel',
          environment: {},
        );

        final content = Uint8List.fromList(
          List.generate(100, (i) => i % 256),
        );
        final hash = sha256.convert(content).toString();
        final checksumContent = '$hash  zajel-1.2.0-linux.tar.gz';

        final release = createTestRelease(checksumContent: checksumContent);
        final mockClient = createMockClient(
          artifactContent: content,
          checksumContent: checksumContent,
        );

        final downloadService = UpdateDownloadService(client: mockClient);
        final orchestrator = UpdateOrchestrator(
          downloadService: downloadService,
          packageDetector: detector,
          getStagingBaseDir: () async => stagingBaseDir,
        );

        // First call: download and verify
        await orchestrator.checkAndPrepare(
          release: release,
          platformName: 'linux',
        );
        expect(orchestrator.state.status, UpdateStatus.ready);

        // Second call: should skip
        final statesBefore = <UpdateState>[];
        orchestrator.stateStream.listen(statesBefore.add);

        await orchestrator.checkAndPrepare(
          release: release,
          platformName: 'linux',
        );

        // No new state changes
        expect(statesBefore, isEmpty);

        orchestrator.dispose();
      });
    });

    group('downloadUpdate', () {
      test('happy path: download -> verify -> ready', () async {
        final detector = UpdatePackageDetector(
          isLinux: true,
          isWindows: false,
          isMacOS: false,
          resolvedExecutablePath: '/usr/bin/zajel',
          environment: {},
        );

        final content = Uint8List.fromList(
          List.generate(100, (i) => i % 256),
        );
        final hash = sha256.convert(content).toString();
        final checksumContent = '$hash  zajel-1.2.0-linux.tar.gz';

        final release = createTestRelease(checksumContent: checksumContent);
        final mockClient = createMockClient(
          artifactContent: content,
          checksumContent: checksumContent,
        );

        final downloadService = UpdateDownloadService(client: mockClient);
        final orchestrator = UpdateOrchestrator(
          downloadService: downloadService,
          packageDetector: detector,
          getStagingBaseDir: () async => stagingBaseDir,
        );

        final states = <UpdateState>[];
        orchestrator.stateStream.listen(states.add);

        await orchestrator.downloadUpdate(
          release: release,
          platformName: 'linux',
        );

        // Allow stream events to propagate
        await Future<void>.delayed(Duration.zero);

        // Check state transitions
        final statuses = states.map((s) => s.status).toList();
        expect(statuses, contains(UpdateStatus.downloading));
        expect(statuses, contains(UpdateStatus.verifying));
        expect(statuses.last, UpdateStatus.ready);

        // Check final state
        expect(orchestrator.state.status, UpdateStatus.ready);
        expect(orchestrator.state.availableVersion, '1.2.0');
        expect(orchestrator.state.releaseNotes, 'Release notes for 1.2.0');

        orchestrator.dispose();
      });

      test('fails when no artifact for platform', () async {
        final detector = UpdatePackageDetector(
          isLinux: true,
          isWindows: false,
          isMacOS: false,
          resolvedExecutablePath: '/usr/bin/zajel',
          environment: {},
        );

        // Release with no Linux asset
        final release = createTestRelease(includeLinuxAsset: false);
        final mockClient = http_testing.MockClient(
          (_) async => http.Response('', 200),
        );

        final downloadService = UpdateDownloadService(client: mockClient);
        final orchestrator = UpdateOrchestrator(
          downloadService: downloadService,
          packageDetector: detector,
          getStagingBaseDir: () async => stagingBaseDir,
        );

        await orchestrator.downloadUpdate(
          release: release,
          platformName: 'linux',
        );

        expect(orchestrator.state.status, UpdateStatus.failed);
        expect(
          orchestrator.state.errorMessage,
          contains('No artifact found'),
        );

        orchestrator.dispose();
      });

      test('fails when checksum verification fails', () async {
        final detector = UpdatePackageDetector(
          isLinux: true,
          isWindows: false,
          isMacOS: false,
          resolvedExecutablePath: '/usr/bin/zajel',
          environment: {},
        );

        final content = Uint8List.fromList([1, 2, 3, 4, 5]);
        final wrongHash = 'deadbeef' * 8;
        final checksumContent = '$wrongHash  zajel-1.2.0-linux.tar.gz';

        final release = createTestRelease(checksumContent: checksumContent);
        final mockClient = createMockClient(
          artifactContent: content,
          checksumContent: checksumContent,
        );

        final downloadService = UpdateDownloadService(client: mockClient);
        final orchestrator = UpdateOrchestrator(
          downloadService: downloadService,
          packageDetector: detector,
          getStagingBaseDir: () async => stagingBaseDir,
        );

        await orchestrator.downloadUpdate(
          release: release,
          platformName: 'linux',
        );

        expect(orchestrator.state.status, UpdateStatus.failed);
        expect(
          orchestrator.state.errorMessage,
          contains('Checksum verification failed'),
        );

        orchestrator.dispose();
      });

      test('fails when no checksums.txt is available', () async {
        final detector = UpdatePackageDetector(
          isLinux: true,
          isWindows: false,
          isMacOS: false,
          resolvedExecutablePath: '/usr/bin/zajel',
          environment: {},
        );

        final content = Uint8List.fromList([1, 2, 3]);

        // Release with no checksums asset and no checksum content
        final release = createTestRelease(includeChecksumsAsset: false);

        final mockClient = createMockClient(
          artifactContent: content,
          checksumContent: '',
        );

        final downloadService = UpdateDownloadService(client: mockClient);
        final orchestrator = UpdateOrchestrator(
          downloadService: downloadService,
          packageDetector: detector,
          getStagingBaseDir: () async => stagingBaseDir,
        );

        await orchestrator.downloadUpdate(
          release: release,
          platformName: 'linux',
        );

        expect(orchestrator.state.status, UpdateStatus.failed);
        expect(
          orchestrator.state.errorMessage,
          contains('checksums unavailable'),
        );

        orchestrator.dispose();
      });

      test('fails when staging directory cannot be resolved', () async {
        final detector = UpdatePackageDetector(
          isLinux: true,
          isWindows: false,
          isMacOS: false,
          resolvedExecutablePath: '/usr/bin/zajel',
          environment: {},
        );

        final mockClient = http_testing.MockClient(
          (_) async => http.Response('', 200),
        );
        final downloadService = UpdateDownloadService(client: mockClient);
        final orchestrator = UpdateOrchestrator(
          downloadService: downloadService,
          packageDetector: detector,
          getStagingBaseDir: () async => throw Exception('No home dir'),
        );

        await orchestrator.downloadUpdate(
          release: createTestRelease(checksumContent: 'abc  file.tar.gz'),
          platformName: 'linux',
        );

        expect(orchestrator.state.status, UpdateStatus.failed);
        expect(
          orchestrator.state.errorMessage,
          contains('Cannot resolve staging directory'),
        );

        orchestrator.dispose();
      });

      test('detects existing staged download and verifies it', () async {
        final detector = UpdatePackageDetector(
          isLinux: true,
          isWindows: false,
          isMacOS: false,
          resolvedExecutablePath: '/usr/bin/zajel',
          environment: {},
        );

        final content = Uint8List.fromList(
          List.generate(100, (i) => i),
        );
        final hash = sha256.convert(content).toString();
        final checksumContent = '$hash  zajel-1.2.0-linux.tar.gz';

        // Pre-stage the artifact
        final versionDir = '$stagingBaseDir/zajel-1.2.0-linux';
        Directory(versionDir).createSync(recursive: true);
        File('$versionDir/zajel-1.2.0-linux.tar.gz').writeAsBytesSync(content);

        final release = createTestRelease(checksumContent: checksumContent);

        // Client that should NOT be called for download
        var downloadCalled = false;
        final mockClient = http_testing.MockClient.streaming(
          (request, bodyStream) async {
            if (request.url.toString().contains('checksums.txt')) {
              return http.StreamedResponse(
                Stream.value(checksumContent.codeUnits),
                200,
              );
            }
            downloadCalled = true;
            return http.StreamedResponse(const Stream.empty(), 200);
          },
        );

        final downloadService = UpdateDownloadService(client: mockClient);
        final orchestrator = UpdateOrchestrator(
          downloadService: downloadService,
          packageDetector: detector,
          getStagingBaseDir: () async => stagingBaseDir,
        );

        await orchestrator.downloadUpdate(
          release: release,
          platformName: 'linux',
        );

        expect(orchestrator.state.status, UpdateStatus.ready);
        expect(downloadCalled, isFalse);

        orchestrator.dispose();
      });
    });

    group('cancelDownload', () {
      test('cancels active download and transitions to failed', () async {
        final detector = UpdatePackageDetector(
          isLinux: true,
          isWindows: false,
          isMacOS: false,
          resolvedExecutablePath: '/usr/bin/zajel',
          environment: {},
        );

        final cancelCompleter = Completer<void>();

        final mockClient = http_testing.MockClient.streaming(
          (request, bodyStream) async {
            if (request.method == 'HEAD') {
              return http.StreamedResponse(
                const Stream.empty(),
                200,
                headers: {'content-length': '10000'},
              );
            }
            // Stream that waits for cancellation
            final controller = StreamController<List<int>>();
            Future(() async {
              controller.add(List.filled(100, 1));
              cancelCompleter.complete();
              // Wait long enough to be cancelled
              await Future.delayed(const Duration(seconds: 5));
              controller.add(List.filled(100, 2));
              await controller.close();
            });
            return http.StreamedResponse(
              controller.stream,
              200,
              contentLength: 10000,
            );
          },
        );

        final release = createTestRelease(
          checksumContent: 'abc  zajel-1.2.0-linux.tar.gz',
        );

        final downloadService = UpdateDownloadService(client: mockClient);
        final orchestrator = UpdateOrchestrator(
          downloadService: downloadService,
          packageDetector: detector,
          getStagingBaseDir: () async => stagingBaseDir,
        );

        // Start download in background
        final downloadFuture = orchestrator.downloadUpdate(
          release: release,
          platformName: 'linux',
        );

        // Wait for download to start streaming
        await cancelCompleter.future;
        await Future.delayed(const Duration(milliseconds: 10));

        // Cancel
        orchestrator.cancelDownload();

        // Wait for the download to complete (with cancellation)
        await downloadFuture;

        expect(orchestrator.state.status, UpdateStatus.failed);
        expect(orchestrator.state.errorMessage, contains('cancelled'));

        orchestrator.dispose();
      });

      test('is a no-op when no download is active', () {
        final detector = UpdatePackageDetector(
          isLinux: true,
          isWindows: false,
          isMacOS: false,
          resolvedExecutablePath: '/usr/bin/zajel',
          environment: {},
        );

        final mockClient = http_testing.MockClient(
          (_) async => http.Response('', 200),
        );
        final downloadService = UpdateDownloadService(client: mockClient);
        final orchestrator = UpdateOrchestrator(
          downloadService: downloadService,
          packageDetector: detector,
          getStagingBaseDir: () async => stagingBaseDir,
        );

        // Should not throw
        orchestrator.cancelDownload();
        expect(orchestrator.state.status, UpdateStatus.idle);

        orchestrator.dispose();
      });
    });

    group('reset', () {
      test('resets state to idle', () async {
        final detector = UpdatePackageDetector(
          isLinux: true,
          isWindows: false,
          isMacOS: false,
          resolvedExecutablePath: '/usr/bin/zajel',
          environment: {},
        );

        final content = Uint8List.fromList([1, 2, 3]);
        final hash = sha256.convert(content).toString();
        final checksumContent = '$hash  zajel-1.2.0-linux.tar.gz';

        final release = createTestRelease(checksumContent: checksumContent);
        final mockClient = createMockClient(
          artifactContent: content,
          checksumContent: checksumContent,
        );

        final downloadService = UpdateDownloadService(client: mockClient);
        final orchestrator = UpdateOrchestrator(
          downloadService: downloadService,
          packageDetector: detector,
          getStagingBaseDir: () async => stagingBaseDir,
        );

        await orchestrator.downloadUpdate(
          release: release,
          platformName: 'linux',
        );
        expect(orchestrator.state.status, UpdateStatus.ready);

        orchestrator.reset();
        expect(orchestrator.state.status, UpdateStatus.idle);

        orchestrator.dispose();
      });
    });

    group('cleanupStaleDownloads', () {
      test('delegates to download service', () async {
        final detector = UpdatePackageDetector(
          isLinux: true,
          isWindows: false,
          isMacOS: false,
          resolvedExecutablePath: '/usr/bin/zajel',
          environment: {},
        );

        // Create stale dirs
        Directory('$stagingBaseDir/zajel-0.9.0-linux').createSync();
        Directory('$stagingBaseDir/zajel-1.0.0-linux').createSync();

        final mockClient = http_testing.MockClient(
          (_) async => http.Response('', 200),
        );
        final downloadService = UpdateDownloadService(client: mockClient);
        final orchestrator = UpdateOrchestrator(
          downloadService: downloadService,
          packageDetector: detector,
          getStagingBaseDir: () async => stagingBaseDir,
        );

        await orchestrator.cleanupStaleDownloads(targetVersion: '1.0.0');

        expect(
          Directory('$stagingBaseDir/zajel-0.9.0-linux').existsSync(),
          isFalse,
        );
        expect(
          Directory('$stagingBaseDir/zajel-1.0.0-linux').existsSync(),
          isTrue,
        );

        orchestrator.dispose();
      });

      test('handles staging dir resolution error gracefully', () async {
        final detector = UpdatePackageDetector(
          isLinux: true,
          isWindows: false,
          isMacOS: false,
          resolvedExecutablePath: '/usr/bin/zajel',
          environment: {},
        );

        final mockClient = http_testing.MockClient(
          (_) async => http.Response('', 200),
        );
        final downloadService = UpdateDownloadService(client: mockClient);
        final orchestrator = UpdateOrchestrator(
          downloadService: downloadService,
          packageDetector: detector,
          getStagingBaseDir: () async => throw Exception('No staging dir'),
        );

        // Should not throw
        await orchestrator.cleanupStaleDownloads(targetVersion: '1.0.0');

        orchestrator.dispose();
      });
    });

    group('stateStream', () {
      test('emits all state transitions', () async {
        final detector = UpdatePackageDetector(
          isLinux: true,
          isWindows: false,
          isMacOS: false,
          resolvedExecutablePath: '/usr/bin/zajel',
          environment: {},
        );

        final content = Uint8List.fromList([1, 2, 3, 4, 5]);
        final hash = sha256.convert(content).toString();
        final checksumContent = '$hash  zajel-1.2.0-linux.tar.gz';

        final release = createTestRelease(checksumContent: checksumContent);
        final mockClient = createMockClient(
          artifactContent: content,
          checksumContent: checksumContent,
        );

        final downloadService = UpdateDownloadService(client: mockClient);
        final orchestrator = UpdateOrchestrator(
          downloadService: downloadService,
          packageDetector: detector,
          getStagingBaseDir: () async => stagingBaseDir,
        );

        final states = <UpdateState>[];
        orchestrator.stateStream.listen(states.add);

        await orchestrator.downloadUpdate(
          release: release,
          platformName: 'linux',
        );

        // Allow stream events to propagate
        await Future<void>.delayed(Duration.zero);

        // Should have at least downloading, verifying, and ready
        final statuses = states.map((s) => s.status).toSet();
        expect(statuses, contains(UpdateStatus.downloading));
        expect(statuses, contains(UpdateStatus.verifying));
        expect(statuses, contains(UpdateStatus.ready));

        orchestrator.dispose();
      });
    });

    group('getStagingDir', () {
      test('returns the injected staging directory', () async {
        final detector = UpdatePackageDetector(
          isLinux: true,
          isWindows: false,
          isMacOS: false,
          resolvedExecutablePath: '/usr/bin/zajel',
          environment: {},
        );

        final mockClient = http_testing.MockClient(
          (_) async => http.Response('', 200),
        );
        final downloadService = UpdateDownloadService(client: mockClient);
        final orchestrator = UpdateOrchestrator(
          downloadService: downloadService,
          packageDetector: detector,
          getStagingBaseDir: () async => '/custom/staging',
        );

        final dir = await orchestrator.getStagingDir();
        expect(dir, '/custom/staging');

        orchestrator.dispose();
      });
    });
  });
}
