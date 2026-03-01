import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:zajel/features/channels/models/channel.dart';
import 'package:zajel/features/channels/models/chunk.dart';
import 'package:zajel/features/channels/services/channel_storage_service.dart';

import '../../mocks/mocks.dart';

/// Helper to create a [Channel] for testing.
Channel _makeChannel({
  String id = 'ch_1',
  ChannelRole role = ChannelRole.owner,
  String name = 'Test Channel',
  String? ownerSigningKeyPrivate,
  String? adminSigningKeyPrivate,
  String? encryptionKeyPrivate,
  DateTime? createdAt,
}) {
  final manifest = ChannelManifest(
    channelId: id,
    name: name,
    description: 'A test channel',
    ownerKey: 'owner_pub_key_b64',
    currentEncryptKey: 'encrypt_pub_key_b64',
  );
  return Channel(
    id: id,
    role: role,
    manifest: manifest,
    ownerSigningKeyPrivate: ownerSigningKeyPrivate,
    adminSigningKeyPrivate: adminSigningKeyPrivate,
    encryptionKeyPrivate: encryptionKeyPrivate,
    encryptionKeyPublic: 'encrypt_pub_key_b64',
    createdAt: createdAt ?? DateTime.utc(2026, 2, 1),
  );
}

/// Helper to create a [Chunk] for testing.
Chunk _makeChunk({
  String chunkId = 'chunk_1',
  String routingHash = 'rh_abc',
  int sequence = 1,
  int chunkIndex = 0,
  int totalChunks = 1,
  Uint8List? payload,
}) {
  final p = payload ?? Uint8List.fromList([10, 20, 30]);
  return Chunk(
    chunkId: chunkId,
    routingHash: routingHash,
    sequence: sequence,
    chunkIndex: chunkIndex,
    totalChunks: totalChunks,
    size: p.length,
    signature: 'sig_abc',
    authorPubkey: 'author_pub',
    encryptedPayload: p,
  );
}

