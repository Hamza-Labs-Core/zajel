import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

import '../config/environment.dart';

/// Verifies Ed25519 signatures on bootstrap server responses.
///
/// The bootstrap server signs `GET /servers` responses with an Ed25519 key.
/// This class verifies those signatures using a hardcoded public key,
/// providing transport-agnostic trust that survives TLS CA rotations.
class BootstrapVerifier {
  static const _productionPublicKey =
      'attUirGAvR2WHcjz00q9lZoQTkWw5QmzJVM0waXwlWQ=';
  static const _qaPublicKey = 'aT6HRI0epsGWdhIX2E2I0h/j/h/9ravxrjl09qnGc/A=';

  /// Maximum age of a signed response before it's considered stale.
  static const maxAge = Duration(minutes: 5);

  final SimplePublicKey _publicKey;
  final Ed25519 _ed25519 = Ed25519();

  BootstrapVerifier._(this._publicKey);

  /// Create a verifier for the current environment (production or QA).
  factory BootstrapVerifier() {
    final keyBase64 = Environment.isQA ? _qaPublicKey : _productionPublicKey;
    return BootstrapVerifier.withKey(keyBase64);
  }

  /// Create a verifier with a specific public key (for testing).
  factory BootstrapVerifier.withKey(String publicKeyBase64) {
    final keyBytes = base64Decode(publicKeyBase64);
    final publicKey = SimplePublicKey(keyBytes, type: KeyPairType.ed25519);
    return BootstrapVerifier._(publicKey);
  }

  /// Verify the signature and freshness of a bootstrap response.
  ///
  /// Returns `true` if:
  /// 1. The Ed25519 signature over [responseBody] is valid
  /// 2. The `timestamp` field in the JSON is within [maxAge]
  ///
  /// Returns `false` for invalid signatures, expired timestamps,
  /// or missing timestamp fields.
  Future<bool> verify(String responseBody, String signatureBase64) async {
    try {
      // Verify Ed25519 signature over the raw body bytes
      final signatureBytes = base64Decode(signatureBase64);
      final bodyBytes = Uint8List.fromList(utf8.encode(responseBody));

      final signature = Signature(
        signatureBytes,
        publicKey: _publicKey,
      );

      final isValid = await _ed25519.verify(bodyBytes, signature: signature);
      if (!isValid) return false;

      // Check timestamp freshness (replay protection)
      final json = jsonDecode(responseBody) as Map<String, dynamic>;
      final timestamp = json['timestamp'] as int?;
      if (timestamp == null) return false;

      final responseTime = DateTime.fromMillisecondsSinceEpoch(timestamp);
      final age = DateTime.now().difference(responseTime).abs();
      return age <= maxAge;
    } catch (_) {
      return false;
    }
  }
}
