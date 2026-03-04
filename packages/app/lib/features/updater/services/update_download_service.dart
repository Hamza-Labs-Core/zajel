import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;

import '../../../core/logging/logger_service.dart';

/// Token for cancelling an in-progress download.
///
/// Create one before starting a download and pass it in.
/// Call [cancel] to signal cancellation. The download service
/// checks [isCancelled] between chunks and aborts if true.
class CancellationToken {
  bool _cancelled = false;

  /// Whether cancellation has been requested.
  bool get isCancelled => _cancelled;

  /// Request cancellation. Idempotent — safe to call multiple times.
  void cancel() => _cancelled = true;
}

/// Exception thrown when a download is cancelled via [CancellationToken].
class DownloadCancelledException implements Exception {
  @override
  String toString() => 'Download was cancelled';
}

/// Exception thrown when a download URL uses HTTP instead of HTTPS.
class InsecureUrlException implements Exception {
  final String url;
  const InsecureUrlException(this.url);

  @override
  String toString() => 'Refusing non-HTTPS download URL: $url';
}

/// Chunked HTTP download service with progress, resume, and verification.
///
/// Downloads artifacts from HTTPS URLs to a staging directory using
/// streamed responses. Supports:
/// - Resumable downloads via HTTP Range headers and .partial files
/// - ETag validation to detect re-uploaded artifacts
/// - SHA-256 checksum verification after download
/// - Cancellation via [CancellationToken]
/// - Stale download cleanup
///
/// This service does NOT manage state — it performs I/O operations and
/// reports progress via callbacks. The [UpdateOrchestrator] coordinates
/// state transitions.
class UpdateDownloadService {
  static const _tag = 'UpdateDownload';

  final http.Client _client;
  final LoggerService _logger;

  UpdateDownloadService({
    required http.Client client,
    LoggerService? loggerService,
  })  : _client = client,
        _logger = loggerService ?? logger;

