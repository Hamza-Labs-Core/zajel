# US-1.4: Error Categorization and Signature

## Story

As a Zajel app, I want errors automatically categorized and assigned a stable signature, so that duplicate errors are correctly grouped.

## Acceptance Criteria

- Every captured error is assigned one of the following categories: `crash`, `network`, `crypto`, `storage`, `ui`, `protocol`, `other`.
- Category assignment is deterministic: the same error type and context always produces the same category.
- The error signature is computed as `SHA-256(category + ":" + top3MeaningfulStackFrames)`.
- "Meaningful" stack frames are those from the app's own code (`packages/app/lib/`), not from Flutter framework internals, Dart SDK, or third-party packages.
- If fewer than 3 meaningful frames exist, all available meaningful frames are used. If zero meaningful frames exist, the signature falls back to `SHA-256(category + ":" + errorMessage)`.
- Two identical crashes (same error type, same code path) produce the same signature, even across different sessions and devices.
- The same error message from different code paths produces different signatures (because the stack frames differ).
- `FlutterError.onError` is hooked to capture Flutter framework errors.
- `PlatformDispatcher.instance.onError` is hooked to capture uncaught async errors.
- Captured errors are stored in-memory in a deduplicated list (keyed by signature), with `count`, `firstOccurrence`, and `lastOccurrence` fields incremented on duplicates.
- The error tracker does not capture errors when diagnostics is disabled (watches `diagnosticsEnabledProvider` from US-1.3).

## Technical Design

### Architecture

This story creates the `ErrorTracker` class in the Flutter diagnostics SDK. It hooks into Flutter's error boundary system, categorizes errors, computes stable signatures, and maintains an in-memory buffer of deduplicated `DiagnosticError` objects that the `DiagnosticsService` (batch upload) can drain periodically.

```
FlutterError.onError ------+
                            +--> ErrorTracker
PlatformDispatcher.onError -+      |
                                   +--> categorize(error)
                                   +--> computeSignature(category, stackTrace)
                                   +--> deduplication buffer (Map<signature, DiagnosticError>)
                                   |
                                   +--> DiagnosticsService drains buffer every 5 min
```

The `ErrorTracker` is designed as a standalone class (not a Riverpod provider itself) that is owned and lifecycle-managed by the `DiagnosticsService`. It does not make any HTTP requests -- it only collects and categorizes.

### Implementation Details

**Error categorization** uses a rule-based classifier that inspects the error type, message, and stack trace:

```dart
class ErrorCategorizer {
  static String categorize(Object error, StackTrace? stackTrace) {
    final errorType = error.runtimeType.toString();
    final message = error.toString().toLowerCase();
    final traceStr = stackTrace?.toString() ?? '';

    // Crash: unrecoverable errors
    if (error is FlutterError && error.diagnostics.any((d) =>
        d.toString().contains('RenderBox was not laid out'))) {
      return 'ui';
    }

    // Network errors
    if (errorType.contains('SocketException') ||
        errorType.contains('HttpException') ||
        errorType.contains('WebSocketException') ||
        message.contains('connection refused') ||
        message.contains('connection timed out') ||
        traceStr.contains('signaling_client.dart') ||
        traceStr.contains('webrtc_service.dart')) {
      return 'network';
    }

    // Crypto errors
    if (errorType.contains('CryptoException') ||
        errorType.contains('SecretBoxAuthenticationError') ||
        message.contains('decrypt') ||
        message.contains('encrypt') ||
        message.contains('key exchange') ||
        traceStr.contains('crypto_service.dart') ||
        traceStr.contains('crypto/')) {
      return 'crypto';
    }

    // Storage errors
    if (errorType.contains('DatabaseException') ||
        errorType.contains('FileSystemException') ||
        message.contains('shared_preferences') ||
        traceStr.contains('storage/') ||
        traceStr.contains('drift/')) {
      return 'storage';
    }

    // UI errors
    if (error is FlutterError ||
        message.contains('renderflex') ||
        message.contains('overflow') ||
        traceStr.contains('widgets/') ||
        traceStr.contains('rendering/')) {
      return 'ui';
    }

    // Protocol errors
    if (message.contains('protocol') ||
        message.contains('handshake') ||
        message.contains('pairing') ||
        traceStr.contains('protocol/')) {
      return 'protocol';
    }

    // Crash: anything that comes through PlatformDispatcher.onError
    // is considered a crash-level unhandled exception
    return 'other';
  }
}
```

