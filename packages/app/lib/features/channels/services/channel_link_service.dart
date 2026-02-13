import 'dart:convert';

import '../models/channel.dart';

/// Encodes and decodes self-contained channel invite links.
///
/// A channel link contains everything a subscriber needs to join:
/// the full signed manifest + the decryption key, encoded as a
/// single base64url string.
///
/// Format: `zajel://channel/<base64url-encoded-json>`
class ChannelLinkService {
  static const _prefix = 'zajel://channel/';

  /// Encode a channel into a self-contained invite link.
  ///
  /// Requires the channel to have [encryptionKeyPrivate] (owner only).
  /// Throws [ArgumentError] if the channel has no private encryption key.
  static String encode(Channel channel) {
    if (channel.encryptionKeyPrivate == null) {
      throw ArgumentError('Channel must have encryptionKeyPrivate to share');
    }

    final payload = {
      'm': channel.manifest.toJson(),
      'k': channel.encryptionKeyPrivate,
    };

    final jsonBytes = utf8.encode(jsonEncode(payload));
    final encoded = base64Url.encode(jsonBytes).replaceAll('=', '');
    return '$_prefix$encoded';
  }

  /// Decode a channel invite link into its manifest and decryption key.
  ///
  /// Throws [FormatException] if the link format is invalid.
  static ({ChannelManifest manifest, String encryptionKey}) decode(
      String link) {
    // Strip all whitespace (clipboard paste on Linux can insert newlines)
    final trimmed = link.replaceAll(RegExp(r'\s+'), '');

    String encoded;
    if (trimmed.startsWith(_prefix)) {
      encoded = trimmed.substring(_prefix.length);
    } else {
      // Try treating the whole string as the encoded payload
      encoded = trimmed;
    }

    // Restore base64url padding
    final padLength = (4 - encoded.length % 4) % 4;
    final padded = encoded + '=' * padLength;

    final jsonBytes = base64Url.decode(padded);
    final payload = jsonDecode(utf8.decode(jsonBytes)) as Map<String, dynamic>;

    final manifestJson = payload['m'] as Map<String, dynamic>;
    final encryptionKey = payload['k'] as String;

    return (
      manifest: ChannelManifest.fromJson(manifestJson),
      encryptionKey: encryptionKey,
    );
  }

  /// Check if a string looks like a channel invite link.
  static bool isChannelLink(String text) {
    return text.trim().startsWith(_prefix);
  }
}
