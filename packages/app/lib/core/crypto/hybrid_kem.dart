import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

import '../constants.dart';

/// Hybrid KEM combiner for X25519 + ML-KEM-768 key exchange.
///
/// Implements the hybrid construction:
///   session_key = HKDF-SHA256(
///     IKM = x25519_shared_secret || ml_kem_shared_secret,
///     salt = empty,
///     info = "zajel_hybrid_session",
///     L = 32 bytes
///   )
///
/// This follows the IETF hybrid key exchange draft recommendations:
/// - Concatenation (not XOR) of shared secrets preserves full entropy
/// - Distinct HKDF info string prevents cross-protocol key reuse
/// - Security holds as long as EITHER algorithm remains unbroken
///
/// ## Protocol Version Negotiation
///
/// Peers negotiate the key exchange method during signaling:
/// - Both support hybrid (version >= 2): Use hybrid X25519 + ML-KEM-768
/// - Either supports only classical (version 1): Fall back to X25519-only
///
/// The negotiation is backward-compatible: a v2 client can always pair
/// with a v1 client using classical key exchange.
class HybridKem {
  final Hkdf _hkdf;

  HybridKem()
      : _hkdf = Hkdf(
          hmac: Hmac.sha256(),
          outputLength: CryptoConstants.hkdfOutputLength,
        );

  /// Derive a hybrid session key from X25519 and ML-KEM shared secrets.
  ///
  /// Combines two independent shared secrets into a single session key
  /// using HKDF-SHA256. The resulting key is secure as long as either
  /// the X25519 or ML-KEM shared secret remains unknown to an attacker.
  ///
  /// [x25519SharedSecret] - 32-byte shared secret from X25519 ECDH
  /// [mlKemSharedSecret] - 32-byte shared secret from ML-KEM-768
  ///
  /// Returns a 32-byte session key derived via HKDF.
  ///
  /// Throws [ArgumentError] if either secret has wrong length.
  Future<SecretKey> deriveHybridSessionKey({
    required Uint8List x25519SharedSecret,
    required Uint8List mlKemSharedSecret,
  }) async {
    if (x25519SharedSecret.length != CryptoConstants.x25519KeySize) {
      throw ArgumentError(
        'X25519 shared secret must be ${CryptoConstants.x25519KeySize} bytes, '
        'got ${x25519SharedSecret.length}',
      );
    }
    if (mlKemSharedSecret.length != CryptoConstants.mlKem768SharedSecretSize) {
      throw ArgumentError(
        'ML-KEM shared secret must be ${CryptoConstants.mlKem768SharedSecretSize} bytes, '
        'got ${mlKemSharedSecret.length}',
      );
    }

    // Concatenate: X25519 || ML-KEM
    final combinedSecret = Uint8List(
      x25519SharedSecret.length + mlKemSharedSecret.length,
    );
    combinedSecret.setAll(0, x25519SharedSecret);
    combinedSecret.setAll(x25519SharedSecret.length, mlKemSharedSecret);

    // Derive via HKDF with hybrid-specific info string
    return _hkdf.deriveKey(
      secretKey: SecretKey(combinedSecret),
      info: utf8.encode(CryptoConstants.hkdfInfoHybrid),
      nonce: const [],
    );
  }

  /// Derive a classical session key from X25519 shared secret only.
  ///
  /// This is the existing key derivation path, factored out for consistency.
  ///
  /// [x25519SharedSecret] - 32-byte shared secret from X25519 ECDH
  ///
  /// Returns a 32-byte session key derived via HKDF.
  Future<SecretKey> deriveClassicalSessionKey({
    required Uint8List x25519SharedSecret,
  }) async {
    if (x25519SharedSecret.length != CryptoConstants.x25519KeySize) {
      throw ArgumentError(
        'X25519 shared secret must be ${CryptoConstants.x25519KeySize} bytes, '
        'got ${x25519SharedSecret.length}',
      );
    }

    return _hkdf.deriveKey(
      secretKey: SecretKey(x25519SharedSecret),
      info: utf8.encode(CryptoConstants.hkdfInfoClassical),
      nonce: const [],
    );
  }

  /// Negotiate the protocol version between two peers.
  ///
  /// Returns the highest mutually supported version. If either peer
  /// only supports classical (version 1), returns 1. If both support
  /// hybrid (version >= 2), returns 2.
  ///
  /// [ourVersion] - Our advertised protocol version
  /// [peerVersion] - Peer's advertised protocol version
  /// [peerHasPqKey] - Whether the peer provided an ML-KEM public key
  static int negotiateVersion({
    required int ourVersion,
    required int peerVersion,
    required bool peerHasPqKey,
  }) {
    // Both must support hybrid AND peer must provide PQ key
    if (ourVersion >= CryptoConstants.protocolVersionHybrid &&
        peerVersion >= CryptoConstants.protocolVersionHybrid &&
        peerHasPqKey) {
      return CryptoConstants.protocolVersionHybrid;
    }
    return CryptoConstants.protocolVersionClassical;
  }
}
