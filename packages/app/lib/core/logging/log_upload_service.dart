import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart' show kIsWeb, kReleaseMode;
import 'package:http/http.dart' as http;

import '../config/environment.dart';
import '../diagnostics/scrubber.dart';
import 'log_dedup_buffer.dart';
import 'logger_service.dart';

/// Reads from [LoggerService.logStream], deduplicates, samples, rate-limits,
/// and uploads log entries to the diagnostics-cf worker.
///
/// Only active when diagnostics is enabled. Respects the same opt-in toggle
/// as [DiagnosticsService].
class LogUploadService {
  static const _tag = 'LogUploadService';

  /// Maximum entries per upload batch.
  static const int maxBatchSize = 500;

  /// Minimum interval between uploads.
  static const Duration uploadInterval = Duration(seconds: 30);

  /// Threshold (entries per minute) above which sampling kicks in.
  static const int highVolumeThreshold = 100;

  /// HTTP timeout for upload requests.
  static const Duration _httpTimeout = Duration(seconds: 10);

  final String _diagnosticsUrl;
  final http.Client _httpClient;
  final LoggerService _loggerService;
  final LogDedupBuffer _dedupBuffer;
  final Random _random;

  /// Stable session hash for upload payloads.
  late final String _sessionHash;

  StreamSubscription<LogEntry>? _logSubscription;
  Timer? _uploadTimer;
  bool _enabled = false;

  /// Rolling count of entries received in the current minute window.
  int _entriesThisMinute = 0;
  int _currentMinuteMs = 0;

  LogUploadService({
    required String diagnosticsUrl,
    http.Client? httpClient,
    LoggerService? loggerService,
    LogDedupBuffer? dedupBuffer,
    Random? random,
  })  : _diagnosticsUrl = diagnosticsUrl,
        _httpClient = httpClient ?? http.Client(),
        _loggerService = loggerService ?? LoggerService.instance,
        _dedupBuffer = dedupBuffer ?? LogDedupBuffer(),
        _random = random ?? Random() {
    _sessionHash = _generateSessionHash();
  }

  /// Whether the service is currently running.
  bool get isRunning => _enabled;

  /// Start listening to the log stream and uploading.
  void start() {
    if (_enabled) return;
    _enabled = true;

    _logSubscription = _loggerService.logStream.listen(_onLogEntry);
    _uploadTimer = Timer.periodic(uploadInterval, (_) => _uploadBatch());

    _loggerService.info(_tag, 'Log upload started');
  }

  /// Stop listening and uploading.
  void stop() {
    if (!_enabled) return;
    _enabled = false;

    _logSubscription?.cancel();
    _logSubscription = null;
    _uploadTimer?.cancel();
    _uploadTimer = null;

    _loggerService.info(_tag, 'Log upload stopped');
  }

  /// Dispose all resources.
  void dispose() {
    stop();
    _httpClient.close();
  }

  /// Handle an incoming log entry from the stream.
  void _onLogEntry(LogEntry entry) {
    if (!_enabled) return;

    // Update per-minute counter
    final nowMs = entry.timestamp.millisecondsSinceEpoch;
    final minuteMs = (nowMs ~/ 60000) * 60000;
    if (minuteMs != _currentMinuteMs) {
      _currentMinuteMs = minuteMs;
      _entriesThisMinute = 0;
    }
    _entriesThisMinute++;

    // Apply severity-based sampling when volume is high
    if (!_shouldInclude(entry)) return;

    // Scrub PII before buffering
    final scrubbedMessage =
        DiagnosticsScrubber.scrubErrorMessage(entry.message);

    final scrubbedEntry = LogEntry(
      timestamp: entry.timestamp,
      level: entry.level,
      tag: entry.tag,
      message: scrubbedMessage,
    );

    _dedupBuffer.add(scrubbedEntry);
  }

  /// Determine whether a log entry should be included based on
  /// severity-based sampling rules.
  bool _shouldInclude(LogEntry entry) {
    // Drop debug entirely in release builds
    if (kReleaseMode && entry.level == LogLevel.debug) {
      return false;
    }

    // If volume is below threshold, include everything (except debug in release)
    if (_entriesThisMinute <= highVolumeThreshold) {
      return true;
    }

    // High volume — apply severity-based sampling
    switch (entry.level) {
      case LogLevel.error:
        return true; // 100%
      case LogLevel.warning:
        return _random.nextDouble() < 0.5; // 50%
      case LogLevel.info:
        return _random.nextDouble() < 0.1; // 10%
      case LogLevel.debug:
        return false; // Drop entirely
    }
  }

  /// Upload a batch of deduplicated entries.
  Future<void> _uploadBatch() async {
    if (!_enabled) return;

    var entries = _dedupBuffer.drain();
    if (entries.isEmpty) return;

    // Apply rate cap: max 500 entries per batch
    if (entries.length > maxBatchSize) {
      entries = _applyRateCap(entries);
    }

    final body = {
      'sessionHash': _sessionHash,
      'appVersion': _appVersion,
      'platform': _platformName,
      'environment': Environment.env,
      'entries': entries.map((e) => e.toJson()).toList(),
    };

    try {
      final response = await _httpClient
          .post(
            Uri.parse('$_diagnosticsUrl/diagnostics/app-logs'),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode(body),
          )
          .timeout(_httpTimeout);

      if (response.statusCode == 200 || response.statusCode == 201) {
        _loggerService.debug(_tag, 'Uploaded ${entries.length} log entries');
      } else if (response.statusCode == 429) {
        _loggerService.debug(_tag, 'Log upload rate-limited');
      } else {
        _loggerService.warning(
            _tag, 'Log upload failed: ${response.statusCode}');
      }
    } catch (e) {
      // Upload failures are non-fatal — silently drop.
      _loggerService.debug(_tag, 'Log upload error: $e');
    }
  }

  /// Apply rate cap by dropping oldest non-error entries when over limit.
  List<DedupedLogEntry> _applyRateCap(List<DedupedLogEntry> entries) {
    // Partition into errors and non-errors
    final errors = <DedupedLogEntry>[];
    final nonErrors = <DedupedLogEntry>[];
    for (final entry in entries) {
      if (entry.severity == 'error') {
        errors.add(entry);
      } else {
        nonErrors.add(entry);
      }
    }

    // Keep all errors, fill remaining with newest non-errors
    final remaining = maxBatchSize - errors.length;
    if (remaining <= 0) {
      // Even errors alone exceed cap — take newest errors
      return errors.sublist(errors.length - maxBatchSize);
    }

    // Take newest non-errors (they're at the end of the list)
    final keptNonErrors = nonErrors.length <= remaining
        ? nonErrors
        : nonErrors.sublist(nonErrors.length - remaining);

    return [...errors, ...keptNonErrors];
  }

  String _generateSessionHash() {
    final seed = '$_platformName:$_appVersion:'
        '${DateTime.now().millisecondsSinceEpoch}';
    return sha256.convert(utf8.encode(seed)).toString();
  }

  String get _appVersion =>
      Environment.version.isNotEmpty ? Environment.version : '0.0.0-dev';

  String get _platformName {
    if (kIsWeb) return 'web';
    if (Platform.isAndroid) return 'android';
    if (Platform.isIOS) return 'ios';
    if (Platform.isMacOS) return 'macos';
    if (Platform.isLinux) return 'linux';
    if (Platform.isWindows) return 'windows';
    return 'unknown';
  }
}
