/// Privacy scrubber for diagnostic data.
///
/// Strips personally identifiable information (PII) from error messages
/// and stack traces before they leave the device. All methods are static
/// and stateless -- no instance is needed.
///
/// Replacement tokens:
///   [IP]              - IPv4 or IPv6 addresses
///   [UUID]            - UUIDs (8-4-4-4-12 hex)
///   [EMAIL]           - Email addresses
///   code:[REDACTED]   - Pairing codes in context
///   peer:[REDACTED]   - Peer IDs in context
///   [KEY]             - Base64 or hex-encoded keys
///   [PATH]            - Absolute file system paths
///   [PARAMS_REDACTED] - URL query/fragment parameters
///   [INSTANCE]        - Dart "Instance of '...'" strings
class DiagnosticsScrubber {
  DiagnosticsScrubber._();

  // ---------------------------------------------------------------------------
  // Pre-compiled regex patterns (static final for zero per-call overhead)
  // ---------------------------------------------------------------------------

  /// Email addresses: local@domain.tld
  static final _email = RegExp(
    r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b',
  );

  /// IPv4 addresses: 0.0.0.0 - 255.255.255.255
  /// The email regex runs before this one. Valid emails (with alpha TLD) are
  /// already replaced with [EMAIL], so the IPv4 regex won't see them.
  /// Invalid email-like patterns (e.g. "admin@192.168.1.1") have the IP
  /// portion scrubbed here, which is correct -- over-scrubbing is preferred.
  static final _ipv4 = RegExp(
    r'\b(?:\d{1,3}\.){3}\d{1,3}\b',
  );

  /// IPv6 addresses -- intentionally broad to avoid false negatives.
  /// Matches:
  ///   - Full form:    2001:0db8:85a3:0000:0000:8a2e:0370:7334
  ///   - Compressed:   fe80::1, ::1, 2001:db8::1
  ///   - Trailing ::   fe80:1234::
  ///
  /// The regex uses three branches:
  ///  1. :: prefix forms (::1, ::ffff:192.0.2.1) -- must come first to
  ///     prevent the other branches from partially consuming the leading ::
  ///  2. Forms containing :: with optional hex groups on either side
  ///  3. Full uncompressed forms with 2-7 colon-separated hex groups
  static final _ipv6 = RegExp(
    // :: prefix forms (::1, ::ffff:x)
    r'::(?:[0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}'
    r'|'
    // Forms with :: in the middle or end: fe80::1, 2001:db8::, fe80::
    // Uses a non-greedy hex:group to stop before the ::
    r'[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})*::(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})*)?'
    r'|'
    // Full / partial uncompressed forms: 2+ colon-separated hex groups
    r'(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}',
  );

  /// Pairing codes: 4-8 digit numeric codes preceded by "code" keyword.
  /// Only matches when clearly labelled as a code to avoid false positives
  /// on legitimate numeric values.
  static final _pairingCode = RegExp(
    r'\bcode[:\s=]+\d{4,8}\b',
    caseSensitive: false,
  );

  /// UUIDs: 8-4-4-4-12 hex pattern.
  static final _uuid = RegExp(
    r'\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b',
  );

  /// Base64-encoded keys (>= 40 base64 characters including optional padding).
  /// A 32-byte key encodes to 43 base64 chars + 1 padding char = 44 total.
  /// We use 40 as the minimum to catch keys with minor variations.
  static final _base64Key = RegExp(
    r'(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])',
  );

  /// Hex-encoded keys / hashes (>= 64 hex characters, i.e. >= 32 bytes).
  static final _hexKey = RegExp(
    r'\b[0-9a-fA-F]{64,}\b',
  );

  /// Peer IDs: hex strings (16-63 chars) preceded by "peer" keyword.
  /// Allows intervening identifier chars like "peer_id=" or "peer: ".
  static final _peerId = RegExp(
    r'\bpeer(?:[_a-zA-Z]*)[_\s:=]+[0-9a-fA-F]{16,63}\b',
    caseSensitive: false,
  );

  /// Absolute file system paths on common platforms.
  /// Matches paths starting with /data, /Users, /home, /tmp, /var,
  /// /private, /storage.
  /// The negative lookbehind prevents matching inside package: URIs
  /// (e.g. "package:zajel/core/home/..." should not trigger on "/home/").
  static final _absolutePath = RegExp(
    r'(?<![A-Za-z0-9_.])/(?:data|Users|home|tmp|var|private|storage)/[^\s:,)]*',
  );

  /// URLs with query parameters or fragment identifiers.
  /// Captures the scheme+host+path portion and replaces the query/fragment.
  /// Supports http, https, ws, and wss schemes.
  static final _urlWithParams = RegExp(
    r'((?:https?|wss?)://[^\s?#]+)[?#][^\s]*',
  );

  /// Memory addresses like (0x7f12345678).
  static final _objectAddress = RegExp(
    r'\(0x[0-9a-fA-F]+\)',
  );

  /// Dart "Instance of 'ClassName'" patterns.
  static final _instanceOf = RegExp(
    r"Instance of '[^']*'",
  );

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /// Scrub an error message of all PII.
  ///
  /// The replacement order is significant:
  ///  1. URLs with params first (most specific URL patterns, before IP
  ///     could match the host portion).
  ///  2. Emails (local parts can resemble partial IPs).
  ///  3. IPv4 / IPv6.
  ///  4. UUIDs before generic hex keys (more specific pattern first).
  ///  5. Pairing codes / peer IDs (contextual patterns).
  ///  6. Base64 keys, hex keys (generic patterns).
  ///  7. Absolute paths last (broadest pattern).
  static String scrubErrorMessage(String message) {
    if (message.isEmpty) return message;

    var result = message;
    // URLs first: strip query params while preserving scheme+host+path
    result = result.replaceAllMapped(
      _urlWithParams,
      (m) => '${m.group(1)}[PARAMS_REDACTED]',
    );
    result = result.replaceAll(_email, '[EMAIL]');
    result = result.replaceAll(_ipv4, '[IP]');
    result = result.replaceAll(_ipv6, '[IP]');
    result = result.replaceAll(_uuid, '[UUID]');
    result = result.replaceAll(_pairingCode, 'code:[REDACTED]');
    result = result.replaceAll(_peerId, 'peer:[REDACTED]');
    result = result.replaceAll(_base64Key, '[KEY]');
    result = result.replaceAll(_hexKey, '[KEY]');
    result = result.replaceAll(_absolutePath, '[PATH]');
    return result;
  }

  /// Scrub a stack trace, retaining frame numbers, package paths, and
  /// line/column numbers while stripping all PII.
  ///
  /// Additionally removes:
  ///  - Object addresses like `(0x7f12345678)`
  ///  - `Instance of 'ClassName'` patterns
  static String scrubStackTrace(String stackTrace) {
    if (stackTrace.isEmpty) return stackTrace;

    final lines = stackTrace.split('\n');
    final scrubbed = <String>[];

    for (final line in lines) {
      // Remove object / memory addresses first (before scrubErrorMessage
      // so that hex inside addresses doesn't trigger path matching)
      var scrubbedLine = line.replaceAll(_objectAddress, '');

      // Replace "Instance of 'ClassName'" with opaque placeholder
      scrubbedLine = scrubbedLine.replaceAll(_instanceOf, '[INSTANCE]');

      // Apply all PII scrubbing rules to each line
      scrubbedLine = scrubErrorMessage(scrubbedLine);

      scrubbed.add(scrubbedLine);
    }

    return scrubbed.join('\n');
  }
}
