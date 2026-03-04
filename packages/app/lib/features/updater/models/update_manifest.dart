import 'dart:convert';
import 'dart:io';

/// JSON manifest model for IPC between the Flutter app and the Go updater.
///
/// The app writes this manifest to disk before launching the updater binary.
/// The updater reads it to know what to update, where files are, and which
/// process to wait for.
///
/// See plan 09 section 4.3 for the schema specification.
class UpdateManifest {
  /// Schema version for forward compatibility. Always 1 for now.
  final int schemaVersion;

  /// PID of the running app process. The updater waits for this to exit.
  final int appPid;

  /// Currently installed version string (e.g., "1.0.0").
  final String appVersionCurrent;

  /// Target version to update to (e.g., "1.2.0").
  final String appVersionTarget;

  /// Absolute path to the app's installation directory.
  final String installDir;

  /// Absolute path to the staging directory containing extracted update files.
  final String stagingDir;

  /// Absolute path to the backup directory for rollback.
  final String backupDir;

  /// Name of the app executable (e.g., "zajel.exe" on Windows, "zajel" on Linux).
  final String appExecutable;

  /// Target platform: "windows", "macos", or "linux".
  final String platform;

  /// SHA-256 checksum of the downloaded artifact, hex-encoded.
  final String checksumSha256;

  /// Timestamp when the manifest was created.
  final DateTime timestamp;

  const UpdateManifest({
    required this.schemaVersion,
    required this.appPid,
    required this.appVersionCurrent,
    required this.appVersionTarget,
    required this.installDir,
    required this.stagingDir,
    required this.backupDir,
    required this.appExecutable,
    required this.platform,
    required this.checksumSha256,
    required this.timestamp,
  });

  /// Creates a manifest from a JSON map.
  ///
  /// Throws [FormatException] if required fields are missing or have
  /// incorrect types.
  factory UpdateManifest.fromJson(Map<String, dynamic> json) {
    final schemaVersion = json['schema_version'];
    if (schemaVersion is! int) {
      throw const FormatException(
        'Missing or invalid "schema_version" field in update manifest',
      );
    }

    final appPid = json['app_pid'];
    if (appPid is! int) {
      throw const FormatException(
        'Missing or invalid "app_pid" field in update manifest',
      );
    }

    final appVersionCurrent = json['app_version_current'];
    if (appVersionCurrent is! String || appVersionCurrent.isEmpty) {
      throw const FormatException(
        'Missing or invalid "app_version_current" field in update manifest',
      );
    }

    final appVersionTarget = json['app_version_target'];
    if (appVersionTarget is! String || appVersionTarget.isEmpty) {
      throw const FormatException(
        'Missing or invalid "app_version_target" field in update manifest',
      );
    }

    final installDir = json['install_dir'];
    if (installDir is! String || installDir.isEmpty) {
      throw const FormatException(
        'Missing or invalid "install_dir" field in update manifest',
      );
    }

    final stagingDir = json['staging_dir'];
    if (stagingDir is! String || stagingDir.isEmpty) {
      throw const FormatException(
        'Missing or invalid "staging_dir" field in update manifest',
      );
    }

    final backupDir = json['backup_dir'];
    if (backupDir is! String || backupDir.isEmpty) {
      throw const FormatException(
        'Missing or invalid "backup_dir" field in update manifest',
      );
    }

    final appExecutable = json['app_executable'];
    if (appExecutable is! String || appExecutable.isEmpty) {
      throw const FormatException(
        'Missing or invalid "app_executable" field in update manifest',
      );
    }

    final platform = json['platform'];
    if (platform is! String || platform.isEmpty) {
      throw const FormatException(
        'Missing or invalid "platform" field in update manifest',
      );
    }
    if (!_validPlatforms.contains(platform)) {
      throw FormatException(
        'Invalid "platform" value "$platform". '
        'Must be one of: ${_validPlatforms.join(", ")}',
      );
    }

    final checksumSha256 = json['checksum_sha256'];
    if (checksumSha256 is! String || checksumSha256.isEmpty) {
      throw const FormatException(
        'Missing or invalid "checksum_sha256" field in update manifest',
      );
    }

    final timestampStr = json['timestamp'];
    if (timestampStr is! String || timestampStr.isEmpty) {
      throw const FormatException(
        'Missing or invalid "timestamp" field in update manifest',
      );
    }
    final timestamp = DateTime.tryParse(timestampStr);
    if (timestamp == null) {
      throw FormatException(
        'Cannot parse "timestamp" value "$timestampStr" as DateTime',
      );
    }

    return UpdateManifest(
      schemaVersion: schemaVersion,
      appPid: appPid,
      appVersionCurrent: appVersionCurrent,
      appVersionTarget: appVersionTarget,
      installDir: installDir,
      stagingDir: stagingDir,
      backupDir: backupDir,
      appExecutable: appExecutable,
      platform: platform,
      checksumSha256: checksumSha256,
      timestamp: timestamp,
    );
  }

