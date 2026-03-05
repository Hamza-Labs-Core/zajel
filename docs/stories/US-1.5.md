# US-1.5: Privacy Scrubbing

## Story

As a Zajel user, I want all diagnostic data scrubbed of personal information before it leaves my device, so that my privacy is protected.

## Acceptance Criteria

- Stack traces contain only file paths and line numbers; all variable values, object addresses, and local state are stripped.
- No IP addresses (IPv4 or IPv6) appear in any transmitted diagnostic data.
- No pairing codes (6-digit numeric codes) appear in transmitted data.
- No cryptographic keys (base64-encoded strings of key-length, hex-encoded key material) appear in transmitted data.
- No peer IDs or session IDs (UUIDs, hex strings > 16 chars that are not error signatures) appear in error messages or stack traces.
- No file system paths outside the app package (e.g., `/data/user/0/com.hamzalabs.zajel/...`, `/Users/john/...`) appear in transmitted data -- only relative `package:zajel/` paths are retained.
- No email addresses appear in transmitted data.
- No URLs containing query parameters or authentication tokens appear in transmitted data (URLs are truncated to scheme + host + path).
- The scrubber is applied to both `message` and `stackTrace` fields of every `DiagnosticError` before it enters the deduplication buffer.
- Automated tests verify that each category of PII listed above is correctly scrubbed.
- Scrubbing does not alter the error signature (signatures are computed from file paths and line numbers, which are retained).

## Technical Design

### Architecture

The `DiagnosticsScrubber` is a stateless utility class with pure static methods. It is called by the `ErrorTracker` (US-1.4) immediately upon capturing an error, before the error is added to the deduplication buffer. This ensures that no unscrubbed data ever resides in memory for longer than the brief moment between capture and scrubbing.

```
FlutterError.onError
    |
    v
ErrorTracker.capture(error, stackTrace)
    |
    +--> scrubMessage = DiagnosticsScrubber.scrubErrorMessage(message)
    +--> scrubTrace = DiagnosticsScrubber.scrubStackTrace(stackTrace)
    +--> signature = ErrorSignature.compute(category, originalTrace, scrubMessage)
    |    ^-- Signature uses ORIGINAL trace for frame extraction (file:line only)
    |        but the stored sample uses SCRUBBED trace
    +--> buffer.add(DiagnosticError(message: scrubMessage, stackTrace: scrubTrace, ...))
```

Note: The signature computation in `ErrorSignature.compute()` (US-1.4) already extracts only file paths and line numbers from the stack trace, so the signature is inherently PII-free. The scrubber is applied to the `message` and the full `stackTrace` string that will be transmitted as sample data for developer inspection.

### Implementation Details

**Scrubber implementation** uses a series of regex replacements applied in sequence. Each regex targets a specific PII category:

```dart
class DiagnosticsScrubber {
  // IPv4 addresses: 1.2.3.4, 192.168.1.100, etc.
  static final _ipv4 = RegExp(
    r'\b(?:\d{1,3}\.){3}\d{1,3}\b',
  );

  // IPv6 addresses: fe80::1, ::1, 2001:db8::1, etc.
  static final _ipv6 = RegExp(
    r'\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b|'
    r'\b::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}\b|'
    r'\b(?:[0-9a-fA-F]{1,4}:){1,6}:\b',
  );

  // Pairing codes: 6-digit numeric codes (standalone, not part of larger numbers)
  static final _pairingCode = RegExp(
    r'\bcode[:\s=]+\d{4,8}\b',
    caseSensitive: false,
  );

  // UUIDs: 8-4-4-4-12 hex pattern
  static final _uuid = RegExp(
    r'\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b',
  );

  // Base64-encoded keys (32+ bytes = 44+ base64 chars)
  static final _base64Key = RegExp(
    r'\b[A-Za-z0-9+/]{44,}={0,2}\b',
  );

  // Hex-encoded keys (32+ bytes = 64+ hex chars, not already matched as signature)
  static final _hexKey = RegExp(
    r'\b[0-9a-fA-F]{64,}\b',
  );

  // Email addresses
  static final _email = RegExp(
    r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b',
  );

  // Absolute file system paths (platform-specific)
  static final _absolutePath = RegExp(
    r'(?:/(?:data|Users|home|tmp|var|private|storage)[^\s:,)]*)',
  );

  // URLs with query parameters or auth tokens
  static final _urlWithParams = RegExp(
    r'(https?://[^\s?#]+)[?#][^\s]*',
  );

  // Peer IDs (hex strings 16-63 chars that appear in peer-related contexts)
  static final _peerId = RegExp(
    r'\bpeer[_\s:=]+[0-9a-fA-F]{16,63}\b',
    caseSensitive: false,
  );

  /// Scrub an error message of all PII.
  static String scrubErrorMessage(String message) {
    var result = message;
    result = result.replaceAll(_email, '[EMAIL]');
    result = result.replaceAll(_ipv4, '[IP]');
    result = result.replaceAll(_ipv6, '[IP]');
    result = result.replaceAll(_uuid, '[UUID]');
    result = result.replaceAll(_pairingCode, 'code:[REDACTED]');
    result = result.replaceAll(_peerId, 'peer:[REDACTED]');
    result = result.replaceAll(_base64Key, '[KEY]');
    result = result.replaceAll(_hexKey, '[KEY]');
    result = result.replaceAll(_urlWithParams, r'$1[PARAMS_REDACTED]');
    result = result.replaceAll(_absolutePath, '[PATH]');
    return result;
  }

  /// Scrub a stack trace, retaining only file paths and line numbers.
  static String scrubStackTrace(String stackTrace) {
    final lines = stackTrace.split('\n');
    final scrubbed = <String>[];

    for (final line in lines) {
      // Retain Flutter/Dart stack frame format: "#N  Class.method (package:path:line:col)"
      // But scrub any inline data that might appear in the frame description
      var scrubbedLine = scrubErrorMessage(line);

      // Remove object addresses like "(0x7f12345678)"
      scrubbedLine = scrubbedLine.replaceAll(
        RegExp(r'\(0x[0-9a-fA-F]+\)'),
        '',
      );

      // Remove "Instance of 'ClassName'" patterns that might contain data
      scrubbedLine = scrubbedLine.replaceAll(
        RegExp(r"Instance of '[^']*'"),
        '[INSTANCE]',
      );

      scrubbed.add(scrubbedLine);
    }

    return scrubbed.join('\n');
  }
}
```

**Ordering of regex replacements** matters: emails are matched before IP addresses (because email local parts could look like partial IP patterns), and UUIDs before hex keys (UUIDs have a more specific pattern).

**Performance** is a consideration since scrubbing runs synchronously on the main isolate during error capture. The regex set is pre-compiled (static final) so there is no compilation overhead per invocation. For typical error messages (< 1 KB) and stack traces (< 5 KB), the scrubbing completes in under 1 ms.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/app/lib/core/diagnostics/scrubber.dart` | Create | `DiagnosticsScrubber` class with all scrubbing methods |
| `packages/app/lib/core/diagnostics/error_tracker.dart` | Modify | Call scrubber before adding errors to deduplication buffer |
| `packages/app/test/core/diagnostics/scrubber_test.dart` | Create | Comprehensive unit tests for every PII category |

### Data Models / Schemas

Not applicable -- this story operates on strings (error messages and stack traces) and produces scrubbed strings. No new data models are introduced.

### API Endpoints

Not applicable -- this story is entirely client-side. The scrubber ensures that data leaving the device via the diagnostics report endpoint (US-1.1) is PII-free.

## Dependencies

- **US-1.4** -- The scrubber is called by the `ErrorTracker` during error capture. US-1.4 must define the error capture flow first.
- **Internal dependencies:**
  - `dart:core` -- for `RegExp`
  - No external packages required -- all functionality uses built-in Dart regex

## Testing Strategy

- **Unit tests (`scrubber_test.dart`):**

  Each PII category requires dedicated test cases:

  **IP addresses:**
  - IPv4 `192.168.1.100` is replaced with `[IP]`.
  - IPv4 `10.0.2.2` is replaced with `[IP]`.
  - IPv6 `fe80::1` is replaced with `[IP]`.
  - IPv6 `2001:0db8:85a3:0000:0000:8a2e:0370:7334` is replaced with `[IP]`.
  - Loopback `127.0.0.1` is replaced with `[IP]`.
  - Port numbers after IP (e.g., `192.168.1.1:8080`) -- IP is replaced, port may remain.

  **Pairing codes:**
  - `"code: 123456"` becomes `"code:[REDACTED]"`.
  - `"pairing code=789012"` is scrubbed.
  - Standalone 6-digit numbers not preceded by "code" are NOT scrubbed (could be legitimate error codes).

  **Cryptographic keys:**
  - 44-character base64 string (256-bit key) is replaced with `[KEY]`.
  - 64-character hex string (256-bit key) is replaced with `[KEY]`.
  - 88-character base64 string (512-bit key) is replaced with `[KEY]`.
  - Short base64 strings (< 44 chars) are NOT scrubbed (could be legitimate encoded data).

  **UUIDs:**
  - Standard UUID `550e8400-e29b-41d4-a716-446655440000` is replaced with `[UUID]`.

  **Peer IDs:**
  - `"peer: abc123def456..."` (hex peer ID) is scrubbed.
  - `"peer_id=abc123def456..."` is scrubbed.

  **Email addresses:**
  - `user@example.com` is replaced with `[EMAIL]`.

  **File system paths:**
  - `/data/user/0/com.hamzalabs.zajel/files/db.sqlite` is replaced with `[PATH]`.
  - `/Users/john/Documents/keys.pem` is replaced with `[PATH]`.
  - `/home/user/.config/zajel/...` is replaced with `[PATH]`.
  - `package:zajel/core/crypto/crypto_service.dart` is NOT scrubbed (this is an app frame).

  **URLs with params:**
  - `https://signal.example.com/ws?token=abc123` becomes `https://signal.example.com/ws[PARAMS_REDACTED]`.
  - `https://example.com/path` (no params) is NOT modified.

  **Stack traces:**
  - A realistic Flutter stack trace is scrubbed while retaining `#N` frame numbers, `package:zajel/` paths, and line numbers.
  - Object addresses `(0x7f12345678)` are removed.
  - `Instance of 'SecretKey'` is replaced with `[INSTANCE]`.

  **Composition:**
  - An error message containing multiple PII types (IP + UUID + key) has all scrubbed simultaneously.
  - An empty string returns an empty string.
  - A message with no PII is returned unchanged.
  - Scrubbing is idempotent: scrubbing an already-scrubbed string produces the same output.

