// Cross-platform crypto interop test.
//
// Verifies that the Dart crypto implementation produces the same
// session keys and ciphertexts as the Python headless client.
// Uses deterministic keys for reproducibility.
import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('Cross-platform crypto interop', () {
    test('HKDF-SHA256 produces expected session key from known shared secret',
        () async {
      // Known shared secret (from Python test):
      // 73b8ab88d1b50f58eadcef6b4c51ee5063b8d192785d46be71bb727168331a4d
      final sharedSecret = Uint8List.fromList([
        0x73, 0xb8, 0xab, 0x88, 0xd1, 0xb5, 0x0f, 0x58,
        0xea, 0xdc, 0xef, 0x6b, 0x4c, 0x51, 0xee, 0x50,
        0x63, 0xb8, 0xd1, 0x92, 0x78, 0x5d, 0x46, 0xbe,
        0x71, 0xbb, 0x72, 0x71, 0x68, 0x33, 0x1a, 0x4d,
      ]);

      // Expected session key from Python:
      // 29948114a67ab050cb523528a5b042dc5f138df9f6c0d75a96115f8025f83236
      final expectedSessionKey = Uint8List.fromList([
        0x29, 0x94, 0x81, 0x14, 0xa6, 0x7a, 0xb0, 0x50,
        0xcb, 0x52, 0x35, 0x28, 0xa5, 0xb0, 0x42, 0xdc,
        0x5f, 0x13, 0x8d, 0xf9, 0xf6, 0xc0, 0xd7, 0x5a,
        0x96, 0x11, 0x5f, 0x80, 0x25, 0xf8, 0x32, 0x36,
      ]);

      // Replicate CryptoService.establishSession HKDF derivation
      final hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: 32);
      final sessionKey = await hkdf.deriveKey(
        secretKey: SecretKey(sharedSecret),
        info: utf8.encode('zajel_session'),
        nonce: const [],
      );

      final sessionKeyBytes = await sessionKey.extractBytes();
      final sessionKeyHex = sessionKeyBytes
          .map((b) => b.toRadixString(16).padLeft(2, '0'))
          .join();

      expect(
        sessionKeyHex,
        '29948114a67ab050cb523528a5b042dc5f138df9f6c0d75a96115f8025f83236',
        reason: 'Dart HKDF must match Python HKDF output',
      );

      expect(
        Uint8List.fromList(sessionKeyBytes),
        expectedSessionKey,
        reason: 'Session key bytes must match exactly',
      );
    });

    test('ChaCha20-Poly1305 encrypt/decrypt interop with Python', () async {
      // Session key from above
      final sessionKeyBytes = Uint8List.fromList([
        0x29, 0x94, 0x81, 0x14, 0xa6, 0x7a, 0xb0, 0x50,
        0xcb, 0x52, 0x35, 0x28, 0xa5, 0xb0, 0x42, 0xdc,
        0x5f, 0x13, 0x8d, 0xf9, 0xf6, 0xc0, 0xd7, 0x5a,
        0x96, 0x11, 0x5f, 0x80, 0x25, 0xf8, 0x32, 0x36,
      ]);
      final sessionKey = SecretKey(sessionKeyBytes);

      // Python encrypted "hello from python" with zero nonce:
      // base64: AAAAAAAAAAAAAAAA5ra13Xvf23TzPAlkW/L0GAC9tPRtw9jKO9ZUAAP1HqUq
      final pythonEncrypted = 'AAAAAAAAAAAAAAAA5ra13Xvf23TzPAlkW/L0GAC9tPRtw9jKO9ZUAAP1HqUq';

      // Decrypt the Python-encrypted message in Dart
      final combined = base64Decode(pythonEncrypted);
      const nonceLength = 12;
      const macLength = 16;

      final nonce = combined.sublist(0, nonceLength);
      final cipherText = combined.sublist(nonceLength, combined.length - macLength);
      final mac = Mac(combined.sublist(combined.length - macLength));

      final secretBox = SecretBox(
        cipherText,
        nonce: nonce,
        mac: mac,
      );

      final chacha20 = Chacha20.poly1305Aead();
      final plaintextBytes = await chacha20.decrypt(
        secretBox,
        secretKey: sessionKey,
      );

      expect(utf8.decode(plaintextBytes), 'hello from python');
    });

    test('Dart encryption can be decrypted with same key', () async {
      final sessionKeyBytes = Uint8List.fromList([
        0x29, 0x94, 0x81, 0x14, 0xa6, 0x7a, 0xb0, 0x50,
        0xcb, 0x52, 0x35, 0x28, 0xa5, 0xb0, 0x42, 0xdc,
        0x5f, 0x13, 0x8d, 0xf9, 0xf6, 0xc0, 0xd7, 0x5a,
        0x96, 0x11, 0x5f, 0x80, 0x25, 0xf8, 0x32, 0x36,
      ]);
      final sessionKey = SecretKey(sessionKeyBytes);
      final chacha20 = Chacha20.poly1305Aead();

      // Encrypt in Dart
      final plaintext = 'hello from dart';
      final plaintextBytes = utf8.encode(plaintext);
      final nonce = chacha20.newNonce();

      final secretBox = await chacha20.encrypt(
        plaintextBytes,
        secretKey: sessionKey,
        nonce: nonce,
      );

      // Combine nonce + ciphertext + mac (same format as CryptoService.encrypt)
      final combined = Uint8List(
        nonce.length + secretBox.cipherText.length + secretBox.mac.bytes.length,
      );
      combined.setAll(0, nonce);
      combined.setAll(nonce.length, secretBox.cipherText);
      combined.setAll(
          nonce.length + secretBox.cipherText.length, secretBox.mac.bytes);

      final encrypted = base64Encode(combined);

      // Now decrypt (same format as CryptoService.decrypt)
      final decoded = base64Decode(encrypted);
      final decNonce = decoded.sublist(0, 12);
      final decCipherText = decoded.sublist(12, decoded.length - 16);
      final decMac = Mac(decoded.sublist(decoded.length - 16));

      final decSecretBox = SecretBox(
        decCipherText,
        nonce: decNonce,
        mac: decMac,
      );

      final decrypted = await chacha20.decrypt(
        decSecretBox,
        secretKey: sessionKey,
      );

      expect(utf8.decode(decrypted), plaintext);
    });

    test('X25519 key exchange produces same shared secret as Python', () async {
      // Alice's private key seed (sha256 of 'alice_test_seed')
      // 661fe849ec958ba761fcfa10e617228b464bb72f9632a94d2aa25534255468d7
      final aliceSeed = Uint8List.fromList([
        0x66, 0x1f, 0xe8, 0x49, 0xec, 0x95, 0x8b, 0xa7,
        0x61, 0xfc, 0xfa, 0x10, 0xe6, 0x17, 0x22, 0x8b,
        0x46, 0x4b, 0xb7, 0x2f, 0x96, 0x32, 0xa9, 0x4d,
        0x2a, 0xa2, 0x55, 0x34, 0x25, 0x54, 0x68, 0xd7,
      ]);

      // Bob's public key base64 from Python: OnXrT/cmMhWjNL/IZIU+q5gdsJN53aGuv1c8DUreFWg=
      final bobPubKeyBase64 = 'OnXrT/cmMhWjNL/IZIU+q5gdsJN53aGuv1c8DUreFWg=';
      final bobPubKeyBytes = base64Decode(bobPubKeyBase64);

      final x25519 = X25519();
      final aliceKeyPair = await x25519.newKeyPairFromSeed(aliceSeed);
      final alicePubKey = await aliceKeyPair.extractPublicKey();

      // Verify Alice's public key matches Python
      final alicePubBase64 = base64Encode(Uint8List.fromList(alicePubKey.bytes));
      expect(alicePubBase64, 'RsXnEIUkURFHkmUEXWq+kS4Xi621h2dvlF2RMFfcMAs=',
          reason: 'Alice public key must match Python');

      // Perform key exchange
      final bobPubKey = SimplePublicKey(
        bobPubKeyBytes,
        type: KeyPairType.x25519,
      );
      final sharedSecret = await x25519.sharedSecretKey(
        keyPair: aliceKeyPair,
        remotePublicKey: bobPubKey,
      );

      final sharedSecretBytes = await sharedSecret.extractBytes();
      final sharedSecretHex = sharedSecretBytes
          .map((b) => b.toRadixString(16).padLeft(2, '0'))
          .join();

      expect(
        sharedSecretHex,
        '73b8ab88d1b50f58eadcef6b4c51ee5063b8d192785d46be71bb727168331a4d',
        reason: 'Shared secret must match Python X25519 output',
      );
    });
  });
}
