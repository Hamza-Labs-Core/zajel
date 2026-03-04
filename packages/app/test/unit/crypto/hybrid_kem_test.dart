import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/constants.dart';
import 'package:zajel/core/crypto/hybrid_kem.dart';
import 'package:zajel/core/crypto/ml_kem_service_stub.dart';

void main() {
  group('HybridKem', () {
    late HybridKem hybridKem;

    setUp(() {
      hybridKem = HybridKem();
    });

    group('deriveHybridSessionKey', () {
      test('produces expected session key from known test vector (vector 1)',
          () async {
        // Known X25519 shared secret (32 bytes) from test-vectors/hybrid-kem-vectors.json
        final x25519Secret = Uint8List.fromList([
          0x73,
          0xb8,
          0xab,
          0x88,
          0xd1,
          0xb5,
          0x0f,
          0x58,
          0xea,
          0xdc,
          0xef,
          0x6b,
          0x4c,
          0x51,
          0xee,
          0x50,
          0x63,
          0xb8,
          0xd1,
          0x92,
          0x78,
          0x5d,
          0x46,
          0xbe,
          0x71,
          0xbb,
          0x72,
          0x71,
          0x68,
          0x33,
          0x1a,
          0x4d,
        ]);

        // Known ML-KEM shared secret (32 bytes)
        final mlKemSecret = Uint8List.fromList([
          0xa1,
          0xa2,
          0xa3,
          0xa4,
          0xa5,
          0xa6,
          0xa7,
          0xa8,
          0xb1,
          0xb2,
          0xb3,
          0xb4,
          0xb5,
          0xb6,
          0xb7,
          0xb8,
          0xc1,
          0xc2,
          0xc3,
          0xc4,
          0xc5,
          0xc6,
          0xc7,
          0xc8,
          0xd1,
          0xd2,
          0xd3,
          0xd4,
          0xd5,
          0xd6,
          0xd7,
          0xd8,
        ]);

        // Expected hybrid session key (computed by Python reference implementation)
        final expectedSessionKey = Uint8List.fromList([
          0x3d,
          0x69,
          0xba,
          0xdd,
          0x53,
          0x94,
          0x9f,
          0x34,
          0x8c,
          0x0f,
          0x17,
          0x71,
          0x16,
          0x7d,
          0x4a,
          0x07,
          0x33,
          0xe5,
          0x55,
          0x94,
          0x2b,
          0xc3,
          0x5a,
          0x98,
          0x73,
          0x51,
          0x27,
          0x43,
          0xd7,
          0x06,
          0x28,
          0xa0,
        ]);

        final sessionKey = await hybridKem.deriveHybridSessionKey(
          x25519SharedSecret: x25519Secret,
          mlKemSharedSecret: mlKemSecret,
        );

        final sessionKeyBytes = await sessionKey.extractBytes();
        expect(sessionKeyBytes, equals(expectedSessionKey));
      });

      test('produces expected key for all-zero secrets (edge case)', () async {
        final allZeros = Uint8List(32);

        final expectedSessionKey = Uint8List.fromList([
          0xde,
          0x04,
          0xe8,
          0x98,
          0xe0,
          0x5e,
          0x60,
          0x14,
          0xf0,
          0x74,
          0x91,
          0x78,
          0xda,
          0x9a,
          0x61,
          0x20,
          0x97,
          0x6f,
          0x13,
          0x4c,
          0xec,
          0x5a,
          0xb6,
          0x70,
          0x82,
          0xeb,
          0x4e,
          0xf9,
          0xa9,
          0x81,
          0x15,
          0xe3,
        ]);

        final sessionKey = await hybridKem.deriveHybridSessionKey(
          x25519SharedSecret: allZeros,
          mlKemSharedSecret: allZeros,
        );

        final sessionKeyBytes = await sessionKey.extractBytes();
        expect(sessionKeyBytes, equals(expectedSessionKey));
      });

      test('produces expected key for all-0xFF secrets (edge case)', () async {
        final allFF = Uint8List.fromList(List.filled(32, 0xff));

        final expectedSessionKey = Uint8List.fromList([
          0xca,
          0x8d,
          0x67,
          0x33,
          0xc5,
          0x9e,
          0xdf,
          0xf4,
          0x25,
          0x64,
          0x91,
          0xda,
          0x10,
          0x76,
          0x0c,
          0xb1,
          0x74,
          0x3a,
          0xc4,
          0x3c,
          0x55,
          0xd7,
          0xbb,
          0x9d,
          0x1a,
          0x3c,
          0x5a,
          0x9f,
          0xb5,
          0x43,
          0xde,
          0xaf,
        ]);

        final sessionKey = await hybridKem.deriveHybridSessionKey(
          x25519SharedSecret: allFF,
          mlKemSharedSecret: allFF,
        );

        final sessionKeyBytes = await sessionKey.extractBytes();
        expect(sessionKeyBytes, equals(expectedSessionKey));
      });

      test('hybrid key differs from classical key with same X25519 secret',
          () async {
        // The same X25519 secret should produce different keys when
        // combined with ML-KEM (hybrid) vs used alone (classical).
        // This is ensured by the different HKDF info strings.
        final x25519Secret = Uint8List.fromList([
          0x73,
          0xb8,
          0xab,
          0x88,
          0xd1,
          0xb5,
          0x0f,
          0x58,
          0xea,
          0xdc,
          0xef,
          0x6b,
          0x4c,
          0x51,
          0xee,
          0x50,
          0x63,
          0xb8,
          0xd1,
          0x92,
          0x78,
          0x5d,
          0x46,
          0xbe,
          0x71,
          0xbb,
          0x72,
          0x71,
          0x68,
          0x33,
          0x1a,
          0x4d,
        ]);

        final mlKemSecret = Uint8List.fromList([
          0xa1,
          0xa2,
          0xa3,
          0xa4,
          0xa5,
          0xa6,
          0xa7,
          0xa8,
          0xb1,
          0xb2,
          0xb3,
          0xb4,
          0xb5,
          0xb6,
          0xb7,
          0xb8,
          0xc1,
          0xc2,
          0xc3,
          0xc4,
          0xc5,
          0xc6,
          0xc7,
          0xc8,
          0xd1,
          0xd2,
          0xd3,
          0xd4,
          0xd5,
          0xd6,
          0xd7,
          0xd8,
        ]);

        final hybridKey = await hybridKem.deriveHybridSessionKey(
          x25519SharedSecret: x25519Secret,
          mlKemSharedSecret: mlKemSecret,
        );

        final classicalKey = await hybridKem.deriveClassicalSessionKey(
          x25519SharedSecret: x25519Secret,
        );

        final hybridBytes = await hybridKey.extractBytes();
        final classicalBytes = await classicalKey.extractBytes();

        expect(hybridBytes, isNot(equals(classicalBytes)));
      });

      test('output is always 32 bytes', () async {
        final secret = Uint8List(32);
        final sessionKey = await hybridKem.deriveHybridSessionKey(
          x25519SharedSecret: secret,
          mlKemSharedSecret: secret,
        );

        final sessionKeyBytes = await sessionKey.extractBytes();
        expect(sessionKeyBytes.length, equals(32));
      });

      test('throws on wrong X25519 secret length', () async {
        final wrongLength = Uint8List(16);
        final correctLength = Uint8List(32);

        expect(
          () => hybridKem.deriveHybridSessionKey(
            x25519SharedSecret: wrongLength,
            mlKemSharedSecret: correctLength,
          ),
          throwsArgumentError,
        );
      });

      test('throws on wrong ML-KEM secret length', () async {
        final correctLength = Uint8List(32);
        final wrongLength = Uint8List(64);

        expect(
          () => hybridKem.deriveHybridSessionKey(
            x25519SharedSecret: correctLength,
            mlKemSharedSecret: wrongLength,
          ),
          throwsArgumentError,
        );
      });
    });

    group('deriveClassicalSessionKey', () {
      test('produces expected session key from known test vector', () async {
        final x25519Secret = Uint8List.fromList([
          0x73,
          0xb8,
          0xab,
          0x88,
          0xd1,
          0xb5,
          0x0f,
          0x58,
          0xea,
          0xdc,
          0xef,
          0x6b,
          0x4c,
          0x51,
          0xee,
          0x50,
          0x63,
          0xb8,
          0xd1,
          0x92,
          0x78,
          0x5d,
          0x46,
          0xbe,
          0x71,
          0xbb,
          0x72,
          0x71,
          0x68,
          0x33,
          0x1a,
          0x4d,
        ]);

        // Expected classical session key (computed by Python reference)
        final expectedSessionKey = Uint8List.fromList([
          0x29,
          0x94,
          0x81,
          0x14,
          0xa6,
          0x7a,
          0xb0,
          0x50,
          0xcb,
          0x52,
          0x35,
          0x28,
          0xa5,
          0xb0,
          0x42,
          0xdc,
          0x5f,
          0x13,
          0x8d,
          0xf9,
          0xf6,
          0xc0,
          0xd7,
          0x5a,
          0x96,
          0x11,
          0x5f,
          0x80,
          0x25,
          0xf8,
          0x32,
          0x36,
        ]);

        final sessionKey = await hybridKem.deriveClassicalSessionKey(
          x25519SharedSecret: x25519Secret,
        );

        final sessionKeyBytes = await sessionKey.extractBytes();
        expect(sessionKeyBytes, equals(expectedSessionKey));
      });

      test('throws on wrong secret length', () async {
        final wrongLength = Uint8List(16);

        expect(
          () => hybridKem.deriveClassicalSessionKey(
            x25519SharedSecret: wrongLength,
          ),
          throwsArgumentError,
        );
      });
    });

    group('negotiateVersion', () {
      test('both hybrid: returns hybrid version', () {
        final result = HybridKem.negotiateVersion(
          ourVersion: CryptoConstants.protocolVersionHybrid,
          peerVersion: CryptoConstants.protocolVersionHybrid,
          peerHasPqKey: true,
        );
        expect(result, CryptoConstants.protocolVersionHybrid);
      });

      test('we hybrid, peer classical: returns classical', () {
        final result = HybridKem.negotiateVersion(
          ourVersion: CryptoConstants.protocolVersionHybrid,
          peerVersion: CryptoConstants.protocolVersionClassical,
          peerHasPqKey: false,
        );
        expect(result, CryptoConstants.protocolVersionClassical);
      });

      test('we classical, peer hybrid: returns classical', () {
        final result = HybridKem.negotiateVersion(
          ourVersion: CryptoConstants.protocolVersionClassical,
          peerVersion: CryptoConstants.protocolVersionHybrid,
          peerHasPqKey: true,
        );
        expect(result, CryptoConstants.protocolVersionClassical);
      });

      test('both classical: returns classical', () {
        final result = HybridKem.negotiateVersion(
          ourVersion: CryptoConstants.protocolVersionClassical,
          peerVersion: CryptoConstants.protocolVersionClassical,
          peerHasPqKey: false,
        );
        expect(result, CryptoConstants.protocolVersionClassical);
      });

      test('both hybrid but no PQ key: returns classical', () {
        // Edge case: versions say hybrid but no actual PQ key provided
        final result = HybridKem.negotiateVersion(
          ourVersion: CryptoConstants.protocolVersionHybrid,
          peerVersion: CryptoConstants.protocolVersionHybrid,
          peerHasPqKey: false,
        );
        expect(result, CryptoConstants.protocolVersionClassical);
      });
    });
  });

  group('MlKemServiceStub', () {
    late MlKemServiceStub stub;

    setUp(() {
      stub = MlKemServiceStub();
    });

    test('all operations throw UnsupportedError', () {
      // Stub is a placeholder that always throws
      expect(() => stub.generateKeyPair(), throwsA(isA<UnsupportedError>()));
    });

    test('generateKeyPair throws UnsupportedError', () {
      expect(
        () => stub.generateKeyPair(),
        throwsA(isA<UnsupportedError>()),
      );
    });

    test('encapsulate throws UnsupportedError', () {
      expect(
        () => stub.encapsulate(Uint8List(MlKemServiceStub.publicKeySize)),
        throwsA(isA<UnsupportedError>()),
      );
    });

    test('decapsulate throws UnsupportedError', () {
      expect(
        () => stub.decapsulate(
          Uint8List(MlKemServiceStub.ciphertextSize),
          Uint8List(MlKemServiceStub.secretKeySize),
        ),
        throwsA(isA<UnsupportedError>()),
      );
    });
  });

  group('CryptoConstants - Post-Quantum', () {
    test('ML-KEM-768 sizes match FIPS 203', () {
      expect(CryptoConstants.mlKem768PublicKeySize, 1184);
      expect(CryptoConstants.mlKem768CiphertextSize, 1088);
      expect(CryptoConstants.mlKem768SharedSecretSize, 32);
      expect(CryptoConstants.mlKem768SecretKeySize, 2400);
    });

    test('protocol version constants are distinct', () {
      expect(
        CryptoConstants.protocolVersionClassical,
        isNot(CryptoConstants.protocolVersionHybrid),
      );
    });

    test('current protocol version is classical (PQ not yet enabled)', () {
      expect(
        CryptoConstants.protocolVersionCurrent,
        CryptoConstants.protocolVersionClassical,
      );
    });

    test('HKDF info strings are distinct', () {
      expect(
        CryptoConstants.hkdfInfoClassical,
        isNot(CryptoConstants.hkdfInfoHybrid),
      );
    });

    test('supportedKEMs includes both classical and hybrid', () {
      expect(CryptoConstants.supportedKEMs, contains('x25519'));
      expect(CryptoConstants.supportedKEMs, contains('x25519-mlkem768'));
    });
  });
}
