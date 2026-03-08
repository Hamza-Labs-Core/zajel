import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:http/http.dart' as http;

import '../config/environment.dart';
import '../logging/logger_service.dart';
import 'diagnostics_models.dart';
import 'error_tracker.dart';
import 'scrubber.dart';

/// Orchestrates diagnostics collection and upload.
///
/// Owns the [ErrorTracker] lifecycle, generates a stable session hash,
/// periodically drains buffered errors, scrubs PII, and POSTs reports
/// and heartbeats to the diagnostics-cf worker.
///
/// The service respects the user's opt-in preference via [isEnabled].
/// When disabled, the error tracker is stopped and no HTTP requests are made.
class DiagnosticsService {
  static const _tag = 'DiagnosticsService';

  /// Interval between report uploads (drain errors and POST).
  static const Duration reportInterval = Duration(minutes: 10);

  /// Interval between heartbeats.
  static const Duration heartbeatInterval = Duration(minutes: 5);

  /// HTTP timeout for diagnostics requests.
  static const Duration _httpTimeout = Duration(seconds: 10);

  final ErrorTracker _errorTracker;
  final String _diagnosticsUrl;
  final http.Client _httpClient;
  final _logger = LoggerService.instance;

  /// Stable session hash (SHA-256 of platform + app version + session start).
  late final String _sessionHash;

  /// Timer for periodic report uploads.
  Timer? _reportTimer;

  /// Timer for periodic heartbeats.
  Timer? _heartbeatTimer;

  /// Whether the service is currently enabled.
  bool _enabled = false;

  /// Callback to get the current connection type.
  String Function()? getConnectionType;

  /// Callback to get network metrics.
  Map<String, dynamic> Function()? getNetworkMetrics;

  DiagnosticsService({
    required ErrorTracker errorTracker,
    required String diagnosticsUrl,
    http.Client? httpClient,
  })  : _errorTracker = errorTracker,
        _diagnosticsUrl = diagnosticsUrl,
        _httpClient = httpClient ?? http.Client() {
    _sessionHash = _generateSessionHash();
  }

  /// Whether the service is currently running.
  bool get isRunning => _enabled;

  /// The error tracker managed by this service.
  ErrorTracker get errorTracker => _errorTracker;

  /// Start collecting and uploading diagnostics.
  void start() {
    if (_enabled) return;
    _enabled = true;

    _errorTracker.start();
    _reportTimer = Timer.periodic(reportInterval, (_) => _uploadReport());
    _heartbeatTimer =
        Timer.periodic(heartbeatInterval, (_) => _sendHeartbeat());

    // Send initial heartbeat after a short delay
    Future.delayed(const Duration(seconds: 5), _sendHeartbeat);

    _logger.info(_tag, 'Started (url: $_diagnosticsUrl)');
  }

  /// Stop collecting and uploading diagnostics.
  void stop() {
    if (!_enabled) return;
    _enabled = false;

    _errorTracker.stop();
    _reportTimer?.cancel();
    _reportTimer = null;
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;

    _logger.info(_tag, 'Stopped');
  }

  /// Dispose all resources.
  void dispose() {
    stop();
    _httpClient.close();
  }

  // ---------------------------------------------------------------------------
  // Report upload
  // ---------------------------------------------------------------------------

  /// Drain buffered errors and upload a diagnostic report.
  Future<void> _uploadReport() async {
    if (!_enabled) return;

    final errors = _errorTracker.drain();
    if (errors.isEmpty) return;

    final scrubbedErrors = errors.map(_scrubError).toList();

    final report = {
      'sessionHash': _sessionHash,
      'appVersion': _appVersion,
      'buildNumber':
          Environment.buildNumber.isNotEmpty ? Environment.buildNumber : '0',
      'platform': _platformName,
      'platformVersion': _platformVersion,
      'locale': Platform.localeName,
      'timestamp': DateTime.now().millisecondsSinceEpoch,
      'errors': scrubbedErrors.map((e) => e.toJson()).toList(),
      if (getConnectionType != null) 'connectionType': getConnectionType!(),
      if (getNetworkMetrics != null) 'network': getNetworkMetrics!(),
    };

    try {
      final response = await _httpClient
          .post(
            Uri.parse('$_diagnosticsUrl/diagnostics/report'),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode(report),
          )
          .timeout(_httpTimeout);

      if (response.statusCode == 200 || response.statusCode == 201) {
        _logger.debug(_tag, 'Report uploaded: ${scrubbedErrors.length} errors');
      } else if (response.statusCode == 429) {
        _logger.debug(_tag, 'Report rate-limited, will retry next cycle');
      } else {
        _logger.warning(_tag, 'Report upload failed: ${response.statusCode}');
      }
    } catch (e) {
      // Diagnostics upload failures are non-fatal — silently drop.
      _logger.debug(_tag, 'Report upload error: $e');
    }
  }

  // ---------------------------------------------------------------------------
  // Heartbeat
  // ---------------------------------------------------------------------------

  /// Send a lightweight heartbeat to the diagnostics server.
  Future<void> _sendHeartbeat() async {
    if (!_enabled) return;

    final body = {
      'sessionHash': _sessionHash,
      'platform': _platformName,
      'appVersion': _appVersion,
      if (getConnectionType != null) 'connectionType': getConnectionType!(),
    };

    try {
      final response = await _httpClient
          .post(
            Uri.parse('$_diagnosticsUrl/diagnostics/heartbeat'),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode(body),
          )
          .timeout(_httpTimeout);

      if (response.statusCode == 200 || response.statusCode == 201) {
        _logger.debug(_tag, 'Heartbeat sent');
      } else if (response.statusCode == 429) {
        _logger.debug(_tag, 'Heartbeat rate-limited');
      } else {
        _logger.warning(_tag, 'Heartbeat failed: ${response.statusCode}');
      }
    } catch (e) {
      _logger.debug(_tag, 'Heartbeat error: $e');
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /// Scrub PII from a diagnostic error before upload.
  DiagnosticError _scrubError(DiagnosticError error) {
    return DiagnosticError(
      category: error.category,
      message: DiagnosticsScrubber.scrubErrorMessage(error.message),
      stackTrace: error.stackTrace != null
          ? DiagnosticsScrubber.scrubStackTrace(error.stackTrace!)
          : null,
      signature: error.signature,
      count: error.count,
      firstOccurrence: error.firstOccurrence,
      lastOccurrence: error.lastOccurrence,
    );
  }

  /// Generate a stable session hash from platform + version + session start.
  /// Returns a full 64-char lowercase hex SHA-256 string as required by the
  /// diagnostics-cf validation (SESSION_HASH_REGEX: /^[0-9a-f]{64}$/).
  String _generateSessionHash() {
    final seed = '$_platformName:$_appVersion:'
        '${DateTime.now().millisecondsSinceEpoch}';
    return sha256.convert(utf8.encode(seed)).toString();
  }

  /// App version in semver format (required by diagnostics-cf).
  /// Falls back to '0.0.0-dev' when no version is configured.
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

  String get _platformVersion {
    if (kIsWeb) return 'web';
    return Platform.operatingSystemVersion;
  }
}