  static const _validPlatforms = {'windows', 'macos', 'linux'};

  /// Reads a manifest from a JSON file on disk.
  ///
  /// Throws [FileSystemException] if the file cannot be read.
  /// Throws [FormatException] if the file content is not valid JSON
  /// or is missing required fields.
  static UpdateManifest fromFile(String path) {
    final file = File(path);
    final content = file.readAsStringSync();
    final json = jsonDecode(content) as Map<String, dynamic>;
    return UpdateManifest.fromJson(json);
  }

  /// Serializes this manifest to a JSON map.
  Map<String, dynamic> toJson() => {
        'schema_version': schemaVersion,
        'app_pid': appPid,
        'app_version_current': appVersionCurrent,
        'app_version_target': appVersionTarget,
        'install_dir': installDir,
        'staging_dir': stagingDir,
        'backup_dir': backupDir,
        'app_executable': appExecutable,
        'platform': platform,
        'checksum_sha256': checksumSha256,
        'timestamp': timestamp.toUtc().toIso8601String(),
      };

  /// Writes this manifest as formatted JSON to a file on disk.
  ///
  /// Creates parent directories if they do not exist.
  void writeToFile(String path) {
    final file = File(path);
    file.parent.createSync(recursive: true);
    final encoder = const JsonEncoder.withIndent('  ');
    file.writeAsStringSync(encoder.convert(toJson()));
  }

  /// Creates a copy with the specified fields replaced.
  UpdateManifest copyWith({
    int? schemaVersion,
    int? appPid,
    String? appVersionCurrent,
    String? appVersionTarget,
    String? installDir,
    String? stagingDir,
    String? backupDir,
    String? appExecutable,
    String? platform,
    String? checksumSha256,
    DateTime? timestamp,
  }) {
    return UpdateManifest(
      schemaVersion: schemaVersion ?? this.schemaVersion,
      appPid: appPid ?? this.appPid,
      appVersionCurrent: appVersionCurrent ?? this.appVersionCurrent,
      appVersionTarget: appVersionTarget ?? this.appVersionTarget,
      installDir: installDir ?? this.installDir,
      stagingDir: stagingDir ?? this.stagingDir,
      backupDir: backupDir ?? this.backupDir,
      appExecutable: appExecutable ?? this.appExecutable,
      platform: platform ?? this.platform,
      checksumSha256: checksumSha256 ?? this.checksumSha256,
      timestamp: timestamp ?? this.timestamp,
    );
  }

  @override
  String toString() => 'UpdateManifest('
      'v$schemaVersion, '
      '$appVersionCurrent -> $appVersionTarget, '
      'platform=$platform, '
      'pid=$appPid)';

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is UpdateManifest &&
          runtimeType == other.runtimeType &&
          schemaVersion == other.schemaVersion &&
          appPid == other.appPid &&
          appVersionCurrent == other.appVersionCurrent &&
          appVersionTarget == other.appVersionTarget &&
          installDir == other.installDir &&
          stagingDir == other.stagingDir &&
          backupDir == other.backupDir &&
          appExecutable == other.appExecutable &&
          platform == other.platform &&
          checksumSha256 == other.checksumSha256 &&
          timestamp == other.timestamp;

  @override
  int get hashCode => Object.hash(
        schemaVersion,
        appPid,
        appVersionCurrent,
        appVersionTarget,
        installDir,
        stagingDir,
        backupDir,
        appExecutable,
        platform,
        checksumSha256,
        timestamp,
      );
}
