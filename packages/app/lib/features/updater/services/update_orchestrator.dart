import 'dart:async';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

import '../../../core/logging/logger_service.dart';
import '../models/github_release.dart';
import '../models/update_state.dart';
import 'update_download_service.dart';
import 'update_package_detector.dart';

/// Coordinates the entire update lifecycle as a state machine.
///
/// Transitions: idle -> checking -> downloading -> verifying -> ready
///
/// The orchestrator holds an [UpdateState] and exposes it via [stateStream].
/// It delegates actual work to [UpdateDownloadService] for I/O operations
/// and [UpdatePackageDetector] for platform checks.
///
/// Usage:
/// ```dart
/// final orchestrator = UpdateOrchestrator(...);
/// orchestrator.stateStream.listen((state) { ... });
/// await orchestrator.checkAndPrepare(release);
/// ```
class UpdateOrchestrator {
  static const _tag = 'UpdateOrchestrator';

  final UpdateDownloadService _downloadService;
  final UpdatePackageDetector _packageDetector;
  final LoggerService _logger;

  /// Function that resolves the staging base directory path.
  /// Injected for testability (avoids path_provider calls in tests).
  final Future<String> Function() _getStagingBaseDir;

  /// Current state of the update lifecycle.
  UpdateState _state = const UpdateState.initial();

  final _stateController = StreamController<UpdateState>.broadcast();

  /// Active cancellation token for the current download, if any.
  CancellationToken? _activeCancellationToken;

  /// Guard flag to prevent concurrent [downloadUpdate] calls.
  bool _isDownloading = false;

  UpdateOrchestrator({
    required UpdateDownloadService downloadService,
    required UpdatePackageDetector packageDetector,
    LoggerService? loggerService,
    Future<String> Function()? getStagingBaseDir,
  })  : _downloadService = downloadService,
        _packageDetector = packageDetector,
        _logger = loggerService ?? logger,
        _getStagingBaseDir = getStagingBaseDir ?? _defaultStagingBaseDir;

  /// Stream of state changes.
  Stream<UpdateState> get stateStream => _stateController.stream;

  /// Current state (synchronous snapshot).
  UpdateState get state => _state;

  /// Full flow: check platform support, download artifact, verify checksum.
  ///
  /// Skips if the platform does not support auto-update (MSIX, Snap, etc.).
  /// Skips if a download is already in progress.
  ///
  /// [release] is the GitHub release to download.
  /// [platformName] is "windows", "macos", or "linux".
  Future<void> checkAndPrepare({
    required GitHubRelease release,
    required String platformName,
  }) async {
    // AC-11: Store-managed bypass
    if (!_packageDetector.supportsAutoUpdate()) {
      _logger.info(
        _tag,
        'Auto-update not supported for ${_packageDetector.detect()} install',
      );
      return;
    }

    // Don't interrupt an active download or already-ready state
    if (_state.status == UpdateStatus.downloading ||
        _state.status == UpdateStatus.verifying) {
      _logger.info(_tag, 'Download already in progress, skipping');
      return;
    }

    // If already ready for this version, skip
    if (_state.status == UpdateStatus.ready &&
        _state.availableVersion == release.version) {
      _logger.info(_tag, 'Update ${release.version} already ready, skipping');
      return;
    }

    await downloadUpdate(release: release, platformName: platformName);
  }

  /// Downloads and verifies a specific release.
  ///
  /// State transitions: downloading -> verifying -> ready (or failed).
  /// Returns immediately if a download is already in progress.
  Future<void> downloadUpdate({
    required GitHubRelease release,
    required String platformName,
  }) async {
    // Concurrency guard: prevent overlapping downloads
    if (_isDownloading) {
      _logger.info(
          _tag, 'Download already in progress, ignoring concurrent call');
      return;
    }
    _isDownloading = true;

    try {
      await _doDownloadUpdate(release: release, platformName: platformName);
    } finally {
      _isDownloading = false;
    }
  }

