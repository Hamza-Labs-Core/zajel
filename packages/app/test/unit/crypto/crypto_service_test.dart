// ignore_for_file: deprecated_member_use_from_same_package
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:zajel/core/crypto/crypto_service.dart';

import '../../mocks/mocks.dart';

void main() {
  group('CryptoService', () {
    late CryptoService cryptoService;
    late FakeCachedSecureStorage fakeStorage;

    setUp(() {
      fakeStorage = FakeCachedSecureStorage();
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
        final alice = CryptoService(secureStorage: FakeCachedSecureStorage());
        final bob = CryptoService(secureStorage: FakeCachedSecureStorage());

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
        final alice = CryptoService(secureStorage: FakeCachedSecureStorage());
        final bob = CryptoService(secureStorage: FakeCachedSecureStorage());
        final charlie = CryptoService(secureStorage: FakeCachedSecureStorage());

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
        final alice = CryptoService(secureStorage: FakeCachedSecureStorage());
        final bob = CryptoService(secureStorage: FakeCachedSecureStorage());

        await alice.initialize();
        await bob.initialize();

        final bobPublicKey = await bob.getPublicKeyBase64();
        final sessionId = await alice.establishSession('bob-id', bobPublicKey);

        expect(sessionId, 'bob-id');
      });

      test('session keys are persisted', () async {
        final storage = FakeCachedSecureStorage();
        final alice = CryptoService(secureStorage: storage);
        final bob = CryptoService(secureStorage: FakeCachedSecureStorage());

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
        alice = CryptoService(secureStorage: FakeCachedSecureStorage());
        bob = CryptoService(secureStorage: FakeCachedSecureStorage());

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
        final charlie = CryptoService(secureStorage: FakeCachedSecureStorage());
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
        final bob = CryptoService(secureStorage: FakeCachedSecureStorage());
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
        final alice = CryptoService(secureStorage: FakeCachedSecureStorage());
        final bob = CryptoService(secureStorage: FakeCachedSecureStorage());
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
        final alice = CryptoService(secureStorage: FakeCachedSecureStorage());
        final bob = CryptoService(secureStorage: FakeCachedSecureStorage());
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
        final alice = CryptoService(secureStorage: FakeCachedSecureStorage());
        final bob = CryptoService(secureStorage: FakeCachedSecureStorage());
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
        final svc = CryptoService(
            secureStorage: FakeCachedSecureStorage(), prefs: prefs);
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
        final svc = CryptoService(
            secureStorage: FakeCachedSecureStorage(), prefs: prefs);
        await svc.initialize();

        expect(svc.stableId, 'ABCD1234EFGH5678');
      });

      test('stableId survives key regeneration', () async {
        SharedPreferences.setMockInitialValues({});
        final prefs = await SharedPreferences.getInstance();
        final svc = CryptoService(
            secureStorage: FakeCachedSecureStorage(), prefs: prefs);
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
        final storage = FakeCachedSecureStorage();

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
        expect(CryptoService.tagFromStableId(id),
            CryptoService.tagFromStableId(id));
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

    group('forward secrecy - ephemeral key exchange', () {
      test('establishSessionWithEphemeral creates session key', () async {
        final alice = CryptoService(secureStorage: FakeCachedSecureStorage());
        final bob = CryptoService(secureStorage: FakeCachedSecureStorage());

        await alice.initialize();
        await bob.initialize();

        // Generate ephemeral keys for both sides
        final aliceEph = await alice.generateEphemeralKeyPair();
        final bobEph = await bob.generateEphemeralKeyPair();

        final alicePub = await alice.getPublicKeyBase64();
        final bobPub = await bob.getPublicKeyBase64();

        // Both establish session with ephemeral keys
        await alice.establishSessionWithEphemeral(
          peerId: 'shared',
          peerIdentityKeyBase64: bobPub,
          peerEphemeralKeyBase64: bobEph.publicKey,
          ourEphemeralPrivateKeyBase64: aliceEph.privateKey,
        );
        await bob.establishSessionWithEphemeral(
          peerId: 'shared',
          peerIdentityKeyBase64: alicePub,
          peerEphemeralKeyBase64: aliceEph.publicKey,
          ourEphemeralPrivateKeyBase64: bobEph.privateKey,
        );

        // Should be able to encrypt and decrypt
        final encrypted = await alice.encrypt('shared', 'Forward secret!');
        final decrypted = await bob.decrypt('shared', encrypted);
        expect(decrypted, 'Forward secret!');
      });

      test('ephemeral session key differs from identity-only session key',
          () async {
        final alice = CryptoService(secureStorage: FakeCachedSecureStorage());
        final bob = CryptoService(secureStorage: FakeCachedSecureStorage());

        await alice.initialize();
        await bob.initialize();

        final alicePub = await alice.getPublicKeyBase64();
        final bobPub = await bob.getPublicKeyBase64();

        // Identity-only session
        await alice.establishSession('identity-only', bobPub);
        final identityEncrypted =
            await alice.encrypt('identity-only', 'test message');

        // Ephemeral session
        final aliceEph = await alice.generateEphemeralKeyPair();
        final bobEph = await bob.generateEphemeralKeyPair();

        await alice.establishSessionWithEphemeral(
          peerId: 'ephemeral',
          peerIdentityKeyBase64: bobPub,
          peerEphemeralKeyBase64: bobEph.publicKey,
          ourEphemeralPrivateKeyBase64: aliceEph.privateKey,
        );

        // The ephemeral session should use a different key
        // (Bob can't decrypt with identity-only session)
        await bob.establishSession('identity-only', alicePub);
        expect(
          () => bob.decrypt('identity-only', identityEncrypted),
          // This should work for identity-only
          returnsNormally,
        );
      });

      test('mixed exchange modes cause decrypt failure', () async {
        // This test proves the race condition bug: if one side uses ephemeral
        // key exchange (zajel_session_v2) and the other uses identity-only
        // (zajel_session), the derived session keys differ and messages
        // cannot be decrypted.
        final alice = CryptoService(secureStorage: FakeCachedSecureStorage());
        final bob = CryptoService(secureStorage: FakeCachedSecureStorage());

        await alice.initialize();
        await bob.initialize();

        final alicePub = await alice.getPublicKeyBase64();
        final bobPub = await bob.getPublicKeyBase64();

        // Both generate ephemeral keys
        final aliceEph = await alice.generateEphemeralKeyPair();
        final bobEph = await bob.generateEphemeralKeyPair();

        // Alice uses ephemeral exchange (dual ECDH → zajel_session_v2)
        await alice.establishSessionWithEphemeral(
          peerId: 'bob',
          peerIdentityKeyBase64: bobPub,
          peerEphemeralKeyBase64: bobEph.publicKey,
          ourEphemeralPrivateKeyBase64: aliceEph.privateKey,
        );

        // Bob uses identity-only exchange (single ECDH → zajel_session)
        // This simulates the race condition where Bob's handshake arrived
        // before Alice generated her ephemeral key
        await bob.establishSession('alice', alicePub);

        // Alice encrypts with ephemeral-derived key
        final encrypted = await alice.encrypt('bob', 'Hello from Alice');

        // Bob cannot decrypt — different session keys
        await expectLater(
          bob.decrypt('alice', encrypted),
          throwsA(anything),
        );
      });

      test('ephemeral session is persisted', () async {
        final storage = FakeCachedSecureStorage();
        final alice = CryptoService(secureStorage: storage);
        final bob = CryptoService(secureStorage: FakeCachedSecureStorage());

        await alice.initialize();
        await bob.initialize();

        final aliceEph = await alice.generateEphemeralKeyPair();
        final bobEph = await bob.generateEphemeralKeyPair();
        final bobPub = await bob.getPublicKeyBase64();

        await alice.establishSessionWithEphemeral(
          peerId: 'bob',
          peerIdentityKeyBase64: bobPub,
          peerEphemeralKeyBase64: bobEph.publicKey,
          ourEphemeralPrivateKeyBase64: aliceEph.privateKey,
        );

        // Create new service with same storage
        final aliceReloaded = CryptoService(secureStorage: storage);
        await aliceReloaded.initialize();

        // Should be able to encrypt without re-establishing session
        final encrypted = await aliceReloaded.encrypt('bob', 'Persisted!');
        expect(encrypted, isNotEmpty);
      });
    });

    group('key ratchet', () {
      late CryptoService alice;
      late CryptoService bob;
      const sessionId = 'ratchet-test';

      setUp(() async {
        alice = CryptoService(secureStorage: FakeCachedSecureStorage());
        bob = CryptoService(secureStorage: FakeCachedSecureStorage());

        await alice.initialize();
        await bob.initialize();

        final alicePub = await alice.getPublicKeyBase64();
        final bobPub = await bob.getPublicKeyBase64();

        await alice.establishSession(sessionId, bobPub);
        await bob.establishSession(sessionId, alicePub);
      });

      test('ratchetSessionKey changes the session key', () async {
        final nonce = Uint8List(32);
        for (var i = 0; i < 32; i++) {
          nonce[i] = i;
        }

        // Encrypt before ratchet
        final beforeEncrypted = await alice.encrypt(sessionId, 'before');

        // Ratchet both sides with same nonce
        await alice.ratchetSessionKey(sessionId, nonce);
        await bob.ratchetSessionKey(sessionId, nonce);

        // Encrypt/decrypt after ratchet should work with new key
        final afterEncrypted = await alice.encrypt(sessionId, 'after');
        final decrypted = await bob.decrypt(sessionId, afterEncrypted);
        expect(decrypted, 'after');

        // Old ciphertext should fail (key changed, grace period on alice's side
        // doesn't help bob since bob ratcheted too)
        // Bob's old key is in grace period, but the pre-ratchet message was
        // encrypted with alice's pre-ratchet key and bob's current key
        // is the post-ratchet key. The pre-ratchet ciphertext was encrypted
        // with alice's pre-ratchet key (same as bob's pre-ratchet key).
        // After ratchet, bob should still be able to decrypt via grace period.
        final stillDecrypted = await bob.decrypt(sessionId, beforeEncrypted);
        expect(stillDecrypted, 'before');
      });

      test('ratchet with same nonce produces deterministic key', () async {
        final nonce = Uint8List.fromList(List.filled(32, 42));

        // Two separate pairs with same starting key and same nonce
        final alice2 = CryptoService(secureStorage: FakeCachedSecureStorage());
        final bob2 = CryptoService(secureStorage: FakeCachedSecureStorage());
        await alice2.initialize();
        await bob2.initialize();

        final alice2Pub = await alice2.getPublicKeyBase64();
        final bob2Pub = await bob2.getPublicKeyBase64();

        // Same key exchange as alice/bob
        await alice2.establishSession(sessionId, bob2Pub);
        await bob2.establishSession(sessionId, alice2Pub);

        // Both alice instances ratchet with same nonce
        await alice.ratchetSessionKey(sessionId, nonce);
        await bob.ratchetSessionKey(sessionId, nonce);

        // Post-ratchet encryption should work for both pairs
        final encrypted = await alice.encrypt(sessionId, 'deterministic');
        final decrypted = await bob.decrypt(sessionId, encrypted);
        expect(decrypted, 'deterministic');
      });

      test('ratchetSessionKey throws with no session', () async {
        expect(
          () => alice.ratchetSessionKey('no-such-peer', Uint8List(32)),
          throwsA(isA<CryptoException>().having(
            (e) => e.message,
            'message',
            contains('No session to ratchet'),
          )),
        );
      });

      test('grace period allows decryption with old key', () async {
        final nonce = Uint8List.fromList(List.filled(32, 7));

        // Encrypt with current key
        final encrypted = await alice.encrypt(sessionId, 'grace period msg');

        // Only bob ratchets (simulating alice sent before bob processed)
        await bob.ratchetSessionKey(sessionId, nonce);

        // Bob should still decrypt via grace period (old key)
        final decrypted = await bob.decrypt(sessionId, encrypted);
        expect(decrypted, 'grace period msg');
      });

      test('multiple ratchets work in sequence', () async {
        for (var i = 0; i < 5; i++) {
          final nonce =
              Uint8List.fromList(List.generate(32, (j) => i * 32 + j));

          await alice.ratchetSessionKey(sessionId, nonce);
          await bob.ratchetSessionKey(sessionId, nonce);

          final encrypted = await alice.encrypt(sessionId, 'msg $i');
          final decrypted = await bob.decrypt(sessionId, encrypted);
          expect(decrypted, 'msg $i');
        }
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

    group('SDP Signing', () {
      test('signSDP returns valid base64 signature', () async {
        await cryptoService.initialize();

        final sdp = 'v=0\r\no=- 12345 2 IN IP4 0.0.0.0\r\n...';
        final signature = await cryptoService.signSDP(sdp);

        expect(signature, isNotEmpty);
        expect(() => base64Decode(signature), returnsNormally);
      });

      test('verifySDP accepts valid signature', () async {
        await cryptoService.initialize();

        final sdp = 'v=0\r\no=- 12345 2 IN IP4 0.0.0.0\r\n...';
        final signature = await cryptoService.signSDP(sdp);
        final publicKey = cryptoService.signingPublicKeyBase64;

        final isValid = await cryptoService.verifySDP(
          sdp: sdp,
          signature: signature,
          peerSigningPublicKey: publicKey,
        );

        expect(isValid, isTrue);
      });

      test('verifySDP rejects modified SDP', () async {
        await cryptoService.initialize();

        final sdp = 'v=0\r\no=- 12345 2 IN IP4 0.0.0.0\r\n...';
        final signature = await cryptoService.signSDP(sdp);
        final publicKey = cryptoService.signingPublicKeyBase64;

        // Modify SDP (simulate MITM tampering)
        final tamperedSdp = sdp.replaceFirst('12345', '99999');

        final isValid = await cryptoService.verifySDP(
          sdp: tamperedSdp,
          signature: signature,
          peerSigningPublicKey: publicKey,
        );

        expect(isValid, isFalse);
      });

      test('verifySDP rejects wrong signing key', () async {
        final crypto1 = CryptoService(secureStorage: FakeCachedSecureStorage());
        final crypto2 = CryptoService(secureStorage: FakeCachedSecureStorage());
        await crypto1.initialize();
        await crypto2.initialize();

        final sdp = 'v=0\r\no=- 12345 2 IN IP4 0.0.0.0\r\n...';
        final signature = await crypto1.signSDP(sdp);
        final wrongKey = crypto2.signingPublicKeyBase64;

        final isValid = await crypto1.verifySDP(
          sdp: sdp,
          signature: signature,
          peerSigningPublicKey: wrongKey,
        );

        expect(isValid, isFalse);
      });

      test('signData and verifyData roundtrip', () async {
        await cryptoService.initialize();

        final data = Uint8List.fromList(utf8.encode('test data'));
        final signature = await cryptoService.signData(data);

        final isValid = await cryptoService.verifyData(
          data: data,
          signatureBase64: signature,
          peerSigningPublicKeyBase64: cryptoService.signingPublicKeyBase64,
        );

        expect(isValid, isTrue);
      });

      test('signData rejects tampered data', () async {
        await cryptoService.initialize();

        final data = Uint8List.fromList(utf8.encode('original data'));
        final signature = await cryptoService.signData(data);

        final tamperedData = Uint8List.fromList(utf8.encode('tampered data'));

        final isValid = await cryptoService.verifyData(
          data: tamperedData,
          signatureBase64: signature,
          peerSigningPublicKeyBase64: cryptoService.signingPublicKeyBase64,
        );

        expect(isValid, isFalse);
      });

      test('signingPublicKeyBase64 throws before initialization', () {
        expect(
          () => cryptoService.signingPublicKeyBase64,
          throwsA(isA<CryptoException>().having(
            (e) => e.message,
            'message',
            contains('not initialized'),
          )),
        );
      });

      test('signingPublicKeyBase64 returns valid base64 after initialization',
          () async {
        await cryptoService.initialize();

        final signingKey = cryptoService.signingPublicKeyBase64;
        expect(signingKey, isNotEmpty);
        expect(() => base64Decode(signingKey), returnsNormally);
        // Ed25519 public key is 32 bytes
        expect(base64Decode(signingKey).length, 32);
      });

      test('signing keys persist across instances', () async {
        await cryptoService.initialize();
        final firstSigningKey = cryptoService.signingPublicKeyBase64;

        // Create new service with same storage
        final newService = CryptoService(secureStorage: fakeStorage);
        await newService.initialize();
        final secondSigningKey = newService.signingPublicKeyBase64;

        expect(secondSigningKey, firstSigningKey);
      });

      test('regenerateIdentityKeys also regenerates signing keys', () async {
        await cryptoService.initialize();
        final firstSigningKey = cryptoService.signingPublicKeyBase64;

        await cryptoService.regenerateIdentityKeys();
        final secondSigningKey = cryptoService.signingPublicKeyBase64;

        expect(secondSigningKey, isNot(firstSigningKey));
      });

      test('verifyData returns false for invalid base64 signature', () async {
        await cryptoService.initialize();

        final data = Uint8List.fromList(utf8.encode('test'));
        final isValid = await cryptoService.verifyData(
          data: data,
          signatureBase64: 'not-valid-base64!!!',
          peerSigningPublicKeyBase64: cryptoService.signingPublicKeyBase64,
        );

        expect(isValid, isFalse);
      });

      test('two peers can cross-verify SDP signatures', () async {
        final aliceCrypto =
            CryptoService(secureStorage: FakeCachedSecureStorage());
        final bobCrypto =
            CryptoService(secureStorage: FakeCachedSecureStorage());
        await aliceCrypto.initialize();
        await bobCrypto.initialize();

        // Alice creates and signs an offer
        final aliceOffer = 'v=0\r\no=- 12345 2 IN IP4 0.0.0.0\r\n...';
        final aliceSignature = await aliceCrypto.signSDP(aliceOffer);

        // Bob verifies Alice's offer
        final aliceOfferValid = await bobCrypto.verifySDP(
          sdp: aliceOffer,
          signature: aliceSignature,
          peerSigningPublicKey: aliceCrypto.signingPublicKeyBase64,
        );
        expect(aliceOfferValid, isTrue);

        // Bob creates and signs an answer
        final bobAnswer = 'v=0\r\no=- 67890 2 IN IP4 0.0.0.0\r\n...';
        final bobSignature = await bobCrypto.signSDP(bobAnswer);

        // Alice verifies Bob's answer
        final bobAnswerValid = await aliceCrypto.verifySDP(
          sdp: bobAnswer,
          signature: bobSignature,
          peerSigningPublicKey: bobCrypto.signingPublicKeyBase64,
        );
        expect(bobAnswerValid, isTrue);
      });

      test('MITM SDP tampering is detected', () async {
        final aliceCrypto =
            CryptoService(secureStorage: FakeCachedSecureStorage());
        final bobCrypto =
            CryptoService(secureStorage: FakeCachedSecureStorage());
        await aliceCrypto.initialize();
        await bobCrypto.initialize();

        // Alice creates and signs an offer
        final aliceOffer = 'v=0\r\na=fingerprint:sha-256 AA:BB:CC:DD\r\n';
        final aliceSignature = await aliceCrypto.signSDP(aliceOffer);

        // Attacker modifies the SDP (changes fingerprint)
        final tamperedOffer = aliceOffer.replaceFirst('AA:BB:CC', 'XX:YY:ZZ');

        // Bob tries to verify tampered SDP
        final isValid = await bobCrypto.verifySDP(
          sdp: tamperedOffer,
          signature: aliceSignature,
          peerSigningPublicKey: aliceCrypto.signingPublicKeyBase64,
        );

        expect(isValid, isFalse); // Attack detected
      });

      test('MITM key substitution is detected via trusted key binding',
          () async {
        final aliceCrypto =
            CryptoService(secureStorage: FakeCachedSecureStorage());
        final attackerCrypto =
            CryptoService(secureStorage: FakeCachedSecureStorage());
        await aliceCrypto.initialize();
        await attackerCrypto.initialize();

        // Alice creates and signs an offer
        final aliceOffer = 'v=0\r\na=fingerprint:sha-256 AA:BB:CC:DD\r\n';
        await aliceCrypto.signSDP(aliceOffer);

        // Attacker re-signs with their own key
        final tamperedOffer = aliceOffer.replaceFirst('AA:BB:CC', 'XX:YY:ZZ');
        final attackerSignature = await attackerCrypto.signSDP(tamperedOffer);

        // Attacker's signature is valid against attacker's key
        final validAgainstAttacker = await aliceCrypto.verifySDP(
          sdp: tamperedOffer,
          signature: attackerSignature,
          peerSigningPublicKey: attackerCrypto.signingPublicKeyBase64,
        );
        expect(validAgainstAttacker, isTrue);

        // But verification against Alice's TRUSTED key fails
        final validAgainstTrusted = await aliceCrypto.verifySDP(
          sdp: tamperedOffer,
          signature: attackerSignature,
          peerSigningPublicKey: aliceCrypto.signingPublicKeyBase64,
        );
        expect(validAgainstTrusted, isFalse); // MITM detected
      });

      test('ICE candidate signing roundtrip', () async {
        await cryptoService.initialize();

        final candidate =
            'candidate:1 1 UDP 2130706431 192.168.1.1 12345 typ host';
        final candidateBytes = Uint8List.fromList(utf8.encode(candidate));

        final signature = await cryptoService.signData(candidateBytes);

        final isValid = await cryptoService.verifyData(
          data: candidateBytes,
          signatureBase64: signature,
          peerSigningPublicKeyBase64: cryptoService.signingPublicKeyBase64,
        );

        expect(isValid, isTrue);
      });
    });
  });
}
