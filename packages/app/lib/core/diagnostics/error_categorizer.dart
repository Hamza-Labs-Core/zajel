/// Rule-based error categorizer for the diagnostics SDK.
///
/// Inspects error type, message content, and stack trace heuristics to assign
/// one of: crash, network, crypto, storage, ui, protocol, other.
library;

import 'package:flutter/foundation.dart';

/// Valid error categories.
///
/// These match the DiagnosticReport schema (US-1.1).
class ErrorCategory {
  static const String crash = 'crash';
  static const String network = 'network';
  static const String crypto = 'crypto';
  static const String storage = 'storage';
  static const String ui = 'ui';
  static const String protocol = 'protocol';
  static const String other = 'other';

  /// All valid categories, in priority order.
  static const List<String> all = [
    crash,
    network,
    crypto,
    storage,
    ui,
    protocol,
    other,
  ];

  ErrorCategory._();
}

/// Categorizes an error based on its type, message, and stack trace.
///
/// The categorizer uses a priority-based rule hierarchy:
/// 1. Specific error types (SocketException, FlutterError, etc.)
/// 2. Message content heuristics
/// 3. Stack trace path heuristics
/// 4. Fallback to 'other'
///
/// Categorization is deterministic: the same error type, message, and stack
/// trace always produce the same category.
class ErrorCategorizer {
  ErrorCategorizer._();

  /// Categorize an error and return one of [ErrorCategory] values.
  static String categorize(Object error, StackTrace? stackTrace) {
    final errorType = error.runtimeType.toString();
    final message = error.toString().toLowerCase();
    final traceStr = stackTrace?.toString() ?? '';

    // UI: FlutterError with render-related diagnostics
    if (error is FlutterError &&
        error.diagnostics.any((d) =>
            d.toString().contains('RenderBox was not laid out') ||
            d.toString().contains('RenderFlex') ||
            d.toString().contains('overflow'))) {
      return ErrorCategory.ui;
    }

    // Network errors — by type
    if (errorType.contains('SocketException') ||
        errorType.contains('HttpException') ||
        errorType.contains('WebSocketException') ||
        errorType.contains('WebSocketChannelException') ||
        errorType.contains('TimeoutException')) {
      return ErrorCategory.network;
    }

    // Network errors — by message
    if (message.contains('connection refused') ||
        message.contains('connection timed out') ||
        message.contains('connection reset') ||
        message.contains('network is unreachable') ||
        message.contains('host not found')) {
      return ErrorCategory.network;
    }

    // Network errors — by stack trace
    if (traceStr.contains('signaling_client.dart') ||
        traceStr.contains('webrtc_service.dart') ||
        traceStr.contains('relay_client.dart') ||
        traceStr.contains('meeting_point_service.dart')) {
      return ErrorCategory.network;
    }

    // Crypto errors — by type
    if (errorType.contains('CryptoException') ||
        errorType.contains('SecretBoxAuthenticationError')) {
      return ErrorCategory.crypto;
    }

    // Crypto errors — by message
    if (message.contains('decrypt') ||
        message.contains('encrypt') ||
        message.contains('key exchange') ||
        message.contains('signature verification') ||
        message.contains('invalid key')) {
      return ErrorCategory.crypto;
    }

    // Crypto errors — by stack trace
    if (traceStr.contains('crypto_service.dart') ||
        traceStr.contains('crypto/') ||
        traceStr.contains('channel_crypto_service.dart') ||
        traceStr.contains('group_crypto_service.dart')) {
      return ErrorCategory.crypto;
    }

    // Storage errors — by type
    if (errorType.contains('DatabaseException') ||
        errorType.contains('FileSystemException') ||
        errorType.contains('SqliteException')) {
      return ErrorCategory.storage;
    }

    // Storage errors — by message
    if (message.contains('shared_preferences') ||
        message.contains('database is locked') ||
        message.contains('no such table')) {
      return ErrorCategory.storage;
    }

    // Storage errors — by stack trace
    if (traceStr.contains('storage/') ||
        traceStr.contains('drift/') ||
        traceStr.contains('sqflite')) {
      return ErrorCategory.storage;
    }

    // UI errors — FlutterError is generic UI
    if (error is FlutterError) {
      return ErrorCategory.ui;
    }

    // UI errors — by message
    if (message.contains('renderflex') ||
        message.contains('renderbox') ||
        message.contains('overflow') ||
        message.contains('setState() called after dispose')) {
      return ErrorCategory.ui;
    }

    // UI errors — by stack trace
    if (traceStr.contains('widgets/') || traceStr.contains('rendering/')) {
      return ErrorCategory.ui;
    }

    // Protocol errors — by message
    if (message.contains('protocol') ||
        message.contains('handshake') ||
        message.contains('pairing') ||
        message.contains('invalid message format')) {
      return ErrorCategory.protocol;
    }

    // Protocol errors — by stack trace
    if (traceStr.contains('protocol/')) {
      return ErrorCategory.protocol;
    }

    return ErrorCategory.other;
  }
}