  /// Downloads an artifact to [destinationPath].
  ///
  /// The file is first written to `$destinationPath.partial` and renamed
  /// to [destinationPath] on successful completion. If a `.partial` file
  /// already exists, the download resumes from where it left off (if the
  /// server supports Range requests and the ETag matches).
  ///
  /// [onProgress] is called with (bytesReceived, totalBytes) as chunks
  /// arrive. totalBytes may be 0 if the server does not report content length.
  ///
  /// Throws [InsecureUrlException] if [url] is not HTTPS.
  /// Throws [DownloadCancelledException] if cancelled via [cancellationToken].
  /// Throws [HttpException] on HTTP error responses.
  /// Throws [IOException] on file system errors.
  ///
  /// Returns the path to the completed download file.
  Future<String> downloadArtifact({
    required String url,
    required String destinationPath,
    required void Function(int received, int total) onProgress,
    CancellationToken? cancellationToken,
  }) async {
    // AC-12: HTTPS only
    final uri = Uri.parse(url);
    if (uri.scheme != 'https') {
      throw InsecureUrlException(url);
    }

    final partialPath = '$destinationPath.partial';
    final etagPath = '$destinationPath.etag';
    final partialFile = File(partialPath);
    final etagFile = File(etagPath);

    // Ensure parent directory exists
    final parentDir = File(destinationPath).parent;
    if (!parentDir.existsSync()) {
      parentDir.createSync(recursive: true);
    }

    // Check for existing complete download
    final destFile = File(destinationPath);
    if (destFile.existsSync()) {
      _logger.info(_tag, 'Download already complete: $destinationPath');
      final stat = destFile.statSync();
      onProgress(stat.size, stat.size);
      return destinationPath;
    }

    // Check for existing .partial file for resume
    var resumeOffset = 0;
    String? storedEtag;
    if (partialFile.existsSync()) {
      resumeOffset = partialFile.lengthSync();
      if (etagFile.existsSync()) {
        storedEtag = etagFile.readAsStringSync().trim();
      }
      _logger.info(
        _tag,
        'Found partial download: $resumeOffset bytes, etag=$storedEtag',
      );
    }

    // HEAD request to get metadata
    int totalBytes = 0;
    bool serverSupportsRange = false;
    String? serverEtag;

    try {
      final headRequest = http.Request('HEAD', uri);
      final headResponse = await _client.send(headRequest).timeout(
            const Duration(seconds: 15),
          );

      totalBytes = headResponse.contentLength ?? 0;
      serverSupportsRange =
          headResponse.headers['accept-ranges']?.contains('bytes') ?? false;
      serverEtag = headResponse.headers['etag'];

      // Drain the head response body (even though it should be empty)
      await headResponse.stream.drain<void>();
    } catch (e) {
      _logger.warning(
          _tag, 'HEAD request failed, proceeding without resume info: $e');
    }

    // Validate resume conditions
    if (resumeOffset > 0) {
      final etagChanged =
          storedEtag != null && serverEtag != null && storedEtag != serverEtag;
      if (etagChanged || !serverSupportsRange) {
        _logger.info(
          _tag,
          etagChanged
              ? 'ETag changed, restarting download from scratch'
              : 'Server does not support Range, restarting download',
        );
        partialFile.deleteSync();
        if (etagFile.existsSync()) etagFile.deleteSync();
        resumeOffset = 0;
      }
    }

    // Build the GET request
    final getRequest = http.Request('GET', uri);
    if (resumeOffset > 0 && serverSupportsRange) {
      getRequest.headers['Range'] = 'bytes=$resumeOffset-';
      _logger.info(_tag, 'Resuming download from byte $resumeOffset');
    }

    // Send the GET request
    final response = await _client.send(getRequest).timeout(
          const Duration(seconds: 30),
        );

    // Validate response status
    if (response.statusCode != 200 && response.statusCode != 206) {
      await response.stream.drain<void>();
      throw HttpException(
        'Download failed with status ${response.statusCode}',
        uri: uri,
      );
    }

    // If server returned 200 (not 206), we got the full file regardless
    // of our Range request. Start from scratch.
    if (response.statusCode == 200 && resumeOffset > 0) {
      _logger.info(
          _tag, 'Server returned 200 instead of 206, restarting download');
      if (partialFile.existsSync()) partialFile.deleteSync();
      resumeOffset = 0;
    }

    // Determine total size
    if (response.statusCode == 200) {
      totalBytes = response.contentLength ?? totalBytes;
    } else if (response.statusCode == 206) {
      // For 206, total = already downloaded + remaining
      totalBytes = resumeOffset + (response.contentLength ?? 0);
    }

    // Save ETag for future resume validation
    if (serverEtag != null) {
      etagFile.writeAsStringSync(serverEtag);
    }

    // Stream response to .partial file
    final openMode = (resumeOffset > 0 && response.statusCode == 206)
        ? FileMode.append
        : FileMode.write;
    final sink = partialFile.openWrite(mode: openMode);

    var bytesReceived = resumeOffset;

    try {
      await for (final chunk in response.stream) {
        // Check cancellation
        if (cancellationToken != null && cancellationToken.isCancelled) {
          await sink.flush();
          await sink.close();
          _logger.info(_tag, 'Download cancelled at $bytesReceived bytes');
          throw DownloadCancelledException();
        }

        sink.add(chunk);
        bytesReceived += chunk.length;
        onProgress(bytesReceived, totalBytes);
      }

      await sink.flush();
      await sink.close();
    } catch (e) {
      // Ensure sink is closed before re-throwing
      try {
        await sink.flush();
        await sink.close();
      } catch (closeError) {
        _logger.debug(_tag, 'Error closing sink during cleanup: $closeError');
      }
      rethrow;
    }

    // Rename .partial to final name
    partialFile.renameSync(destinationPath);

    // Clean up .etag file
    if (etagFile.existsSync()) {
      etagFile.deleteSync();
    }

    _logger.info(
      _tag,
      'Download complete: $destinationPath ($bytesReceived bytes)',
    );
    return destinationPath;
  }

  /// Verifies the SHA-256 checksum of a downloaded file.
  ///
  /// Streams the file through SHA-256 in chunks to avoid loading
  /// the entire file into memory. Compares the computed hash against
  /// [expectedSha256] (case-insensitive hex comparison).
  ///
  /// Returns true if the checksum matches, false otherwise.
  Future<bool> verifyChecksum(String filePath, String expectedSha256) async {
    final file = File(filePath);
    if (!file.existsSync()) {
      _logger.error(
          _tag, 'File not found for checksum verification: $filePath');
      return false;
    }

    late Digest digest;
    final output = ChunkedConversionSink<Digest>.withCallback((chunks) {
      digest = chunks.single;
    });
    final input = sha256.startChunkedConversion(output);
    await for (final chunk in file.openRead()) {
      input.add(chunk);
    }
    input.close();
    final computed = digest.toString();
    final matches = computed == expectedSha256.toLowerCase();

    if (matches) {
      _logger.info(_tag, 'Checksum verified: $filePath');
    } else {
      _logger.error(
        _tag,
        'Checksum mismatch for $filePath: '
        'expected=$expectedSha256, computed=$computed',
      );
    }

    return matches;
  }

