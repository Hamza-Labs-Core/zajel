import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

/// Log level for filtering log messages.
enum LogLevel {
  debug,
  info,
  warning,
  error,
}

/// A file-based logging service for the app.
///
/// Features:
/// - Writes logs to a file in the app's documents directory
/// - Log rotation (keeps last 7 days of logs)
/// - Export functionality via share_plus
/// - Cross-platform support (desktop and mobile)
class LoggerService {
  static LoggerService? _instance;
  static LoggerService get instance => _instance ??= LoggerService._();

  LoggerService._();

  /// Minimum log level to record. Messages below this level are ignored.
  LogLevel minLevel = LogLevel.debug;

  /// Maximum number of log files to keep.
  static const int maxLogFiles = 7;

  /// Maximum size of a single log file in bytes (5 MB).
  static const int maxLogFileSize = 5 * 1024 * 1024;

  Directory? _logDirectory;
  File? _currentLogFile;
  IOSink? _logSink;
  bool _initialized = false;
  final _initCompleter = Completer<void>();

  /// Stream controller for real-time log monitoring.
  final _logController = StreamController<LogEntry>.broadcast();

  /// Stream of log entries for real-time monitoring.
  Stream<LogEntry> get logStream => _logController.stream;

  /// Initialize the logger service.
  ///
  /// Must be called before using the logger, typically in main().
  Future<void> initialize() async {
    if (_initialized) return;

    try {
      // Get the documents directory
      final appDir = await getApplicationDocumentsDirectory();
      _logDirectory = Directory('${appDir.path}/zajel_logs');

      // Create logs directory if it doesn't exist
      if (!await _logDirectory!.exists()) {
        await _logDirectory!.create(recursive: true);
      }

      // Open or create today's log file
      await _openLogFile();

      // Clean up old log files
      await _cleanupOldLogs();

      _initialized = true;
      _initCompleter.complete();

      info('LoggerService', 'Logger initialized at ${_logDirectory!.path}');
    } catch (e, stack) {
      // If initialization fails, complete with error but don't crash
      if (!_initCompleter.isCompleted) {
        _initCompleter.completeError(e);
      }
      debugPrint('Failed to initialize logger: $e\n$stack');
    }
  }

  /// Wait for initialization to complete.
  Future<void> get ready => _initCompleter.future;

  /// Log a debug message.
  void debug(String tag, String message) {
    _log(LogLevel.debug, tag, message);
  }

  /// Log an info message.
  void info(String tag, String message) {
    _log(LogLevel.info, tag, message);
  }

  /// Log a warning message.
  void warning(String tag, String message) {
    _log(LogLevel.warning, tag, message);
  }

  /// Log an error message with optional stack trace.
  void error(String tag, String message, [Object? error, StackTrace? stackTrace]) {
    var fullMessage = message;
    if (error != null) {
      fullMessage += '\nError: $error';
    }
    if (stackTrace != null) {
      fullMessage += '\nStackTrace:\n$stackTrace';
    }
    _log(LogLevel.error, tag, fullMessage);
  }

  /// Log a message with the given level.
  void _log(LogLevel level, String tag, String message) {
    if (level.index < minLevel.index) return;

    final entry = LogEntry(
      timestamp: DateTime.now(),
      level: level,
      tag: tag,
      message: message,
    );

    // Always print to debug console
    if (kDebugMode) {
      debugPrint(entry.formatted);
    }

    // Emit to stream for real-time monitoring
    _logController.add(entry);

    // Write to file asynchronously (fire and forget)
    if (_initialized && _logSink != null) {
      _writeToFile(entry);
    }
  }

  void _writeToFile(LogEntry entry) {
    try {
      _logSink?.writeln(entry.formatted);

      // Check if we need to rotate (async, don't block logging)
      _checkRotation();
    } catch (e) {
      debugPrint('Failed to write log: $e');
    }
  }

  Future<void> _openLogFile() async {
    final fileName = _getLogFileName(DateTime.now());
    _currentLogFile = File('${_logDirectory!.path}/$fileName');
    _logSink = _currentLogFile!.openWrite(mode: FileMode.append);
  }

  String _getLogFileName(DateTime date) {
    final dateStr = '${date.year}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}';
    return 'zajel_$dateStr.log';
  }

  Future<void> _checkRotation() async {
    if (_currentLogFile == null) return;

    try {
      final stat = await _currentLogFile!.stat();

      // Check if file is too large
      if (stat.size > maxLogFileSize) {
        await _rotateLogs();
      }

      // Check if date has changed
      final currentFileName = _getLogFileName(DateTime.now());
      if (!_currentLogFile!.path.endsWith(currentFileName)) {
        await _logSink?.flush();
        await _logSink?.close();
        await _openLogFile();
        await _cleanupOldLogs();
      }
    } catch (e) {
      // Ignore errors during rotation check
    }
  }

  Future<void> _rotateLogs() async {
    await _logSink?.flush();
    await _logSink?.close();

    // Rename current file with timestamp
    final timestamp = DateTime.now().millisecondsSinceEpoch;
    final newName = _currentLogFile!.path.replaceAll('.log', '_$timestamp.log');
    await _currentLogFile!.rename(newName);

    // Open new file
    await _openLogFile();
  }