**Signature computation** uses the `crypto` package (part of Dart SDK -- `dart:convert` + `package:crypto` or `dart:typed_data` with Web Crypto):

```dart
class ErrorSignature {
  static const _appPrefix = 'package:zajel/';

  static String compute(String category, StackTrace? stackTrace, String message) {
    final frames = _extractMeaningfulFrames(stackTrace);
    final input = frames.isNotEmpty
        ? '$category:${frames.join('\n')}'
        : '$category:$message';
    return sha256.convert(utf8.encode(input)).toString();
  }

  static List<String> _extractMeaningfulFrames(StackTrace? stackTrace) {
    if (stackTrace == null) return [];

    final lines = stackTrace.toString().split('\n');
    final meaningful = <String>[];

    for (final line in lines) {
      if (meaningful.length >= 3) break;

      // Normalize the frame: keep only file path and line number
      final normalized = _normalizeFrame(line);
      if (normalized != null && _isAppFrame(normalized)) {
        meaningful.add(normalized);
      }
    }

    return meaningful;
  }

  static String? _normalizeFrame(String line) {
    // Match patterns like "package:zajel/core/crypto/crypto_service.dart:142:5"
    final match = RegExp(r'(package:zajel/[^\s:]+:\d+)').firstMatch(line);
    if (match != null) return match.group(1);

    // Match patterns like "lib/core/crypto/crypto_service.dart:142:5"
    final libMatch = RegExp(r'(lib/[^\s:]+:\d+)').firstMatch(line);
    if (libMatch != null) return libMatch.group(1);

    return null;
  }

  static bool _isAppFrame(String frame) {
    return frame.startsWith('package:zajel/') || frame.startsWith('lib/');
  }
}
```

**Deduplication buffer** uses a `Map<String, DiagnosticError>` keyed by signature. When a new error matches an existing signature, `count` is incremented and `lastOccurrence` is updated. A `drain()` method returns the current map contents and clears the buffer.

**Error hook registration** happens in the `ErrorTracker.start()` method, which saves the previous `FlutterError.onError` handler and chains to it after recording the error. `PlatformDispatcher.instance.onError` is similarly chained. The `stop()` method restores the original handlers.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/app/lib/core/diagnostics/error_tracker.dart` | Create | ErrorTracker class with hook registration, categorization, signature computation, and deduplication buffer |
| `packages/app/lib/core/diagnostics/error_categorizer.dart` | Create | Static categorization rules |
| `packages/app/lib/core/diagnostics/error_signature.dart` | Create | SHA-256 signature computation with frame extraction |
| `packages/app/lib/core/diagnostics/diagnostics_models.dart` | Create | DiagnosticError, PerformanceMetrics, NetworkMetrics data classes |
| `packages/app/test/core/diagnostics/error_categorizer_test.dart` | Create | Unit tests for categorization |
| `packages/app/test/core/diagnostics/error_signature_test.dart` | Create | Unit tests for signature computation |
| `packages/app/test/core/diagnostics/error_tracker_test.dart` | Create | Unit tests for the tracker lifecycle and deduplication |

### Data Models / Schemas

**DiagnosticError (Dart data class):**

```dart
class DiagnosticError {
  final String category;
  final String message;
  final String? stackTrace;
  final String signature;
  int count;
  final int firstOccurrence;  // Unix ms
  int lastOccurrence;          // Unix ms

  DiagnosticError({
    required this.category,
    required this.message,
    this.stackTrace,
    required this.signature,
    this.count = 1,
    required this.firstOccurrence,
    required this.lastOccurrence,
  });

