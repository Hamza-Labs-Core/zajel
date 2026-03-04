import 'dart:convert';
import 'dart:io';

import '../../../core/logging/logger_service.dart';
import '../models/update_manifest.dart';

/// Manages the external updater binary and launches it for update installation
/// or rollback.
///
/// The updater binary lives OUTSIDE the install directory because it replaces
/// that directory's contents. Platform-specific paths:
/// - Windows: `%LOCALAPPDATA%\Zajel\updater\zajel-updater.exe`
/// - macOS: `~/Library/Application Support/com.zajel.zajel/updater/zajel-updater`
/// - Linux: `~/.local/share/zajel/updater/zajel-updater`
///
/// For testability, platform values and process operations can be injected
/// via the constructor.
class UpdaterLauncher {
  static const _tag = 'UpdaterLauncher';

  /// Name of the updater binary (without platform extension).
  static const _updaterBaseName = 'zajel-updater';

  /// Name of the manifest file.
  static const _manifestFileName = 'manifest.json';

  /// Name of the update result file.
  static const _resultFileName = 'update-result.json';

  /// Name of the lock file.
  static const _lockFileName = 'update-in-progress.lock';

  final LoggerService _logger;

  // Injected platform dependencies for testability.
  final bool _isWindows;
  final bool _isMacOS;
  final bool _isLinux;
  final String _resolvedExecutable;
  final Map<String, String> _environment;
  final int Function() _getPid;
  final bool Function(String path) _fileExists;
  final void Function(String src, String dst) _copyFile;
  final void Function(String path) _createDirectoryRecursive;
  final Future<Process> Function(
    String executable,
    List<String> arguments, {
    ProcessStartMode mode,
  }) _startProcess;
  final Future<ProcessResult> Function(
    String executable,
    List<String> arguments,
  ) _runProcess;
  final void Function(String path, String content) _writeFileString;

  /// Creates an [UpdaterLauncher].
  ///
  /// All platform-specific dependencies default to the real implementations.
  /// Override them in tests.
  UpdaterLauncher({
    LoggerService? logger,
    bool? isWindows,
    bool? isMacOS,
    bool? isLinux,
    String? resolvedExecutable,
    Map<String, String>? environment,
    int Function()? getPid,
    bool Function(String path)? fileExists,
    void Function(String src, String dst)? copyFile,
    void Function(String path)? createDirectoryRecursive,
    Future<Process> Function(
      String executable,
      List<String> arguments, {
      ProcessStartMode mode,
    })? startProcess,
    Future<ProcessResult> Function(
      String executable,
      List<String> arguments,
    )? runProcess,
    void Function(String path, String content)? writeFileString,
  })  : _logger = logger ?? LoggerService.instance,
        _isWindows = isWindows ?? Platform.isWindows,
        _isMacOS = isMacOS ?? Platform.isMacOS,
        _isLinux = isLinux ?? Platform.isLinux,
        _resolvedExecutable = resolvedExecutable ?? Platform.resolvedExecutable,
        _environment = environment ?? Platform.environment,
        _getPid = getPid ?? (() => pid),
        _fileExists = fileExists ?? ((p) => File(p).existsSync()),
        _copyFile = copyFile ?? ((src, dst) => File(src).copySync(dst)),
        _createDirectoryRecursive = createDirectoryRecursive ??
            ((p) => Directory(p).createSync(recursive: true)),
        _startProcess = startProcess ?? _defaultStartProcess,
        _runProcess = runProcess ?? Process.run,
        _writeFileString =
            writeFileString ?? ((p, c) => File(p).writeAsStringSync(c));

  static Future<Process> _defaultStartProcess(
    String executable,
    List<String> arguments, {
    ProcessStartMode mode = ProcessStartMode.normal,
  }) {
    return Process.start(executable, arguments, mode: mode);
  }