  /// Internal implementation of [downloadUpdate], called after the
  /// concurrency guard is acquired.
  Future<void> _doDownloadUpdate({
    required GitHubRelease release,
    required String platformName,
  }) async {
    final asset = release.getAssetForPlatform(platformName);
    if (asset == null) {
      _setState(UpdateState.failed(
        errorMessage: 'No artifact found for platform: $platformName',
        availableVersion: release.version,
      ));
      return;
    }

    // Resolve staging directory
    String stagingBaseDir;
    try {
      stagingBaseDir = await _getStagingBaseDir();
    } catch (e) {
      _setState(UpdateState.failed(
        errorMessage: 'Cannot resolve staging directory: $e',
        availableVersion: release.version,
      ));
      return;
    }

    final versionDir =
        '$stagingBaseDir/${_versionDirName(release.version, platformName)}';
    final artifactPath = '$versionDir/${asset.name}';

    // Check for existing completed download (AC-9)
    if (File(artifactPath).existsSync()) {
      _logger.info(_tag, 'Existing staged download found: $artifactPath');

      // Verify the existing file
      final checksum = await _resolveChecksum(release, asset.name);
      if (checksum != null) {
        _setState(UpdateState.verifying(
          version: release.version,
          releaseNotes: release.body,
          releaseDate: release.publishedAt,
        ));

        final valid =
            await _downloadService.verifyChecksum(artifactPath, checksum);
        if (valid) {
          _setState(UpdateState.ready(
            version: release.version,
            releaseNotes: release.body,
            releaseDate: release.publishedAt,
          ));
          return;
        }
        // Checksum failed — delete and re-download
        _logger.warning(
            _tag, 'Existing download failed verification, re-downloading');
        File(artifactPath).deleteSync();
      }
    }

    // Start download
    _activeCancellationToken = CancellationToken();

    _setState(UpdateState.downloading(
      version: release.version,
      progress: 0.0,
      releaseNotes: release.body,
      releaseDate: release.publishedAt,
    ));

    try {
      // Download the artifact
      await _downloadService.downloadArtifact(
        url: asset.browserDownloadUrl,
        destinationPath: artifactPath,
        onProgress: (received, total) {
          final progress = total > 0 ? received / total : 0.0;
          _setState(UpdateState.downloading(
            version: release.version,
            progress: progress,
            releaseNotes: release.body,
            releaseDate: release.publishedAt,
          ));
        },
        cancellationToken: _activeCancellationToken,
      );

      // Transition to verifying
      _setState(UpdateState.verifying(
        version: release.version,
        releaseNotes: release.body,
        releaseDate: release.publishedAt,
      ));

      // Verify checksum (AC-6)
      final checksum = await _resolveChecksum(release, asset.name);
      if (checksum == null) {
        // No checksums.txt available — cannot verify
        _logger.error(_tag, 'No checksum available for ${asset.name}');
        _tryDeleteFile(artifactPath);
        _setState(UpdateState.failed(
          errorMessage:
              'Cannot verify update integrity — checksums unavailable',
          availableVersion: release.version,
        ));
        return;
      }

      final valid =
          await _downloadService.verifyChecksum(artifactPath, checksum);
      if (!valid) {
        _logger.error(_tag, 'Checksum verification failed for ${asset.name}');
        _tryDeleteFile(artifactPath);
        _setState(UpdateState.failed(
          errorMessage: 'Checksum verification failed',
          availableVersion: release.version,
        ));
        return;
      }

      // Success
      _setState(UpdateState.ready(
        version: release.version,
        releaseNotes: release.body,
        releaseDate: release.publishedAt,
      ));

      _logger.info(_tag, 'Update ${release.version} downloaded and verified');
    } on DownloadCancelledException {
      _logger.info(_tag, 'Download of ${release.version} was cancelled');
      _setState(UpdateState.failed(
        errorMessage: 'Download cancelled',
        availableVersion: release.version,
      ));
    } catch (e) {
      _logger.error(_tag, 'Download failed', e);
      _setState(UpdateState.failed(
        errorMessage: e.toString(),
        availableVersion: release.version,
      ));
    } finally {
      _activeCancellationToken = null;
    }
  }