## Technical Notes

**Codebase patterns to follow:**
- The scrubber follows the utility class pattern seen throughout the codebase (e.g., static methods, no instance state).
- Test organization follows the `test/` mirror of `lib/` structure.

**External best practices applied:**
- The scrubbing approach follows OpenTelemetry's "Handling Sensitive Data" guidelines: scrub at collection time (not at transmission time), use pattern matching for known PII types, and replace with fixed placeholder tokens.
- The regex-based approach is what Sentry, Bugsnag, and Datadog use for client-side scrubbing. Server-side scrubbing is an additional defense layer (US-1.1 could add server-side re-scrubbing), but the primary scrubbing must happen on the device.
- GDPR considers stack traces with file paths as non-personal data (they describe code structure, not users). This is why `package:zajel/` paths are retained -- they are essential for debugging.
- The TelemetryDeck anonymization approach recommends double-hashing for user identifiers. The `sessionHash` in Zajel already uses SHA-256 of a random UUID, which provides equivalent anonymization.

**Gotchas:**
- Regex ordering matters for overlapping patterns. For example, a hex-encoded Ed25519 public key (64 hex chars) could also match as two adjacent IPv4 addresses if the IP regex runs first and matches greedily. The implementation order (specific patterns first, generic last) prevents this.
- The `_hexKey` regex (`[0-9a-fA-F]{64,}`) will also match the `sessionHash` field in error messages if the session hash is logged. This is intentional -- session hashes in error messages should be redacted. The `sessionHash` field in the `DiagnosticReport` itself is a top-level field, not part of the scrubbed message/trace.
- Stack traces from release builds may contain `<anonymous closure>` instead of function names. The scrubber must handle this gracefully (it does, since it scrubs content within lines rather than parsing the frame structure).
- IPv6 regex is intentionally broad. It may false-positive on some hex-colon patterns. This is acceptable -- false positives (over-scrubbing) are always preferable to false negatives (leaking PII).
- The scrubber must not modify the error `signature` field. Signatures are computed from file paths and line numbers only (US-1.4), which are explicitly retained by the scrubber. The signature is computed from the original stack trace frames before scrubbing is applied to the sample message/trace.

## Estimation

**M (Medium)** -- The core scrubbing logic is a set of regex replacements, which is straightforward to implement. The complexity lies in comprehensive test coverage: each PII category needs positive tests (PII is scrubbed), negative tests (non-PII is preserved), and edge case tests (overlapping patterns, empty inputs, already-scrubbed inputs). The regex patterns for IPv6 and base64 keys require careful tuning to minimize false positives/negatives.
