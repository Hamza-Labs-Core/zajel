import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/channels/models/channel.dart';
import 'package:zajel/features/channels/models/chunk.dart';
import 'package:zajel/features/channels/services/channel_crypto_service.dart';
import 'package:zajel/features/channels/services/channel_service.dart';
import 'package:zajel/features/channels/services/channel_storage_service.dart';

import '../../mocks/mocks.dart';

/// In-memory implementation of ChannelStorageService for unit testing.
///
/// Avoids SQLite and secure storage dependencies.
class FakeChannelStorageService extends ChannelStorageService {
  final Map<String, Channel> _channels = {};
  final Map<String, List<Chunk>> _chunks = {};

  FakeChannelStorageService() : super(secureStorage: FakeSecureStorage());

  @override
  Future<void> initialize() async {
    // No-op for in-memory implementation
  }

  @override
  Future<void> saveChannel(Channel channel) async {
    _channels[channel.id] = channel;
  }

  @override
  Future<Channel?> getChannel(String channelId) async {
    return _channels[channelId];
  }

  @override
  Future<List<Channel>> getAllChannels() async {
    return _channels.values.toList();
  }

  @override
  Future<void> deleteChannel(String channelId) async {
    _channels.remove(channelId);
    _chunks.remove(channelId);
  }

  @override
  Future<void> saveChunk(String channelId, Chunk chunk) async {
    _chunks.putIfAbsent(channelId, () => []).add(chunk);
  }

  @override
  Future<List<Chunk>> getChunksBySequence(
      String channelId, int sequence) async {
    return (_chunks[channelId] ?? [])
        .where((c) => c.sequence == sequence)
        .toList()
      ..sort((a, b) => a.chunkIndex.compareTo(b.chunkIndex));
  }

  @override
  Future<Chunk?> getChunk(String channelId, String chunkId) async {
    return (_chunks[channelId] ?? [])
        .where((c) => c.chunkId == chunkId)
        .firstOrNull;
  }

  @override
  Future<List<String>> getChunkIds(String channelId) async {
    return (_chunks[channelId] ?? []).map((c) => c.chunkId).toList();
  }

  @override
  Future<void> deleteChunksBySequence(String channelId, int sequence) async {
    _chunks[channelId]?.removeWhere((c) => c.sequence == sequence);
  }

  @override
  Future<int> getLatestSequence(String channelId) async {
    final chunks = _chunks[channelId] ?? [];
    if (chunks.isEmpty) return 0;
    return chunks.map((c) => c.sequence).reduce((a, b) => a > b ? a : b);
  }

  @override
  Future<void> close() async {
    // No-op
  }
}

