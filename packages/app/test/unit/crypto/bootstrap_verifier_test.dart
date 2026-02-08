import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/crypto/bootstrap_verifier.dart';

void main() {
  group('BootstrapVerifier', () {
    late Ed25519 ed25519;
    late SimpleKeyPair keyPair;
    late String publicKeyBase64;

    setUp(() async {
      ed25519 = Ed25519();
      keyPair = await ed25519.newKeyPair();
      final publicKey = await keyPair.extractPublicKey();
      publicKeyBase64 = base64Encode(publicKey.bytes);
    });

    Future<String> signPayload(String payload) async {
      final data = utf8.encode(payload);
      final signature = await ed25519.sign(data, keyPair: keyPair);
      return base64Encode(signature.bytes);
    }

    Map<String, dynamic> makePayload({int? timestamp}) {
      return {
        'servers': [
          {
            'serverId': 'ed25519:test',
            'endpoint': 'wss://test.example.com',
            'publicKey': 'test-key',
            'region': 'eu-west',
            'registeredAt': 1000,
            'lastSeen': 2000,
          }
        ],
        'timestamp': timestamp ?? DateTime.now().millisecondsSinceEpoch,
      };
    }

    test('valid signature with fresh timestamp returns true', () async {
      final verifier = BootstrapVerifier.withKey(publicKeyBase64);
      final payload = makePayload();
      final body = jsonEncode(payload);
      final sig = await signPayload(body);

      final result = await verifier.verify(body, sig);
      expect(result, isTrue);
    });

    test('invalid signature returns false', () async {
      final verifier = BootstrapVerifier.withKey(publicKeyBase64);
      final payload = makePayload();
      final body = jsonEncode(payload);

      // Create a bogus signature (64 bytes of zeros)
      final bogusSig = base64Encode(List.filled(64, 0));

      final result = await verifier.verify(body, bogusSig);
      expect(result, isFalse);
    });

    test('tampered body returns false', () async {
      final verifier = BootstrapVerifier.withKey(publicKeyBase64);
      final payload = makePayload();
      final body = jsonEncode(payload);
      final sig = await signPayload(body);

      // Tamper with the body
      final tampered = '${body}x';
      final result = await verifier.verify(tampered, sig);
      expect(result, isFalse);
    });

    test('expired timestamp returns false', () async {
      final verifier = BootstrapVerifier.withKey(publicKeyBase64);
      // Timestamp 10 minutes in the past
      final oldTimestamp =
          DateTime.now().subtract(const Duration(minutes: 10)).millisecondsSinceEpoch;
      final payload = makePayload(timestamp: oldTimestamp);
      final body = jsonEncode(payload);
      final sig = await signPayload(body);

      final result = await verifier.verify(body, sig);
      expect(result, isFalse);
    });

    test('missing timestamp returns false', () async {
      final verifier = BootstrapVerifier.withKey(publicKeyBase64);
      final payload = {'servers': []};
      final body = jsonEncode(payload);
      final sig = await signPayload(body);

      final result = await verifier.verify(body, sig);
      expect(result, isFalse);
    });

    test('timestamp near max age boundary returns true', () async {
      final verifier = BootstrapVerifier.withKey(publicKeyBase64);
      // Timestamp 4 minutes 50 seconds ago (just inside the 5-minute window)
      final nearBoundary = DateTime.now()
          .subtract(const Duration(minutes: 4, seconds: 50))
          .millisecondsSinceEpoch;
      final payload = makePayload(timestamp: nearBoundary);
      final body = jsonEncode(payload);
      final sig = await signPayload(body);

      final result = await verifier.verify(body, sig);
      expect(result, isTrue);
    });

    test('future timestamp within max age returns true', () async {
      final verifier = BootstrapVerifier.withKey(publicKeyBase64);
      // Timestamp 2 minutes in the future (minor clock skew)
      final futureTimestamp =
          DateTime.now().add(const Duration(minutes: 2)).millisecondsSinceEpoch;
      final payload = makePayload(timestamp: futureTimestamp);
      final body = jsonEncode(payload);
      final sig = await signPayload(body);

      final result = await verifier.verify(body, sig);
      expect(result, isTrue);
    });

    test('wrong public key returns false', () async {
      // Generate a different keypair
      final otherKeyPair = await ed25519.newKeyPair();
      final otherPublicKey = await otherKeyPair.extractPublicKey();
      final otherPubBase64 = base64Encode(otherPublicKey.bytes);

      // Verifier uses the "other" public key
      final verifier = BootstrapVerifier.withKey(otherPubBase64);

      // But the payload is signed with the original key
      final payload = makePayload();
      final body = jsonEncode(payload);
      final sig = await signPayload(body);

      final result = await verifier.verify(body, sig);
      expect(result, isFalse);
    });

    test('malformed signature base64 returns false', () async {
      final verifier = BootstrapVerifier.withKey(publicKeyBase64);
      final payload = makePayload();
      final body = jsonEncode(payload);

      final result = await verifier.verify(body, 'not-valid-base64!!!');
      expect(result, isFalse);
    });

    test('empty body returns false', () async {
      final verifier = BootstrapVerifier.withKey(publicKeyBase64);
      final sig = await signPayload('');

      final result = await verifier.verify('', sig);
      // Empty body has no timestamp, so it should fail
      expect(result, isFalse);
    });
  });
}
