import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/groups/services/group_crypto_service.dart';

void main() {
  late GroupCryptoService cryptoService;

  setUp(() {
    cryptoService = GroupCryptoService();
  });

  group('Sender key generation', () {
    test('generateSenderKey produces a 32-byte key (base64 encoded)', () async {
      final key = await cryptoService.generateSenderKey();
      expect(key, isNotEmpty);

      final bytes = base64Decode(key);
      expect(bytes.length, 32);
    });

    test('generateSenderKey produces unique keys each time', () async {
      final key1 = await cryptoService.generateSenderKey();
      final key2 = await cryptoService.generateSenderKey();
      expect(key1, isNot(key2));
    });
  });

  group('Sender key management', () {
    test('setSenderKey and getSenderKey roundtrip', () async {
      final key = await cryptoService.generateSenderKey();
      cryptoService.setSenderKey('group1', 'deviceA', key);

      final retrieved = cryptoService.getSenderKey('group1', 'deviceA');
      expect(retrieved, isNotNull);
    });

    test('getSenderKey returns null for unknown group', () {
      expect(cryptoService.getSenderKey('unknown', 'deviceA'), isNull);
    });

    test('getSenderKey returns null for unknown device', () async {
      final key = await cryptoService.generateSenderKey();
      cryptoService.setSenderKey('group1', 'deviceA', key);

      expect(cryptoService.getSenderKey('group1', 'unknown'), isNull);
    });

    test('hasSenderKey returns correct boolean', () async {
      final key = await cryptoService.generateSenderKey();
      cryptoService.setSenderKey('group1', 'deviceA', key);

      expect(cryptoService.hasSenderKey('group1', 'deviceA'), isTrue);
      expect(cryptoService.hasSenderKey('group1', 'deviceB'), isFalse);
      expect(cryptoService.hasSenderKey('group2', 'deviceA'), isFalse);
    });

    test('getSenderKeyDeviceIds returns all device IDs for a group', () async {
      final key1 = await cryptoService.generateSenderKey();
      final key2 = await cryptoService.generateSenderKey();

      cryptoService.setSenderKey('group1', 'deviceA', key1);
      cryptoService.setSenderKey('group1', 'deviceB', key2);

      final ids = cryptoService.getSenderKeyDeviceIds('group1');
      expect(ids, containsAll(['deviceA', 'deviceB']));
      expect(ids.length, 2);
    });

    test('getSenderKeyDeviceIds returns empty for unknown group', () {
      expect(cryptoService.getSenderKeyDeviceIds('unknown'), isEmpty);
    });

    test('removeSenderKey removes a specific key', () async {
      final key = await cryptoService.generateSenderKey();
      cryptoService.setSenderKey('group1', 'deviceA', key);

      cryptoService.removeSenderKey('group1', 'deviceA');
      expect(cryptoService.hasSenderKey('group1', 'deviceA'), isFalse);
    });

    test('clearGroupKeys removes all keys for a group', () async {
      final key1 = await cryptoService.generateSenderKey();
      final key2 = await cryptoService.generateSenderKey();

      cryptoService.setSenderKey('group1', 'deviceA', key1);
      cryptoService.setSenderKey('group1', 'deviceB', key2);

      cryptoService.clearGroupKeys('group1');
      expect(cryptoService.getSenderKeyDeviceIds('group1'), isEmpty);
    });

    test('clearAllKeys removes all cached keys', () async {
      final key1 = await cryptoService.generateSenderKey();
      final key2 = await cryptoService.generateSenderKey();

      cryptoService.setSenderKey('group1', 'deviceA', key1);
      cryptoService.setSenderKey('group2', 'deviceB', key2);

      cryptoService.clearAllKeys();
      expect(cryptoService.getSenderKeyDeviceIds('group1'), isEmpty);
      expect(cryptoService.getSenderKeyDeviceIds('group2'), isEmpty);
    });

    test('setSenderKey rejects invalid base64', () {
      expect(
        () => cryptoService.setSenderKey('group1', 'deviceA', '!!!invalid'),
        throwsA(isA<GroupCryptoException>().having(
          (e) => e.message,
          'message',
          contains('Invalid base64'),
        )),
      );
    });

    test('setSenderKey rejects wrong key length', () {
      // 16 bytes instead of 32
      final shortKey = base64Encode(Uint8List(16));
      expect(
        () => cryptoService.setSenderKey('group1', 'deviceA', shortKey),
        throwsA(isA<GroupCryptoException>().having(
          (e) => e.message,
          'message',
          contains('Invalid sender key length'),
        )),
      );
    });
  });

  group('Encryption and decryption', () {
    late String senderKey;

    setUp(() async {
      senderKey = await cryptoService.generateSenderKey();
      cryptoService.setSenderKey('group1', 'deviceA', senderKey);
    });

    test('encrypt and decrypt roundtrip', () async {
      final plaintext = Uint8List.fromList(utf8.encode('Hello, group!'));

      final encrypted =
          await cryptoService.encrypt(plaintext, 'group1', 'deviceA');
      final decrypted =
          await cryptoService.decrypt(encrypted, 'group1', 'deviceA');

      expect(utf8.decode(decrypted), 'Hello, group!');
    });

    test('encrypted output is different from plaintext', () async {
      final plaintext = Uint8List.fromList(utf8.encode('Secret message'));

      final encrypted =
          await cryptoService.encrypt(plaintext, 'group1', 'deviceA');

      expect(encrypted, isNot(plaintext));
      expect(encrypted.length, greaterThan(plaintext.length));
    });

    test('encrypting same plaintext twice produces different ciphertext',
        () async {
      final plaintext = Uint8List.fromList(utf8.encode('Same message'));

      final encrypted1 =
          await cryptoService.encrypt(plaintext, 'group1', 'deviceA');
      final encrypted2 =
          await cryptoService.encrypt(plaintext, 'group1', 'deviceA');

      // Different nonces => different ciphertext
      expect(encrypted1, isNot(encrypted2));
    });

    test('any member with sender key can decrypt', () async {
      // Alice (deviceA) sends, Bob (deviceB) and Charlie (deviceC) can decrypt
      // They all have Alice's sender key
      cryptoService.setSenderKey('group1', 'deviceA', senderKey);

      // Create separate crypto services for Bob and Charlie
      final bobCrypto = GroupCryptoService();
      bobCrypto.setSenderKey('group1', 'deviceA', senderKey);

      final charlieCrypto = GroupCryptoService();
      charlieCrypto.setSenderKey('group1', 'deviceA', senderKey);

      final plaintext = Uint8List.fromList(utf8.encode('Broadcast message'));
      final encrypted =
          await cryptoService.encrypt(plaintext, 'group1', 'deviceA');

      // Both can decrypt
      final decryptedBob =
          await bobCrypto.decrypt(encrypted, 'group1', 'deviceA');
      final decryptedCharlie =
          await charlieCrypto.decrypt(encrypted, 'group1', 'deviceA');

      expect(utf8.decode(decryptedBob), 'Broadcast message');
      expect(utf8.decode(decryptedCharlie), 'Broadcast message');
    });

    test('decrypt fails without sender key', () async {
      final plaintext = Uint8List.fromList(utf8.encode('Secret'));
      final encrypted =
          await cryptoService.encrypt(plaintext, 'group1', 'deviceA');

      final otherCrypto = GroupCryptoService();
      expect(
        () => otherCrypto.decrypt(encrypted, 'group1', 'deviceA'),
        throwsA(isA<GroupCryptoException>().having(
          (e) => e.message,
          'message',
          contains('No sender key'),
        )),
      );
    });

    test('decrypt fails with wrong sender key', () async {
      final plaintext = Uint8List.fromList(utf8.encode('Secret'));
      final encrypted =
          await cryptoService.encrypt(plaintext, 'group1', 'deviceA');

      // Set up a different key
      final wrongKey = await cryptoService.generateSenderKey();
      final otherCrypto = GroupCryptoService();
      otherCrypto.setSenderKey('group1', 'deviceA', wrongKey);

      expect(
        () => otherCrypto.decrypt(encrypted, 'group1', 'deviceA'),
        throwsA(isA<GroupCryptoException>().having(
          (e) => e.message,
          'message',
          contains('MAC verification failed'),
        )),
      );
    });

    test('decrypt fails with tampered ciphertext', () async {
      final plaintext = Uint8List.fromList(utf8.encode('Integrity test'));
      final encrypted =
          await cryptoService.encrypt(plaintext, 'group1', 'deviceA');

      // Tamper with ciphertext (after nonce, before MAC)
      encrypted[15] ^= 0xFF;

      expect(
        () => cryptoService.decrypt(encrypted, 'group1', 'deviceA'),
        throwsA(isA<GroupCryptoException>().having(
          (e) => e.message,
          'message',
          contains('MAC verification failed'),
        )),
      );
    });

    test('decrypt fails with too-short data', () {
      expect(
        () => cryptoService.decrypt(
            Uint8List.fromList([1, 2, 3]), 'group1', 'deviceA'),
        throwsA(isA<GroupCryptoException>().having(
          (e) => e.message,
          'message',
          contains('too short'),
        )),
      );
    });

    test('encrypt fails without sender key', () {
      expect(
        () => cryptoService.encrypt(
          Uint8List.fromList(utf8.encode('test')),
          'group1',
          'deviceB', // No key set for deviceB
        ),
        throwsA(isA<GroupCryptoException>().having(
          (e) => e.message,
          'message',
          contains('No sender key'),
        )),
      );
    });

    test('large message encrypt and decrypt', () async {
      // 100KB message
      final largePayload = Uint8List(100 * 1024);
      for (var i = 0; i < largePayload.length; i++) {
        largePayload[i] = i % 256;
      }

      final encrypted =
          await cryptoService.encrypt(largePayload, 'group1', 'deviceA');
      final decrypted =
          await cryptoService.decrypt(encrypted, 'group1', 'deviceA');

      expect(decrypted, largePayload);
    });
  });

  group('Key rotation', () {
    test('old key cannot decrypt messages encrypted with new key', () async {
      final oldKey = await cryptoService.generateSenderKey();
      cryptoService.setSenderKey('group1', 'deviceA', oldKey);

      // Encrypt with old key
      final plaintext = Uint8List.fromList(utf8.encode('Before rotation'));
      final encryptedOld =
          await cryptoService.encrypt(plaintext, 'group1', 'deviceA');

      // Rotate key
      final newKey = await cryptoService.generateSenderKey();
      cryptoService.setSenderKey('group1', 'deviceA', newKey);

      // Encrypt with new key
      final encryptedNew = await cryptoService.encrypt(
        Uint8List.fromList(utf8.encode('After rotation')),
        'group1',
        'deviceA',
      );

      // Old ciphertext can no longer be decrypted (key changed)
      // This is expected since the in-memory key was replaced
      expect(
        () => cryptoService.decrypt(encryptedOld, 'group1', 'deviceA'),
        throwsA(isA<GroupCryptoException>()),
      );

      // New ciphertext works with new key
      final decryptedNew =
          await cryptoService.decrypt(encryptedNew, 'group1', 'deviceA');
      expect(utf8.decode(decryptedNew), 'After rotation');
    });

    test('removed member cannot decrypt with old key', () async {
      final memberKey = await cryptoService.generateSenderKey();

      // Set up keys for the group
      cryptoService.setSenderKey('group1', 'deviceA', memberKey);

      // Removed member still has the old key
      final removedMemberCrypto = GroupCryptoService();
      removedMemberCrypto.setSenderKey('group1', 'deviceA', memberKey);

      // Rotate key (new key unknown to removed member)
      final newKey = await cryptoService.generateSenderKey();
      cryptoService.setSenderKey('group1', 'deviceA', newKey);

      // Encrypt with new key
      final encrypted = await cryptoService.encrypt(
        Uint8List.fromList(utf8.encode('Post-rotation secret')),
        'group1',
        'deviceA',
      );

      // Removed member cannot decrypt
      expect(
        () => removedMemberCrypto.decrypt(encrypted, 'group1', 'deviceA'),
        throwsA(isA<GroupCryptoException>()),
      );
    });
  });

  group('Key export and import', () {
    test('exportGroupKeys and importGroupKeys roundtrip', () async {
      final key1 = await cryptoService.generateSenderKey();
      final key2 = await cryptoService.generateSenderKey();

      cryptoService.setSenderKey('group1', 'deviceA', key1);
      cryptoService.setSenderKey('group1', 'deviceB', key2);

      final exported = await cryptoService.exportGroupKeys('group1');

      expect(exported, hasLength(2));
      expect(exported.containsKey('deviceA'), isTrue);
      expect(exported.containsKey('deviceB'), isTrue);

      // Import into a fresh service
      final otherCrypto = GroupCryptoService();
      otherCrypto.importGroupKeys('group1', exported);

      expect(otherCrypto.hasSenderKey('group1', 'deviceA'), isTrue);
      expect(otherCrypto.hasSenderKey('group1', 'deviceB'), isTrue);

      // Verify the imported keys work for decryption
      final plaintext = Uint8List.fromList(utf8.encode('Import test'));
      final encrypted =
          await cryptoService.encrypt(plaintext, 'group1', 'deviceA');
      final decrypted =
          await otherCrypto.decrypt(encrypted, 'group1', 'deviceA');

      expect(utf8.decode(decrypted), 'Import test');
    });

    test('exportGroupKeys returns empty for unknown group', () async {
      final exported = await cryptoService.exportGroupKeys('unknown');
      expect(exported, isEmpty);
    });
  });
}
