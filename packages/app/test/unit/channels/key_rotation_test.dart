import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/channels/models/channel.dart';
import 'package:zajel/features/channels/models/chunk.dart';
import 'package:zajel/features/channels/services/admin_management_service.dart';
import 'package:zajel/features/channels/services/channel_crypto_service.dart';
import 'package:zajel/features/channels/services/channel_service.dart';
import 'package:zajel/features/channels/services/routing_hash_service.dart';

import 'channel_service_test.dart';

void main() {
  late ChannelCryptoService cryptoService;
  late FakeChannelStorageService storageService;
  late ChannelService channelService;
  late AdminManagementService adminService;
  late RoutingHashService routingHashService;

  setUp(() {
    cryptoService = ChannelCryptoService();
    storageService = FakeChannelStorageService();
    channelService = ChannelService(
      cryptoService: cryptoService,
      storageService: storageService,
    );
    adminService = AdminManagementService(
      cryptoService: cryptoService,
      storageService: storageService,
    );
    routingHashService = RoutingHashService();
  });

  group('Key rotation on admin removal', () {
    late Channel ownerChannel;
    late String admin1PublicKey;
    late String admin1PrivateKey;
    late String admin2PublicKey;
    late String admin2PrivateKey;

    setUp(() async {
      ownerChannel = await channelService.createChannel(
        name: 'Key Rotation Test',
      );

      final admin1Keys = await cryptoService.generateSigningKeyPair();
      admin1PublicKey = admin1Keys.publicKey;
      admin1PrivateKey = admin1Keys.privateKey;

      final admin2Keys = await cryptoService.generateSigningKeyPair();
      admin2PublicKey = admin2Keys.publicKey;
      admin2PrivateKey = admin2Keys.privateKey;

      ownerChannel = await adminService.appointAdmin(
        channel: ownerChannel,
        adminPublicKey: admin1PublicKey,
        adminLabel: 'Admin 1',
      );
      ownerChannel = await adminService.appointAdmin(
        channel: ownerChannel,
        adminPublicKey: admin2PublicKey,
        adminLabel: 'Admin 2',
      );
    });

    test('removing admin 1 rotates key, admin 2 still authorized', () async {
      final channelAfterRemoval = await adminService.removeAdmin(
        channel: ownerChannel,
        adminPublicKey: admin1PublicKey,
      );

      // Key should be rotated
      expect(channelAfterRemoval.manifest.keyEpoch,
          ownerChannel.manifest.keyEpoch + 1);
      expect(channelAfterRemoval.encryptionKeyPrivate,
          isNot(ownerChannel.encryptionKeyPrivate));

      // Admin 2 is still in the manifest
      expect(channelAfterRemoval.manifest.adminKeys, hasLength(1));
      expect(channelAfterRemoval.manifest.adminKeys.first.key,
          admin2PublicKey);

      // Admin 2 can still publish content that passes verification
      final payload = ChunkPayload(
        type: ContentType.text,
        payload: Uint8List.fromList(utf8.encode('Admin 2 still here')),
        author: admin2PublicKey,
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final encrypted = await cryptoService.encryptPayload(
        payload,
        channelAfterRemoval.encryptionKeyPrivate!,
        channelAfterRemoval.manifest.keyEpoch,
      );

      final signature =
          await cryptoService.signChunk(encrypted, admin2PrivateKey);

      final chunk = Chunk(
        chunkId: 'ch_admin2_000',
        routingHash: 'rh_test',
        sequence: 1,
        chunkIndex: 0,
        totalChunks: 1,
        size: encrypted.length,
        signature: signature,
        authorPubkey: admin2PublicKey,
        encryptedPayload: encrypted,
      );

      final decrypted = await cryptoService.verifyAndDecryptChunk(
        chunk: chunk,
        manifest: channelAfterRemoval.manifest,
        trustedOwnerKey: channelAfterRemoval.manifest.ownerKey,
        encryptionPrivateKeyBase64:
            channelAfterRemoval.encryptionKeyPrivate!,
      );

      expect(utf8.decode(decrypted.payload), 'Admin 2 still here');
    });

    test('removed admin cannot decrypt new content', () async {
      final oldEncKey = ownerChannel.encryptionKeyPrivate!;
      final oldEpoch = ownerChannel.manifest.keyEpoch;

      final channelAfterRemoval = await adminService.removeAdmin(
        channel: ownerChannel,
        adminPublicKey: admin1PublicKey,
      );

      // Owner publishes new content
      final payload = ChunkPayload(
        type: ContentType.text,
        payload: Uint8List.fromList(utf8.encode('Secret after removal')),
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final encrypted = await cryptoService.encryptPayload(
        payload,
        channelAfterRemoval.encryptionKeyPrivate!,
        channelAfterRemoval.manifest.keyEpoch,
      );

      // Removed admin tries to decrypt with old key
      expect(
        () => cryptoService.decryptPayload(encrypted, oldEncKey, oldEpoch),
        throwsA(isA<ChannelCryptoException>()),
      );

      // Also fails with old key + new epoch
      expect(
        () => cryptoService.decryptPayload(
            encrypted, oldEncKey, channelAfterRemoval.manifest.keyEpoch),
        throwsA(isA<ChannelCryptoException>()),
      );
    });

    test('pre-rotation content remains decryptable with old key', () async {
      // Encrypt content before rotation
      final payload = ChunkPayload(
        type: ContentType.text,
        payload: Uint8List.fromList(utf8.encode('Pre-rotation content')),
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final encrypted = await cryptoService.encryptPayload(
        payload,
        ownerChannel.encryptionKeyPrivate!,
        ownerChannel.manifest.keyEpoch,
      );

      // Rotate the key
      await adminService.removeAdmin(
        channel: ownerChannel,
        adminPublicKey: admin1PublicKey,
      );

      // Old content can still be decrypted with the old key
      final decrypted = await cryptoService.decryptPayload(
        encrypted,
        ownerChannel.encryptionKeyPrivate!,
        ownerChannel.manifest.keyEpoch,
      );

      expect(utf8.decode(decrypted.payload), 'Pre-rotation content');
    });
  });

  group('Key rotation via ChannelService.rotateEncryptionKey', () {
    late Channel channel;

    setUp(() async {
      channel = await channelService.createChannel(
        name: 'Service Rotation Test',
      );
    });

    test('successive rotations produce unique keys', () async {
      final keys = <String>[];
      var current = channel;

      for (var i = 0; i < 5; i++) {
        current = await channelService.rotateEncryptionKey(channel: current);
        keys.add(current.encryptionKeyPublic);
      }

      // All keys should be unique
      expect(keys.toSet().length, 5);
    });

    test('content encrypted at different epochs cannot cross-decrypt',
        () async {
      final epoch1Channel = channel;
      final epoch2Channel =
          await channelService.rotateEncryptionKey(channel: epoch1Channel);
      final epoch3Channel =
          await channelService.rotateEncryptionKey(channel: epoch2Channel);

      final makePayload = (String text) => ChunkPayload(
            type: ContentType.text,
            payload: Uint8List.fromList(utf8.encode(text)),
            timestamp: DateTime.utc(2026, 2, 10),
          );

      // Encrypt at epoch 1
      final enc1 = await cryptoService.encryptPayload(
        makePayload('Epoch 1'),
        epoch1Channel.encryptionKeyPrivate!,
        epoch1Channel.manifest.keyEpoch,
      );

      // Encrypt at epoch 2
      final enc2 = await cryptoService.encryptPayload(
        makePayload('Epoch 2'),
        epoch2Channel.encryptionKeyPrivate!,
        epoch2Channel.manifest.keyEpoch,
      );

      // Encrypt at epoch 3
      final enc3 = await cryptoService.encryptPayload(
        makePayload('Epoch 3'),
        epoch3Channel.encryptionKeyPrivate!,
        epoch3Channel.manifest.keyEpoch,
      );

      // Each can be decrypted with its own key+epoch
      final dec1 = await cryptoService.decryptPayload(
          enc1,
          epoch1Channel.encryptionKeyPrivate!,
          epoch1Channel.manifest.keyEpoch);
      expect(utf8.decode(dec1.payload), 'Epoch 1');

      final dec2 = await cryptoService.decryptPayload(
          enc2,
          epoch2Channel.encryptionKeyPrivate!,
          epoch2Channel.manifest.keyEpoch);
      expect(utf8.decode(dec2.payload), 'Epoch 2');

      final dec3 = await cryptoService.decryptPayload(
          enc3,
          epoch3Channel.encryptionKeyPrivate!,
          epoch3Channel.manifest.keyEpoch);
      expect(utf8.decode(dec3.payload), 'Epoch 3');

      // Cross-epoch decryption fails
      expect(
        () => cryptoService.decryptPayload(
            enc1,
            epoch2Channel.encryptionKeyPrivate!,
            epoch2Channel.manifest.keyEpoch),
        throwsA(isA<ChannelCryptoException>()),
      );

      expect(
        () => cryptoService.decryptPayload(
            enc3,
            epoch1Channel.encryptionKeyPrivate!,
            epoch1Channel.manifest.keyEpoch),
        throwsA(isA<ChannelCryptoException>()),
      );
    });
  });

  group('Routing hash rotation after key rotation', () {
    late Channel channel;

    setUp(() async {
      channel = await channelService.createChannel(
        name: 'Routing Hash Rotation',
      );
    });

    test('routing hash changes when encryption key rotates', () async {
      final time = DateTime.utc(2026, 2, 10, 12, 0);

      final hash1 = await routingHashService.deriveRoutingHash(
        channelSecret: channel.encryptionKeyPrivate!,
        now: time,
      );

      final rotated =
          await channelService.rotateEncryptionKey(channel: channel);

      final hash2 = await routingHashService.deriveRoutingHash(
        channelSecret: rotated.encryptionKeyPrivate!,
        now: time,
      );

      // New key = new routing hash, even at the same time
      expect(hash1, isNot(hash2));
    });

    test('VPS cannot correlate old and new routing hashes', () async {
      final time = DateTime.utc(2026, 2, 10, 12, 0);
      final hashes = <String>[];

      var current = channel;
      for (var i = 0; i < 5; i++) {
        final hash = await routingHashService.deriveRoutingHash(
          channelSecret: current.encryptionKeyPrivate!,
          now: time,
        );
        hashes.add(hash);
        current =
            await channelService.rotateEncryptionKey(channel: current);
      }

      // All routing hashes should be unique
      expect(hashes.toSet().length, 5);
    });
  });

  group('End-to-end: admin lifecycle with key rotation', () {
    test('full admin lifecycle: appoint, publish, remove, verify', () async {
      // 1. Owner creates channel
      final channel = await channelService.createChannel(
        name: 'Full Lifecycle',
        rules: const ChannelRules(
          repliesEnabled: true,
          pollsEnabled: true,
          maxUpstreamSize: 4096,
        ),
      );

      // 2. Appoint an admin
      final adminKeys = await cryptoService.generateSigningKeyPair();
      var currentChannel = await adminService.appointAdmin(
        channel: channel,
        adminPublicKey: adminKeys.publicKey,
        adminLabel: 'Test Admin',
      );

      // 3. Admin publishes content
      final payload = ChunkPayload(
        type: ContentType.text,
        payload: Uint8List.fromList(utf8.encode('Admin content')),
        author: adminKeys.publicKey,
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final encrypted = await cryptoService.encryptPayload(
        payload,
        currentChannel.encryptionKeyPrivate!,
        currentChannel.manifest.keyEpoch,
      );

      final signature =
          await cryptoService.signChunk(encrypted, adminKeys.privateKey);

      final chunk = Chunk(
        chunkId: 'ch_lifecycle_000',
        routingHash: 'rh_test',
        sequence: 1,
        chunkIndex: 0,
        totalChunks: 1,
        size: encrypted.length,
        signature: signature,
        authorPubkey: adminKeys.publicKey,
        encryptedPayload: encrypted,
      );

      // 4. Subscriber verifies admin content
      final decrypted = await cryptoService.verifyAndDecryptChunk(
        chunk: chunk,
        manifest: currentChannel.manifest,
        trustedOwnerKey: currentChannel.manifest.ownerKey,
        encryptionPrivateKeyBase64:
            currentChannel.encryptionKeyPrivate!,
      );
      expect(utf8.decode(decrypted.payload), 'Admin content');

      // 5. Owner removes admin (triggers key rotation)
      currentChannel = await adminService.removeAdmin(
        channel: currentChannel,
        adminPublicKey: adminKeys.publicKey,
      );

      // 6. Verify key was rotated
      expect(currentChannel.manifest.keyEpoch, channel.manifest.keyEpoch + 1);
      expect(currentChannel.manifest.adminKeys, isEmpty);

      // 7. Admin's attempt to publish now fails verification
      final newPayload = ChunkPayload(
        type: ContentType.text,
        payload: Uint8List.fromList(utf8.encode('Unauthorized')),
        author: adminKeys.publicKey,
        timestamp: DateTime.utc(2026, 2, 10),
      );

      // Use old encryption key (admin doesn't have new one)
      final oldEncrypted = await cryptoService.encryptPayload(
        newPayload,
        channel.encryptionKeyPrivate!,
        channel.manifest.keyEpoch,
      );

      final newSignature =
          await cryptoService.signChunk(oldEncrypted, adminKeys.privateKey);

      final rejectedChunk = Chunk(
        chunkId: 'ch_rejected_000',
        routingHash: 'rh_test',
        sequence: 2,
        chunkIndex: 0,
        totalChunks: 1,
        size: oldEncrypted.length,
        signature: newSignature,
        authorPubkey: adminKeys.publicKey,
        encryptedPayload: oldEncrypted,
      );

      // Should fail at step 2 (admin no longer in manifest)
      expect(
        () => cryptoService.verifyAndDecryptChunk(
          chunk: rejectedChunk,
          manifest: currentChannel.manifest,
          trustedOwnerKey: currentChannel.manifest.ownerKey,
          encryptionPrivateKeyBase64:
              currentChannel.encryptionKeyPrivate!,
        ),
        throwsA(isA<ChannelCryptoException>().having(
          (e) => e.message,
          'message',
          contains('Step 2'),
        )),
      );
    });
  });

  group('Permission rules enforcement', () {
    test('upstream message validation with size limits', () async {
      final channel = await channelService.createChannel(
        name: 'Size Limit Test',
        rules: const ChannelRules(maxUpstreamSize: 1024),
      );

      // Within limit
      final okResult = adminService.validateUpstreamMessage(
        manifest: channel.manifest,
        messageSize: 512,
      );
      expect(okResult, isNull);

      // At exact limit
      final exactResult = adminService.validateUpstreamMessage(
        manifest: channel.manifest,
        messageSize: 1024,
      );
      expect(exactResult, isNull);

      // Over limit
      final overResult = adminService.validateUpstreamMessage(
        manifest: channel.manifest,
        messageSize: 1025,
      );
      expect(overResult, isNotNull);
      expect(overResult, contains('exceeds'));
    });

    test('combined rules check for reply + size', () async {
      final channel = await channelService.createChannel(
        name: 'Combined Rules',
        rules: const ChannelRules(
          repliesEnabled: false,
          maxUpstreamSize: 1024,
        ),
      );

      // Reply disabled takes precedence
      final result = adminService.validateUpstreamMessage(
        manifest: channel.manifest,
        messageSize: 100,
        isReply: true,
      );
      expect(result, isNotNull);
      expect(result, contains('Replies'));
    });
  });
}