void main() {
  sqfliteFfiInit();
  databaseFactory = databaseFactoryFfi;

  late ChannelStorageService service;
  late FakeSecureStorage secureStorage;

  setUp(() async {
    secureStorage = FakeSecureStorage();

    // Open an in-memory database with the same schema the service uses,
    // then inject it via the @visibleForTesting constructor.
    final db = await openDatabase(
      inMemoryDatabasePath,
      version: 1,
      onCreate: (db, version) async {
        await db.execute('''
          CREATE TABLE channels (
            id TEXT PRIMARY KEY,
            role TEXT NOT NULL,
            manifest TEXT NOT NULL,
            encryption_key_public TEXT NOT NULL,
            created_at TEXT NOT NULL
          )
        ''');
        await db.execute('''
          CREATE TABLE chunks (
            chunk_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            routing_hash TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL,
            total_chunks INTEGER NOT NULL,
            size INTEGER NOT NULL,
            signature TEXT NOT NULL,
            author_pubkey TEXT NOT NULL,
            encrypted_payload BLOB NOT NULL,
            PRIMARY KEY (chunk_id, channel_id)
          )
        ''');
        await db.execute(
          'CREATE INDEX idx_chunks_channel ON chunks (channel_id)',
        );
        await db.execute(
          'CREATE INDEX idx_chunks_sequence ON chunks (channel_id, sequence)',
        );
        await db.execute(
          'CREATE INDEX idx_chunks_routing ON chunks (routing_hash, channel_id)',
        );
      },
    );

    service = ChannelStorageService.withDatabase(
      database: db,
      secureStorage: secureStorage,
    );
  });

  tearDown(() async {
    await service.close();
  });

  // -- Tests --

  group('ChannelStorageService — uninitialized database guards', () {
    test('saveChannel throws ChannelStorageException when db is null', () {
      final uninit = ChannelStorageService(secureStorage: secureStorage);
      expect(
        () => uninit.saveChannel(_makeChannel()),
        throwsA(isA<ChannelStorageException>()),
      );
    });

    test('saveChunk throws ChannelStorageException when db is null', () {
      final uninit = ChannelStorageService(secureStorage: secureStorage);
      expect(
        () => uninit.saveChunk('ch_1', _makeChunk()),
        throwsA(isA<ChannelStorageException>()),
      );
    });

    test('getChannel returns null when db is null', () async {
      final uninit = ChannelStorageService(secureStorage: secureStorage);
      expect(await uninit.getChannel('ch_1'), isNull);
    });

    test('getAllChannels returns empty list when db is null', () async {
      final uninit = ChannelStorageService(secureStorage: secureStorage);
      expect(await uninit.getAllChannels(), isEmpty);
    });

    test('getChunksBySequence returns empty when db is null', () async {
      final uninit = ChannelStorageService(secureStorage: secureStorage);
      expect(await uninit.getChunksBySequence('ch_1', 1), isEmpty);
    });

    test('getLatestSequence returns 0 when db is null', () async {
      final uninit = ChannelStorageService(secureStorage: secureStorage);
      expect(await uninit.getLatestSequence('ch_1'), 0);
    });

    test('deleteChannel is a no-op when db is null', () async {
      final uninit = ChannelStorageService(secureStorage: secureStorage);
      await uninit.deleteChannel('ch_1'); // should not throw
    });

    test('getChunkIds returns empty when db is null', () async {
      final uninit = ChannelStorageService(secureStorage: secureStorage);
      expect(await uninit.getChunkIds('ch_1'), isEmpty);
    });
  });

  group('ChannelStorageService — saveChannel and getChannel', () {
    test('saves and retrieves a channel with all fields', () async {
      final channel = _makeChannel(
        ownerSigningKeyPrivate: 'priv_sign',
        encryptionKeyPrivate: 'priv_enc',
      );
      await service.saveChannel(channel);

      final retrieved = await service.getChannel('ch_1');
      expect(retrieved, isNotNull);
      expect(retrieved!.id, 'ch_1');
      expect(retrieved.role, ChannelRole.owner);
      expect(retrieved.manifest.name, 'Test Channel');
      expect(retrieved.manifest.description, 'A test channel');
      expect(retrieved.encryptionKeyPublic, 'encrypt_pub_key_b64');
      expect(retrieved.ownerSigningKeyPrivate, 'priv_sign');
      expect(retrieved.encryptionKeyPrivate, 'priv_enc');
    });

    test('stores admin signing key in secure storage', () async {
      final channel = _makeChannel(
        role: ChannelRole.admin,
        adminSigningKeyPrivate: 'admin_priv',
      );
      await service.saveChannel(channel);

      final retrieved = await service.getChannel('ch_1');
      expect(retrieved!.adminSigningKeyPrivate, 'admin_priv');
    });

    test('subscriber channel stores no private keys', () async {
      final channel = _makeChannel(role: ChannelRole.subscriber);
      await service.saveChannel(channel);

      final retrieved = await service.getChannel('ch_1');
      expect(retrieved!.ownerSigningKeyPrivate, isNull);
      expect(retrieved.adminSigningKeyPrivate, isNull);
      expect(retrieved.encryptionKeyPrivate, isNull);
    });

    test('replaces existing channel on conflict (upsert)', () async {
      await service.saveChannel(_makeChannel(name: 'Original'));
      await service.saveChannel(_makeChannel(name: 'Updated'));

      final retrieved = await service.getChannel('ch_1');
      expect(retrieved!.manifest.name, 'Updated');
    });

    test('getChannel returns null for non-existent ID', () async {
      expect(await service.getChannel('missing'), isNull);
    });
  });

  group('ChannelStorageService — getAllChannels', () {
    test('returns empty list when no channels exist', () async {
      expect(await service.getAllChannels(), isEmpty);
    });

    test('returns all saved channels with private keys', () async {
      await service.saveChannel(_makeChannel(
        id: 'ch_1',
        ownerSigningKeyPrivate: 'p1',
        createdAt: DateTime.utc(2026, 1, 1),
      ));
      await service.saveChannel(_makeChannel(
        id: 'ch_2',
        ownerSigningKeyPrivate: 'p2',
        createdAt: DateTime.utc(2026, 2, 1),
      ));

      final channels = await service.getAllChannels();
      expect(channels, hasLength(2));
      expect(channels.map((c) => c.id).toSet(), {'ch_1', 'ch_2'});
    });

    test('channels are ordered by created_at DESC', () async {
      await service.saveChannel(_makeChannel(
        id: 'old',
        createdAt: DateTime.utc(2025, 1, 1),
      ));
      await service.saveChannel(_makeChannel(
        id: 'new',
        createdAt: DateTime.utc(2026, 6, 1),
      ));

      final channels = await service.getAllChannels();
      expect(channels.first.id, 'new');
      expect(channels.last.id, 'old');
    });
  });

  group('ChannelStorageService — deleteChannel', () {
    test('removes channel row from database', () async {
      await service.saveChannel(_makeChannel());
      await service.deleteChannel('ch_1');
      expect(await service.getChannel('ch_1'), isNull);
    });

    test('removes associated chunks', () async {
      await service.saveChannel(_makeChannel());
      await service.saveChunk('ch_1', _makeChunk());
      await service.deleteChannel('ch_1');

      final chunks = await service.getChunkIds('ch_1');
      expect(chunks, isEmpty);
    });

    test('removes private keys from secure storage', () async {
      await service.saveChannel(_makeChannel(
        ownerSigningKeyPrivate: 'sign',
        adminSigningKeyPrivate: 'admin',
        encryptionKeyPrivate: 'enc',
      ));
      await service.deleteChannel('ch_1');

      expect(
        await secureStorage.read(key: 'zajel_channel_ch_1_signing_private'),
        isNull,
      );
      expect(
        await secureStorage.read(
            key: 'zajel_channel_ch_1_admin_signing_private'),
        isNull,
      );
      expect(
        await secureStorage.read(key: 'zajel_channel_ch_1_encryption_private'),
        isNull,
      );
    });

    test('is safe to call for non-existent channel', () async {
      await service.deleteChannel('missing'); // should not throw
    });
  });

  group('ChannelStorageService — saveChunk and chunk retrieval', () {
    test('saves and retrieves a chunk by ID', () async {
      final chunk = _makeChunk();
      await service.saveChunk('ch_1', chunk);

      final retrieved = await service.getChunk('ch_1', 'chunk_1');
      expect(retrieved, isNotNull);
      expect(retrieved!.chunkId, 'chunk_1');
      expect(retrieved.routingHash, 'rh_abc');
      expect(retrieved.sequence, 1);
      expect(retrieved.encryptedPayload, Uint8List.fromList([10, 20, 30]));
    });

    test('replaces chunk on primary key conflict', () async {
      await service.saveChunk(
          'ch_1', _makeChunk(payload: Uint8List.fromList([1, 2])));
      await service.saveChunk(
          'ch_1', _makeChunk(payload: Uint8List.fromList([3, 4, 5])));

      final retrieved = await service.getChunk('ch_1', 'chunk_1');
      expect(retrieved, isNotNull);
      expect(retrieved!.encryptedPayload, Uint8List.fromList([3, 4, 5]));
    });
  });

  group('ChannelStorageService — getChunksBySequence', () {
    test('returns chunks for target sequence ordered by chunk_index', () async {
      await service.saveChunk(
        'ch_1',
        _makeChunk(chunkId: 'c1', sequence: 1, chunkIndex: 1, totalChunks: 2),
      );
      await service.saveChunk(
        'ch_1',
        _makeChunk(chunkId: 'c0', sequence: 1, chunkIndex: 0, totalChunks: 2),
      );
      await service.saveChunk(
        'ch_1',
        _makeChunk(chunkId: 'c2', sequence: 2, chunkIndex: 0),
      );

      final chunks = await service.getChunksBySequence('ch_1', 1);
      expect(chunks, hasLength(2));
      expect(chunks[0].chunkIndex, 0);
      expect(chunks[1].chunkIndex, 1);
    });

    test('returns empty list for non-existent sequence', () async {
      final chunks = await service.getChunksBySequence('ch_1', 99);
      expect(chunks, isEmpty);
    });
  });

  group('ChannelStorageService — getChunkIds', () {
    test('returns all chunk IDs for the specified channel only', () async {
      await service.saveChunk('ch_1', _makeChunk(chunkId: 'c1'));
      await service.saveChunk('ch_1', _makeChunk(chunkId: 'c2'));
      await service.saveChunk('ch_other', _makeChunk(chunkId: 'c3'));

      final ids = await service.getChunkIds('ch_1');
      expect(ids, containsAll(['c1', 'c2']));
      expect(ids, hasLength(2));
    });
  });

  group('ChannelStorageService — getAllChunksForChannel', () {
    test('returns chunks ordered by sequence ASC, chunk_index ASC', () async {
      await service.saveChunk(
        'ch_1',
        _makeChunk(chunkId: 'c3', sequence: 2, chunkIndex: 0),
      );
      await service.saveChunk(
        'ch_1',
        _makeChunk(chunkId: 'c1', sequence: 1, chunkIndex: 0, totalChunks: 2),
      );
      await service.saveChunk(
        'ch_1',
        _makeChunk(chunkId: 'c2', sequence: 1, chunkIndex: 1, totalChunks: 2),
      );

      final chunks = await service.getAllChunksForChannel('ch_1');
      expect(chunks, hasLength(3));
      expect(chunks[0].chunkId, 'c1');
      expect(chunks[1].chunkId, 'c2');
      expect(chunks[2].chunkId, 'c3');
    });
  });

  group('ChannelStorageService — deleteChunksBySequence', () {
    test('removes only chunks for target sequence', () async {
      await service.saveChunk('ch_1', _makeChunk(chunkId: 'c1', sequence: 1));
      await service.saveChunk('ch_1', _makeChunk(chunkId: 'c2', sequence: 2));

      await service.deleteChunksBySequence('ch_1', 1);

      final remaining = await service.getAllChunksForChannel('ch_1');
      expect(remaining, hasLength(1));
      expect(remaining[0].sequence, 2);
    });
  });

  group('ChannelStorageService — getLatestSequence', () {
    test('returns max sequence number across all chunks', () async {
      await service.saveChunk('ch_1', _makeChunk(chunkId: 'c1', sequence: 1));
      await service.saveChunk('ch_1', _makeChunk(chunkId: 'c2', sequence: 5));
      await service.saveChunk('ch_1', _makeChunk(chunkId: 'c3', sequence: 3));

      expect(await service.getLatestSequence('ch_1'), 5);
    });

    test('returns 0 when no chunks exist', () async {
      expect(await service.getLatestSequence('ch_1'), 0);
    });
  });

  group('ChannelStorageException', () {
    test('toString includes the message', () {
      final e = ChannelStorageException('test error');
      expect(e.toString(), 'ChannelStorageException: test error');
    });

    test('message field is accessible', () {
      final e = ChannelStorageException('some issue');
      expect(e.message, 'some issue');
    });
  });

  group('Channel model serialization round-trip', () {
    test('toJson and fromJson preserve all fields', () {
      final channel = _makeChannel(
        ownerSigningKeyPrivate: 'sign_priv',
        encryptionKeyPrivate: 'enc_priv',
      );
      final json = channel.toJson();
      final restored = Channel.fromJson(
        json,
        ownerSigningKeyPrivate: 'sign_priv',
        encryptionKeyPrivate: 'enc_priv',
      );

      expect(restored.id, channel.id);
      expect(restored.role, channel.role);
      expect(restored.manifest.name, channel.manifest.name);
      expect(restored.encryptionKeyPublic, channel.encryptionKeyPublic);
      expect(restored.ownerSigningKeyPrivate, 'sign_priv');
      expect(restored.encryptionKeyPrivate, 'enc_priv');
    });
  });

  group('Chunk model serialization round-trip', () {
    test('stored payload bytes are preserved through DB insert/query',
        () async {
      final payload = Uint8List.fromList([0, 1, 2, 255, 128, 64]);
      await service.saveChunk('ch_1', _makeChunk(payload: payload));

      final retrieved = await service.getChunk('ch_1', 'chunk_1');
      expect(retrieved, isNotNull);
      expect(retrieved!.encryptedPayload, payload);
    });
  });
}
