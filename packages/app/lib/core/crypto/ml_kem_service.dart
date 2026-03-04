import 'dart:ffi';
import 'dart:io' show Platform;
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

/// FFI wrapper around liboqs ML-KEM-768 implementation.
///
/// This service provides Dart bindings to the Open Quantum Safe (OQS)
/// liboqs C library for ML-KEM-768 (FIPS 203, formerly CRYSTALS-Kyber).
///
/// NOTE: This implementation uses dart:ffi and is NOT available on
/// Flutter Web. For web targets, use the stub implementation via
/// conditional imports (ml_kem_service_stub.dart).
///
/// Requires liboqs >= 0.10.1 for post-FIPS 203 `ml_kem_768` function names.
class MlKemService {
  static const int publicKeySize = 1184;
  static const int secretKeySize = 2400;
  static const int ciphertextSize = 1088;
  static const int sharedSecretSize = 32;

  late final DynamicLibrary _lib;
  late final int Function(Pointer<Uint8>, Pointer<Uint8>) _keygen;
  late final int Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>)
      _encapsulate;
  late final int Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>)
      _decapsulate;

  MlKemService() {
    // Load platform-specific library
    if (Platform.isAndroid || Platform.isLinux) {
      _lib = DynamicLibrary.open('liboqs.so');
    } else if (Platform.isIOS || Platform.isMacOS) {
      _lib = DynamicLibrary.open('liboqs.dylib');
    } else if (Platform.isWindows) {
      _lib = DynamicLibrary.open('oqs.dll');
    } else {
      throw UnsupportedError('Platform not supported for ML-KEM');
    }

    // Bind C functions (using post-FIPS 203 ML-KEM names, liboqs >= 0.10.1)
    _keygen = _lib.lookupFunction<
        Int32 Function(Pointer<Uint8>, Pointer<Uint8>),
        int Function(Pointer<Uint8>, Pointer<Uint8>)>(
      'OQS_KEM_ml_kem_768_keypair',
    );

    _encapsulate = _lib.lookupFunction<
        Int32 Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>),
        int Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>)>(
      'OQS_KEM_ml_kem_768_encaps',
    );

    _decapsulate = _lib.lookupFunction<
        Int32 Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>),
        int Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Uint8>)>(
      'OQS_KEM_ml_kem_768_decaps',
    );
  }

  /// Generate a new ML-KEM-768 key pair.
  ({Uint8List publicKey, Uint8List secretKey}) generateKeyPair() {
    final publicKeyPtr = calloc<Uint8>(publicKeySize);
    final secretKeyPtr = calloc<Uint8>(secretKeySize);

    try {
      final result = _keygen(publicKeyPtr, secretKeyPtr);
      if (result != 0) {
        throw Exception('ML-KEM keygen failed with code $result');
      }

      final publicKey =
          Uint8List.fromList(publicKeyPtr.asTypedList(publicKeySize));
      final secretKey =
          Uint8List.fromList(secretKeyPtr.asTypedList(secretKeySize));

      return (publicKey: publicKey, secretKey: secretKey);
    } finally {
      calloc.free(publicKeyPtr);
      calloc.free(secretKeyPtr);
    }
  }

  /// Encapsulate to a peer's public key (initiator side).
  ///
  /// Returns the ciphertext to send to the peer and the shared secret.
  ({Uint8List ciphertext, Uint8List sharedSecret}) encapsulate(
    Uint8List peerPublicKey,
  ) {
    if (peerPublicKey.length != publicKeySize) {
      throw ArgumentError(
        'Invalid ML-KEM public key size: ${peerPublicKey.length}',
      );
    }

    final ciphertextPtr = calloc<Uint8>(ciphertextSize);
    final sharedSecretPtr = calloc<Uint8>(sharedSecretSize);
    final publicKeyPtr = calloc<Uint8>(publicKeySize);

    try {
      // Copy public key to native memory
      publicKeyPtr.asTypedList(publicKeySize).setAll(0, peerPublicKey);

      final result = _encapsulate(ciphertextPtr, sharedSecretPtr, publicKeyPtr);
      if (result != 0) {
        throw Exception('ML-KEM encapsulation failed with code $result');
      }

      final ciphertext =
          Uint8List.fromList(ciphertextPtr.asTypedList(ciphertextSize));
      final sharedSecret =
          Uint8List.fromList(sharedSecretPtr.asTypedList(sharedSecretSize));

      return (ciphertext: ciphertext, sharedSecret: sharedSecret);
    } finally {
      calloc.free(ciphertextPtr);
      calloc.free(sharedSecretPtr);
      calloc.free(publicKeyPtr);
    }
  }

  /// Decapsulate a ciphertext (responder side).
  ///
  /// Returns the 32-byte shared secret.
  Uint8List decapsulate(Uint8List ciphertext, Uint8List secretKey) {
    if (ciphertext.length != ciphertextSize) {
      throw ArgumentError(
        'Invalid ML-KEM ciphertext size: ${ciphertext.length}',
      );
    }
    if (secretKey.length != secretKeySize) {
      throw ArgumentError(
        'Invalid ML-KEM secret key size: ${secretKey.length}',
      );
    }

    final sharedSecretPtr = calloc<Uint8>(sharedSecretSize);
    final ciphertextPtr = calloc<Uint8>(ciphertextSize);
    final secretKeyPtr = calloc<Uint8>(secretKeySize);

    try {
      // Copy inputs to native memory
      ciphertextPtr.asTypedList(ciphertextSize).setAll(0, ciphertext);
      secretKeyPtr.asTypedList(secretKeySize).setAll(0, secretKey);

      final result = _decapsulate(sharedSecretPtr, ciphertextPtr, secretKeyPtr);
      if (result != 0) {
        throw Exception('ML-KEM decapsulation failed with code $result');
      }

      return Uint8List.fromList(
        sharedSecretPtr.asTypedList(sharedSecretSize),
      );
    } finally {
      calloc.free(sharedSecretPtr);
      calloc.free(ciphertextPtr);
      calloc.free(secretKeyPtr);
    }
  }
}