  Map<String, dynamic> toJson() => {
    'category': category,
    'message': message,
    'stackTrace': stackTrace,
    'signature': signature,
    'count': count,
    'firstOccurrence': firstOccurrence,
    'lastOccurrence': lastOccurrence,
  };
}
```

### API Endpoints

Not applicable -- this story is entirely client-side. The `DiagnosticError` objects are later serialized and sent as part of the `DiagnosticReport` in the `errors[]` array (US-1.1 schema).

## Dependencies

- **US-1.3** -- The `ErrorTracker` respects the diagnostics enabled setting. When disabled, error hooks are not registered.
- **Internal dependencies:**
  - `packages/app/lib/core/config/environment.dart` -- for version/build info in error reports
  - `dart:convert` -- for UTF-8 encoding
  - `package:crypto` -- for SHA-256 (already a transitive dependency via the `cryptography` package)
- **External dependencies:**
  - `package:crypto` (if not already direct) -- for `sha256` hash function

## Testing Strategy

- **Unit tests (`error_categorizer_test.dart`):**
  - `SocketException` is categorized as `network`.
  - `CryptoException` is categorized as `crypto`.
  - `FlutterError` with render-related message is categorized as `ui`.
  - `FileSystemException` is categorized as `storage`.
  - Error with stack trace containing `signaling_client.dart` is categorized as `network`.
  - Error with stack trace containing `crypto_service.dart` is categorized as `crypto`.
  - Unknown error type with no matching heuristics is categorized as `other`.
  - Categorization is deterministic: same input always produces same output.

- **Unit tests (`error_signature_test.dart`):**
  - Two identical stack traces produce the same signature.
  - Two different stack traces (different files/lines) produce different signatures.
  - Only app frames (`package:zajel/`) are included, not framework frames.
  - Stack trace with fewer than 3 app frames uses all available frames.
  - Stack trace with zero app frames falls back to message-based signature.
  - Signature is stable across different error message suffixes (only top 3 frames matter).
  - Frame normalization strips column numbers and extra context, keeping only `file:line`.

- **Unit tests (`error_tracker_test.dart`):**
  - `start()` registers `FlutterError.onError` handler.
  - `stop()` restores the previous `FlutterError.onError` handler.
  - Captured error appears in `drain()` output with correct category and signature.
  - Two identical errors (same signature) result in a single entry with `count == 2`.
  - `drain()` clears the buffer.
  - Errors captured after `stop()` are not tracked.
  - Buffer does not grow unbounded: maximum 100 unique signatures retained (oldest evicted).

## Technical Notes

**Codebase patterns to follow:**
- The `DiagnosticError` data class follows the same pattern as `LogEntry` in `logger_service.dart`: immutable fields with a `toJson()` serialization method.
- The error categorizer inspects `runtimeType` and message content, similar to how the existing `LoggerService` categorizes by `tag`.
- Stack trace parsing uses Dart's standard string representation. Flutter stack traces use the format `#0 ClassName.method (package:zajel/path/file.dart:line:col)`.

**External best practices applied:**
- The error signature approach (hash of category + top N stack frames) is the standard technique used by Sentry, Crashlytics, and Bugsnag for grouping duplicate errors. Using the top 3 frames (rather than the full trace) ensures that minor call-path variations (e.g., different async continuations) still group together.
- Only app-owned frames are included in the signature, following the Sentry "in-app frame" concept. This prevents framework version upgrades from changing signatures for the same app-level bug.
- The categorizer uses a hierarchy of rules: specific error types first, then message heuristics, then stack trace path heuristics, then fallback. This mirrors the priority-based classification used by Datadog's Flutter SDK.

**Gotchas:**
- `FlutterError.onError` can be called on any isolate, but the main isolate is where most UI errors occur. For compute isolates, errors are typically caught by the isolate's uncaught error handler rather than `FlutterError.onError`.
- In release builds, stack traces may be obfuscated if `--obfuscate` is used. The signature should still be stable (obfuscated symbols are deterministic per build). However, the `sample_stack_trace` stored in D1 will need symbolication for human readability -- this is a future concern.
- `PlatformDispatcher.instance.onError` returns a `bool`. Returning `true` means the error was handled; returning `false` lets it propagate. The ErrorTracker should return `false` (or chain to the previous handler's return value) to avoid swallowing errors that other systems (like Crashlytics) might also want to see.
- The buffer size limit (100 unique signatures) prevents memory issues in pathological error storms. When the limit is reached, the oldest entry (by `firstOccurrence`) is evicted.

## Estimation

**M (Medium)** -- The categorization rules are straightforward but require thorough testing across many error types. The signature computation requires careful stack frame parsing and normalization. The deduplication buffer is simple in structure but needs lifecycle management (start/stop/drain). The number of test cases is significant due to the many categorization paths.