  /// Cancels an in-progress download.
  ///
  /// If no download is active, this is a no-op.
  void cancelDownload() {
    if (_activeCancellationToken != null) {
      _activeCancellationToken!.cancel();
      _logger.info(_tag, 'Download cancellation requested');
    }
  }

  /// Resets state to idle.
  void reset() {
    cancelDownload();
    _setState(const UpdateState.initial());
  }

  /// Returns the platform-specific staging base directory path.
  ///
  /// - Windows: %LOCALAPPDATA%\Zajel\update-staging\
  /// - macOS: ~/Library/Application Support/com.zajel.zajel/update-staging/
  /// - Linux: ~/.local/share/zajel/update-staging/
  static Future<String> _defaultStagingBaseDir() async {
    if (Platform.isWindows) {
      final localAppData = Platform.environment['LOCALAPPDATA'];
      if (localAppData == null) {
        throw const FileSystemException(
            'LOCALAPPDATA environment variable not set');
      }
      return '$localAppData\\Zajel\\update-staging';
    } else if (Platform.isMacOS) {
      final appSupport = await getApplicationSupportDirectory();
      return '${appSupport.path}/update-staging';
    } else {
      // Linux
      final xdgData = Platform.environment['XDG_DATA_HOME'] ??
          '${Platform.environment['HOME']}/.local/share';
      return '$xdgData/zajel/update-staging';
    }
  }

  /// Returns the staging subdirectory name for a version+platform.
  String _versionDirName(String version, String platform) {
    return 'zajel-$version-$platform';
  }

  /// Resolves the SHA-256 checksum for an asset from the release's checksum content.
  ///
  /// If the release already has checksumContent attached, uses that.
  /// Otherwise fetches checksums.txt from the release assets.
  Future<String?> _resolveChecksum(
      GitHubRelease release, String assetName) async {
    // Try pre-loaded checksum content first
    if (release.checksumContent != null) {
      return release.getChecksumForAsset(assetName);
    }

    // Fetch checksums.txt from the release
    final checksumsAsset = release.checksumsAsset;
    if (checksumsAsset == null) {
      return null;
    }

    final content = await _downloadService
        .fetchChecksums(checksumsAsset.browserDownloadUrl);
    if (content == null) return null;

    // Parse the fetched content using the same logic
    final releaseWithChecksums = release.withChecksumContent(content);
    return releaseWithChecksums.getChecksumForAsset(assetName);
  }

  /// Cleans up stale staging downloads.
  ///
  /// Should be called on app start after version check completes.
  Future<void> cleanupStaleDownloads({String? targetVersion}) async {
    try {
      final baseDir = await _getStagingBaseDir();
      await _downloadService.cleanupStaleDownloads(
        baseDir,
        targetVersion: targetVersion,
      );
    } catch (e) {
      _logger.warning(_tag, 'Failed to clean up stale downloads: $e');
    }
  }

  /// Returns the staging base directory path.
  Future<String> getStagingDir() => _getStagingBaseDir();

  void _setState(UpdateState newState) {
    _state = newState;
    if (!_stateController.isClosed) {
      _stateController.add(newState);
    }
  }

  void _tryDeleteFile(String path) {
    try {
      final file = File(path);
      if (file.existsSync()) file.deleteSync();
    } catch (e) {
      _logger.warning(_tag, 'Failed to delete $path: $e');
    }
  }

  /// Releases resources. Must be called when the orchestrator is no longer needed.
  void dispose() {
    cancelDownload();
    _stateController.close();
  }
}
