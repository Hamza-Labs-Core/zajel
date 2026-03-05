import 'dart:typed_data';

/// Stub ML-KEM service for Flutter Web.
///
/// dart:ffi is not available on Flutter Web, so this stub throws
/// UnsupportedError for all operations. On Web, the app falls back
/// to classical X25519-only key exchange.
///
/// A future story may implement ML-KEM on Web via @noble/post-quantum
/// through dart:js_interop.
class MlKemService {
  static const int publicKeySize = 1184;
  static const int secretKeySize = 2400;
  static const int ciphertextSize = 1088;
  static const int sharedSecretSize = 32;

  MlKemService();

  /// Not supported on Flutter Web.
  ({Uint8List publicKey, Uint8List secretKey}) generateKeyPair() {
    throw UnsupportedError(
      'ML-KEM is not available on Flutter Web. '
      'Hybrid post-quantum key exchange requires a native platform '
      '(Android, iOS, Linux, macOS, Windows).',
    );
  }

  /// Not supported on Flutter Web.
  ({Uint8List ciphertext, Uint8List sharedSecret}) encapsulate(
    Uint8List peerPublicKey,
  ) {
    throw UnsupportedError(
      'ML-KEM is not available on Flutter Web. '
      'Hybrid post-quantum key exchange requires a native platform.',
    );
  }

  /// Not supported on Flutter Web.
  Uint8List decapsulate(Uint8List ciphertext, Uint8List secretKey) {
    throw UnsupportedError(
      'ML-KEM is not available on Flutter Web. '
      'Hybrid post-quantum key exchange requires a native platform.',
    );
  }
}
