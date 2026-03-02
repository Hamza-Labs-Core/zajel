import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/crypto/crypto_service.dart';
import 'package:zajel/core/crypto/key_ratchet.dart';

import '../../mocks/mocks.dart';

void main() {
  group('KeyRatchet', () {
    late CryptoService alice;
    late CryptoService bob;
    late KeyRatchet aliceRatchet;
    late List<(String peerId, String message)> sentControls;
    const sessionId = 'ratchet-peer';

    setUp(() async {
      alice = CryptoService(secureStorage: FakeSecureStorage());
      bob = CryptoService(secureStorage: FakeSecureStorage());
      await alice.initialize();
      await bob.initialize();

      final alicePub = await alice.getPublicKeyBase64();
      final bobPub = await bob.getPublicKeyBase64();

      await alice.establishSession(sessionId, bobPub);
      await bob.establishSession(sessionId, alicePub);

      sentControls = [];
      aliceRatchet = KeyRatchet(
        cryptoService: alice,
        sendControl: (peerId, message) {
          sentControls.add((peerId, message));
        },
        messageThreshold: 5, // Low threshold for testing
        timeThreshold: const Duration(hours: 24), // Don't trigger time-based
      );
    });

    test('does not ratchet before threshold', () async {
      // Send 4 messages (threshold is 5)
      for (var i = 0; i < 4; i++) {
        await aliceRatchet.onMessageSent(sessionId);
      }

      expect(sentControls, isEmpty);
    });

    test('ratchets at message threshold', () async {
      // Send exactly 5 messages (threshold)
      for (var i = 0; i < 5; i++) {
        await aliceRatchet.onMessageSent(sessionId);
      }

      expect(sentControls, hasLength(1));
      expect(sentControls[0].$1, sessionId);
      expect(sentControls[0].$2, startsWith('ratchet:'));
    });

    test('ratchet control message has valid format', () async {
      for (var i = 0; i < 5; i++) {
        await aliceRatchet.onMessageSent(sessionId);
      }

      final payload = sentControls[0].$2.substring('ratchet:'.length);
      final json = jsonDecode(payload) as Map<String, dynamic>;

      expect(json['type'], 'key_ratchet');
      expect(json['version'], 1);
      expect(json['epoch'], 1);
      expect(json['nonce'], isA<String>());

      // Nonce should be 32 bytes base64-encoded
      final nonceBytes = base64Decode(json['nonce'] as String);
      expect(nonceBytes.length, 32);
    });

    test('epoch increments with each ratchet', () async {
      expect(aliceRatchet.getEpoch(sessionId), 0);

      // First ratchet
      for (var i = 0; i < 5; i++) {
        await aliceRatchet.onMessageSent(sessionId);
      }
      expect(aliceRatchet.getEpoch(sessionId), 1);

      // Second ratchet
      for (var i = 0; i < 5; i++) {
        await aliceRatchet.onMessageSent(sessionId);
      }
      expect(aliceRatchet.getEpoch(sessionId), 2);
    });

    test('counter resets after ratchet', () async {
      // Trigger first ratchet at message 5
      for (var i = 0; i < 5; i++) {
        await aliceRatchet.onMessageSent(sessionId);
      }
      expect(sentControls, hasLength(1));

      // Send 4 more (should not trigger another ratchet)
      for (var i = 0; i < 4; i++) {
        await aliceRatchet.onMessageSent(sessionId);
      }
      expect(sentControls, hasLength(1));

      // 5th message after reset triggers second ratchet
      await aliceRatchet.onMessageSent(sessionId);
      expect(sentControls, hasLength(2));
    });

    test('onRatchetReceived applies incoming ratchet', () async {
      // Trigger Alice's ratchet
      for (var i = 0; i < 5; i++) {
        await aliceRatchet.onMessageSent(sessionId);
      }

      // Extract the ratchet payload
      final payload = sentControls[0].$2.substring('ratchet:'.length);

      // Bob receives the ratchet (create a Bob-side ratchet)
      final bobRatchet = KeyRatchet(
        cryptoService: bob,
        sendControl: (_, __) {},
      );

      await bobRatchet.onRatchetReceived(sessionId, payload);

      // After ratchet, both should be able to encrypt/decrypt
      final encrypted = await alice.encrypt(sessionId, 'post-ratchet');
      final decrypted = await bob.decrypt(sessionId, encrypted);
      expect(decrypted, 'post-ratchet');
    });

    test('onRatchetReceived updates epoch', () async {
      final bobRatchet = KeyRatchet(
        cryptoService: bob,
        sendControl: (_, __) {},
      );

      expect(bobRatchet.getEpoch(sessionId), 0);

      // Trigger Alice's ratchet
      for (var i = 0; i < 5; i++) {
        await aliceRatchet.onMessageSent(sessionId);
      }

      final payload = sentControls[0].$2.substring('ratchet:'.length);
      await bobRatchet.onRatchetReceived(sessionId, payload);

      expect(bobRatchet.getEpoch(sessionId), 1);
    });

    test('rejects ratchet with unknown version', () async {
      final bobRatchet = KeyRatchet(
        cryptoService: bob,
        sendControl: (_, __) {},
      );

      final badPayload = jsonEncode({
        'type': 'key_ratchet',
        'nonce': base64Encode(List.filled(32, 0)),
        'epoch': 1,
        'version': 99,
      });

      // Should not throw but should be ignored
      await bobRatchet.onRatchetReceived(sessionId, badPayload);
      expect(bobRatchet.getEpoch(sessionId), 0); // Not updated
    });

    test('rejects ratchet with invalid nonce length', () async {
      final bobRatchet = KeyRatchet(
        cryptoService: bob,
        sendControl: (_, __) {},
      );

      final badPayload = jsonEncode({
        'type': 'key_ratchet',
        'nonce': base64Encode(List.filled(16, 0)), // 16 bytes, not 32
        'epoch': 1,
        'version': 1,
      });

      await bobRatchet.onRatchetReceived(sessionId, badPayload);
      expect(bobRatchet.getEpoch(sessionId), 0); // Not updated
    });

    test('removePeer clears state', () async {
      // Send some messages to set up state
      for (var i = 0; i < 3; i++) {
        await aliceRatchet.onMessageSent(sessionId);
      }
      expect(aliceRatchet.getEpoch(sessionId), 0);

      aliceRatchet.removePeer(sessionId);
      expect(aliceRatchet.getEpoch(sessionId), 0); // Reset to 0

      // After removal, counting starts fresh — should need full 5 messages
      for (var i = 0; i < 4; i++) {
        await aliceRatchet.onMessageSent(sessionId);
      }
      expect(sentControls, isEmpty); // Still below threshold
    });

    test('independent counters per peer', () async {
      // Set up second peer session
      final charlie = CryptoService(secureStorage: FakeSecureStorage());
      await charlie.initialize();
      final charliePub = await charlie.getPublicKeyBase64();
      await alice.establishSession('charlie', charliePub);

      // Send 4 messages to each peer
      for (var i = 0; i < 4; i++) {
        await aliceRatchet.onMessageSent(sessionId);
        await aliceRatchet.onMessageSent('charlie');
      }

      // No ratchets yet
      expect(sentControls, isEmpty);

      // One more to sessionId — triggers ratchet only for that peer
      await aliceRatchet.onMessageSent(sessionId);
      expect(sentControls, hasLength(1));
      expect(sentControls[0].$1, sessionId);
    });
  });
}