  Future<void> _cleanupOldLogs() async {
    if (_logDirectory == null) return;

    try {
      final files = await _logDirectory!
          .list()
          .where((entity) => entity is File && entity.path.endsWith('.log'))
          .cast<File>()
          .toList();

      // Sort by modification time (newest first)
      files.sort((a, b) => b.path.compareTo(a.path));

      // Delete files beyond the limit
      if (files.length > maxLogFiles) {
        for (var i = maxLogFiles; i < files.length; i++) {
          await files[i].delete();
        }
      }
    } catch (e) {
      debugPrint('Failed to cleanup old logs: $e');
    }
  }

  /// Get the path to the logs directory.
  String? get logDirectoryPath => _logDirectory?.path;

  /// Get all log files.
  Future<List<File>> getLogFiles() async {
    if (_logDirectory == null || !await _logDirectory!.exists()) {
      return [];
    }

    final files = await _logDirectory!
        .list()
        .where((entity) => entity is File && entity.path.endsWith('.log'))
        .cast<File>()
        .toList();

    // Sort by name (newest first)
    files.sort((a, b) => b.path.compareTo(a.path));

    return files;
  }

  /// Get the current log file content.
  Future<String> getCurrentLogContent() async {
    if (_currentLogFile == null) return '';

    await _logSink?.flush();

    try {
      return await _currentLogFile!.readAsString();
    } catch (e) {
      return 'Failed to read log file: $e';
    }
  }

  /// Get all log content combined.
  Future<String> getAllLogContent() async {
    final files = await getLogFiles();
    final buffer = StringBuffer();

    for (final file in files) {
      try {
        buffer.writeln('=== ${file.path.split('/').last} ===');
        buffer.writeln(await file.readAsString());
        buffer.writeln();
      } catch (e) {
        buffer.writeln('Failed to read ${file.path}: $e');
      }
    }

    return buffer.toString();
  }

  /// Export logs using the system share sheet.
  ///
  /// On mobile, this opens the share sheet.
  /// On desktop, this may open a file dialog or share functionality.
  Future<void> exportLogs() async {
    await _logSink?.flush();

    final files = await getLogFiles();
    if (files.isEmpty) {
      throw LoggerException('No log files to export');
    }

    // Convert to XFile for sharing
    final xFiles = files.map((f) => XFile(f.path)).toList();

    await Share.shareXFiles(
      xFiles,
      subject: 'Zajel Logs',
      text: 'Zajel application logs',
    );

    info('LoggerService', 'Exported ${files.length} log files');
  }

  /// Export logs to a specific directory (for desktop).
  Future<String> exportLogsToDirectory(String directoryPath) async {
    await _logSink?.flush();

    final files = await getLogFiles();
    if (files.isEmpty) {
      throw LoggerException('No log files to export');
    }

    final exportDir = Directory(directoryPath);
    if (!await exportDir.exists()) {
      await exportDir.create(recursive: true);
    }

    final timestamp = DateTime.now().millisecondsSinceEpoch;
    final exportPath = '${exportDir.path}/zajel_logs_$timestamp';
    final exportZipDir = Directory(exportPath);
    await exportZipDir.create();

    // Copy all log files
    for (final file in files) {
      final fileName = file.path.split(Platform.pathSeparator).last;
      await file.copy('$exportPath/$fileName');
    }

    info('LoggerService', 'Exported ${files.length} log files to $exportPath');
    return exportPath;
  }

  /// Clear all logs.
  Future<void> clearLogs() async {
    await _logSink?.flush();
    await _logSink?.close();

    final files = await getLogFiles();
    for (final file in files) {
      try {
        await file.delete();
      } catch (e) {
        debugPrint('Failed to delete log file: $e');
      }
    }

    // Reopen log file
    await _openLogFile();
    info('LoggerService', 'All logs cleared');
  }

  /// Dispose the logger service.
  Future<void> dispose() async {
    await _logSink?.flush();
    await _logSink?.close();
    await _logController.close();
    _logSink = null;
    _currentLogFile = null;
    _initialized = false;
  }
}

/// Represents a single log entry.
class LogEntry {
  final DateTime timestamp;
  final LogLevel level;
  final String tag;
  final String message;

  const LogEntry({
    required this.timestamp,
    required this.level,
    required this.tag,
    required this.message,
  });

  /// Format the log entry as a string.
  String get formatted {
    final time = '${timestamp.hour.toString().padLeft(2, '0')}:'
        '${timestamp.minute.toString().padLeft(2, '0')}:'
        '${timestamp.second.toString().padLeft(2, '0')}.'
        '${timestamp.millisecond.toString().padLeft(3, '0')}';
    final levelStr = level.name.toUpperCase().padRight(7);
    return '$time [$levelStr] [$tag] $message';
  }

  @override
  String toString() => formatted;
}

/// Exception thrown by the logger service.
class LoggerException implements Exception {
  final String message;

  const LoggerException(this.message);

  @override
  String toString() => 'LoggerException: $message';
}

/// Convenience global logger instance.
LoggerService get logger => LoggerService.instance;
