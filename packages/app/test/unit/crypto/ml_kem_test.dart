import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/crypto/ml_kem_service_stub.dart';

/// Unit tests for ML-KEM-768 service interface and stub behavior.
///
/// These tests verify:
/// 1. The MlKemServiceStub correctly throws UnsupportedError on web
/// 2. Key size constants match NIST FIPS 203 specification
///
/// Note: The FFI-based MlKemService cannot be tested in flutter_test
/// because liboqs is not available in the test environment.
/// Integration tests with liboqs are done via the headless client
/// (Python cryptography library) and cross-platform test vectors.
void main() {
  group('MlKemServiceStub', () {
    late MlKemServiceStub stub;

    setUp(() {
      stub = MlKemServiceStub();
    });

    test('constants match FIPS 203 spec', () {
      expect(MlKemServiceStub.publicKeySize, 1184);
      expect(MlKemServiceStub.secretKeySize, 2400);
      expect(MlKemServiceStub.ciphertextSize, 1088);
      expect(MlKemServiceStub.sharedSecretSize, 32);
    });

    test('generateKeyPair throws UnsupportedError', () {
      expect(
        () => stub.generateKeyPair(),
        throwsA(isA<UnsupportedError>().having(
          (e) => e.message,
          'message',
          contains('ML-KEM is not available on Flutter Web'),
        )),
      );
    });

    test('encapsulate throws UnsupportedError', () {
      expect(
        () => stub.encapsulate(Uint8List(1184)),
        throwsA(isA<UnsupportedError>().having(
          (e) => e.message,
          'message',
          contains('ML-KEM is not available on Flutter Web'),
        )),
      );
    });

    test('decapsulate throws UnsupportedError', () {
      expect(
        () => stub.decapsulate(Uint8List(1088), Uint8List(2400)),
        throwsA(isA<UnsupportedError>().having(
          (e) => e.message,
          'message',
          contains('ML-KEM is not available on Flutter Web'),
        )),
      );
    });
  });

  group('ML-KEM constants', () {
    test('ML-KEM-768 sizes are correct per FIPS 203', () {
      // ML-KEM-768 sizes from NIST FIPS 203 Table 3
      // These must match across all three client implementations
      // (Flutter/Dart, Python headless, TypeScript web)
      const expectedPublicKeySize = 1184;
      const expectedCiphertextSize = 1088;
      const expectedSharedSecretSize = 32;

      expect(MlKemServiceStub.publicKeySize, expectedPublicKeySize);
      expect(MlKemServiceStub.ciphertextSize, expectedCiphertextSize);
      expect(MlKemServiceStub.sharedSecretSize, expectedSharedSecretSize);
    });
  });
}
