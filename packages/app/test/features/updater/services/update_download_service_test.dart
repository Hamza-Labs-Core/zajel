import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart' as http_testing;
import 'package:zajel/features/updater/services/update_download_service.dart';

void main() {
  late Directory tempDir;

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('update_download_test_');
  });

  tearDown(() {
    if (tempDir.existsSync()) {
      tempDir.deleteSync(recursive: true);
    }
  });

  group('UpdateDownloadService', () {
    group('downloadArtifact', () {
      test('downloads full file and renames from .partial', () async {
        final content = Uint8List.fromList(
          List.generate(1024, (i) => i % 256),
        );

        final mockClient = http_testing.MockClient.streaming(
          (request, bodyStream) async {
            if (request.method == 'HEAD') {
              return http.StreamedResponse(
                const Stream.empty(),
                200,
                headers: {
                  'content-length': '${content.length}',
                  'accept-ranges': 'bytes',
                  'etag': '"abc123"',
                },
              );
            }
            // GET request
            expect(request.method, 'GET');
            return http.StreamedResponse(
              Stream.value(content),
              200,
              contentLength: content.length,
              headers: {'etag': '"abc123"'},
            );
          },
        );

        final service = UpdateDownloadService(client: mockClient);
        final destPath = '${tempDir.path}/artifact.zip';

        final progressUpdates = <List<int>>[];
        final result = await service.downloadArtifact(
          url: 'https://example.com/artifact.zip',
          destinationPath: destPath,
          onProgress: (received, total) {
            progressUpdates.add([received, total]);
          },
        );

        expect(result, destPath);
        expect(File(destPath).existsSync(), isTrue);
        expect(File(destPath).readAsBytesSync(), content);
        // .partial file should be gone
        expect(File('$destPath.partial').existsSync(), isFalse);
        // Progress should have been reported
        expect(progressUpdates, isNotEmpty);
        // Last progress update should show full completion
        expect(progressUpdates.last[0], content.length);
      });

      test(
          'resumes download when .partial file exists and server supports Range',
          () async {
        final fullContent = Uint8List.fromList(
          List.generate(2048, (i) => i % 256),
        );
        // Pre-create a .partial file with first half
        final partialContent = fullContent.sublist(0, 1024);
        final remainingContent = fullContent.sublist(1024);

        final destPath = '${tempDir.path}/artifact.zip';
        final partialFile = File('$destPath.partial');
        partialFile.writeAsBytesSync(partialContent);
        // Write matching ETag
        File('$destPath.etag').writeAsStringSync('"abc123"');

        String? rangeHeader;

        final mockClient = http_testing.MockClient.streaming(
          (request, bodyStream) async {
            if (request.method == 'HEAD') {
              return http.StreamedResponse(
                const Stream.empty(),
                200,
                headers: {
                  'content-length': '${fullContent.length}',
                  'accept-ranges': 'bytes',
                  'etag': '"abc123"',
                },
              );
            }
            // GET request
            rangeHeader = request.headers['Range'];
            return http.StreamedResponse(
              Stream.value(remainingContent),
              206,
              contentLength: remainingContent.length,
              headers: {'etag': '"abc123"'},
            );
          },
        );

        final service = UpdateDownloadService(client: mockClient);
        await service.downloadArtifact(
          url: 'https://example.com/artifact.zip',
          destinationPath: destPath,
          onProgress: (_, __) {},
        );

        // Range header should have been sent
        expect(rangeHeader, 'bytes=1024-');
        // Final file should exist with full content
        expect(File(destPath).existsSync(), isTrue);
        expect(File(destPath).readAsBytesSync().length, fullContent.length);
      });

      test('restarts download when ETag changes', () async {
        final content = Uint8List.fromList([1, 2, 3, 4, 5]);

        // Pre-create .partial with old ETag
        final destPath = '${tempDir.path}/artifact.zip';
        File('$destPath.partial').writeAsBytesSync([1, 2, 3]);
        File('$destPath.etag').writeAsStringSync('"old-etag"');

        final mockClient = http_testing.MockClient.streaming(
          (request, bodyStream) async {
            if (request.method == 'HEAD') {
              return http.StreamedResponse(
                const Stream.empty(),
                200,
                headers: {
                  'content-length': '${content.length}',
                  'accept-ranges': 'bytes',
                  'etag': '"new-etag"', // Different ETag
                },
              );
            }
            // GET — should NOT have Range header since ETag changed
            expect(request.headers.containsKey('Range'), isFalse);
            return http.StreamedResponse(
              Stream.value(content),
              200,
              contentLength: content.length,
            );
          },
        );

        final service = UpdateDownloadService(client: mockClient);
        await service.downloadArtifact(
          url: 'https://example.com/artifact.zip',
          destinationPath: destPath,
          onProgress: (_, __) {},
        );

        expect(File(destPath).readAsBytesSync(), content);
      });

      test('restarts download when server does not support Range', () async {
        final content = Uint8List.fromList([1, 2, 3, 4, 5]);

        // Pre-create .partial
        final destPath = '${tempDir.path}/artifact.zip';
        File('$destPath.partial').writeAsBytesSync([1, 2, 3]);

        final mockClient = http_testing.MockClient.streaming(
          (request, bodyStream) async {
            if (request.method == 'HEAD') {
              return http.StreamedResponse(
                const Stream.empty(),
                200,
                headers: {
                  'content-length': '${content.length}',
                  // No accept-ranges header
                },
              );
            }
            // Should not have Range header
            expect(request.headers.containsKey('Range'), isFalse);
            return http.StreamedResponse(
              Stream.value(content),
              200,
              contentLength: content.length,
            );
          },
        );

        final service = UpdateDownloadService(client: mockClient);
        await service.downloadArtifact(
          url: 'https://example.com/artifact.zip',
          destinationPath: destPath,
          onProgress: (_, __) {},
        );

        expect(File(destPath).readAsBytesSync(), content);
      });

      test('rejects non-HTTPS URLs', () async {
        final mockClient = http_testing.MockClient.streaming(
          (request, bodyStream) async {
            return http.StreamedResponse(const Stream.empty(), 200);
          },
        );

        final service = UpdateDownloadService(client: mockClient);

        expect(
          () => service.downloadArtifact(
            url: 'http://example.com/artifact.zip',
            destinationPath: '${tempDir.path}/artifact.zip',
            onProgress: (_, __) {},
          ),
          throwsA(isA<InsecureUrlException>()),
        );
      });

      test('throws HttpException on non-200/206 response', () async {
        final mockClient = http_testing.MockClient.streaming(
          (request, bodyStream) async {
            if (request.method == 'HEAD') {
              return http.StreamedResponse(const Stream.empty(), 200);
            }
            return http.StreamedResponse(const Stream.empty(), 404);
          },
        );

        final service = UpdateDownloadService(client: mockClient);

        expect(
          () => service.downloadArtifact(
            url: 'https://example.com/artifact.zip',
            destinationPath: '${tempDir.path}/artifact.zip',
            onProgress: (_, __) {},
          ),
          throwsA(isA<HttpException>()),
        );
      });

      test('cancellation stops download and keeps .partial file', () async {
        final token = CancellationToken();

        final mockClient = http_testing.MockClient.streaming(
          (request, bodyStream) async {
            if (request.method == 'HEAD') {
              return http.StreamedResponse(
                const Stream.empty(),
                200,
                headers: {'content-length': '3000'},
              );
            }
            // Stream multiple chunks
            final controller = StreamController<List<int>>();
            Future(() async {
              for (var i = 0; i < 3; i++) {
                if (token.isCancelled) break;
                controller.add(List.filled(1000, i));
                // Cancel after first chunk
                if (i == 0) token.cancel();
                await Future.delayed(Duration.zero);
              }
              await controller.close();
            });
            return http.StreamedResponse(controller.stream, 200,
                contentLength: 3000);
          },
        );

        final service = UpdateDownloadService(client: mockClient);
        final destPath = '${tempDir.path}/artifact.zip';

        expect(
          () => service.downloadArtifact(
            url: 'https://example.com/artifact.zip',
            destinationPath: destPath,
            onProgress: (_, __) {},
            cancellationToken: token,
          ),
          throwsA(isA<DownloadCancelledException>()),
        );

        // Wait for the async error to propagate
        await Future.delayed(const Duration(milliseconds: 50));

        // .partial file should still exist (for future resume)
        expect(File('$destPath.partial').existsSync(), isTrue);
        // Final file should NOT exist
        expect(File(destPath).existsSync(), isFalse);
      });

      test('returns existing file immediately if already downloaded', () async {
        final content = Uint8List.fromList([1, 2, 3]);
        final destPath = '${tempDir.path}/artifact.zip';
        File(destPath).writeAsBytesSync(content);

        var httpCallsMade = false;
        final mockClient = http_testing.MockClient.streaming(
          (request, bodyStream) async {
            httpCallsMade = true;
            return http.StreamedResponse(const Stream.empty(), 200);
          },
        );

        final service = UpdateDownloadService(client: mockClient);
        final progressUpdates = <List<int>>[];

        final result = await service.downloadArtifact(
          url: 'https://example.com/artifact.zip',
          destinationPath: destPath,
          onProgress: (received, total) {
            progressUpdates.add([received, total]);
          },
        );

        expect(result, destPath);
        expect(httpCallsMade, isFalse);
        expect(progressUpdates, hasLength(1));
        expect(progressUpdates.first[0], content.length);
      });

      test('reports progress correctly during download', () async {
        final chunk1 = Uint8List.fromList(List.filled(500, 1));
        final chunk2 = Uint8List.fromList(List.filled(500, 2));

        final mockClient = http_testing.MockClient.streaming(
          (request, bodyStream) async {
            if (request.method == 'HEAD') {
              return http.StreamedResponse(
                const Stream.empty(),
                200,
                headers: {'content-length': '1000'},
              );
            }
            return http.StreamedResponse(
              Stream.fromIterable([chunk1, chunk2]),
              200,
              contentLength: 1000,
            );
          },
        );

        final service = UpdateDownloadService(client: mockClient);
        final destPath = '${tempDir.path}/artifact.zip';
        final progressUpdates = <List<int>>[];

        await service.downloadArtifact(
          url: 'https://example.com/artifact.zip',
          destinationPath: destPath,
          onProgress: (received, total) {
            progressUpdates.add([received, total]);
          },
        );

        // Should have 2 progress updates (one per chunk)
        expect(progressUpdates, hasLength(2));
        expect(progressUpdates[0], [500, 1000]);
        expect(progressUpdates[1], [1000, 1000]);
      });
    });

    group('verifyChecksum', () {
      test('returns true for correct SHA-256 hash', () async {
        final content = Uint8List.fromList([1, 2, 3, 4, 5]);
        final expectedHash = sha256.convert(content).toString();

        final filePath = '${tempDir.path}/test_file';
        File(filePath).writeAsBytesSync(content);

        final mockClient = http_testing.MockClient(
          (_) async => http.Response('', 200),
        );
        final service = UpdateDownloadService(client: mockClient);

        final result = await service.verifyChecksum(filePath, expectedHash);
        expect(result, isTrue);
      });

      test('returns false for incorrect SHA-256 hash', () async {
        final content = Uint8List.fromList([1, 2, 3, 4, 5]);
        final wrongHash = 'deadbeef' * 8; // 64 hex chars

        final filePath = '${tempDir.path}/test_file';
        File(filePath).writeAsBytesSync(content);

        final mockClient = http_testing.MockClient(
          (_) async => http.Response('', 200),
        );
        final service = UpdateDownloadService(client: mockClient);

        final result = await service.verifyChecksum(filePath, wrongHash);
        expect(result, isFalse);
      });

      test('returns false for non-existent file', () async {
        final mockClient = http_testing.MockClient(
          (_) async => http.Response('', 200),
        );
        final service = UpdateDownloadService(client: mockClient);

        final result = await service.verifyChecksum(
          '${tempDir.path}/nonexistent',
          'abc123',
        );
        expect(result, isFalse);
      });

      test('handles case-insensitive hash comparison', () async {
        final content = Uint8List.fromList([10, 20, 30]);
        final hash = sha256.convert(content).toString();
        // Uppercase the hash
        final upperHash = hash.toUpperCase();

        final filePath = '${tempDir.path}/test_file';
        File(filePath).writeAsBytesSync(content);

        final mockClient = http_testing.MockClient(
          (_) async => http.Response('', 200),
        );
        final service = UpdateDownloadService(client: mockClient);

        final result = await service.verifyChecksum(filePath, upperHash);
        expect(result, isTrue);
      });

      test('verifies large file with streaming SHA-256', () async {
        // 1 MB file
        final content = Uint8List.fromList(
          List.generate(1024 * 1024, (i) => i % 256),
        );
        final expectedHash = sha256.convert(content).toString();

        final filePath = '${tempDir.path}/large_file';
        File(filePath).writeAsBytesSync(content);

        final mockClient = http_testing.MockClient(
          (_) async => http.Response('', 200),
        );
        final service = UpdateDownloadService(client: mockClient);

        final result = await service.verifyChecksum(filePath, expectedHash);
        expect(result, isTrue);
      });
    });

    group('fetchChecksums', () {
      test('returns content on success', () async {
        const checksumContent =
            'abc123  zajel-1.0.0-linux.tar.gz\ndef456  zajel-1.0.0-windows.zip';

        final mockClient = http_testing.MockClient((request) async {
          expect(request.url.scheme, 'https');
          return http.Response(checksumContent, 200);
        });

        final service = UpdateDownloadService(client: mockClient);
        final result = await service.fetchChecksums(
          'https://example.com/checksums.txt',
        );

        expect(result, checksumContent);
      });

      test('returns null on HTTP error', () async {
        final mockClient = http_testing.MockClient((request) async {
          return http.Response('Not Found', 404);
        });

        final service = UpdateDownloadService(client: mockClient);
        final result = await service.fetchChecksums(
          'https://example.com/checksums.txt',
        );

        expect(result, isNull);
      });

      test('returns null for non-HTTPS URL', () async {
        final mockClient = http_testing.MockClient((request) async {
          return http.Response('', 200);
        });

        final service = UpdateDownloadService(client: mockClient);
        final result = await service.fetchChecksums(
          'http://example.com/checksums.txt',
        );

        expect(result, isNull);
      });

      test('returns null on network error', () async {
        final mockClient = http_testing.MockClient((request) async {
          throw const SocketException('Connection refused');
        });

        final service = UpdateDownloadService(client: mockClient);
        final result = await service.fetchChecksums(
          'https://example.com/checksums.txt',
        );

        expect(result, isNull);
      });
    });

    group('extractArchive', () {
      test('extracts tar.gz archive', () async {
        final mockClient = http_testing.MockClient(
          (_) async => http.Response('', 200),
        );
        final service = UpdateDownloadService(client: mockClient);

        // Create a source directory with a test file
        final sourceDir = '${tempDir.path}/source';
        Directory(sourceDir).createSync();
        File('$sourceDir/hello.txt').writeAsStringSync('hello world');

        // Create a tar.gz archive from the source directory
        final archivePath = '${tempDir.path}/test-archive.tar.gz';
        final tarResult = await Process.run(
          'tar',
          ['-czf', archivePath, '-C', tempDir.path, 'source'],
        );
        expect(tarResult.exitCode, 0,
            reason: 'Failed to create tar.gz: ${tarResult.stderr}');

        // Extract the archive
        final extractDir = '${tempDir.path}/extracted';
        final result = await service.extractArchive(archivePath, extractDir);

        expect(result, extractDir);
        expect(
          File('$extractDir/source/hello.txt').existsSync(),
          isTrue,
        );
        expect(
          File('$extractDir/source/hello.txt').readAsStringSync(),
          'hello world',
        );
      });

      test('extracts zip archive', () async {
        final mockClient = http_testing.MockClient(
          (_) async => http.Response('', 200),
        );
        final service = UpdateDownloadService(client: mockClient);

        // Create a source directory with a test file
        final sourceDir = '${tempDir.path}/source';
        Directory(sourceDir).createSync();
        File('$sourceDir/data.txt').writeAsStringSync('zip content');

        // Create a zip archive
        final archivePath = '${tempDir.path}/test-archive.zip';
        final zipResult = await Process.run(
          'zip',
          ['-r', archivePath, 'source'],
          workingDirectory: tempDir.path,
        );
        // zip may not be installed; skip if so
        if (zipResult.exitCode != 0) {
          // If zip command is not available, create archive with
          // Python's zipfile module as fallback
          final pyResult = await Process.run('python3', [
            '-c',
            'import zipfile,os;'
                'z=zipfile.ZipFile("$archivePath","w");'
                'z.write("$sourceDir/data.txt","source/data.txt");'
                'z.close()',
          ]);
          expect(pyResult.exitCode, 0,
              reason: 'Failed to create zip: ${pyResult.stderr}');
        }

        // Extract the archive
        final extractDir = '${tempDir.path}/extracted';
        final result = await service.extractArchive(archivePath, extractDir);

        expect(result, extractDir);
        expect(
          File('$extractDir/source/data.txt').existsSync(),
          isTrue,
        );
        expect(
          File('$extractDir/source/data.txt').readAsStringSync(),
          'zip content',
        );
      });

      test('throws ArgumentError for unsupported format', () async {
        final mockClient = http_testing.MockClient(
          (_) async => http.Response('', 200),
        );
        final service = UpdateDownloadService(client: mockClient);

        final archivePath = '${tempDir.path}/test.unknown';
        File(archivePath).writeAsStringSync('not an archive');
        final extractDir = '${tempDir.path}/extracted';

        expect(
          () => service.extractArchive(archivePath, extractDir),
          throwsA(isA<ArgumentError>()),
        );
      });

      test('throws ProcessException on non-zero exit code', () async {
        final mockClient = http_testing.MockClient(
          (_) async => http.Response('', 200),
        );
        final service = UpdateDownloadService(client: mockClient);

        // Create a file that is not a valid tar.gz
        final archivePath = '${tempDir.path}/bad-archive.tar.gz';
        File(archivePath).writeAsStringSync('this is not a valid archive');
        final extractDir = '${tempDir.path}/extracted';

        expect(
          () => service.extractArchive(archivePath, extractDir),
          throwsA(isA<ProcessException>()),
        );
      });

      test('creates extraction directory if it does not exist', () async {
        final mockClient = http_testing.MockClient(
          (_) async => http.Response('', 200),
        );
        final service = UpdateDownloadService(client: mockClient);

        // Create a valid tar.gz with a file in it
        final sourceDir = '${tempDir.path}/source';
        Directory(sourceDir).createSync();
        File('$sourceDir/file.txt').writeAsStringSync('content');

        final archivePath = '${tempDir.path}/archive.tar.gz';
        await Process.run(
          'tar',
          ['-czf', archivePath, '-C', tempDir.path, 'source'],
        );

        // Use a nested path that does not yet exist
        final extractDir = '${tempDir.path}/deep/nested/extract';
        expect(Directory(extractDir).existsSync(), isFalse);

        await service.extractArchive(archivePath, extractDir);

        expect(Directory(extractDir).existsSync(), isTrue);
        expect(
          File('$extractDir/source/file.txt').existsSync(),
          isTrue,
        );
      });

      test('extracts .tgz archive (alias for tar.gz)', () async {
        final mockClient = http_testing.MockClient(
          (_) async => http.Response('', 200),
        );
        final service = UpdateDownloadService(client: mockClient);

        final sourceDir = '${tempDir.path}/source';
        Directory(sourceDir).createSync();
        File('$sourceDir/tgz-file.txt').writeAsStringSync('tgz content');

        // Create a .tgz archive (same format as tar.gz)
        final archivePath = '${tempDir.path}/test-archive.tgz';
        final tarResult = await Process.run(
          'tar',
          ['-czf', archivePath, '-C', tempDir.path, 'source'],
        );
        expect(tarResult.exitCode, 0);

        final extractDir = '${tempDir.path}/extracted';
        final result = await service.extractArchive(archivePath, extractDir);

        expect(result, extractDir);
        expect(
          File('$extractDir/source/tgz-file.txt').readAsStringSync(),
          'tgz content',
        );
      });
    });

    group('cleanupStaleDownloads', () {
      test('deletes staging dirs for versions other than target', () async {
        final stagingBase = '${tempDir.path}/staging';
        Directory(stagingBase).createSync();

        // Create dirs for different versions
        Directory('$stagingBase/zajel-1.0.0-linux').createSync();
        Directory('$stagingBase/zajel-1.1.0-linux').createSync();
        Directory('$stagingBase/zajel-1.2.0-linux').createSync();

        final mockClient = http_testing.MockClient(
          (_) async => http.Response('', 200),
        );
        final service = UpdateDownloadService(client: mockClient);

        await service.cleanupStaleDownloads(
          stagingBase,
          targetVersion: '1.2.0',
        );

        // Only the target version dir should remain
        expect(
            Directory('$stagingBase/zajel-1.0.0-linux').existsSync(), isFalse);
        expect(
            Directory('$stagingBase/zajel-1.1.0-linux').existsSync(), isFalse);
        expect(
            Directory('$stagingBase/zajel-1.2.0-linux').existsSync(), isTrue);
      });

      test('preserves target version directory', () async {
        final stagingBase = '${tempDir.path}/staging';
        Directory(stagingBase).createSync();
        Directory('$stagingBase/zajel-2.0.0-linux').createSync();
        // Put a file in it
        File('$stagingBase/zajel-2.0.0-linux/artifact.tar.gz')
            .writeAsBytesSync([1, 2, 3]);

        final mockClient = http_testing.MockClient(
          (_) async => http.Response('', 200),
        );
        final service = UpdateDownloadService(client: mockClient);

        await service.cleanupStaleDownloads(
          stagingBase,
          targetVersion: '2.0.0',
        );

        expect(
            Directory('$stagingBase/zajel-2.0.0-linux').existsSync(), isTrue);
        expect(
          File('$stagingBase/zajel-2.0.0-linux/artifact.tar.gz').existsSync(),
          isTrue,
        );
      });

      test('handles non-existent staging directory gracefully', () async {
        final mockClient = http_testing.MockClient(
          (_) async => http.Response('', 200),
        );
        final service = UpdateDownloadService(client: mockClient);

        // Should not throw
        await service.cleanupStaleDownloads(
          '${tempDir.path}/nonexistent',
          targetVersion: '1.0.0',
        );
      });

      test('deletes all directories when no target version specified',
          () async {
        final stagingBase = '${tempDir.path}/staging';
        Directory(stagingBase).createSync();
        Directory('$stagingBase/zajel-1.0.0-linux').createSync();
        Directory('$stagingBase/zajel-1.1.0-linux').createSync();

        final mockClient = http_testing.MockClient(
          (_) async => http.Response('', 200),
        );
        final service = UpdateDownloadService(client: mockClient);

        await service.cleanupStaleDownloads(stagingBase);

        expect(
            Directory('$stagingBase/zajel-1.0.0-linux').existsSync(), isFalse);
        expect(
            Directory('$stagingBase/zajel-1.1.0-linux').existsSync(), isFalse);
      });
    });
  });

  group('CancellationToken', () {
    test('starts as not cancelled', () {
      final token = CancellationToken();
      expect(token.isCancelled, isFalse);
    });

    test('becomes cancelled after cancel()', () {
      final token = CancellationToken();
      token.cancel();
      expect(token.isCancelled, isTrue);
    });

    test('cancel() is idempotent', () {
      final token = CancellationToken();
      token.cancel();
      token.cancel();
      expect(token.isCancelled, isTrue);
    });
  });
}
