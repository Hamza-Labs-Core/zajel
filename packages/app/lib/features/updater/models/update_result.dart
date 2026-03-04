import 'dart:convert';
import 'dart:io';

import '../../../core/logging/logger_service.dart';

/// Result of an update operation, written by the Go updater and read by
/// the Dart app on subsequent startup.
///
/// The file is stored alongside the updater binary in the platform-specific
/// application data directory (see [UpdaterLauncher.getUpdaterDir]).
///
/// Status values:
/// - `pending_verification`: Update applied, awaiting app launch confirmation.
/// - `verified`: App launched successfully after update.
/// - `rolled_back`: Rollback completed (by updater or by app-triggered rollback).
/// - `rollback_failed`: Rollback attempted but failed (manual intervention needed).
/// - `failed`: Update failed.
/// - `interrupted_recovery`: Recovered from lock file (power loss).
/// - `acknowledged`: User has been shown the rollback notification.
class UpdateResult {
  /// Schema version for forward compatibility.
  final int schemaVersion;

  /// Status of the update result.
  final String status;

  /// Exit code from the updater process.
  final int exitCode;

  /// The version that was installed before the update.
  final String previousVersion;

  /// The version the update was targeting.
  final String targetVersion;

  /// When the result was written.
  final DateTime timestamp;

  /// Human-readable error message, if any.
  final String? errorMessage;

  /// Path to the backup directory (for rollback).
  final String? backupDir;

  /// Path to the install directory.
  final String? installDir;

  /// Version of the updater binary that wrote this result.
  final String? updaterVersion;

  const UpdateResult({
    this.schemaVersion = 1,
    required this.status,
    required this.exitCode,
    required this.previousVersion,
    required this.targetVersion,
    required this.timestamp,
    this.errorMessage,
    this.backupDir,
    this.installDir,
    this.updaterVersion,
  });

  /// Parses an [UpdateResult] from a JSON map.
  ///
  /// Throws [FormatException] if required fields are missing or invalid.
  factory UpdateResult.fromJson(Map<String, dynamic> json) {
    final status = json['status'];
    if (status is! String || status.isEmpty) {
      throw const FormatException(
        'Missing or invalid "status" field in update result',
      );
    }

    final exitCode = json['exit_code'];
    if (exitCode is! int) {
      throw const FormatException(
        'Missing or invalid "exit_code" field in update result',
      );
    }

    final previousVersion = json['previous_version'];
    if (previousVersion is! String || previousVersion.isEmpty) {
      throw const FormatException(
        'Missing or invalid "previous_version" field in update result',
      );
    }

    final targetVersion = json['target_version'];
    if (targetVersion is! String || targetVersion.isEmpty) {
      throw const FormatException(
        'Missing or invalid "target_version" field in update result',
      );
    }

    final timestampStr = json['timestamp'];
    if (timestampStr is! String || timestampStr.isEmpty) {
      throw const FormatException(
        'Missing or invalid "timestamp" field in update result',
      );
    }
    final timestamp = DateTime.tryParse(timestampStr);
    if (timestamp == null) {
      throw FormatException(
        'Cannot parse "timestamp" value "$timestampStr" as DateTime',
      );
    }

    return UpdateResult(
      schemaVersion: (json['schema_version'] as int?) ?? 1,
      status: status,
      exitCode: exitCode,
      previousVersion: previousVersion,
      targetVersion: targetVersion,
      timestamp: timestamp,
      errorMessage: json['error_message'] as String?,
      backupDir: json['backup_dir'] as String?,
      installDir: json['install_dir'] as String?,
      updaterVersion: json['updater_version'] as String?,
    );
  }

  /// Reads an [UpdateResult] from a JSON file on disk.
  ///
  /// Returns `null` if the file does not exist or contains invalid JSON.
  static UpdateResult? fromFile(String path) {
    final file = File(path);
    if (!file.existsSync()) return null;

    try {
      final content = file.readAsStringSync();
      final json = jsonDecode(content) as Map<String, dynamic>;
      return UpdateResult.fromJson(json);
    } on FormatException catch (e) {
      logger.warning(
        'UpdateResult',
        'Failed to parse update result from $path: $e',
      );
      return null;
    } on FileSystemException catch (e) {
      logger.warning(
        'UpdateResult',
        'Failed to read update result file at $path: $e',
      );
      return null;
    }
  }

  /// Serializes this result to a JSON map.
  Map<String, dynamic> toJson() => {
        'schema_version': schemaVersion,
        'status': status,
        'exit_code': exitCode,
        'previous_version': previousVersion,
        'target_version': targetVersion,
        'timestamp': timestamp.toUtc().toIso8601String(),
        if (errorMessage != null) 'error_message': errorMessage,
        if (backupDir != null) 'backup_dir': backupDir,
        if (installDir != null) 'install_dir': installDir,
        if (updaterVersion != null) 'updater_version': updaterVersion,
      };

  /// Writes this result as formatted JSON to a file on disk.
  ///
  /// Creates parent directories if they do not exist.
  void writeToFile(String path) {
    final file = File(path);
    file.parent.createSync(recursive: true);
    final encoder = const JsonEncoder.withIndent('  ');
    file.writeAsStringSync(encoder.convert(toJson()));
  }

  /// Creates a copy with the specified fields replaced.
  UpdateResult copyWith({
    int? schemaVersion,
    String? status,
    int? exitCode,
    String? previousVersion,
    String? targetVersion,
    DateTime? timestamp,
    String? Function()? errorMessage,
    String? Function()? backupDir,
    String? Function()? installDir,
    String? Function()? updaterVersion,
  }) {
    return UpdateResult(
      schemaVersion: schemaVersion ?? this.schemaVersion,
      status: status ?? this.status,
      exitCode: exitCode ?? this.exitCode,
      previousVersion: previousVersion ?? this.previousVersion,
      targetVersion: targetVersion ?? this.targetVersion,
      timestamp: timestamp ?? this.timestamp,
      errorMessage: errorMessage != null ? errorMessage() : this.errorMessage,
      backupDir: backupDir != null ? backupDir() : this.backupDir,
      installDir: installDir != null ? installDir() : this.installDir,
      updaterVersion:
          updaterVersion != null ? updaterVersion() : this.updaterVersion,
    );
  }

  @override
  String toString() => 'UpdateResult('
      'status=$status, '
      'exitCode=$exitCode, '
      '$previousVersion -> $targetVersion)';

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is UpdateResult &&
          runtimeType == other.runtimeType &&
          schemaVersion == other.schemaVersion &&
          status == other.status &&
          exitCode == other.exitCode &&
          previousVersion == other.previousVersion &&
          targetVersion == other.targetVersion &&
          timestamp == other.timestamp &&
          errorMessage == other.errorMessage;

  @override
  int get hashCode => Object.hash(
        schemaVersion,
        status,
        exitCode,
        previousVersion,
        targetVersion,
        timestamp,
        errorMessage,
      );
}
