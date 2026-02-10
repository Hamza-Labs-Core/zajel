import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/channels/models/channel.dart';
import 'package:zajel/features/channels/models/chunk.dart';
import 'package:zajel/features/channels/services/admin_management_service.dart';
import 'package:zajel/features/channels/services/channel_crypto_service.dart';
import 'package:zajel/features/channels/services/channel_service.dart';

import 'channel_service_test.dart';

void main() {
  late ChannelCryptoService cryptoService;
  late FakeChannelStorageService storageService;
  late ChannelService channelService;
  late AdminManagementService adminService;

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
  });

  group('Admin appointment', () {
    late Channel ownerChannel;

    setUp(() async {
      ownerChannel = await channelService.createChannel(
        name: 'Admin Test Channel',
        description: 'For testing admin management',
      );
    });

    test('appointAdmin adds admin key to manifest and re-signs', () async {
      final adminKeys = await cryptoService.generateSigningKeyPair();

      final updated = await adminService.appointAdmin(
        channel: ownerChannel,
        adminPublicKey: adminKeys.publicKey,
        adminLabel: 'Admin One',
      );

      expect(updated.manifest.adminKeys, hasLength(1));
      expect(updated.manifest.adminKeys.first.key, adminKeys.publicKey);
      expect(updated.manifest.adminKeys.first.label, 'Admin One');

      // Manifest should be validly signed
      final isValid = await cryptoService.verifyManifest(updated.manifest);
      expect(isValid, isTrue);
    });

    test('appointAdmin can add multiple admins', () async {
      final admin1Keys = await cryptoService.generateSigningKeyPair();
      final admin2Keys = await cryptoService.generateSigningKeyPair();

      var updated = await adminService.appointAdmin(
        channel: ownerChannel,
        adminPublicKey: admin1Keys.publicKey,
        adminLabel: 'Admin One',
      );

      updated = await adminService.appointAdmin(
        channel: updated,
        adminPublicKey: admin2Keys.publicKey,
        adminLabel: 'Admin Two',
      );

      expect(updated.manifest.adminKeys, hasLength(2));
      expect(
        updated.manifest.adminKeys.map((a) => a.label).toList(),
        containsAll(['Admin One', 'Admin Two']),
      );

      final isValid = await cryptoService.verifyManifest(updated.manifest);
      expect(isValid, isTrue);
    });

    test('appointAdmin rejects duplicate admin key', () async {
      final adminKeys = await cryptoService.generateSigningKeyPair();

      final updated = await adminService.appointAdmin(
        channel: ownerChannel,
        adminPublicKey: adminKeys.publicKey,
        adminLabel: 'Admin One',
      );

      expect(
        () => adminService.appointAdmin(
          channel: updated,
          adminPublicKey: adminKeys.publicKey,
          adminLabel: 'Duplicate',
        ),
        throwsA(isA<AdminManagementException>().having(
          (e) => e.message,
          'message',
          contains('already appointed'),
        )),
      );
    });

    test('appointAdmin rejects owner key as admin', () async {
      expect(
        () => adminService.appointAdmin(
          channel: ownerChannel,
          adminPublicKey: ownerChannel.manifest.ownerKey,
          adminLabel: 'Self',
        ),
        throwsA(isA<AdminManagementException>().having(
          (e) => e.message,
          'message',
          contains('Cannot appoint the owner'),
        )),
      );
    });

    test('appointAdmin fails for subscriber channel', () async {
      final subscription = await channelService.subscribe(
        manifest: ownerChannel.manifest,
        encryptionPrivateKey: ownerChannel.encryptionKeyPrivate!,
      );

      expect(
        () => adminService.appointAdmin(
          channel: subscription,
          adminPublicKey: 'some-key',
          adminLabel: 'Attempt',
        ),
        throwsA(isA<AdminManagementException>().having(
          (e) => e.message,
          'message',
          contains('owner'),
        )),
      );
    });

    test('appointAdmin persists to storage', () async {
      final adminKeys = await cryptoService.generateSigningKeyPair();

      final updated = await adminService.appointAdmin(
        channel: ownerChannel,
        adminPublicKey: adminKeys.publicKey,
        adminLabel: 'Persisted Admin',
      );

      final retrieved = await storageService.getChannel(updated.id);
      expect(retrieved, isNotNull);
      expect(retrieved!.manifest.adminKeys, hasLength(1));
      expect(retrieved.manifest.adminKeys.first.label, 'Persisted Admin');
    });
  });

  group('Admin removal', () {
    late Channel ownerChannel;
    late String adminPublicKey;

    setUp(() async {
      ownerChannel = await channelService.createChannel(
        name: 'Removal Test',
      );
      final adminKeys = await cryptoService.generateSigningKeyPair();
      adminPublicKey = adminKeys.publicKey;
      ownerChannel = await adminService.appointAdmin(
        channel: ownerChannel,
        adminPublicKey: adminPublicKey,
        adminLabel: 'To Remove',
      );
    });

    test('removeAdmin removes key and rotates encryption key', () async {
      final oldEpoch = ownerChannel.manifest.keyEpoch;
      final oldEncKey = ownerChannel.encryptionKeyPublic;

      final updated = await adminService.removeAdmin(
        channel: ownerChannel,
        adminPublicKey: adminPublicKey,
      );

      expect(updated.manifest.adminKeys, isEmpty);
      expect(updated.manifest.keyEpoch, oldEpoch + 1);
      expect(updated.encryptionKeyPublic, isNot(oldEncKey));

      final isValid = await cryptoService.verifyManifest(updated.manifest);
      expect(isValid, isTrue);
    });

    test('removeAdmin with old key cannot decrypt new content', () async {
      final oldEncKey = ownerChannel.encryptionKeyPrivate!;

      final updated = await adminService.removeAdmin(
        channel: ownerChannel,
        adminPublicKey: adminPublicKey,
      );

      // Encrypt content with the new key
      final payload = ChunkPayload(
        type: ContentType.text,
        payload: Uint8List.fromList(utf8.encode('Post-removal content')),
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final encrypted = await cryptoService.encryptPayload(
        payload,
        updated.encryptionKeyPrivate!,
        updated.manifest.keyEpoch,
      );

      // Try to decrypt with the old key
      expect(
        () => cryptoService.decryptPayload(
          encrypted,
          oldEncKey,
          ownerChannel.manifest.keyEpoch,
        ),
        throwsA(isA<ChannelCryptoException>()),
      );
    });

    test('removeAdmin fails for non-existent admin', () async {
      final otherKeys = await cryptoService.generateSigningKeyPair();

      expect(
        () => adminService.removeAdmin(
          channel: ownerChannel,
          adminPublicKey: otherKeys.publicKey,
        ),
        throwsA(isA<AdminManagementException>().having(
          (e) => e.message,
          'message',
          contains('not in the manifest'),
        )),
      );
    });

    test('removeAdmin fails for subscriber channel', () async {
      final subscription = await channelService.subscribe(
        manifest: ownerChannel.manifest,
        encryptionPrivateKey: ownerChannel.encryptionKeyPrivate!,
      );

      expect(
        () => adminService.removeAdmin(
          channel: subscription,
          adminPublicKey: adminPublicKey,
        ),
        throwsA(isA<AdminManagementException>().having(
          (e) => e.message,
          'message',
          contains('owner'),
        )),
      );
    });

    test('removing one admin preserves others', () async {
      final admin2Keys = await cryptoService.generateSigningKeyPair();
      var channel = await adminService.appointAdmin(
        channel: ownerChannel,
        adminPublicKey: admin2Keys.publicKey,
        adminLabel: 'Admin Two',
      );

      expect(channel.manifest.adminKeys, hasLength(2));

      channel = await adminService.removeAdmin(
        channel: channel,
        adminPublicKey: adminPublicKey,
      );

      expect(channel.manifest.adminKeys, hasLength(1));
      expect(channel.manifest.adminKeys.first.key, admin2Keys.publicKey);
      expect(channel.manifest.adminKeys.first.label, 'Admin Two');
    });
  });

  group('Admin authorization validation', () {
    late Channel ownerChannel;
    late String adminPublicKey;

    setUp(() async {
      ownerChannel = await channelService.createChannel(name: 'Auth Test');
      final adminKeys = await cryptoService.generateSigningKeyPair();
      adminPublicKey = adminKeys.publicKey;
      ownerChannel = await adminService.appointAdmin(
        channel: ownerChannel,
        adminPublicKey: adminPublicKey,
        adminLabel: 'Auth Admin',
      );
    });

    test('isAuthorizedAdmin returns true for appointed admin', () {
      expect(
        adminService.isAuthorizedAdmin(ownerChannel.manifest, adminPublicKey),
        isTrue,
      );
    });

    test('isAuthorizedAdmin returns false for owner key', () {
      expect(
        adminService.isAuthorizedAdmin(
            ownerChannel.manifest, ownerChannel.manifest.ownerKey),
        isFalse,
      );
    });

    test('isAuthorizedAdmin returns false for unknown key', () {
      expect(
        adminService.isAuthorizedAdmin(ownerChannel.manifest, 'unknown-key'),
        isFalse,
      );
    });

    test('isAuthorizedPublisher returns true for owner', () {
      expect(
        adminService.isAuthorizedPublisher(
            ownerChannel.manifest, ownerChannel.manifest.ownerKey),
        isTrue,
      );
    });

    test('isAuthorizedPublisher returns true for admin', () {
      expect(
        adminService.isAuthorizedPublisher(
            ownerChannel.manifest, adminPublicKey),
        isTrue,
      );
    });

    test('isAuthorizedPublisher returns false for random key', () {
      expect(
        adminService.isAuthorizedPublisher(ownerChannel.manifest, 'random-key'),
        isFalse,
      );
    });
  });

  group('Permission rules validation', () {
    test('validates replies when enabled', () {
      const manifest = ChannelManifest(
        channelId: 'test',
        name: 'Test',
        description: '',
        ownerKey: 'owner',
        currentEncryptKey: 'enc',
        rules: ChannelRules(repliesEnabled: true),
      );

      final result = adminService.validateUpstreamMessage(
        manifest: manifest,
        messageSize: 100,
        isReply: true,
      );

      expect(result, isNull);
    });

    test('rejects replies when disabled', () {
      const manifest = ChannelManifest(
        channelId: 'test',
        name: 'Test',
        description: '',
        ownerKey: 'owner',
        currentEncryptKey: 'enc',
        rules: ChannelRules(repliesEnabled: false),
      );

      final result = adminService.validateUpstreamMessage(
        manifest: manifest,
        messageSize: 100,
        isReply: true,
      );

      expect(result, isNotNull);
      expect(result, contains('Replies are not enabled'));
    });

    test('validates polls when enabled', () {
      const manifest = ChannelManifest(
        channelId: 'test',
        name: 'Test',
        description: '',
        ownerKey: 'owner',
        currentEncryptKey: 'enc',
        rules: ChannelRules(pollsEnabled: true),
      );

      final result = adminService.validateUpstreamMessage(
        manifest: manifest,
        messageSize: 100,
        isPoll: true,
      );

      expect(result, isNull);
    });

    test('rejects polls when disabled', () {
      const manifest = ChannelManifest(
        channelId: 'test',
        name: 'Test',
        description: '',
        ownerKey: 'owner',
        currentEncryptKey: 'enc',
        rules: ChannelRules(pollsEnabled: false),
      );

      final result = adminService.validateUpstreamMessage(
        manifest: manifest,
        messageSize: 100,
        isPoll: true,
      );

      expect(result, isNotNull);
      expect(result, contains('Polls are not enabled'));
    });

    test('rejects messages exceeding max upstream size', () {
      const manifest = ChannelManifest(
        channelId: 'test',
        name: 'Test',
        description: '',
        ownerKey: 'owner',
        currentEncryptKey: 'enc',
        rules: ChannelRules(maxUpstreamSize: 1024),
      );

      final result = adminService.validateUpstreamMessage(
        manifest: manifest,
        messageSize: 2048,
      );

      expect(result, isNotNull);
      expect(result, contains('exceeds maximum'));
      expect(result, contains('2048'));
      expect(result, contains('1024'));
    });

    test('accepts messages within max upstream size', () {
      const manifest = ChannelManifest(
        channelId: 'test',
        name: 'Test',
        description: '',
        ownerKey: 'owner',
        currentEncryptKey: 'enc',
        rules: ChannelRules(maxUpstreamSize: 4096),
      );

      final result = adminService.validateUpstreamMessage(
        manifest: manifest,
        messageSize: 4096,
      );

      expect(result, isNull);
    });

    test('accepts messages at exactly max upstream size', () {
      const manifest = ChannelManifest(
        channelId: 'test',
        name: 'Test',
        description: '',
        ownerKey: 'owner',
        currentEncryptKey: 'enc',
        rules: ChannelRules(maxUpstreamSize: 4096),
      );

      final result = adminService.validateUpstreamMessage(
        manifest: manifest,
        messageSize: 4096,
      );

      expect(result, isNull);
    });
  });

  group('Update rules', () {
    late Channel ownerChannel;

    setUp(() async {
      ownerChannel = await channelService.createChannel(name: 'Rules Test');
    });

    test('updateRules changes rules and re-signs manifest', () async {
      const newRules = ChannelRules(
        repliesEnabled: false,
        pollsEnabled: false,
        maxUpstreamSize: 8192,
      );

      final updated = await adminService.updateRules(
        channel: ownerChannel,
        rules: newRules,
      );

      expect(updated.manifest.rules.repliesEnabled, isFalse);
      expect(updated.manifest.rules.pollsEnabled, isFalse);
      expect(updated.manifest.rules.maxUpstreamSize, 8192);

      final isValid = await cryptoService.verifyManifest(updated.manifest);
      expect(isValid, isTrue);
    });

    test('updateRules fails for subscriber', () async {
      final subscription = await channelService.subscribe(
        manifest: ownerChannel.manifest,
        encryptionPrivateKey: ownerChannel.encryptionKeyPrivate!,
      );

      expect(
        () => adminService.updateRules(
          channel: subscription,
          rules: const ChannelRules(repliesEnabled: false),
        ),
        throwsA(isA<AdminManagementException>().having(
          (e) => e.message,
          'message',
          contains('owner'),
        )),
      );
    });

    test('updateRules persists to storage', () async {
      const newRules = ChannelRules(
        repliesEnabled: false,
        pollsEnabled: true,
        maxUpstreamSize: 2048,
      );

      final updated = await adminService.updateRules(
        channel: ownerChannel,
        rules: newRules,
      );

      final retrieved = await storageService.getChannel(updated.id);
      expect(retrieved, isNotNull);
      expect(retrieved!.manifest.rules.repliesEnabled, isFalse);
      expect(retrieved.manifest.rules.maxUpstreamSize, 2048);
    });
  });

  group('Key rotation on member removal', () {
    late Channel ownerChannel;

    setUp(() async {
      ownerChannel = await channelService.createChannel(
        name: 'Rotation Test',
      );
    });

    test('rotateEncryptionKeyForRemoval generates new key and epoch', () async {
      final oldEpoch = ownerChannel.manifest.keyEpoch;
      final oldEncKey = ownerChannel.encryptionKeyPublic;

      final updated = await adminService.rotateEncryptionKeyForRemoval(
        channel: ownerChannel,
      );

      expect(updated.manifest.keyEpoch, oldEpoch + 1);
      expect(updated.encryptionKeyPublic, isNot(oldEncKey));
      expect(updated.manifest.currentEncryptKey, updated.encryptionKeyPublic);
      expect(updated.encryptionKeyPrivate, isNotNull);
      expect(updated.encryptionKeyPrivate,
          isNot(ownerChannel.encryptionKeyPrivate));

      final isValid = await cryptoService.verifyManifest(updated.manifest);
      expect(isValid, isTrue);
    });

    test('multiple rotations increment epoch correctly', () async {
      var channel = ownerChannel;

      for (var i = 0; i < 3; i++) {
        channel = await adminService.rotateEncryptionKeyForRemoval(
          channel: channel,
        );
      }

      expect(channel.manifest.keyEpoch, ownerChannel.manifest.keyEpoch + 3);
    });

    test('rotateEncryptionKeyForRemoval fails for subscriber', () async {
      final subscription = await channelService.subscribe(
        manifest: ownerChannel.manifest,
        encryptionPrivateKey: ownerChannel.encryptionKeyPrivate!,
      );

      expect(
        () => adminService.rotateEncryptionKeyForRemoval(
          channel: subscription,
        ),
        throwsA(isA<AdminManagementException>().having(
          (e) => e.message,
          'message',
          contains('owner'),
        )),
      );
    });

    test('old key cannot decrypt content after rotation', () async {
      final oldKey = ownerChannel.encryptionKeyPrivate!;
      final oldEpoch = ownerChannel.manifest.keyEpoch;

      final updated = await adminService.rotateEncryptionKeyForRemoval(
        channel: ownerChannel,
      );

      // Encrypt with new key
      final payload = ChunkPayload(
        type: ContentType.text,
        payload: Uint8List.fromList(utf8.encode('Rotated content')),
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final encrypted = await cryptoService.encryptPayload(
        payload,
        updated.encryptionKeyPrivate!,
        updated.manifest.keyEpoch,
      );

      // Old key + old epoch cannot decrypt
      expect(
        () => cryptoService.decryptPayload(encrypted, oldKey, oldEpoch),
        throwsA(isA<ChannelCryptoException>()),
      );

      // Old key + new epoch also cannot decrypt (different derived key)
      expect(
        () => cryptoService.decryptPayload(
            encrypted, oldKey, updated.manifest.keyEpoch),
        throwsA(isA<ChannelCryptoException>()),
      );

      // New key + new epoch can decrypt
      final decrypted = await cryptoService.decryptPayload(
        encrypted,
        updated.encryptionKeyPrivate!,
        updated.manifest.keyEpoch,
      );
      expect(utf8.decode(decrypted.payload), 'Rotated content');
    });
  });

  group('Bulk admin operations', () {
    late Channel ownerChannel;

    setUp(() async {
      ownerChannel = await channelService.createChannel(
        name: 'Bulk Test',
      );
    });

    test('getAdmins returns empty list for new channel', () {
      final admins = adminService.getAdmins(ownerChannel.manifest);
      expect(admins, isEmpty);
    });

    test('getAdmins returns all admins', () async {
      final admin1 = await cryptoService.generateSigningKeyPair();
      final admin2 = await cryptoService.generateSigningKeyPair();

      var channel = await adminService.appointAdmin(
        channel: ownerChannel,
        adminPublicKey: admin1.publicKey,
        adminLabel: 'Admin 1',
      );
      channel = await adminService.appointAdmin(
        channel: channel,
        adminPublicKey: admin2.publicKey,
        adminLabel: 'Admin 2',
      );

      final admins = adminService.getAdmins(channel.manifest);
      expect(admins, hasLength(2));
    });

    test('getAdmins returns unmodifiable list', () async {
      final adminKeys = await cryptoService.generateSigningKeyPair();
      final channel = await adminService.appointAdmin(
        channel: ownerChannel,
        adminPublicKey: adminKeys.publicKey,
        adminLabel: 'Admin',
      );

      final admins = adminService.getAdmins(channel.manifest);
      expect(
        () => admins.add(const AdminKey(key: 'hack', label: 'Hack')),
        throwsA(isA<UnsupportedError>()),
      );
    });

    test('hasAdmins returns false for new channel', () {
      expect(adminService.hasAdmins(ownerChannel.manifest), isFalse);
    });

    test('hasAdmins returns true after adding admin', () async {
      final adminKeys = await cryptoService.generateSigningKeyPair();
      final channel = await adminService.appointAdmin(
        channel: ownerChannel,
        adminPublicKey: adminKeys.publicKey,
        adminLabel: 'Admin',
      );

      expect(adminService.hasAdmins(channel.manifest), isTrue);
    });
  });

  group('Admin content publishing verification', () {
    late Channel ownerChannel;
    late String adminPublicKey;
    late String adminPrivateKey;

    setUp(() async {
      ownerChannel = await channelService.createChannel(
        name: 'Publishing Test',
      );
      final adminKeys = await cryptoService.generateSigningKeyPair();
      adminPublicKey = adminKeys.publicKey;
      adminPrivateKey = adminKeys.privateKey;
      ownerChannel = await adminService.appointAdmin(
        channel: ownerChannel,
        adminPublicKey: adminPublicKey,
        adminLabel: 'Publisher Admin',
      );
    });

    test('admin can sign content that passes 5-step verification', () async {
      // Admin encrypts and signs a chunk
      final payload = ChunkPayload(
        type: ContentType.text,
        payload: Uint8List.fromList(utf8.encode('Admin broadcast')),
        author: adminPublicKey,
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final encrypted = await cryptoService.encryptPayload(
        payload,
        ownerChannel.encryptionKeyPrivate!,
        ownerChannel.manifest.keyEpoch,
      );

      final signature =
          await cryptoService.signChunk(encrypted, adminPrivateKey);

      final chunk = Chunk(
        chunkId: 'ch_admin_pub_000',
        routingHash: 'rh_test',
        sequence: 1,
        chunkIndex: 0,
        totalChunks: 1,
        size: encrypted.length,
        signature: signature,
        authorPubkey: adminPublicKey,
        encryptedPayload: encrypted,
      );

      // Verify the chunk passes all 5 steps
      final decrypted = await cryptoService.verifyAndDecryptChunk(
        chunk: chunk,
        manifest: ownerChannel.manifest,
        trustedOwnerKey: ownerChannel.manifest.ownerKey,
        encryptionPrivateKeyBase64: ownerChannel.encryptionKeyPrivate!,
      );

      expect(utf8.decode(decrypted.payload), 'Admin broadcast');
      expect(decrypted.author, adminPublicKey);
    });

    test('removed admin content fails step 2 verification', () async {
      // Remove the admin
      final channelAfterRemoval = await adminService.removeAdmin(
        channel: ownerChannel,
        adminPublicKey: adminPublicKey,
      );

      // Try to verify a chunk signed by the removed admin
      // using the old encryption key (which the admin still has)
      final payload = ChunkPayload(
        type: ContentType.text,
        payload: Uint8List.fromList(utf8.encode('Removed admin attempt')),
        author: adminPublicKey,
        timestamp: DateTime.utc(2026, 2, 10),
      );

      // The removed admin would use the old key
      final encrypted = await cryptoService.encryptPayload(
        payload,
        ownerChannel.encryptionKeyPrivate!,
        ownerChannel.manifest.keyEpoch,
      );

      final signature =
          await cryptoService.signChunk(encrypted, adminPrivateKey);

      final chunk = Chunk(
        chunkId: 'ch_removed_000',
        routingHash: 'rh_test',
        sequence: 1,
        chunkIndex: 0,
        totalChunks: 1,
        size: encrypted.length,
        signature: signature,
        authorPubkey: adminPublicKey,
        encryptedPayload: encrypted,
      );

      // Verification should fail at step 2 (author not in manifest)
      expect(
        () => cryptoService.verifyAndDecryptChunk(
          chunk: chunk,
          manifest: channelAfterRemoval.manifest,
          trustedOwnerKey: channelAfterRemoval.manifest.ownerKey,
          encryptionPrivateKeyBase64: channelAfterRemoval.encryptionKeyPrivate!,
        ),
        throwsA(isA<ChannelCryptoException>().having(
          (e) => e.message,
          'message',
          contains('Step 2'),
        )),
      );
    });
  });
}
