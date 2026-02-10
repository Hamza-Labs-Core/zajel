import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/channels/models/channel.dart';
import 'package:zajel/features/channels/models/chunk.dart';
import 'package:zajel/features/channels/services/channel_crypto_service.dart';

void main() {
  late ChannelCryptoService cryptoService;

  setUp(() {
    cryptoService = ChannelCryptoService();
  });

  group('Key generation', () {
    test('generateSigningKeyPair produces valid Ed25519 keys', () async {
      final keys = await cryptoService.generateSigningKeyPair();

      expect(keys.publicKey, isNotEmpty);
      expect(keys.privateKey, isNotEmpty);

      // Ed25519 public key = 32 bytes, private seed = 32 bytes
      final publicBytes = base64Decode(keys.publicKey);
      final privateBytes = base64Decode(keys.privateKey);

      expect(publicBytes.length, 32);
      expect(privateBytes.length, 32);
    });

    test('generateSigningKeyPair produces unique keys each time', () async {
      final keys1 = await cryptoService.generateSigningKeyPair();
      final keys2 = await cryptoService.generateSigningKeyPair();

      expect(keys1.publicKey, isNot(keys2.publicKey));
      expect(keys1.privateKey, isNot(keys2.privateKey));
    });

    test('generateEncryptionKeyPair produces valid X25519 keys', () async {
      final keys = await cryptoService.generateEncryptionKeyPair();

      expect(keys.publicKey, isNotEmpty);
      expect(keys.privateKey, isNotEmpty);

      final publicBytes = base64Decode(keys.publicKey);
      final privateBytes = base64Decode(keys.privateKey);

      expect(publicBytes.length, 32);
      expect(privateBytes.length, 32);
    });

    test('generateEncryptionKeyPair produces unique keys each time', () async {
      final keys1 = await cryptoService.generateEncryptionKeyPair();
      final keys2 = await cryptoService.generateEncryptionKeyPair();

      expect(keys1.publicKey, isNot(keys2.publicKey));
      expect(keys1.privateKey, isNot(keys2.privateKey));
    });

    test('deriveChannelId produces deterministic hex string', () async {
      final keys = await cryptoService.generateSigningKeyPair();
      final id1 = await cryptoService.deriveChannelId(keys.publicKey);
      final id2 = await cryptoService.deriveChannelId(keys.publicKey);

      expect(id1, id2);
      // 16 bytes = 32 hex chars
      expect(id1.length, 32);
      // All lowercase hex
      expect(RegExp(r'^[0-9a-f]{32}$').hasMatch(id1), isTrue);
    });

    test('different public keys produce different channel IDs', () async {
      final keys1 = await cryptoService.generateSigningKeyPair();
      final keys2 = await cryptoService.generateSigningKeyPair();
      final id1 = await cryptoService.deriveChannelId(keys1.publicKey);
      final id2 = await cryptoService.deriveChannelId(keys2.publicKey);

      expect(id1, isNot(id2));
    });
  });

  group('Manifest signing and verification', () {
    late String ownerPublicKey;
    late String ownerPrivateKey;
    late String encryptionPublicKey;

    setUp(() async {
      final signingKeys = await cryptoService.generateSigningKeyPair();
      ownerPublicKey = signingKeys.publicKey;
      ownerPrivateKey = signingKeys.privateKey;

      final encryptionKeys = await cryptoService.generateEncryptionKeyPair();
      encryptionPublicKey = encryptionKeys.publicKey;
    });

    test('signManifest produces a non-empty signature', () async {
      final channelId = await cryptoService.deriveChannelId(ownerPublicKey);
      final manifest = ChannelManifest(
        channelId: channelId,
        name: 'Test Channel',
        description: 'A test channel',
        ownerKey: ownerPublicKey,
        currentEncryptKey: encryptionPublicKey,
        keyEpoch: 1,
      );

      final signed =
          await cryptoService.signManifest(manifest, ownerPrivateKey);

      expect(signed.signature, isNotEmpty);
      expect(() => base64Decode(signed.signature), returnsNormally);
    });

    test('verifyManifest returns true for a validly signed manifest', () async {
      final channelId = await cryptoService.deriveChannelId(ownerPublicKey);
      final manifest = ChannelManifest(
        channelId: channelId,
        name: 'Test Channel',
        description: 'A test channel',
        ownerKey: ownerPublicKey,
        currentEncryptKey: encryptionPublicKey,
        keyEpoch: 1,
      );

      final signed =
          await cryptoService.signManifest(manifest, ownerPrivateKey);
      final isValid = await cryptoService.verifyManifest(signed);

      expect(isValid, isTrue);
    });

    test('verifyManifest returns false for an unsigned manifest', () async {
      final manifest = ChannelManifest(
        channelId: 'test-id',
        name: 'Test Channel',
        description: '',
        ownerKey: ownerPublicKey,
        currentEncryptKey: encryptionPublicKey,
      );

      final isValid = await cryptoService.verifyManifest(manifest);
      expect(isValid, isFalse);
    });

    test('verifyManifest returns false for tampered manifest', () async {
      final channelId = await cryptoService.deriveChannelId(ownerPublicKey);
      final manifest = ChannelManifest(
        channelId: channelId,
        name: 'Test Channel',
        description: 'Original description',
        ownerKey: ownerPublicKey,
        currentEncryptKey: encryptionPublicKey,
      );

      final signed =
          await cryptoService.signManifest(manifest, ownerPrivateKey);

      // Tamper with the name
      final tampered = signed.copyWith(name: 'Tampered Name');
      final isValid = await cryptoService.verifyManifest(tampered);

      expect(isValid, isFalse);
    });

    test('verifyManifest returns false for wrong owner key', () async {
      final otherKeys = await cryptoService.generateSigningKeyPair();
      final channelId = await cryptoService.deriveChannelId(ownerPublicKey);

      final manifest = ChannelManifest(
        channelId: channelId,
        name: 'Test Channel',
        description: '',
        ownerKey: ownerPublicKey,
        currentEncryptKey: encryptionPublicKey,
      );

      // Sign with the real owner key
      final signed =
          await cryptoService.signManifest(manifest, ownerPrivateKey);

      // Replace owner_key with a different key (but keep the original signature)
      final swapped = signed.copyWith(ownerKey: otherKeys.publicKey);
      final isValid = await cryptoService.verifyManifest(swapped);

      expect(isValid, isFalse);
    });

    test('manifest with admin keys signs and verifies correctly', () async {
      final adminKeys = await cryptoService.generateSigningKeyPair();
      final channelId = await cryptoService.deriveChannelId(ownerPublicKey);

      final manifest = ChannelManifest(
        channelId: channelId,
        name: 'Multi-Admin Channel',
        description: 'Has admins',
        ownerKey: ownerPublicKey,
        adminKeys: [AdminKey(key: adminKeys.publicKey, label: 'Admin 1')],
        currentEncryptKey: encryptionPublicKey,
        keyEpoch: 3,
        rules: const ChannelRules(repliesEnabled: false, pollsEnabled: true),
      );

      final signed =
          await cryptoService.signManifest(manifest, ownerPrivateKey);
      final isValid = await cryptoService.verifyManifest(signed);

      expect(isValid, isTrue);
    });
  });

  group('Chunk payload encryption and decryption', () {
    late String encryptionPrivateKey;

    setUp(() async {
      final keys = await cryptoService.generateEncryptionKeyPair();
      encryptionPrivateKey = keys.privateKey;
    });

    test('encrypt then decrypt returns original payload', () async {
      final payload = ChunkPayload(
        type: ContentType.text,
        payload: Uint8List.fromList(utf8.encode('Hello, channel!')),
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final encrypted = await cryptoService.encryptPayload(
        payload,
        encryptionPrivateKey,
        1,
      );

      final decrypted = await cryptoService.decryptPayload(
        encrypted,
        encryptionPrivateKey,
        1,
      );

      expect(utf8.decode(decrypted.payload), 'Hello, channel!');
      expect(decrypted.type, ContentType.text);
      expect(decrypted.timestamp, DateTime.utc(2026, 2, 10));
    });

    test('different key epochs produce different ciphertexts', () async {
      final payload = ChunkPayload(
        type: ContentType.text,
        payload: Uint8List.fromList(utf8.encode('Same message')),
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final encrypted1 = await cryptoService.encryptPayload(
        payload,
        encryptionPrivateKey,
        1,
      );
      final encrypted2 = await cryptoService.encryptPayload(
        payload,
        encryptionPrivateKey,
        2,
      );

      // Different epoch = different derived key = different ciphertext
      expect(encrypted1, isNot(encrypted2));
    });

    test('decryption with wrong epoch fails', () async {
      final payload = ChunkPayload(
        type: ContentType.text,
        payload: Uint8List.fromList(utf8.encode('Epoch-bound')),
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final encrypted = await cryptoService.encryptPayload(
        payload,
        encryptionPrivateKey,
        1,
      );

      expect(
        () => cryptoService.decryptPayload(encrypted, encryptionPrivateKey, 2),
        throwsA(isA<ChannelCryptoException>()),
      );
    });

    test('decryption with wrong key fails', () async {
      final otherKeys = await cryptoService.generateEncryptionKeyPair();
      final payload = ChunkPayload(
        type: ContentType.text,
        payload: Uint8List.fromList(utf8.encode('Key-bound')),
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final encrypted = await cryptoService.encryptPayload(
        payload,
        encryptionPrivateKey,
        1,
      );

      expect(
        () => cryptoService.decryptPayload(encrypted, otherKeys.privateKey, 1),
        throwsA(isA<ChannelCryptoException>()),
      );
    });

    test('payload with metadata roundtrips correctly', () async {
      final payload = ChunkPayload(
        type: ContentType.file,
        payload: Uint8List.fromList([0, 1, 2, 3, 4, 5]),
        metadata: {'filename': 'test.pdf', 'mimetype': 'application/pdf'},
        replyTo: 'msg_123',
        author: 'admin_1',
        timestamp: DateTime.utc(2026, 2, 10, 14, 30),
      );

      final encrypted = await cryptoService.encryptPayload(
        payload,
        encryptionPrivateKey,
        1,
      );
      final decrypted = await cryptoService.decryptPayload(
        encrypted,
        encryptionPrivateKey,
        1,
      );

      expect(decrypted.type, ContentType.file);
      expect(decrypted.payload, [0, 1, 2, 3, 4, 5]);
      expect(decrypted.metadata['filename'], 'test.pdf');
      expect(decrypted.metadata['mimetype'], 'application/pdf');
      expect(decrypted.replyTo, 'msg_123');
      expect(decrypted.author, 'admin_1');
      expect(decrypted.timestamp, DateTime.utc(2026, 2, 10, 14, 30));
    });

    test('decryption with tampered ciphertext reports MAC failure', () async {
      final payload = ChunkPayload(
        type: ContentType.text,
        payload: Uint8List.fromList(utf8.encode('Tamper test')),
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final encrypted = await cryptoService.encryptPayload(
        payload,
        encryptionPrivateKey,
        1,
      );

      // Tamper with the ciphertext portion (after nonce, before MAC)
      encrypted[15] ^= 0xFF;

      expect(
        () => cryptoService.decryptPayload(encrypted, encryptionPrivateKey, 1),
        throwsA(isA<ChannelCryptoException>().having(
          (e) => e.message,
          'message',
          contains('MAC verification failed'),
        )),
      );
    });

    test('decryption of truncated ciphertext fails', () async {
      expect(
        () => cryptoService.decryptPayload(
          Uint8List.fromList([1, 2, 3]),
          encryptionPrivateKey,
          1,
        ),
        throwsA(isA<ChannelCryptoException>().having(
          (e) => e.message,
          'message',
          contains('too short'),
        )),
      );
    });
  });

  group('Chunk signing and verification', () {
    late String signingPublicKey;
    late String signingPrivateKey;

    setUp(() async {
      final keys = await cryptoService.generateSigningKeyPair();
      signingPublicKey = keys.publicKey;
      signingPrivateKey = keys.privateKey;
    });

    test('signChunk produces a valid signature', () async {
      final data = Uint8List.fromList(utf8.encode('encrypted chunk data'));
      final signature = await cryptoService.signChunk(data, signingPrivateKey);

      expect(signature, isNotEmpty);
      expect(() => base64Decode(signature), returnsNormally);
      // Ed25519 signature = 64 bytes
      expect(base64Decode(signature).length, 64);
    });

    test('verifyChunkSignature returns true for valid chunk', () async {
      final data = Uint8List.fromList(utf8.encode('encrypted chunk data'));
      final signature = await cryptoService.signChunk(data, signingPrivateKey);

      final chunk = Chunk(
        chunkId: 'ch_test_001',
        routingHash: 'rh_test',
        sequence: 1,
        chunkIndex: 0,
        totalChunks: 1,
        size: data.length,
        signature: signature,
        authorPubkey: signingPublicKey,
        encryptedPayload: data,
      );

      final isValid = await cryptoService.verifyChunkSignature(chunk);
      expect(isValid, isTrue);
    });

    test('verifyChunkSignature returns false for tampered payload', () async {
      final data = Uint8List.fromList(utf8.encode('original data'));
      final signature = await cryptoService.signChunk(data, signingPrivateKey);

      final tampered = Uint8List.fromList(utf8.encode('tampered data'));
      final chunk = Chunk(
        chunkId: 'ch_test_001',
        routingHash: 'rh_test',
        sequence: 1,
        chunkIndex: 0,
        totalChunks: 1,
        size: tampered.length,
        signature: signature,
        authorPubkey: signingPublicKey,
        encryptedPayload: tampered,
      );

      final isValid = await cryptoService.verifyChunkSignature(chunk);
      expect(isValid, isFalse);
    });

    test('verifyChunkSignature returns false for wrong author key', () async {
      final otherKeys = await cryptoService.generateSigningKeyPair();
      final data = Uint8List.fromList(utf8.encode('encrypted chunk data'));
      final signature = await cryptoService.signChunk(data, signingPrivateKey);

      final chunk = Chunk(
        chunkId: 'ch_test_001',
        routingHash: 'rh_test',
        sequence: 1,
        chunkIndex: 0,
        totalChunks: 1,
        size: data.length,
        signature: signature,
        authorPubkey: otherKeys.publicKey, // Wrong key
        encryptedPayload: data,
      );

      final isValid = await cryptoService.verifyChunkSignature(chunk);
      expect(isValid, isFalse);
    });
  });

  group('Subscriber verification (5-step check)', () {
    late String ownerPublicKey;
    late String ownerPrivateKey;
    late String encryptionPublicKey;
    late String encryptionPrivateKey;
    late ChannelManifest signedManifest;

    setUp(() async {
      final signingKeys = await cryptoService.generateSigningKeyPair();
      ownerPublicKey = signingKeys.publicKey;
      ownerPrivateKey = signingKeys.privateKey;

      final encryptionKeys = await cryptoService.generateEncryptionKeyPair();
      encryptionPublicKey = encryptionKeys.publicKey;
      encryptionPrivateKey = encryptionKeys.privateKey;

      final channelId = await cryptoService.deriveChannelId(ownerPublicKey);
      final manifest = ChannelManifest(
        channelId: channelId,
        name: 'Verified Channel',
        description: 'For testing verification',
        ownerKey: ownerPublicKey,
        currentEncryptKey: encryptionPublicKey,
        keyEpoch: 1,
      );
      signedManifest =
          await cryptoService.signManifest(manifest, ownerPrivateKey);
    });

    /// Helper to create a valid signed chunk with encrypted payload.
    Future<Chunk> createValidChunk() async {
      final payload = ChunkPayload(
        type: ContentType.text,
        payload: Uint8List.fromList(utf8.encode('Verified message')),
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final encrypted = await cryptoService.encryptPayload(
        payload,
        encryptionPrivateKey,
        signedManifest.keyEpoch,
      );

      final signature =
          await cryptoService.signChunk(encrypted, ownerPrivateKey);

      return Chunk(
        chunkId: 'ch_valid_000',
        routingHash: 'rh_test',
        sequence: 1,
        chunkIndex: 0,
        totalChunks: 1,
        size: encrypted.length,
        signature: signature,
        authorPubkey: ownerPublicKey,
        encryptedPayload: encrypted,
      );
    }

    test('all 5 steps pass for a valid chunk from the owner', () async {
      final chunk = await createValidChunk();

      final decrypted = await cryptoService.verifyAndDecryptChunk(
        chunk: chunk,
        manifest: signedManifest,
        trustedOwnerKey: ownerPublicKey,
        encryptionPrivateKeyBase64: encryptionPrivateKey,
      );

      expect(utf8.decode(decrypted.payload), 'Verified message');
      expect(decrypted.type, ContentType.text);
    });

    test('step 1 fails: invalid chunk signature', () async {
      final chunk = await createValidChunk();
      // Tamper with the payload after signing
      final tampered = chunk.copyWith(
        encryptedPayload: Uint8List.fromList([
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0
        ]),
      );

      expect(
        () => cryptoService.verifyAndDecryptChunk(
          chunk: tampered,
          manifest: signedManifest,
          trustedOwnerKey: ownerPublicKey,
          encryptionPrivateKeyBase64: encryptionPrivateKey,
        ),
        throwsA(isA<ChannelCryptoException>().having(
          (e) => e.message,
          'message',
          contains('Step 1'),
        )),
      );
    });

    test('step 2 fails: author not in manifest', () async {
      final intruderKeys = await cryptoService.generateSigningKeyPair();

      // Create a chunk signed by someone not in the manifest
      final payload = ChunkPayload(
        type: ContentType.text,
        payload: Uint8List.fromList(utf8.encode('Intruder message')),
        timestamp: DateTime.utc(2026, 2, 10),
      );
      final encrypted = await cryptoService.encryptPayload(
        payload,
        encryptionPrivateKey,
        signedManifest.keyEpoch,
      );
      final signature =
          await cryptoService.signChunk(encrypted, intruderKeys.privateKey);

      final chunk = Chunk(
        chunkId: 'ch_intruder_000',
        routingHash: 'rh_test',
        sequence: 1,
        chunkIndex: 0,
        totalChunks: 1,
        size: encrypted.length,
        signature: signature,
        authorPubkey: intruderKeys.publicKey,
        encryptedPayload: encrypted,
      );

      expect(
        () => cryptoService.verifyAndDecryptChunk(
          chunk: chunk,
          manifest: signedManifest,
          trustedOwnerKey: ownerPublicKey,
          encryptionPrivateKeyBase64: encryptionPrivateKey,
        ),
        throwsA(isA<ChannelCryptoException>().having(
          (e) => e.message,
          'message',
          contains('Step 2'),
        )),
      );
    });

    test('step 2 passes for an authorized admin', () async {
      final adminKeys = await cryptoService.generateSigningKeyPair();

      // Update manifest with admin
      final manifestWithAdmin = signedManifest.copyWith(
        adminKeys: [AdminKey(key: adminKeys.publicKey, label: 'Test Admin')],
        signature: '',
      );
      final resignedManifest = await cryptoService.signManifest(
        manifestWithAdmin,
        ownerPrivateKey,
      );

      // Create chunk signed by the admin
      final payload = ChunkPayload(
        type: ContentType.text,
        payload: Uint8List.fromList(utf8.encode('Admin message')),
        timestamp: DateTime.utc(2026, 2, 10),
      );
      final encrypted = await cryptoService.encryptPayload(
        payload,
        encryptionPrivateKey,
        resignedManifest.keyEpoch,
      );
      final signature =
          await cryptoService.signChunk(encrypted, adminKeys.privateKey);

      final chunk = Chunk(
        chunkId: 'ch_admin_000',
        routingHash: 'rh_test',
        sequence: 1,
        chunkIndex: 0,
        totalChunks: 1,
        size: encrypted.length,
        signature: signature,
        authorPubkey: adminKeys.publicKey,
        encryptedPayload: encrypted,
      );

      final decrypted = await cryptoService.verifyAndDecryptChunk(
        chunk: chunk,
        manifest: resignedManifest,
        trustedOwnerKey: ownerPublicKey,
        encryptionPrivateKeyBase64: encryptionPrivateKey,
      );

      expect(utf8.decode(decrypted.payload), 'Admin message');
    });

    test('step 3 fails: manifest signature is invalid', () async {
      final chunk = await createValidChunk();

      // Tamper with the manifest (change name but keep old signature)
      final tamperedManifest = signedManifest.copyWith(name: 'Tampered');

      expect(
        () => cryptoService.verifyAndDecryptChunk(
          chunk: chunk,
          manifest: tamperedManifest,
          trustedOwnerKey: ownerPublicKey,
          encryptionPrivateKeyBase64: encryptionPrivateKey,
        ),
        throwsA(isA<ChannelCryptoException>().having(
          (e) => e.message,
          'message',
          contains('Step 3'),
        )),
      );
    });

    test('step 4 fails: owner key does not match trusted key', () async {
      final chunk = await createValidChunk();
      final otherKeys = await cryptoService.generateSigningKeyPair();

      expect(
        () => cryptoService.verifyAndDecryptChunk(
          chunk: chunk,
          manifest: signedManifest,
          trustedOwnerKey: otherKeys.publicKey, // Wrong trusted key
          encryptionPrivateKeyBase64: encryptionPrivateKey,
        ),
        throwsA(isA<ChannelCryptoException>().having(
          (e) => e.message,
          'message',
          contains('Step 4'),
        )),
      );
    });

    test('step 5 fails: wrong decryption key', () async {
      final chunk = await createValidChunk();
      final otherEncKeys = await cryptoService.generateEncryptionKeyPair();

      expect(
        () => cryptoService.verifyAndDecryptChunk(
          chunk: chunk,
          manifest: signedManifest,
          trustedOwnerKey: ownerPublicKey,
          encryptionPrivateKeyBase64: otherEncKeys.privateKey, // Wrong key
        ),
        throwsA(isA<ChannelCryptoException>().having(
          (e) => e.message,
          'message',
          contains('Step 5'),
        )),
      );
    });
  });
}
