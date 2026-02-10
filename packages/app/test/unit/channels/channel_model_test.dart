import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/channels/models/channel.dart';
import 'package:zajel/features/channels/models/chunk.dart';

void main() {
  group('ChannelRole', () {
    test('has all expected values', () {
      expect(ChannelRole.values, containsAll([
        ChannelRole.owner,
        ChannelRole.admin,
        ChannelRole.subscriber,
      ]));
    });
  });

  group('AdminKey', () {
    test('toJson and fromJson roundtrip', () {
      const admin = AdminKey(key: 'abc123', label: 'Test Admin');
      final json = admin.toJson();
      final restored = AdminKey.fromJson(json);

      expect(restored.key, 'abc123');
      expect(restored.label, 'Test Admin');
      expect(restored, admin);
    });
  });

  group('ChannelRules', () {
    test('default values', () {
      const rules = ChannelRules();
      expect(rules.repliesEnabled, isTrue);
      expect(rules.pollsEnabled, isTrue);
      expect(rules.maxUpstreamSize, 4096);
    });

    test('toJson and fromJson roundtrip', () {
      const rules = ChannelRules(
        repliesEnabled: false,
        pollsEnabled: true,
        maxUpstreamSize: 8192,
      );
      final json = rules.toJson();
      final restored = ChannelRules.fromJson(json);

      expect(restored, rules);
    });
  });

  group('ChannelManifest', () {
    test('toSignableJson excludes signature', () {
      const manifest = ChannelManifest(
        channelId: 'ch_123',
        name: 'Test',
        description: 'Desc',
        ownerKey: 'owner_pub',
        currentEncryptKey: 'enc_pub',
        keyEpoch: 1,
        signature: 'should_not_appear',
      );

      final signable = manifest.toSignableJson();
      expect(signable, isNot(contains('should_not_appear')));
      expect(signable, contains('ch_123'));
      expect(signable, contains('Test'));
    });

    test('toSignableJson is deterministic', () {
      const manifest = ChannelManifest(
        channelId: 'ch_123',
        name: 'Test',
        description: 'Desc',
        ownerKey: 'owner_pub',
        currentEncryptKey: 'enc_pub',
        keyEpoch: 1,
      );

      final s1 = manifest.toSignableJson();
      final s2 = manifest.toSignableJson();
      expect(s1, s2);
    });

    test('toJson and fromJson roundtrip', () {
      const manifest = ChannelManifest(
        channelId: 'ch_123',
        name: 'Test Channel',
        description: 'A description',
        ownerKey: 'owner_pub_key',
        adminKeys: [AdminKey(key: 'admin1', label: 'Admin One')],
        currentEncryptKey: 'enc_pub_key',
        keyEpoch: 5,
        rules: ChannelRules(repliesEnabled: false),
        signature: 'sig_data',
      );

      final json = manifest.toJson();
      final restored = ChannelManifest.fromJson(json);

      expect(restored.channelId, 'ch_123');
      expect(restored.name, 'Test Channel');
      expect(restored.description, 'A description');
      expect(restored.ownerKey, 'owner_pub_key');
      expect(restored.adminKeys, hasLength(1));
      expect(restored.adminKeys.first.key, 'admin1');
      expect(restored.currentEncryptKey, 'enc_pub_key');
      expect(restored.keyEpoch, 5);
      expect(restored.rules.repliesEnabled, isFalse);
      expect(restored.signature, 'sig_data');
    });

    test('copyWith creates independent copy', () {
      const manifest = ChannelManifest(
        channelId: 'ch_123',
        name: 'Original',
        description: '',
        ownerKey: 'key',
        currentEncryptKey: 'enc',
      );

      final copy = manifest.copyWith(name: 'Modified');
      expect(copy.name, 'Modified');
      expect(manifest.name, 'Original');
      expect(copy.channelId, manifest.channelId);
    });
  });

  group('Channel', () {
    test('toJson and fromJson roundtrip', () {
      const manifest = ChannelManifest(
        channelId: 'ch_abc',
        name: 'My Channel',
        description: 'Desc',
        ownerKey: 'owner_key',
        currentEncryptKey: 'enc_key',
        keyEpoch: 2,
        signature: 'sig',
      );

      final channel = Channel(
        id: 'ch_abc',
        role: ChannelRole.owner,
        manifest: manifest,
        ownerSigningKeyPrivate: 'priv_sign',
        encryptionKeyPrivate: 'priv_enc',
        encryptionKeyPublic: 'pub_enc',
        createdAt: DateTime.utc(2026, 2, 10),
      );

      final json = channel.toJson();
      final restored = Channel.fromJson(
        json,
        ownerSigningKeyPrivate: 'priv_sign',
        encryptionKeyPrivate: 'priv_enc',
      );

      expect(restored.id, 'ch_abc');
      expect(restored.role, ChannelRole.owner);
      expect(restored.manifest.name, 'My Channel');
      expect(restored.ownerSigningKeyPrivate, 'priv_sign');
      expect(restored.encryptionKeyPrivate, 'priv_enc');
      expect(restored.encryptionKeyPublic, 'pub_enc');
    });

    test('subscriber channel has no private keys', () {
      const manifest = ChannelManifest(
        channelId: 'ch_sub',
        name: 'Sub Channel',
        description: '',
        ownerKey: 'owner',
        currentEncryptKey: 'enc',
      );

      final channel = Channel(
        id: 'ch_sub',
        role: ChannelRole.subscriber,
        manifest: manifest,
        encryptionKeyPublic: 'enc',
        createdAt: DateTime.utc(2026, 2, 10),
      );

      expect(channel.ownerSigningKeyPrivate, isNull);
      expect(channel.encryptionKeyPrivate, isNull);
    });
  });

  group('ContentType', () {
    test('fromString returns correct enum values', () {
      expect(ContentType.fromString('text'), ContentType.text);
      expect(ContentType.fromString('file'), ContentType.file);
      expect(ContentType.fromString('audio'), ContentType.audio);
      expect(ContentType.fromString('video'), ContentType.video);
      expect(ContentType.fromString('document'), ContentType.document);
      expect(ContentType.fromString('poll'), ContentType.poll);
    });

    test('fromString defaults to text for unknown values', () {
      expect(ContentType.fromString('unknown'), ContentType.text);
    });
  });

  group('ChunkPayload', () {
    test('toBytes and fromBytes roundtrip for text', () {
      final payload = ChunkPayload(
        type: ContentType.text,
        payload: Uint8List.fromList(utf8.encode('Hello, world!')),
        timestamp: DateTime.utc(2026, 2, 10, 12, 0),
      );

      final bytes = payload.toBytes();
      final restored = ChunkPayload.fromBytes(bytes);

      expect(restored.type, ContentType.text);
      expect(utf8.decode(restored.payload), 'Hello, world!');
      expect(restored.timestamp, DateTime.utc(2026, 2, 10, 12, 0));
      expect(restored.replyTo, isNull);
      expect(restored.author, isNull);
    });

    test('toBytes and fromBytes roundtrip with all fields', () {
      final payload = ChunkPayload(
        type: ContentType.file,
        payload: Uint8List.fromList([1, 2, 3, 4, 5]),
        metadata: {'filename': 'test.pdf', 'size': 12345},
        replyTo: 'msg_42',
        author: 'admin_1',
        timestamp: DateTime.utc(2026, 2, 10, 14, 30),
      );

      final bytes = payload.toBytes();
      final restored = ChunkPayload.fromBytes(bytes);

      expect(restored.type, ContentType.file);
      expect(restored.payload, [1, 2, 3, 4, 5]);
      expect(restored.metadata['filename'], 'test.pdf');
      expect(restored.metadata['size'], 12345);
      expect(restored.replyTo, 'msg_42');
      expect(restored.author, 'admin_1');
    });
  });

  group('Chunk', () {
    test('toJson and fromJson roundtrip', () {
      final encryptedData = Uint8List.fromList([10, 20, 30, 40, 50]);

      final chunk = Chunk(
        chunkId: 'ch_abc_001',
        routingHash: 'rh_xyz',
        sequence: 42,
        chunkIndex: 1,
        totalChunks: 3,
        size: 5,
        signature: base64Encode([1, 2, 3]),
        authorPubkey: base64Encode([4, 5, 6]),
        encryptedPayload: encryptedData,
      );

      final json = chunk.toJson();
      final restored = Chunk.fromJson(json);

      expect(restored.chunkId, 'ch_abc_001');
      expect(restored.routingHash, 'rh_xyz');
      expect(restored.sequence, 42);
      expect(restored.chunkIndex, 1);
      expect(restored.totalChunks, 3);
      expect(restored.size, 5);
      expect(restored.encryptedPayload, encryptedData);
    });

    test('signedData returns encryptedPayload', () {
      final data = Uint8List.fromList([1, 2, 3]);
      final chunk = Chunk(
        chunkId: 'ch_test',
        routingHash: 'rh',
        sequence: 1,
        chunkIndex: 0,
        totalChunks: 1,
        size: 3,
        signature: '',
        authorPubkey: '',
        encryptedPayload: data,
      );

      expect(chunk.signedData, data);
    });

    test('copyWith creates modified copy', () {
      final chunk = Chunk(
        chunkId: 'ch_original',
        routingHash: 'rh',
        sequence: 1,
        chunkIndex: 0,
        totalChunks: 1,
        size: 0,
        signature: 'sig',
        authorPubkey: 'author',
        encryptedPayload: Uint8List(0),
      );

      final modified = chunk.copyWith(chunkId: 'ch_modified', sequence: 99);
      expect(modified.chunkId, 'ch_modified');
      expect(modified.sequence, 99);
      expect(modified.routingHash, 'rh'); // Unchanged
      expect(chunk.chunkId, 'ch_original'); // Original unchanged
    });
  });
}
