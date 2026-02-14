import 'dart:typed_data';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path/path.dart';
import 'package:path_provider/path_provider.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../models/channel.dart';
import '../models/chunk.dart';

/// SQLite-backed storage for channels and chunks.
///
/// Channels are stored in the `channels` table. Private keys are kept
/// separately in [FlutterSecureStorage] to avoid leaking them if the
/// database file is compromised.
///
/// Chunks are stored in the `chunks` table, indexed by channel and sequence.
class ChannelStorageService {
  static const _dbName = 'zajel_channels.db';
  static const _channelsTable = 'channels';
  static const _chunksTable = 'chunks';
  static const _dbVersion = 1;

  static const _secureKeyPrefix = 'zajel_channel_';

  Database? _db;
  final FlutterSecureStorage _secureStorage;

  ChannelStorageService({FlutterSecureStorage? secureStorage})
      : _secureStorage = secureStorage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  /// Open the database, creating tables if necessary.
  ///
  /// On desktop platforms (Linux, Windows, macOS), the sqflite FFI backend
  /// must be initialized once before any database is opened. This is done
  /// centrally in `main()` — do NOT call `sqfliteFfiInit()` here.
  Future<void> initialize() async {
    if (_db != null) return;

    final dir = await getApplicationDocumentsDirectory();
    final path = join(dir.path, _dbName);

    _db = await openDatabase(
      path,
      version: _dbVersion,
      onCreate: (db, version) async {
        await db.execute('''
          CREATE TABLE $_channelsTable (
            id TEXT PRIMARY KEY,
            role TEXT NOT NULL,
            manifest TEXT NOT NULL,
            encryption_key_public TEXT NOT NULL,
            created_at TEXT NOT NULL
          )
        ''');

        await db.execute('''
          CREATE TABLE $_chunksTable (
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
          'CREATE INDEX idx_chunks_channel ON $_chunksTable (channel_id)',
        );
        await db.execute(
          'CREATE INDEX idx_chunks_sequence ON $_chunksTable (channel_id, sequence)',
        );
        await db.execute(
          'CREATE INDEX idx_chunks_routing ON $_chunksTable (routing_hash)',
        );
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Channel CRUD
  // ---------------------------------------------------------------------------

  /// Save a channel to the database and its private keys to secure storage.
  Future<void> saveChannel(Channel channel) async {
    final db = _db;
    if (db == null) {
      throw ChannelStorageException('Database not initialized');
    }

    await db.insert(
      _channelsTable,
      channel.toJson(),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );

    // Store private keys in secure storage (only if present)
    if (channel.ownerSigningKeyPrivate != null) {
      await _secureStorage.write(
        key: '$_secureKeyPrefix${channel.id}_signing_private',
        value: channel.ownerSigningKeyPrivate,
      );
    }
    if (channel.adminSigningKeyPrivate != null) {
      await _secureStorage.write(
        key: '$_secureKeyPrefix${channel.id}_admin_signing_private',
        value: channel.adminSigningKeyPrivate,
      );
    }
    if (channel.encryptionKeyPrivate != null) {
      await _secureStorage.write(
        key: '$_secureKeyPrefix${channel.id}_encryption_private',
        value: channel.encryptionKeyPrivate,
      );
    }
  }

  /// Get a channel by ID, loading private keys from secure storage.
  Future<Channel?> getChannel(String channelId) async {
    final db = _db;
    if (db == null) return null;

    final rows = await db.query(
      _channelsTable,
      where: 'id = ?',
      whereArgs: [channelId],
      limit: 1,
    );

    if (rows.isEmpty) return null;

    final signingKey = await _secureStorage.read(
      key: '$_secureKeyPrefix${channelId}_signing_private',
    );
    final adminSigningKey = await _secureStorage.read(
      key: '$_secureKeyPrefix${channelId}_admin_signing_private',
    );
    final encryptionKey = await _secureStorage.read(
      key: '$_secureKeyPrefix${channelId}_encryption_private',
    );

    return Channel.fromJson(
      rows.first,
      ownerSigningKeyPrivate: signingKey,
      adminSigningKeyPrivate: adminSigningKey,
      encryptionKeyPrivate: encryptionKey,
    );
  }

  /// Get all channels.
  Future<List<Channel>> getAllChannels() async {
    final db = _db;
    if (db == null) return [];

    final rows = await db.query(_channelsTable, orderBy: 'created_at DESC');
    final channels = <Channel>[];

    for (final row in rows) {
      final id = row['id'] as String;
      final signingKey = await _secureStorage.read(
        key: '$_secureKeyPrefix${id}_signing_private',
      );
      final adminSigningKey = await _secureStorage.read(
        key: '$_secureKeyPrefix${id}_admin_signing_private',
      );
      final encryptionKey = await _secureStorage.read(
        key: '$_secureKeyPrefix${id}_encryption_private',
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

  /// Delete a channel and all its chunks + secure keys.
  Future<void> deleteChannel(String channelId) async {
    final db = _db;
    if (db == null) return;

    await db.delete(_channelsTable, where: 'id = ?', whereArgs: [channelId]);
    await db
        .delete(_chunksTable, where: 'channel_id = ?', whereArgs: [channelId]);

    await _secureStorage.delete(
        key: '$_secureKeyPrefix${channelId}_signing_private');
    await _secureStorage.delete(
        key: '$_secureKeyPrefix${channelId}_admin_signing_private');
    await _secureStorage.delete(
        key: '$_secureKeyPrefix${channelId}_encryption_private');
  }

  // ---------------------------------------------------------------------------
  // Chunk CRUD
  // ---------------------------------------------------------------------------

  /// Save a chunk to the database.
  Future<void> saveChunk(String channelId, Chunk chunk) async {
    final db = _db;
    if (db == null) {
      throw ChannelStorageException('Database not initialized');
    }

    await db.insert(
      _chunksTable,
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

  /// Get all chunks for a specific sequence (message) in a channel.
  Future<List<Chunk>> getChunksBySequence(
      String channelId, int sequence) async {
    final db = _db;
    if (db == null) return [];

    final rows = await db.query(
      _chunksTable,
      where: 'channel_id = ? AND sequence = ?',
      whereArgs: [channelId, sequence],
      orderBy: 'chunk_index ASC',
    );

    return rows.map(_rowToChunk).toList();
  }

  /// Get a single chunk by ID.
  Future<Chunk?> getChunk(String channelId, String chunkId) async {
    final db = _db;
    if (db == null) return null;

    final rows = await db.query(
      _chunksTable,
      where: 'channel_id = ? AND chunk_id = ?',
      whereArgs: [channelId, chunkId],
      limit: 1,
    );

    if (rows.isEmpty) return null;
    return _rowToChunk(rows.first);
  }

  /// Get all chunk IDs for a channel (for announcing availability to VPS).
  Future<List<String>> getChunkIds(String channelId) async {
    final db = _db;
    if (db == null) return [];

    final rows = await db.query(
      _chunksTable,
      columns: ['chunk_id'],
      where: 'channel_id = ?',
      whereArgs: [channelId],
    );

    return rows.map((r) => r['chunk_id'] as String).toList();
  }

  /// Get all chunks for a channel, ordered by sequence then chunk_index.
  Future<List<Chunk>> getAllChunksForChannel(String channelId) async {
    final db = _db;
    if (db == null) return [];

    final rows = await db.query(
      _chunksTable,
      where: 'channel_id = ?',
      whereArgs: [channelId],
      orderBy: 'sequence ASC, chunk_index ASC',
    );

    return rows.map(_rowToChunk).toList();
  }

  /// Delete all chunks for a specific sequence.
  Future<void> deleteChunksBySequence(String channelId, int sequence) async {
    final db = _db;
    if (db == null) return;

    await db.delete(
      _chunksTable,
      where: 'channel_id = ? AND sequence = ?',
      whereArgs: [channelId, sequence],
    );
  }

  /// Get the latest sequence number for a channel (for incrementing).
  Future<int> getLatestSequence(String channelId) async {
    final db = _db;
    if (db == null) return 0;

    final result = await db.rawQuery(
      'SELECT MAX(sequence) as max_seq FROM $_chunksTable WHERE channel_id = ?',
      [channelId],
    );

    final maxSeq = result.first['max_seq'];
    if (maxSeq == null) return 0;
    return maxSeq as int;
  }

  /// Close the database.
  Future<void> close() async {
    await _db?.close();
    _db = null;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  Chunk _rowToChunk(Map<String, dynamic> row) {
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
}

/// Exception thrown by channel storage operations.
class ChannelStorageException implements Exception {
  final String message;
  ChannelStorageException(this.message);

  @override
  String toString() => 'ChannelStorageException: $message';
}
