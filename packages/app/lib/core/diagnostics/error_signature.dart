/// Stable SHA-256 error signature computation for deduplication.
///
/// The signature is computed from the error category plus the top 3
/// "meaningful" (app-owned) stack frames. Two identical crashes produce
/// the same signature, even across sessions and devices.
library;

import 'dart:convert';

import 'package:crypto/crypto.dart';

/// Computes stable SHA-256 error signatures for deduplication grouping.
///
/// Signature = SHA-256(category + ":" + top3MeaningfulStackFrames)
///
/// "Meaningful" frames are those from the app's own code (package:zajel/),
/// not from Flutter framework internals, Dart SDK, or third-party packages.
///
/// If fewer than 3 meaningful frames exist, all available ones are used.
/// If zero meaningful frames exist, falls back to SHA-256(category + ":" + message).
class ErrorSignature {
  /// Prefix that identifies app-owned frames in stack traces.
  static const _appPackagePrefix = 'package:zajel/';

  /// Alternative prefix for app frames when run from source.
  static const _appLibPrefix = 'lib/';

  /// Maximum number of meaningful frames to include in the signature.
  static const _maxFrames = 3;

  ErrorSignature._();

  /// Compute a stable SHA-256 signature for the given error context.
  ///
  /// [category] is the error category (e.g., 'network', 'crypto').
  /// [stackTrace] is the stack trace from the error (may be null).
  /// [message] is the error message, used as fallback when no app frames exist.
  static String compute(
      String category, StackTrace? stackTrace, String message) {
    final frames = _extractMeaningfulFrames(stackTrace);
    final input = frames.isNotEmpty
        ? '$category:${frames.join('\n')}'
        : '$category:$message';
    return sha256.convert(utf8.encode(input)).toString();
  }

  /// Extract up to [_maxFrames] app-owned frames from a stack trace.
  ///
  /// Each frame is normalized to `file:line` format (stripping column numbers
  /// and surrounding context) to ensure stability across minor code changes
  /// that don't affect the call path.
  static List<String> _extractMeaningfulFrames(StackTrace? stackTrace) {
    if (stackTrace == null) return [];

    final lines = stackTrace.toString().split('\n');
    final meaningful = <String>[];

    for (final line in lines) {
      if (meaningful.length >= _maxFrames) break;

      final normalized = _normalizeFrame(line);
      if (normalized != null && _isAppFrame(normalized)) {
        meaningful.add(normalized);
      }
    }

    return meaningful;
  }

  /// Normalize a stack frame line to `package:zajel/path/file.dart:line` or
  /// `lib/path/file.dart:line` format.
  ///
  /// Strips column numbers and surrounding context (method names, etc.) to
  /// ensure that the signature is stable even when column positions shift
  /// due to minor edits.
  static String? _normalizeFrame(String line) {
    // Match patterns like "package:zajel/core/crypto/crypto_service.dart:142:5"
    // Captures up to and including the line number, but NOT the column.
    final match = RegExp(r'(package:zajel/[^\s:]+:\d+)').firstMatch(line);
    if (match != null) return match.group(1);

    // Match patterns like "lib/core/crypto/crypto_service.dart:142:5"
    final libMatch = RegExp(r'(lib/[^\s:]+:\d+)').firstMatch(line);
    if (libMatch != null) return libMatch.group(1);

    return null;
  }

  /// Returns true if the frame is from app-owned code.
  static bool _isAppFrame(String frame) {
    return frame.startsWith(_appPackagePrefix) ||
        frame.startsWith(_appLibPrefix);
  }
}