  /// Returns the platform-specific directory for the updater binary and
  /// related files (result JSON, manifest).
  ///
  /// Throws [MissingEnvironmentException] if the required environment variable
  /// (`LOCALAPPDATA` on Windows, `HOME` on macOS/Linux) is not set.
  String getUpdaterDir() {
    if (_isWindows) {
      final localAppData = _requireEnv('LOCALAPPDATA');
      return '$localAppData\\Zajel\\updater';
    } else if (_isMacOS) {
      final home = _requireEnv('HOME');
      return '$home/Library/Application Support/com.zajel.zajel/updater';
    } else {
      // Linux and other Unix-like
      final home = _requireEnv('HOME');
      return '$home/.local/share/zajel/updater';
    }
  }

  /// Returns the full path to the external updater binary.
  String getUpdaterPath() {
    final dir = getUpdaterDir();
    final name = _isWindows ? '$_updaterBaseName.exe' : _updaterBaseName;
    final sep = _isWindows ? '\\' : '/';
    return '$dir$sep$name';
  }

  /// Returns the install directory (where the running app lives).
  ///
  /// Derived from the resolved executable path:
  /// - macOS: Navigate up to the `.app` bundle's parent directory.
  /// - Windows/Linux: Parent directory of the executable.
  String getInstallDir() {
    if (_isMacOS) {
      // macOS: resolvedExecutable is inside zajel.app/Contents/MacOS/zajel
      // We want the parent of the .app bundle.
      final parts = _resolvedExecutable.split('/');
      for (var i = parts.length - 1; i >= 0; i--) {
        if (parts[i].endsWith('.app')) {
          return parts.sublist(0, i).join('/');
        }
      }
      // Fallback: parent directory
      return File(_resolvedExecutable).parent.path;
    }

    // Windows and Linux: parent directory of the executable
    return File(_resolvedExecutable).parent.path;
  }

  /// Returns the backup directory path.
  ///
  /// Throws [MissingEnvironmentException] if the required environment variable
  /// (`LOCALAPPDATA` on Windows, `HOME` on macOS/Linux) is not set.
  String getBackupDir() {
    if (_isWindows) {
      final localAppData = _requireEnv('LOCALAPPDATA');
      return '$localAppData\\Zajel\\update-backup';
    } else if (_isMacOS) {
      final home = _requireEnv('HOME');
      return '$home/Library/Application Support/com.zajel.zajel/update-backup';
    } else {
      final home = _requireEnv('HOME');
      return '$home/.local/share/zajel/update-backup';
    }
  }

  /// Returns the staging parent directory path.
  ///
  /// Throws [MissingEnvironmentException] if the required environment variable
  /// (`LOCALAPPDATA` on Windows, `HOME` on macOS/Linux) is not set.
  String getStagingParentDir() {
    if (_isWindows) {
      final localAppData = _requireEnv('LOCALAPPDATA');
      return '$localAppData\\Zajel\\update-staging';
    } else if (_isMacOS) {
      final home = _requireEnv('HOME');
      return '$home/Library/Application Support/com.zajel.zajel/update-staging';
    } else {
      final home = _requireEnv('HOME');
      return '$home/.local/share/zajel/update-staging';
    }
  }

  /// Returns the path to the manifest file.
  String getManifestPath() {
    final dir = getUpdaterDir();
    final sep = _isWindows ? '\\' : '/';
    return '$dir$sep$_manifestFileName';
  }

  /// Returns the path to the update result file.
  String getResultPath() {
    final dir = getUpdaterDir();
    final sep = _isWindows ? '\\' : '/';
    return '$dir$sep$_resultFileName';
  }

  /// Returns the path to the lock file.
  String getLockFilePath() {
    final backupDir = getBackupDir();
    final sep = _isWindows ? '\\' : '/';
    return '$backupDir$sep$_lockFileName';
  }

