import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:zajel/features/channels/models/channel.dart';
import 'package:zajel/features/channels/models/chunk.dart';
import 'package:zajel/features/channels/services/channel_storage_service.dart';

import '../../mocks/mocks.dart';

// Since ChannelStorageService._db is file-private and initialize() requires
// path_provider (a platform channel), we test the service's SQL and secure
// storage logic using an in-memory sqflite_ffi database that replicates the
// same schema and queries. The uninitialized-database guard tests exercise
// the real ChannelStorageService instance directly.

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

  late Database db;
  late FakeSecureStorage secureStorage;

  // Constants matching the production code.
  const channelsTable = 'channels';
  const chunksTable = 'chunks';
  const secureKeyPrefix = 'zajel_channel_';

  setUp(() async {
    secureStorage = FakeSecureStorage();
    db = await openDatabase(
      inMemoryDatabasePath,
      version: 1,
      onCreate: (db, version) async {
        await db.execute('''
          CREATE TABLE $channelsTable (
            id TEXT PRIMARY KEY,
            role TEXT NOT NULL,
            manifest TEXT NOT NULL,
            encryption_key_public TEXT NOT NULL,
            created_at TEXT NOT NULL
          )
        ''');
        await db.execute('''
          CREATE TABLE $chunksTable (
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
          'CREATE INDEX idx_chunks_channel ON $chunksTable (channel_id)',
        );
        await db.execute(
          'CREATE INDEX idx_chunks_sequence ON $chunksTable (channel_id, sequence)',
        );
        await db.execute(
          'CREATE INDEX idx_chunks_routing ON $chunksTable (routing_hash)',
        );
      },
    );
  });

  tearDown(() async {
    await db.close();
  });

  // -- Helper functions that replicate the service's SQL logic for testing --

  Future<void> saveChannel(Channel channel) async {
    await db.insert(
      channelsTable,
      channel.toJson(),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
    if (channel.ownerSigningKeyPrivate != null) {
      await secureStorage.write(
        key: '$secureKeyPrefix${channel.id}_signing_private',
        value: channel.ownerSigningKeyPrivate,
      );
    }
    if (channel.adminSigningKeyPrivate != null) {
      await secureStorage.write(
        key: '$secureKeyPrefix${channel.id}_admin_signing_private',
        value: channel.adminSigningKeyPrivate,
      );
    }
    if (channel.encryptionKeyPrivate != null) {
      await secureStorage.write(
        key: '$secureKeyPrefix${channel.id}_encryption_private',
        value: channel.encryptionKeyPrivate,
      );
    }
  }

  Future<Channel?> getChannel(String channelId) async {
    final rows = await db.query(
      channelsTable,
      where: 'id = ?',
      whereArgs: [channelId],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    final signingKey = await secureStorage.read(
      key: '$secureKeyPrefix${channelId}_signing_private',
    );
    final adminSigningKey = await secureStorage.read(
      key: '$secureKeyPrefix${channelId}_admin_signing_private',
    );
    final encryptionKey = await secureStorage.read(
      key: '$secureKeyPrefix${channelId}_encryption_private',
    );
    return Channel.fromJson(
      rows.first,
      ownerSigningKeyPrivate: signingKey,
      adminSigningKeyPrivate: adminSigningKey,
      encryptionKeyPrivate: encryptionKey,
    );
  }

  Future<List<Channel>> getAllChannels() async {
    final rows = await db.query(channelsTable, orderBy: 'created_at DESC');
    final channels = <Channel>[];
    for (final row in rows) {
      final id = row['id'] as String;
      final signingKey = await secureStorage.read(
        key: '$secureKeyPrefix${id}_signing_private',
      );
      final adminSigningKey = await secureStorage.read(
        key: '$secureKeyPrefix${id}_admin_signing_private',
      );
      final encryptionKey = await secureStorage.read(
        key: '$secureKeyPrefix${id}_encryption_private',
      );
      channels.add(Channel.fromJson(
        row,
        ownerSigningKeyPrivate: signingKey,
        adminSigningKeyPrivate: adminSigningKey,
        encryptionKeyPrivate: encryptionKey,
      ));
    }
    return channels;
  }

  Future<void> deleteChannel(String channelId) async {
    await db.delete(channelsTable, where: 'id = ?', whereArgs: [channelId]);
    await db
        .delete(chunksTable, where: 'channel_id = ?', whereArgs: [channelId]);
    await secureStorage.delete(
        key: '$secureKeyPrefix${channelId}_signing_private');
    await secureStorage.delete(
        key: '$secureKeyPrefix${channelId}_admin_signing_private');
    await secureStorage.delete(
        key: '$secureKeyPrefix${channelId}_encryption_private');
  }

  Future<void> saveChunk(String channelId, Chunk chunk) async {
    await db.insert(
      chunksTable,
      {
        'chunk_id': chunk.chunkId,
        'channel_id': channelId,
        'routing_hash': chunk.routingHash,
        'sequence': chunk.sequence,
        'chunk_index': chunk.chunkIndex,
        'total_chunks': chunk.totalChunks,
        'size': chunk.size,
        'signature': chunk.signature,
        'author_pubkey': chunk.authorPubkey,
        'encrypted_payload': chunk.encryptedPayload,
      },
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  Chunk rowToChunk(Map<String, dynamic> row) {
    return Chunk(
      chunkId: row['chunk_id'] as String,
      routingHash: row['routing_hash'] as String,
      sequence: row['sequence'] as int,
      chunkIndex: row['chunk_index'] as int,
      totalChunks: row['total_chunks'] as int,
      size: row['size'] as int,
      signature: row['signature'] as String,
      authorPubkey: row['author_pubkey'] as String,
      encryptedPayload:
          Uint8List.fromList(row['encrypted_payload'] as List<int>),
    );
  }

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
      await saveChannel(channel);

      final retrieved = await getChannel('ch_1');
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
      await saveChannel(channel);

      final retrieved = await getChannel('ch_1');
      expect(retrieved!.adminSigningKeyPrivate, 'admin_priv');
    });

    test('subscriber channel stores no private keys', () async {
      final channel = _makeChannel(role: ChannelRole.subscriber);
      await saveChannel(channel);

      final retrieved = await getChannel('ch_1');
      expect(retrieved!.ownerSigningKeyPrivate, isNull);
      expect(retrieved.adminSigningKeyPrivate, isNull);
      expect(retrieved.encryptionKeyPrivate, isNull);
    });

    test('replaces existing channel on conflict (upsert)', () async {
      await saveChannel(_makeChannel(name: 'Original'));
      await saveChannel(_makeChannel(name: 'Updated'));

      final retrieved = await getChannel('ch_1');
      expect(retrieved!.manifest.name, 'Updated');
    });

    test('getChannel returns null for non-existent ID', () async {
      expect(await getChannel('missing'), isNull);
    });
  });

  group('ChannelStorageService — getAllChannels', () {
    test('returns empty list when no channels exist', () async {
      expect(await getAllChannels(), isEmpty);
    });

    test('returns all saved channels with private keys', () async {
      await saveChannel(_makeChannel(
        id: 'ch_1',
        ownerSigningKeyPrivate: 'p1',
        createdAt: DateTime.utc(2026, 1, 1),
      ));
      await saveChannel(_makeChannel(
        id: 'ch_2',
        ownerSigningKeyPrivate: 'p2',
        createdAt: DateTime.utc(2026, 2, 1),
      ));

      final channels = await getAllChannels();
      expect(channels, hasLength(2));
      expect(channels.map((c) => c.id).toSet(), {'ch_1', 'ch_2'});
    });

    test('channels are ordered by created_at DESC', () async {
      await saveChannel(_makeChannel(
        id: 'old',
        createdAt: DateTime.utc(2025, 1, 1),
      ));
      await saveChannel(_makeChannel(
        id: 'new',
        createdAt: DateTime.utc(2026, 6, 1),
      ));

      final channels = await getAllChannels();
      expect(channels.first.id, 'new');
      expect(channels.last.id, 'old');
    });
  });

  group('ChannelStorageService — deleteChannel', () {
    test('removes channel row from database', () async {
      await saveChannel(_makeChannel());
      await deleteChannel('ch_1');
      expect(await getChannel('ch_1'), isNull);
    });

    test('removes associated chunks', () async {
      await saveChannel(_makeChannel());
      await saveChunk('ch_1', _makeChunk());
      await deleteChannel('ch_1');

      final rows = await db
          .query(chunksTable, where: 'channel_id = ?', whereArgs: ['ch_1']);
      expect(rows, isEmpty);
    });

    test('removes private keys from secure storage', () async {
      await saveChannel(_makeChannel(
        ownerSigningKeyPrivate: 'sign',
        adminSigningKeyPrivate: 'admin',
        encryptionKeyPrivate: 'enc',
      ));
      await deleteChannel('ch_1');

      expect(
        await secureStorage.read(key: '${secureKeyPrefix}ch_1_signing_private'),
        isNull,
      );
      expect(
        await secureStorage.read(
            key: '${secureKeyPrefix}ch_1_admin_signing_private'),
        isNull,
      );
      expect(
        await secureStorage.read(
            key: '${secureKeyPrefix}ch_1_encryption_private'),
        isNull,
      );
    });

    test('is safe to call for non-existent channel', () async {
      await deleteChannel('missing'); // should not throw
    });
  });

  group('ChannelStorageService — saveChunk and chunk retrieval', () {
    test('saves and retrieves a chunk by ID', () async {
      final chunk = _makeChunk();
      await saveChunk('ch_1', chunk);

      final rows = await db.query(
        chunksTable,
        where: 'channel_id = ? AND chunk_id = ?',
        whereArgs: ['ch_1', 'chunk_1'],
        limit: 1,
      );
      expect(rows, hasLength(1));
      final retrieved = rowToChunk(rows.first);
      expect(retrieved.chunkId, 'chunk_1');
      expect(retrieved.routingHash, 'rh_abc');
      expect(retrieved.sequence, 1);
      expect(retrieved.encryptedPayload, Uint8List.fromList([10, 20, 30]));
    });

    test('replaces chunk on primary key conflict', () async {
      await saveChunk('ch_1', _makeChunk(payload: Uint8List.fromList([1, 2])));
      await saveChunk(
          'ch_1', _makeChunk(payload: Uint8List.fromList([3, 4, 5])));

      final rows = await db.query(chunksTable,
          where: 'channel_id = ? AND chunk_id = ?',
          whereArgs: ['ch_1', 'chunk_1']);
      expect(rows, hasLength(1));
      final retrieved = rowToChunk(rows.first);
      expect(retrieved.encryptedPayload, Uint8List.fromList([3, 4, 5]));
    });
  });

  group('ChannelStorageService — getChunksBySequence', () {
    test('returns chunks for target sequence ordered by chunk_index', () async {
      await saveChunk(
        'ch_1',
        _makeChunk(chunkId: 'c1', sequence: 1, chunkIndex: 1, totalChunks: 2),
      );
      await saveChunk(
        'ch_1',
        _makeChunk(chunkId: 'c0', sequence: 1, chunkIndex: 0, totalChunks: 2),
      );
      await saveChunk(
        'ch_1',
        _makeChunk(chunkId: 'c2', sequence: 2, chunkIndex: 0),
      );

      final rows = await db.query(
        chunksTable,
        where: 'channel_id = ? AND sequence = ?',
        whereArgs: ['ch_1', 1],
        orderBy: 'chunk_index ASC',
      );
      expect(rows, hasLength(2));
      expect(rows[0]['chunk_index'], 0);
      expect(rows[1]['chunk_index'], 1);
    });

    test('returns empty list for non-existent sequence', () async {
      final rows = await db.query(
        chunksTable,
        where: 'channel_id = ? AND sequence = ?',
        whereArgs: ['ch_1', 99],
      );
      expect(rows, isEmpty);
    });
  });

  group('ChannelStorageService — getChunkIds', () {
    test('returns all chunk IDs for the specified channel only', () async {
      await saveChunk('ch_1', _makeChunk(chunkId: 'c1'));
      await saveChunk('ch_1', _makeChunk(chunkId: 'c2'));
      await saveChunk('ch_other', _makeChunk(chunkId: 'c3'));

      final rows = await db.query(
        chunksTable,
        columns: ['chunk_id'],
        where: 'channel_id = ?',
        whereArgs: ['ch_1'],
      );
      final ids = rows.map((r) => r['chunk_id'] as String).toList();
      expect(ids, containsAll(['c1', 'c2']));
      expect(ids, hasLength(2));
    });
  });

  group('ChannelStorageService — getAllChunksForChannel', () {
    test('returns chunks ordered by sequence ASC, chunk_index ASC', () async {
      await saveChunk(
        'ch_1',
        _makeChunk(chunkId: 'c3', sequence: 2, chunkIndex: 0),
      );
      await saveChunk(
        'ch_1',
        _makeChunk(chunkId: 'c1', sequence: 1, chunkIndex: 0, totalChunks: 2),
      );
      await saveChunk(
        'ch_1',
        _makeChunk(chunkId: 'c2', sequence: 1, chunkIndex: 1, totalChunks: 2),
      );

      final rows = await db.query(
        chunksTable,
        where: 'channel_id = ?',
        whereArgs: ['ch_1'],
        orderBy: 'sequence ASC, chunk_index ASC',
      );
      expect(rows, hasLength(3));
      expect(rows[0]['chunk_id'], 'c1');
      expect(rows[1]['chunk_id'], 'c2');
      expect(rows[2]['chunk_id'], 'c3');
    });
  });

  group('ChannelStorageService — deleteChunksBySequence', () {
    test('removes only chunks for target sequence', () async {
      await saveChunk('ch_1', _makeChunk(chunkId: 'c1', sequence: 1));
      await saveChunk('ch_1', _makeChunk(chunkId: 'c2', sequence: 2));

      await db.delete(
        chunksTable,
        where: 'channel_id = ? AND sequence = ?',
        whereArgs: ['ch_1', 1],
      );

      final remaining = await db
          .query(chunksTable, where: 'channel_id = ?', whereArgs: ['ch_1']);
      expect(remaining, hasLength(1));
      expect(remaining[0]['sequence'], 2);
    });
  });

  group('ChannelStorageService — getLatestSequence', () {
    test('returns max sequence number across all chunks', () async {
      await saveChunk('ch_1', _makeChunk(chunkId: 'c1', sequence: 1));
      await saveChunk('ch_1', _makeChunk(chunkId: 'c2', sequence: 5));
      await saveChunk('ch_1', _makeChunk(chunkId: 'c3', sequence: 3));

      final result = await db.rawQuery(
        'SELECT MAX(sequence) as max_seq FROM $chunksTable WHERE channel_id = ?',
        ['ch_1'],
      );
      expect(result.first['max_seq'], 5);
    });

    test('returns 0 (null) when no chunks exist', () async {
      final result = await db.rawQuery(
        'SELECT MAX(sequence) as max_seq FROM $chunksTable WHERE channel_id = ?',
        ['ch_1'],
      );
      expect(result.first['max_seq'], isNull);
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
      await saveChunk('ch_1', _makeChunk(payload: payload));

      final rows = await db.query(chunksTable,
          where: 'channel_id = ? AND chunk_id = ?',
          whereArgs: ['ch_1', 'chunk_1']);
      final retrieved = rowToChunk(rows.first);
      expect(retrieved.encryptedPayload, payload);
    });
  });
}
