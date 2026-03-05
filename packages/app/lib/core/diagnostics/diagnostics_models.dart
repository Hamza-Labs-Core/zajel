/// Data models for the diagnostics SDK.
///
/// These models are used by the [ErrorTracker] and eventually serialized
/// into the `DiagnosticReport.errors[]` array for upload.
library;

/// Represents a categorized, deduplicated error captured by [ErrorTracker].
///
/// Each unique error (identified by [signature]) is stored once. When the
/// same error recurs, [count] is incremented and [lastOccurrence] is updated.
class DiagnosticError {
  /// Error category: crash, network, crypto, storage, ui, protocol, or other.
  final String category;

  /// Human-readable error message (truncated to 1024 chars).
  final String message;

  /// Sample stack trace from the first occurrence (may be null).
  final String? stackTrace;

  /// SHA-256 signature for deduplication grouping.
  final String signature;

  /// Number of times this error has occurred.
  int count;

  /// Unix milliseconds of the first occurrence.
  final int firstOccurrence;

  /// Unix milliseconds of the most recent occurrence.
  int lastOccurrence;

  DiagnosticError({
    required this.category,
    required this.message,
    this.stackTrace,
    required this.signature,
    this.count = 1,
    required this.firstOccurrence,
    required this.lastOccurrence,
  });

  /// Serializes this error for inclusion in a diagnostic report.
  Map<String, dynamic> toJson() => {
        'category': category,
        'message': message,
        'stackTrace': stackTrace,
        'signature': signature,
        'count': count,
        'firstOccurrence': firstOccurrence,
        'lastOccurrence': lastOccurrence,
      };

  @override
  String toString() =>
      'DiagnosticError($category, sig=${signature.substring(0, 8)}..., '
      'count=$count)';
}
