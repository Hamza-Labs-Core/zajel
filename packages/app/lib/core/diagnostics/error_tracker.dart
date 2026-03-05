/// Error tracking with categorization, signature computation, and deduplication.
///
/// The [ErrorTracker] hooks into Flutter's error boundary system to
/// automatically capture, categorize, and deduplicate errors. It is
/// designed as a standalone class owned by the DiagnosticsService.
library;

import 'dart:ui';

import 'package:flutter/foundation.dart';

import 'diagnostics_models.dart';
import 'error_categorizer.dart';
import 'error_signature.dart';

/// Callback type for checking whether diagnostics collection is enabled.
///
/// When this returns false, errors are not captured.
typedef DiagnosticsEnabledChecker = bool Function();

/// Captures Flutter and platform errors, categorizes them, and stores
/// deduplicated [DiagnosticError] entries in an in-memory buffer.
///
/// Usage:
/// ```dart
/// final tracker = ErrorTracker(isEnabled: () => true);
/// tracker.start();
/// // ... errors are automatically captured ...
/// final errors = tracker.drain(); // get and clear buffered errors
/// tracker.stop();
/// ```
///
/// The tracker does not make any HTTP requests -- it only collects.
/// The [DiagnosticsService] is responsible for draining and uploading.
class ErrorTracker {
  /// Maximum number of unique error signatures retained in the buffer.
  ///
  /// When this limit is reached, the oldest entry (by firstOccurrence)
  /// is evicted to make room for new errors.
  static const int maxBufferSize = 100;

  /// Callback to check if diagnostics collection is enabled.
  final DiagnosticsEnabledChecker _isEnabled;

  /// In-memory deduplication buffer, keyed by error signature.
  final Map<String, DiagnosticError> _buffer = {};

  /// The previous FlutterError.onError handler, restored on stop().
  FlutterExceptionHandler? _previousFlutterErrorHandler;

  /// The previous PlatformDispatcher.onError handler, restored on stop().
  ErrorCallback? _previousPlatformErrorHandler;

  /// Whether the tracker is currently active (hooks registered).
  bool _running = false;

  /// Whether the tracker is currently active.
  bool get isRunning => _running;

  /// Number of unique errors currently in the buffer.
  int get bufferSize => _buffer.length;

  /// Creates an [ErrorTracker].
  ///
  /// [isEnabled] is called before each error capture to determine whether
  /// diagnostics collection is active. If null or not provided, errors are
  /// always captured.
  ErrorTracker({DiagnosticsEnabledChecker? isEnabled})
      : _isEnabled = isEnabled ?? (() => true);

  /// Register error hooks and start capturing errors.
  ///
  /// Saves the previous handlers and chains to them after recording.
  /// Calling start() when already running is a no-op.
  void start() {
    if (_running) return;
    _running = true;

    // Hook FlutterError.onError
    _previousFlutterErrorHandler = FlutterError.onError;
    FlutterError.onError = _handleFlutterError;

    // Hook PlatformDispatcher.instance.onError
    _previousPlatformErrorHandler = PlatformDispatcher.instance.onError;
    PlatformDispatcher.instance.onError = _handlePlatformError;
  }

  /// Unregister error hooks and stop capturing errors.
  ///
  /// Restores the previous handlers. Calling stop() when not running is a no-op.
  void stop() {
    if (!_running) return;
    _running = false;

    // Restore previous handlers
    FlutterError.onError = _previousFlutterErrorHandler;
    PlatformDispatcher.instance.onError = _previousPlatformErrorHandler;

    _previousFlutterErrorHandler = null;
    _previousPlatformErrorHandler = null;
  }

  /// Drain the buffer: returns all currently buffered errors and clears
  /// the internal buffer.
  ///
  /// This is called by the DiagnosticsService during periodic uploads.
  List<DiagnosticError> drain() {
    final errors = _buffer.values.toList();
    _buffer.clear();
    return errors;
  }

  /// Record an error manually (for testing or programmatic use).
  ///
  /// Normally errors are captured automatically via the Flutter/platform
  /// hooks, but this method allows direct recording.
  /// Errors are only recorded when the tracker is running AND diagnostics
  /// is enabled.
  void recordError(Object error, StackTrace? stackTrace) {
    if (!_running || !_isEnabled()) return;
    _captureError(error, stackTrace);
  }

  /// Handle a FlutterError (from FlutterError.onError).
  void _handleFlutterError(FlutterErrorDetails details) {
    if (_isEnabled()) {
      _captureError(details.exception, details.stack);
    }

    // Chain to previous handler (don't swallow errors)
    _previousFlutterErrorHandler?.call(details);
  }

  /// Handle a platform error (from PlatformDispatcher.instance.onError).
  ///
  /// Returns false to indicate the error was not fully handled,
  /// allowing it to propagate to other handlers (e.g. Crashlytics).
  bool _handlePlatformError(Object error, StackTrace stackTrace) {
    if (_isEnabled()) {
      _captureError(error, stackTrace);
    }

    // Chain to previous handler, or return false if none
    final previous = _previousPlatformErrorHandler;
    if (previous != null) {
      return previous(error, stackTrace);
    }
    return false;
  }

  /// Core capture logic: categorize, compute signature, and deduplicate.
  void _captureError(Object error, StackTrace? stackTrace) {
    final category = ErrorCategorizer.categorize(error, stackTrace);
    final message = _truncateMessage(error.toString());
    final signature = ErrorSignature.compute(category, stackTrace, message);
    final now = DateTime.now().millisecondsSinceEpoch;

    final existing = _buffer[signature];
    if (existing != null) {
      // Deduplicate: increment count and update lastOccurrence
      existing.count++;
      existing.lastOccurrence = now;
    } else {
      // Evict oldest if buffer is full
      if (_buffer.length >= maxBufferSize) {
        _evictOldest();
      }

      _buffer[signature] = DiagnosticError(
        category: category,
        message: message,
        stackTrace: stackTrace?.toString(),
        signature: signature,
        count: 1,
        firstOccurrence: now,
        lastOccurrence: now,
      );
    }
  }

  /// Evict the oldest entry (by firstOccurrence) from the buffer.
  void _evictOldest() {
    if (_buffer.isEmpty) return;

    String? oldestKey;
    int oldestTime = 0x7FFFFFFFFFFFFFFF; // max int

    for (final entry in _buffer.entries) {
      if (entry.value.firstOccurrence < oldestTime) {
        oldestTime = entry.value.firstOccurrence;
        oldestKey = entry.key;
      }
    }

    if (oldestKey != null) {
      _buffer.remove(oldestKey);
    }
  }

  /// Truncate an error message to a reasonable length.
  static String _truncateMessage(String message) {
    const maxLength = 1024;
    if (message.length <= maxLength) return message;
    return '${message.substring(0, maxLength)}...';
  }
}