  /// Extracts an archive to a staging directory.
  ///
  /// Uses platform-native tools:
  /// - Windows: `tar` (built-in on Windows 10+) for ZIP files
  /// - macOS: `hdiutil` for DMG, `tar` for tar.gz
  /// - Linux: `tar` for tar.gz
  ///
  /// Returns the path to the extraction directory.
  /// Throws [ProcessException] if extraction fails.
  Future<String> extractArchive(String archivePath, String extractDir) async {
    final extractDirectory = Directory(extractDir);
    if (!extractDirectory.existsSync()) {
      extractDirectory.createSync(recursive: true);
    }

    final archiveName = archivePath.split(Platform.pathSeparator).last;
    ProcessResult result;

    if (archiveName.endsWith('.zip')) {
      // Windows or cross-platform ZIP
      if (Platform.isWindows) {
        result = await Process.run(
          'tar',
          ['-xf', archivePath, '-C', extractDir],
        );
      } else {
        result = await Process.run(
          'unzip',
          ['-o', archivePath, '-d', extractDir],
        );
      }
    } else if (archiveName.endsWith('.tar.gz') ||
        archiveName.endsWith('.tgz')) {
      result = await Process.run(
        'tar',
        ['-xzf', archivePath, '-C', extractDir],
      );
    } else if (archiveName.endsWith('.dmg')) {
      // macOS DMG: mount, copy contents, unmount
      final mountPoint = '$extractDir/.dmg-mount';
      Directory(mountPoint).createSync(recursive: true);

      // Mount the DMG
      result = await Process.run(
        'hdiutil',
        ['attach', archivePath, '-mountpoint', mountPoint, '-nobrowse'],
      );
      if (result.exitCode != 0) {
        throw ProcessException(
          'hdiutil',
          ['attach'],
          'DMG mount failed: ${result.stderr}',
          result.exitCode,
        );
      }

      try {
        // Copy .app bundle from mount point
        final copyResult = await Process.run(
          'cp',
          ['-R', '$mountPoint/', extractDir],
        );
        if (copyResult.exitCode != 0) {
          throw ProcessException(
            'cp',
            ['-R'],
            'Copy from DMG failed: ${copyResult.stderr}',
            copyResult.exitCode,
          );
        }
      } finally {
        // Always unmount
        final detachResult =
            await Process.run('hdiutil', ['detach', mountPoint, '-force']);
        if (detachResult.exitCode != 0) {
          _logger.warning(
            _tag,
            'hdiutil detach failed (exit ${detachResult.exitCode}): '
            '${detachResult.stderr}',
          );
        }
        // Clean up mount point directory
        if (Directory(mountPoint).existsSync()) {
          Directory(mountPoint).deleteSync(recursive: true);
        }
      }
      return extractDir;
    } else {
      throw ArgumentError('Unsupported archive format: $archiveName');
    }

    if (result.exitCode != 0) {
      throw ProcessException(
        'archive extraction',
        [archivePath],
        'Extraction failed: ${result.stderr}',
        result.exitCode,
      );
    }

    _logger.info(_tag, 'Extracted $archivePath to $extractDir');
    return extractDir;
  }

  /// Fetches the checksums.txt content from a URL.
  ///
  /// Returns the text content, or null on failure.
  Future<String?> fetchChecksums(String url) async {
    final uri = Uri.parse(url);
    if (uri.scheme != 'https') {
      _logger.error(_tag, 'Refusing non-HTTPS checksum URL: $url');
      return null;
    }

    try {
      final response = await _client.get(uri).timeout(
            const Duration(seconds: 15),
          );
      if (response.statusCode == 200) {
        return response.body;
      }
      _logger.warning(
        _tag,
        'Failed to fetch checksums: HTTP ${response.statusCode}',
      );
      return null;
    } catch (e) {
      _logger.error(_tag, 'Failed to fetch checksums', e);
      return null;
    }
  }

  /// Cleans up stale downloads from the staging base directory.
  ///
  /// Deletes:
  /// - Staging subdirectories for versions other than [targetVersion]
  /// - Orphaned .partial files older than 7 days
  ///
  /// Preserves:
  /// - The staging directory for [targetVersion] (including .partial files)
  /// - Any .partial file for the target version (for resumption)
  Future<void> cleanupStaleDownloads(
    String stagingBaseDir, {
    String? targetVersion,
  }) async {
    final baseDir = Directory(stagingBaseDir);
    if (!baseDir.existsSync()) return;

    final now = DateTime.now();
    final staleThreshold = const Duration(days: 7);

    await for (final entity in baseDir.list()) {
      try {
        if (entity is Directory) {
          final dirName = entity.path.split(Platform.pathSeparator).last;

          // Keep the target version directory
          if (targetVersion != null && dirName.contains(targetVersion)) {
            continue;
          }

          // Delete directories for other versions
          _logger.info(_tag, 'Cleaning up stale staging dir: ${entity.path}');
          await entity.delete(recursive: true);
        } else if (entity is File && entity.path.endsWith('.partial')) {
          // Delete orphaned .partial files older than 7 days
          final stat = await entity.stat();
          if (now.difference(stat.modified) > staleThreshold) {
            _logger.info(
                _tag, 'Cleaning up stale partial file: ${entity.path}');
            await entity.delete();
          }
        }
      } catch (e) {
        _logger.warning(_tag, 'Error cleaning up ${entity.path}: $e');
      }
    }
  }

  /// Disposes the HTTP client.
  void dispose() {
    _client.close();
  }
}