  /// Copies the updater binary from the staging directory to the external
  /// updater location.
  ///
  /// Each release artifact includes the updater binary. This copies the
  /// NEW updater from staging, overwriting any existing one. This ensures
  /// the updater is always from the latest release (self-update).
  ///
  /// On Linux/macOS, `chmod +x` is applied to the copied binary.
  ///
  /// Throws [UpdaterBinaryNotFoundException] if the updater binary is not
  /// found in the staging directory.
  /// Throws [UpdaterCopyException] if the copy operation fails.
  Future<void> deployUpdater(String stagingDir) async {
    final updaterName = _isWindows ? '$_updaterBaseName.exe' : _updaterBaseName;

    // Search for the updater binary in the staging directory
    final sep = _isWindows ? '\\' : '/';
    final candidatePaths = [
      '$stagingDir$sep$updaterName',
      '$stagingDir${sep}updater$sep$updaterName',
    ];

    String? sourcePath;
    for (final candidate in candidatePaths) {
      if (_fileExists(candidate)) {
        sourcePath = candidate;
        break;
      }
    }

    if (sourcePath == null) {
      throw UpdaterBinaryNotFoundException(
        'Updater binary "$updaterName" not found in staging directory '
        '"$stagingDir"',
      );
    }

    final targetPath = getUpdaterPath();
    _logger.info(_tag, 'Deploying updater from $sourcePath to $targetPath');

    try {
      // Create the target directory if it doesn't exist
      final targetDir = getUpdaterDir();
      _createDirectoryRecursive(targetDir);

      // Copy the binary
      _copyFile(sourcePath, targetPath);
    } catch (e) {
      if (e is UpdaterBinaryNotFoundException) rethrow;
      throw UpdaterCopyException(
        'Failed to copy updater binary to $targetPath: $e',
      );
    }

    // Set executable permission on Unix-like systems
    if (_isLinux || _isMacOS) {
      try {
        final chmodResult = await _runProcess('chmod', ['+x', targetPath]);
        if (chmodResult.exitCode != 0) {
          throw UpdaterCopyException(
            'chmod +x failed on $targetPath (exit code ${chmodResult.exitCode}): '
            '${chmodResult.stderr}',
          );
        }
      } catch (e) {
        if (e is UpdaterCopyException) rethrow;
        throw UpdaterCopyException(
          'Failed to set executable permission on $targetPath: $e',
        );
      }
    }

    // Clear macOS quarantine attribute
    if (_isMacOS) {
      try {
        await _runProcess('xattr', ['-rd', 'com.apple.quarantine', targetPath]);
      } catch (e) {
        _logger.warning(
            _tag, 'Failed to clear quarantine attribute on updater: $e');
      }
    }

    _logger.info(_tag, 'Updater binary deployed successfully');
  }

  /// Writes the manifest file and launches the updater process for a
  /// regular update installation.
  ///
  /// Returns `true` if the updater was launched successfully.
  ///
  /// Throws [UpdaterBinaryNotFoundException] if the updater binary is not
  /// found in the staging directory.
  /// Throws [ManifestWriteException] if the manifest cannot be written.
  /// Throws [UpdaterLaunchException] if the updater process fails to start.
  /// Throws [UpdaterCopyException] if the updater binary cannot be copied.
  Future<bool> launchUpdate({
    required String targetVersion,
    required String currentVersion,
    required String stagingDir,
    required String checksumSha256,
  }) async {
    _logger.info(
        _tag,
        'Preparing to launch update: '
        '$currentVersion -> $targetVersion');

    // 1. Deploy the updater binary from staging
    await deployUpdater(stagingDir);

    // 2. Build and write the manifest
    final manifestPath = getManifestPath();
    final currentPid = _getPid();

    final manifest = UpdateManifest(
      schemaVersion: 1,
      appPid: currentPid,
      appVersionCurrent: currentVersion,
      appVersionTarget: targetVersion,
      installDir: getInstallDir(),
      stagingDir: stagingDir,
      backupDir: getBackupDir(),
      appExecutable: _getAppExecutableName(),
      platform: _getPlatformString(),
      checksumSha256: checksumSha256,
      timestamp: DateTime.now().toUtc(),
    );

    try {
      _createDirectoryRecursive(getUpdaterDir());
      final encoder = const JsonEncoder.withIndent('  ');
      _writeFileString(manifestPath, encoder.convert(manifest.toJson()));
      _logger.info(_tag, 'Manifest written to $manifestPath');
    } catch (e) {
      throw ManifestWriteException(
        'Failed to write manifest to $manifestPath: $e',
      );
    }

    // 3. Launch the updater as a detached process
    final updaterPath = getUpdaterPath();
    if (!_fileExists(updaterPath)) {
      throw UpdaterLaunchException(
        'Updater binary not found at $updaterPath after deployment',
      );
    }

    try {
      await _startProcess(
        updaterPath,
        ['--manifest', manifestPath, '--pid', currentPid.toString()],
        mode: ProcessStartMode.detached,
      );
      _logger.info(_tag, 'Updater launched successfully (PID: $currentPid)');
      return true;
    } catch (e) {
      throw UpdaterLaunchException(
        'Failed to launch updater at $updaterPath: $e',
      );
    }
  }