void main() {
  late ChannelCryptoService cryptoService;
  late FakeChannelStorageService storageService;
  late ChannelService channelService;

  setUp(() {
    cryptoService = ChannelCryptoService();
    storageService = FakeChannelStorageService();
    channelService = ChannelService(
      cryptoService: cryptoService,
      storageService: storageService,
    );
  });

  group('Channel creation', () {
    test('createChannel generates keys, signs manifest, and persists',
        () async {
      final channel = await channelService.createChannel(
        name: 'My Channel',
        description: 'A test channel',
      );

      expect(channel.id, isNotEmpty);
      expect(channel.role, ChannelRole.owner);
      expect(channel.manifest.name, 'My Channel');
      expect(channel.manifest.description, 'A test channel');
      expect(channel.manifest.signature, isNotEmpty);
      expect(channel.ownerSigningKeyPrivate, isNotEmpty);
      expect(channel.encryptionKeyPrivate, isNotEmpty);
      expect(channel.encryptionKeyPublic, isNotEmpty);
      expect(channel.manifest.keyEpoch, 1);
      expect(channel.manifest.adminKeys, isEmpty);
    });

    test('createChannel produces verifiable manifest', () async {
      final channel = await channelService.createChannel(name: 'Verifiable');
      final isValid = await cryptoService.verifyManifest(channel.manifest);
      expect(isValid, isTrue);
    });

    test('createChannel persists to storage', () async {
      final channel = await channelService.createChannel(name: 'Stored');
      final retrieved = await storageService.getChannel(channel.id);

      expect(retrieved, isNotNull);
      expect(retrieved!.id, channel.id);
      expect(retrieved.manifest.name, 'Stored');
    });

    test('createChannel with custom rules', () async {
      final channel = await channelService.createChannel(
        name: 'Custom Rules',
        rules: const ChannelRules(
          repliesEnabled: false,
          pollsEnabled: true,
          maxUpstreamSize: 8192,
        ),
      );

      expect(channel.manifest.rules.repliesEnabled, isFalse);
      expect(channel.manifest.rules.pollsEnabled, isTrue);
      expect(channel.manifest.rules.maxUpstreamSize, 8192);
    });

    test('each createChannel generates unique IDs', () async {
      final c1 = await channelService.createChannel(name: 'One');
      final c2 = await channelService.createChannel(name: 'Two');

      expect(c1.id, isNot(c2.id));
      expect(c1.manifest.ownerKey, isNot(c2.manifest.ownerKey));
    });
  });

  group('Subscription', () {
    late Channel ownerChannel;

    setUp(() async {
      ownerChannel = await channelService.createChannel(
        name: 'Subscribe Test',
      );
    });

    test('subscribe stores the channel as subscriber', () async {
      final subscription = await channelService.subscribe(
        manifest: ownerChannel.manifest,
        encryptionPrivateKey: ownerChannel.encryptionKeyPrivate!,
      );

      expect(subscription.role, ChannelRole.subscriber);
      expect(subscription.id, ownerChannel.id);
      expect(subscription.manifest.ownerKey, ownerChannel.manifest.ownerKey);
      expect(subscription.ownerSigningKeyPrivate, isNull);
    });

    test('subscribe rejects invalid manifest signature', () async {
      final tamperedManifest = ownerChannel.manifest.copyWith(name: 'Tampered');

      expect(
        () => channelService.subscribe(
          manifest: tamperedManifest,
          encryptionPrivateKey: ownerChannel.encryptionKeyPrivate!,
        ),
        throwsA(isA<ChannelServiceException>().having(
          (e) => e.message,
          'message',
          contains('invalid'),
        )),
      );
    });
  });

  group('Chunk splitting and reassembly', () {
    late Channel channel;

    setUp(() async {
      channel = await channelService.createChannel(name: 'Chunk Test');
    });

    test('small content produces a single chunk', () async {
      final payload = ChunkPayload(
        type: ContentType.text,
        payload: Uint8List.fromList(utf8.encode('Short message')),
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final chunks = await channelService.splitIntoChunks(
        payload: payload,
        channel: channel,
        sequence: 1,
        routingHash: 'rh_test',
      );

      expect(chunks.length, 1);
      expect(chunks.first.chunkIndex, 0);
      expect(chunks.first.totalChunks, 1);
      expect(chunks.first.sequence, 1);
      expect(chunks.first.routingHash, 'rh_test');
      expect(chunks.first.signature, isNotEmpty);
      expect(chunks.first.authorPubkey, channel.manifest.ownerKey);
    });

    test('large content produces multiple chunks', () async {
      // Create payload larger than 64KB chunk size
      // The encrypted output will be larger than input, so use a payload
      // that will produce 3+ chunks after encryption
      final largeData = Uint8List(ChannelService.chunkSize * 2 + 1000);
      for (var i = 0; i < largeData.length; i++) {
        largeData[i] = i % 256;
      }

      final payload = ChunkPayload(
        type: ContentType.file,
        payload: largeData,
        metadata: {'filename': 'large.bin'},
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final chunks = await channelService.splitIntoChunks(
        payload: payload,
        channel: channel,
        sequence: 1,
        routingHash: 'rh_test',
      );

      expect(chunks.length, greaterThan(1));

      // Verify chunk indices are sequential
      for (var i = 0; i < chunks.length; i++) {
        expect(chunks[i].chunkIndex, i);
        expect(chunks[i].totalChunks, chunks.length);
        expect(chunks[i].sequence, 1);
      }

      // Verify all chunks are signed
      for (final chunk in chunks) {
        final isValid = await cryptoService.verifyChunkSignature(chunk);
        expect(isValid, isTrue,
            reason: 'Chunk ${chunk.chunkIndex} signature invalid');
      }
    });

    test('split and reassemble roundtrip preserves encrypted data', () async {
      final payload = ChunkPayload(
        type: ContentType.text,
        payload: Uint8List.fromList(utf8.encode('Roundtrip test')),
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final chunks = await channelService.splitIntoChunks(
        payload: payload,
        channel: channel,
        sequence: 1,
        routingHash: 'rh_test',
      );

      // Reassemble
      final reassembled = channelService.reassembleChunks(chunks);

      // Decrypt and verify
      final decrypted = await cryptoService.decryptPayload(
        reassembled,
        channel.encryptionKeyPrivate!,
        channel.manifest.keyEpoch,
      );

      expect(utf8.decode(decrypted.payload), 'Roundtrip test');
      expect(decrypted.type, ContentType.text);
    });

    test('reassemble with large multi-chunk content roundtrips', () async {
      final largeData = Uint8List(ChannelService.chunkSize * 3);
      for (var i = 0; i < largeData.length; i++) {
        largeData[i] = i % 256;
      }

      final payload = ChunkPayload(
        type: ContentType.video,
        payload: largeData,
        metadata: {'duration': 120},
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final chunks = await channelService.splitIntoChunks(
        payload: payload,
        channel: channel,
        sequence: 1,
        routingHash: 'rh_test',
      );

      // Reassemble in shuffled order to verify sorting works
      final shuffled = List<Chunk>.from(chunks)..shuffle();
      final reassembled = channelService.reassembleChunks(shuffled);

      final decrypted = await cryptoService.decryptPayload(
        reassembled,
        channel.encryptionKeyPrivate!,
        channel.manifest.keyEpoch,
      );

      expect(decrypted.payload, largeData);
      expect(decrypted.type, ContentType.video);
      expect(decrypted.metadata['duration'], 120);
    });

    test('reassemble rejects empty chunk list', () {
      expect(
        () => channelService.reassembleChunks([]),
        throwsA(isA<ChannelServiceException>().having(
          (e) => e.message,
          'message',
          contains('no chunks'),
        )),
      );
    });

    test('reassemble rejects mismatched sequence numbers', () async {
      final payload = ChunkPayload(
        type: ContentType.text,
        payload: Uint8List.fromList(utf8.encode('test')),
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final chunks1 = await channelService.splitIntoChunks(
        payload: payload,
        channel: channel,
        sequence: 1,
        routingHash: 'rh_test',
      );
      final chunks2 = await channelService.splitIntoChunks(
        payload: payload,
        channel: channel,
        sequence: 2,
        routingHash: 'rh_test',
      );

      expect(
        () => channelService.reassembleChunks([chunks1.first, chunks2.first]),
        throwsA(isA<ChannelServiceException>().having(
          (e) => e.message,
          'message',
          contains('different sequence'),
        )),
      );
    });

    test('reassemble rejects duplicate chunk indices', () async {
      final payload = ChunkPayload(
        type: ContentType.text,
        payload: Uint8List.fromList(utf8.encode('test')),
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final chunks = await channelService.splitIntoChunks(
        payload: payload,
        channel: channel,
        sequence: 1,
        routingHash: 'rh_test',
      );

      // Duplicate the first chunk to simulate a replay attack
      final duplicated = [
        chunks.first,
        chunks.first.copyWith(chunkId: 'ch_dup')
      ];

      expect(
        () => channelService.reassembleChunks(duplicated),
        throwsA(isA<ChannelServiceException>().having(
          (e) => e.message,
          'message',
          contains('duplicate'),
        )),
      );
    });

    test('reassemble rejects incomplete chunk set', () async {
      final largeData = Uint8List(ChannelService.chunkSize * 2 + 100);
      final payload = ChunkPayload(
        type: ContentType.file,
        payload: largeData,
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final chunks = await channelService.splitIntoChunks(
        payload: payload,
        channel: channel,
        sequence: 1,
        routingHash: 'rh_test',
      );

      // Remove the last chunk
      final incomplete = chunks.sublist(0, chunks.length - 1);

      expect(
        () => channelService.reassembleChunks(incomplete),
        throwsA(isA<ChannelServiceException>().having(
          (e) => e.message,
          'message',
          contains('expected'),
        )),
      );
    });
  });

  group('Manifest updates', () {
    late Channel channel;

    setUp(() async {
      channel = await channelService.createChannel(name: 'Admin Test');
    });

    test('addAdmin adds key to manifest and re-signs', () async {
      final adminKeys = await cryptoService.generateSigningKeyPair();

      final updated = await channelService.addAdmin(
        channel: channel,
        adminPublicKey: adminKeys.publicKey,
        adminLabel: 'Admin 1',
      );

      expect(updated.manifest.adminKeys, hasLength(1));
      expect(updated.manifest.adminKeys.first.key, adminKeys.publicKey);
      expect(updated.manifest.adminKeys.first.label, 'Admin 1');

      // Signature should be valid
      final isValid = await cryptoService.verifyManifest(updated.manifest);
      expect(isValid, isTrue);
    });

    test('removeAdmin removes key from manifest and re-signs', () async {
      final adminKeys = await cryptoService.generateSigningKeyPair();

      var updated = await channelService.addAdmin(
        channel: channel,
        adminPublicKey: adminKeys.publicKey,
        adminLabel: 'Admin 1',
      );

      updated = await channelService.removeAdmin(
        channel: updated,
        adminPublicKey: adminKeys.publicKey,
      );

      expect(updated.manifest.adminKeys, isEmpty);
      final isValid = await cryptoService.verifyManifest(updated.manifest);
      expect(isValid, isTrue);
    });

    test('rotateEncryptionKey generates new key and increments epoch',
        () async {
      final originalKey = channel.encryptionKeyPublic;
      final originalEpoch = channel.manifest.keyEpoch;

      final updated =
          await channelService.rotateEncryptionKey(channel: channel);

      expect(updated.encryptionKeyPublic, isNot(originalKey));
      expect(updated.manifest.keyEpoch, originalEpoch + 1);
      expect(updated.manifest.currentEncryptKey, updated.encryptionKeyPublic);

      final isValid = await cryptoService.verifyManifest(updated.manifest);
      expect(isValid, isTrue);
    });

    test('rotateEncryptionKey means old key cannot decrypt new content',
        () async {
      final oldKey = channel.encryptionKeyPrivate!;
      final updated =
          await channelService.rotateEncryptionKey(channel: channel);

      // Encrypt with the new key
      final payload = ChunkPayload(
        type: ContentType.text,
        payload: Uint8List.fromList(utf8.encode('New epoch content')),
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final encrypted = await cryptoService.encryptPayload(
        payload,
        updated.encryptionKeyPrivate!,
        updated.manifest.keyEpoch,
      );

      // Try to decrypt with the old key and old epoch — should fail
      expect(
        () => cryptoService.decryptPayload(encrypted, oldKey, 1),
        throwsA(isA<ChannelCryptoException>()),
      );
    });

    test('subscriber channel cannot add admin', () async {
      final subscription = await channelService.subscribe(
        manifest: channel.manifest,
        encryptionPrivateKey: channel.encryptionKeyPrivate!,
      );

      expect(
        () => channelService.addAdmin(
          channel: subscription,
          adminPublicKey: 'some-key',
          adminLabel: 'Attempt',
        ),
        throwsA(isA<ChannelServiceException>().having(
          (e) => e.message,
          'message',
          contains('owner'),
        )),
      );
    });
  });

  group('Storage delegation', () {
    test('getAllChannels returns all created channels', () async {
      await channelService.createChannel(name: 'Channel 1');
      await channelService.createChannel(name: 'Channel 2');

      final channels = await channelService.getAllChannels();
      expect(channels, hasLength(2));
    });

    test('getChannel returns correct channel', () async {
      final created = await channelService.createChannel(name: 'Find Me');
      final found = await channelService.getChannel(created.id);

      expect(found, isNotNull);
      expect(found!.manifest.name, 'Find Me');
    });

    test('deleteChannel removes channel', () async {
      final created = await channelService.createChannel(name: 'Delete Me');
      await channelService.deleteChannel(created.id);

      final found = await channelService.getChannel(created.id);
      expect(found, isNull);
    });
  });
}
