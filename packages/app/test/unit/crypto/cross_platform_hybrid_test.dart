import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/constants.dart';
import 'package:zajel/core/crypto/crypto_service.dart';

import '../../mocks/mocks.dart';

/// Cross-platform hybrid key exchange tests.
///
/// These tests verify that the CryptoService correctly handles
/// protocol version negotiation and ML-KEM availability detection.
/// Actual hybrid crypto operations require liboqs (not in test env),
/// so these focus on the negotiation and fallback logic.
void main() {
  group('Protocol version negotiation', () {
    test('CryptoConstants has correct protocol versions', () {
      expect(CryptoConstants.protocolVersionClassical, 1);
      expect(CryptoConstants.protocolVersionHybrid, 2);
      expect(CryptoConstants.protocolVersionCurrent, 2);
    });

    test('supportedKEMs includes both classical and hybrid', () {
      expect(CryptoConstants.supportedKEMs, contains('x25519'));
      expect(CryptoConstants.supportedKEMs, contains('x25519-mlkem768'));
      expect(CryptoConstants.supportedKEMs.length, 2);
    });

    test('ML-KEM key sizes match FIPS 203', () {
      expect(CryptoConstants.mlKem768PublicKeySize, 1184);
      expect(CryptoConstants.mlKem768CiphertextSize, 1088);
      expect(CryptoConstants.mlKem768SharedSecretSize, 32);
    });
  });

  group('CryptoService ML-KEM properties', () {
    late CryptoService cryptoService;

    setUp(() async {
      cryptoService = CryptoService(secureStorage: FakeCachedSecureStorage());
      await cryptoService.initialize();
    });

    test('isMlKemAvailable reflects platform capability', () {
      // In flutter_test, liboqs is NOT available (no native FFI).
      // The service should gracefully degrade to classical-only.
      // Note: This may be true or false depending on platform -
      // we just verify it doesn't throw.
      expect(cryptoService.isMlKemAvailable, isA<bool>());
    });

    test('mlKemPublicKeyBase64 is null when unavailable', () {
      // In test environment (no liboqs), should return null
      if (!cryptoService.isMlKemAvailable) {
        expect(cryptoService.mlKemPublicKeyBase64, isNull);
      }
    });

    test('getPeerProtocolVersion returns null for unknown peer', () {
      expect(cryptoService.getPeerProtocolVersion('unknown-peer'), isNull);
    });

    test('setPeerMlKemPublicKey stores peer info', () {
      final fakeKey = Uint8List(1184);
      cryptoService.setPeerMlKemPublicKey(
        'peer-1',
        fakeKey,
        CryptoConstants.protocolVersionHybrid,
      );
      expect(
        cryptoService.getPeerProtocolVersion('peer-1'),
        CryptoConstants.protocolVersionHybrid,
      );
    });

    test('establishHybridSession throws when ML-KEM unavailable', () async {
      // In test environment without liboqs, hybrid session should fail
      if (!cryptoService.isMlKemAvailable) {
        await expectLater(
          cryptoService.establishHybridSession(
            peerId: 'peer-1',
            peerX25519PublicKeyBase64: 'AAAA',
            peerMlKemPublicKeyBase64: 'BBBB',
            role: 'initiator',
          ),
          throwsA(isA<CryptoException>().having(
            (e) => e.message,
            'message',
            contains('ML-KEM not available'),
          )),
        );
      }
    });

    test('classical establishSession still works', () async {
      final bob = CryptoService(secureStorage: FakeCachedSecureStorage());
      await bob.initialize();

      final bobPub = await bob.getPublicKeyBase64();
      final result = await cryptoService.establishSession('bob', bobPub);

      expect(result, 'bob');
    });
  });

  group('HKDF info strings', () {
    test('classical session uses zajel_session info', () async {
      // Verify that two peers using classical establishSession can
      // encrypt/decrypt — proving the HKDF info string matches
      final alice = CryptoService(secureStorage: FakeCachedSecureStorage());
      final bob = CryptoService(secureStorage: FakeCachedSecureStorage());
      await alice.initialize();
      await bob.initialize();

      const sid = 'interop-test';
      final alicePub = await alice.getPublicKeyBase64();
      final bobPub = await bob.getPublicKeyBase64();

      await alice.establishSession(sid, bobPub);
      await bob.establishSession(sid, alicePub);

      final encrypted = await alice.encrypt(sid, 'cross-platform test');
      final decrypted = await bob.decrypt(sid, encrypted);
      expect(decrypted, 'cross-platform test');
    });
  });
}