  /// Launches the updater in rollback mode to restore the previous version.
  ///
  /// Returns `true` if the updater was launched successfully.
  /// Returns `false` if the updater binary or manifest is not available.
  Future<bool> launchRollback() async {
    final updaterPath = getUpdaterPath();
    final manifestPath = getManifestPath();

    if (!_fileExists(updaterPath)) {
      _logger.error(
          _tag, 'Cannot rollback: updater binary not found at $updaterPath');
      return false;
    }

    if (!_fileExists(manifestPath)) {
      _logger.error(
          _tag, 'Cannot rollback: manifest not found at $manifestPath');
      return false;
    }

    try {
      await _startProcess(
        updaterPath,
        ['--rollback', '--manifest', manifestPath],
        mode: ProcessStartMode.detached,
      );
      _logger.info(_tag, 'Updater launched in rollback mode');
      return true;
    } catch (e) {
      _logger.error(_tag, 'Failed to launch updater for rollback', e);
      return false;
    }
  }

  /// Returns the app executable name for the current platform.
  String _getAppExecutableName() {
    final exePath = _resolvedExecutable;
    final sep = _isWindows ? '\\' : '/';
    final parts = exePath.split(sep);
    return parts.last;
  }

  /// Returns the platform string for the manifest.
  String _getPlatformString() {
    if (_isWindows) return 'windows';
    if (_isMacOS) return 'macos';
    if (_isLinux) return 'linux';
    return 'unknown';
  }

  /// Returns the value of the environment variable [name], or throws
  /// [MissingEnvironmentException] if it is not set or empty.
  String _requireEnv(String name) {
    final value = _environment[name];
    if (value == null || value.isEmpty) {
      throw MissingEnvironmentException(
        'Required environment variable $name is not set. '
        'Cannot determine updater directory paths.',
      );
    }
    return value;
  }
}

/// Thrown when the updater binary is not found in the staging directory.
class UpdaterBinaryNotFoundException implements Exception {
  final String message;
  const UpdaterBinaryNotFoundException(this.message);

  @override
  String toString() => 'UpdaterBinaryNotFoundException: $message';
}

/// Thrown when the updater binary cannot be copied to the external location.
class UpdaterCopyException implements Exception {
  final String message;
  const UpdaterCopyException(this.message);

  @override
  String toString() => 'UpdaterCopyException: $message';
}

/// Thrown when the manifest file cannot be written.
class ManifestWriteException implements Exception {
  final String message;
  const ManifestWriteException(this.message);

  @override
  String toString() => 'ManifestWriteException: $message';
}

/// Thrown when the updater process fails to start.
class UpdaterLaunchException implements Exception {
  final String message;
  const UpdaterLaunchException(this.message);

  @override
  String toString() => 'UpdaterLaunchException: $message';
}

/// Thrown when a required environment variable is missing.
class MissingEnvironmentException implements Exception {
  final String message;
  const MissingEnvironmentException(this.message);

  @override
  String toString() => 'MissingEnvironmentException: $message';
}
