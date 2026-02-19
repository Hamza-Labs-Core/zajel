// ignore_for_file: deprecated_member_use_from_same_package
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:zajel/core/crypto/crypto_service.dart';

import '../../mocks/mocks.dart';

void main() {
  group('CryptoService', () {
    late CryptoService cryptoService;
    late FakeSecureStorage fakeStorage;

    setUp(() {
      fakeStorage = FakeSecureStorage();
      cryptoService = CryptoService(secureStorage: fakeStorage);
    });

    group('initialization', () {
      test('initialize generates identity keys', () async {
        await cryptoService.initialize();

        final publicKey = await cryptoService.getPublicKeyBase64();
        expect(publicKey, isNotEmpty);
        expect(() => base64Decode(publicKey), returnsNormally);
      });

      test('publicKeyBase64 sync getter works after initialization', () async {
        await cryptoService.initialize();

        // Sync getter should return the same key as async method
        final syncKey = cryptoService.publicKeyBase64;
        final asyncKey = await cryptoService.getPublicKeyBase64();

        expect(syncKey, isNotEmpty);
        expect(syncKey, asyncKey);
        expect(() => base64Decode(syncKey), returnsNormally);
      });

      test('publicKeyBase64 sync getter throws before initialization', () {
        // Should throw when called before initialize()
        expect(
          () => cryptoService.publicKeyBase64,
          throwsA(isA<CryptoException>().having(
            (e) => e.message,
            'message',
            contains('not initialized'),
          )),
        );
      });

      test('initialize loads existing keys from storage', () async {
        // First initialization - generates keys
        await cryptoService.initialize();
        final firstPublicKey = await cryptoService.getPublicKeyBase64();

        // Create new service with same storage
        final newService = CryptoService(secureStorage: fakeStorage);
        await newService.initialize();
        final secondPublicKey = await newService.getPublicKeyBase64();

        // Should load the same keys
        expect(secondPublicKey, firstPublicKey);
      });

      test('regenerateIdentityKeys creates new keys', () async {
        await cryptoService.initialize();
        final firstKey = await cryptoService.getPublicKeyBase64();

        await cryptoService.regenerateIdentityKeys();
        final secondKey = await cryptoService.getPublicKeyBase64();

        expect(secondKey, isNot(firstKey));
      });
    });

    group('key exchange', () {
      test('performKeyExchange produces shared secret', () async {
        final alice = CryptoService(secureStorage: FakeSecureStorage());
        final bob = CryptoService(secureStorage: FakeSecureStorage());

        await alice.initialize();
        await bob.initialize();

        final alicePublicKey = await alice.getPublicKeyBase64();
        final bobPublicKey = await bob.getPublicKeyBase64();

        final aliceSharedSecret = await alice.performKeyExchange(bobPublicKey);
        final bobSharedSecret = await bob.performKeyExchange(alicePublicKey);

        // Both parties should derive the same shared secret
        expect(aliceSharedSecret, bobSharedSecret);
      });

      test('different key pairs produce different shared secrets', () async {
        final alice = CryptoService(secureStorage: FakeSecureStorage());
        final bob = CryptoService(secureStorage: FakeSecureStorage());
        final charlie = CryptoService(secureStorage: FakeSecureStorage());

        await alice.initialize();
        await bob.initialize();
        await charlie.initialize();

        final bobPublicKey = await bob.getPublicKeyBase64();
        final charliePublicKey = await charlie.getPublicKeyBase64();

        final aliceBobSecret = await alice.performKeyExchange(bobPublicKey);
        final aliceCharlieSecret =
            await alice.performKeyExchange(charliePublicKey);

        expect(aliceBobSecret, isNot(aliceCharlieSecret));
      });
    });

    group('session establishment', () {
      test('establishSession creates session key', () async {
        final alice = CryptoService(secureStorage: FakeSecureStorage());
        final bob = CryptoService(secureStorage: FakeSecureStorage());

        await alice.initialize();
        await bob.initialize();

        final bobPublicKey = await bob.getPublicKeyBase64();
        final sessionId = await alice.establishSession('bob-id', bobPublicKey);

        expect(sessionId, 'bob-id');
      });

      test('session keys are persisted', () async {
        final storage = FakeSecureStorage();
        final alice = CryptoService(secureStorage: storage);
        final bob = CryptoService(secureStorage: FakeSecureStorage());

        await alice.initialize();
        await bob.initialize();

        final bobPublicKey = await bob.getPublicKeyBase64();
        await alice.establishSession('bob-id', bobPublicKey);

        // Create new service with same storage
        final aliceReloaded = CryptoService(secureStorage: storage);
        await aliceReloaded.initialize();

        // Should be able to encrypt without re-establishing session
        final encrypted = await aliceReloaded.encrypt('bob-id', 'Test');
        expect(encrypted, isNotEmpty);
      });
    });

    group('encryption and decryption', () {
      late CryptoService alice;
      late CryptoService bob;
      // Use same session ID for both parties to ensure symmetric key derivation
      const sessionId = 'shared-session';

      setUp(() async {
        alice = CryptoService(secureStorage: FakeSecureStorage());
        bob = CryptoService(secureStorage: FakeSecureStorage());

        await alice.initialize();
        await bob.initialize();

        // Establish mutual sessions with same session ID for symmetric encryption
        final alicePublicKey = await alice.getPublicKeyBase64();
        final bobPublicKey = await bob.getPublicKeyBase64();

        // Both use the same session ID to derive the same key
        await alice.establishSession(sessionId, bobPublicKey);
        await bob.establishSession(sessionId, alicePublicKey);
      });

      test('encrypt produces base64 output', () async {
        final encrypted = await alice.encrypt(sessionId, 'Hello, Bob!');

        expect(encrypted, isNotEmpty);
        expect(() => base64Decode(encrypted), returnsNormally);
      });

      test('decrypt recovers original plaintext', () async {
        const original = 'Hello, Bob!';
        final encrypted = await alice.encrypt(sessionId, original);
        final decrypted = await bob.decrypt(sessionId, encrypted);

        expect(decrypted, original);
      });

      test('roundtrip encryption preserves message', () async {
        const messages = [
          'Short',
          'A slightly longer message with more content',
          'Unicode: 你好世界 مرحبا 🌍🎉',
          '', // Empty message
        ];

        for (final original in messages) {
          final encrypted = await alice.encrypt(sessionId, original);
          final decrypted = await bob.decrypt(sessionId, encrypted);
          expect(decrypted, original, reason: 'Failed for: "$original"');
        }
      });

      test('same plaintext produces different ciphertext', () async {
        const plaintext = 'Same message';

        final cipher1 = await alice.encrypt(sessionId, plaintext);
        final cipher2 = await alice.encrypt(sessionId, plaintext);

        // Due to random nonce, ciphertexts should differ
        expect(cipher1, isNot(cipher2));
      });

      test('decryption fails with wrong session', () async {
        final charlie = CryptoService(secureStorage: FakeSecureStorage());
        await charlie.initialize();

        // Charlie establishes a different session
        await charlie.establishSession(
            'different-session', await alice.getPublicKeyBase64());

        final encrypted = await alice.encrypt(sessionId, 'Secret message');

        // Charlie cannot decrypt Alice's message (different session key)
        expect(
          () => charlie.decrypt('different-session', encrypted),
          throwsA(anything), // Will fail due to wrong key
        );
      });

      test('throws when no session established', () async {
        expect(
          () => alice.encrypt('unknown-peer', 'Message'),
          throwsA(isA<CryptoException>().having(
            (e) => e.message,
            'message',
            contains('No session established'),
          )),
        );
      });

      test('throws on invalid ciphertext - too short', () async {
        final shortCipher = base64Encode([1, 2, 3]); // Too short

        expect(
          () => bob.decrypt(sessionId, shortCipher),
          throwsA(isA<CryptoException>().having(
            (e) => e.message,
            'message',
            contains('Invalid ciphertext'),
          )),
        );
      });
    });

    group('ephemeral key generation', () {
      test('generateEphemeralKeyPair produces valid keys', () async {
        await cryptoService.initialize();
        final keyPair = await cryptoService.generateEphemeralKeyPair();

        expect(keyPair.publicKey, isNotEmpty);
        expect(keyPair.privateKey, isNotEmpty);
        expect(() => base64Decode(keyPair.publicKey), returnsNormally);
        expect(() => base64Decode(keyPair.privateKey), returnsNormally);
      });

      test('each call generates unique keys', () async {
        await cryptoService.initialize();

        final keyPair1 = await cryptoService.generateEphemeralKeyPair();
        final keyPair2 = await cryptoService.generateEphemeralKeyPair();

        expect(keyPair1.publicKey, isNot(keyPair2.publicKey));
        expect(keyPair1.privateKey, isNot(keyPair2.privateKey));
      });
    });

    group('session management', () {
      test('clearAllSessions removes all session keys', () async {
        final bob = CryptoService(secureStorage: FakeSecureStorage());
        await cryptoService.initialize();
        await bob.initialize();

        final bobPublicKey = await bob.getPublicKeyBase64();
        await cryptoService.establishSession('bob', bobPublicKey);

        // Verify encryption works
        await cryptoService.encrypt('bob', 'Test');

        // Clear sessions
        await cryptoService.clearAllSessions();

        // Encryption should now fail
        expect(
          () => cryptoService.encrypt('bob', 'Test'),
          throwsA(isA<CryptoException>()),
        );
      });
    });

    group('CryptoException', () {
      test('toString includes message', () {
        final exception = CryptoException('Test error message');

        expect(exception.toString(), contains('Test error message'));
        expect(exception.toString(), contains('CryptoException'));
      });

      test('message property returns message', () {
        const errorMessage = 'Something went wrong';
        final exception = CryptoException(errorMessage);

        expect(exception.message, errorMessage);
      });
    });

    group('edge cases', () {
      test('handles very long messages', () async {
        final alice = CryptoService(secureStorage: FakeSecureStorage());
        final bob = CryptoService(secureStorage: FakeSecureStorage());
        await alice.initialize();
        await bob.initialize();

        // Use same session ID for symmetric key derivation
        const sessionId = 'test-session';
        await alice.establishSession(sessionId, await bob.getPublicKeyBase64());
        await bob.establishSession(sessionId, await alice.getPublicKeyBase64());

        final longMessage = 'X' * 100000;
        final encrypted = await alice.encrypt(sessionId, longMessage);
        final decrypted = await bob.decrypt(sessionId, encrypted);

        expect(decrypted, longMessage);
      });

      test('handles special characters', () async {
        final alice = CryptoService(secureStorage: FakeSecureStorage());
        final bob = CryptoService(secureStorage: FakeSecureStorage());
        await alice.initialize();
        await bob.initialize();

        // Use same session ID for symmetric key derivation
        const sessionId = 'test-session';
        await alice.establishSession(sessionId, await bob.getPublicKeyBase64());
        await bob.establishSession(sessionId, await alice.getPublicKeyBase64());

        const specialMessage =
            'Newlines:\n\r\nTabs:\t\tNull:\x00Backslash:\\Quote:"';
        final encrypted = await alice.encrypt(sessionId, specialMessage);
        final decrypted = await bob.decrypt(sessionId, encrypted);

        expect(decrypted, specialMessage);
      });
    });

    group('tagFromPublicKey', () {
      test('returns 4-character uppercase hex string', () async {
        await cryptoService.initialize();
        final publicKey = await cryptoService.getPublicKeyBase64();

        final tag = CryptoService.tagFromPublicKey(publicKey);

        expect(tag.length, 4);
        expect(tag, matches(RegExp(r'^[0-9A-F]{4}$')));
      });

      test('is consistent with peerIdFromPublicKey', () async {
        await cryptoService.initialize();
        final publicKey = await cryptoService.getPublicKeyBase64();

        final tag = CryptoService.tagFromPublicKey(publicKey);
        final peerId = CryptoService.peerIdFromPublicKey(publicKey);

        // Both use same SHA-256 hash; tag is first 4 chars, peerId is first 16
        expect(peerId.substring(0, 4), tag);
      });

      test('is deterministic for same key', () async {
        await cryptoService.initialize();
        final publicKey = await cryptoService.getPublicKeyBase64();

        final tag1 = CryptoService.tagFromPublicKey(publicKey);
        final tag2 = CryptoService.tagFromPublicKey(publicKey);

        expect(tag1, tag2);
      });

      test('produces different tags for different keys', () async {
        final alice = CryptoService(secureStorage: FakeSecureStorage());
        final bob = CryptoService(secureStorage: FakeSecureStorage());
        await alice.initialize();
        await bob.initialize();

        final aliceTag =
            CryptoService.tagFromPublicKey(await alice.getPublicKeyBase64());
        final bobTag =
            CryptoService.tagFromPublicKey(await bob.getPublicKeyBase64());

        // Technically could collide (1 in 65536) but extremely unlikely
        expect(aliceTag, isNot(bobTag));
      });

      test('works with known base64 input', () {
        // A fixed 32-byte key as base64
        final knownKey = base64Encode(List.filled(32, 0));

        final tag = CryptoService.tagFromPublicKey(knownKey);

        expect(tag.length, 4);
        expect(tag, matches(RegExp(r'^[0-9A-F]{4}$')));
        // Should be stable across runs
        final tag2 = CryptoService.tagFromPublicKey(knownKey);
        expect(tag, tag2);
      });
    });

    group('stableId', () {
      test('stableId getter throws before initialization', () {
        expect(
          () => cryptoService.stableId,
          throwsA(isA<CryptoException>().having(
            (e) => e.message,
            'message',
            contains('not initialized'),
          )),
        );
      });

      test('generates stableId on first init (no prefs)', () async {
        // CryptoService with no SharedPreferences — should generate random ID
        await cryptoService.initialize();

        final id = cryptoService.stableId;
        expect(id.length, 16);
        expect(id, matches(RegExp(r'^[0-9A-F]{16}$')));
      });

      test('migration: derives stableId from publicKey when no stored ID',
          () async {
        SharedPreferences.setMockInitialValues({});
        final prefs = await SharedPreferences.getInstance();
        final svc =
            CryptoService(secureStorage: FakeSecureStorage(), prefs: prefs);
        await svc.initialize();

        // Migration: stableId should match peerIdFromPublicKey
        final expected = CryptoService.peerIdFromPublicKey(svc.publicKeyBase64);
        expect(svc.stableId, expected);

        // Should be persisted
        expect(prefs.getString('zajel_stable_id'), expected);
      });

      test('loads stored stableId from SharedPreferences', () async {
        SharedPreferences.setMockInitialValues(
            {'zajel_stable_id': 'ABCD1234EFGH5678'});
        final prefs = await SharedPreferences.getInstance();
        final svc =
            CryptoService(secureStorage: FakeSecureStorage(), prefs: prefs);
        await svc.initialize();

        expect(svc.stableId, 'ABCD1234EFGH5678');
      });

      test('stableId survives key regeneration', () async {
        SharedPreferences.setMockInitialValues({});
        final prefs = await SharedPreferences.getInstance();
        final svc =
            CryptoService(secureStorage: FakeSecureStorage(), prefs: prefs);
        await svc.initialize();

        final originalStableId = svc.stableId;
        final originalPublicKey = svc.publicKeyBase64;

        // Regenerate keys — should NOT change stableId
        await svc.regenerateIdentityKeys();
        expect(svc.publicKeyBase64, isNot(originalPublicKey));
        expect(svc.stableId, originalStableId);
      });

      test('stableId persists across service instances', () async {
        SharedPreferences.setMockInitialValues({});
        final prefs = await SharedPreferences.getInstance();
        final storage = FakeSecureStorage();

        final svc1 = CryptoService(secureStorage: storage, prefs: prefs);
        await svc1.initialize();
        final firstId = svc1.stableId;

        // Create new instance with same storage
        final svc2 = CryptoService(secureStorage: storage, prefs: prefs);
        await svc2.initialize();
        expect(svc2.stableId, firstId);
      });
    });

    group('tagFromStableId', () {
      test('returns first 4 characters uppercased', () {
        expect(CryptoService.tagFromStableId('ABCD1234EFGH5678'), 'ABCD');
        expect(CryptoService.tagFromStableId('abcd1234efgh5678'), 'ABCD');
      });

      test('is deterministic', () {
        const id = '1234567890ABCDEF';
        expect(
            CryptoService.tagFromStableId(id), CryptoService.tagFromStableId(id));
      });

      test('throws ArgumentError for strings shorter than 4 chars', () {
        expect(
          () => CryptoService.tagFromStableId('AB'),
          throwsA(isA<ArgumentError>().having(
            (e) => e.message,
            'message',
            contains('at least 4 characters'),
          )),
        );
      });

      test('throws ArgumentError for empty string', () {
        expect(
          () => CryptoService.tagFromStableId(''),
          throwsA(isA<ArgumentError>()),
        );
      });

      test('works with exactly 4 characters', () {
        expect(CryptoService.tagFromStableId('abcd'), 'ABCD');
      });
    });

    group('removePeerPublicKey', () {
      test('removes a stored peer public key', () async {
        await cryptoService.initialize();
        cryptoService.setPeerPublicKey('peer-1', 'key123');
        expect(cryptoService.getPeerPublicKey('peer-1'), 'key123');

        cryptoService.removePeerPublicKey('peer-1');
        expect(cryptoService.getPeerPublicKey('peer-1'), isNull);
      });

      test('is a no-op for unknown peer', () async {
        await cryptoService.initialize();
        // Should not throw
        cryptoService.removePeerPublicKey('nonexistent');
      });
    });
  });
}
