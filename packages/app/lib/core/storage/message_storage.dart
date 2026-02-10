import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:path/path.dart';
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../models/message.dart';

/// SQLite-backed storage for chat messages.
///
/// Provides persistent message storage with per-peer retrieval,
/// paginated loading, and conversation deletion.
class MessageStorage {
  static const _dbName = 'zajel_messages.db';
  static const _tableName = 'messages';
  static const _dbVersion = 1;

  Database? _db;

  /// Open the database, creating it if necessary.
  Future<void> initialize() async {
    if (_db != null) return;

    // sqflite requires FFI initialization on desktop platforms
    if (!kIsWeb &&
        (Platform.isLinux || Platform.isWindows || Platform.isMacOS)) {
      sqfliteFfiInit();
      databaseFactory = databaseFactoryFfi;
    }

    final dir = await getApplicationDocumentsDirectory();
    final path = join(dir.path, _dbName);

    _db = await openDatabase(
      path,
      version: _dbVersion,
      onCreate: (db, version) async {
        await db.execute('''
          CREATE TABLE $_tableName (
            localId TEXT PRIMARY KEY,
            peerId TEXT NOT NULL,
            content TEXT NOT NULL,
            type TEXT NOT NULL,
            status TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            isOutgoing INTEGER NOT NULL,
            attachmentPath TEXT,
            attachmentSize INTEGER,
            attachmentName TEXT
          )
        ''');
        await db.execute(
          'CREATE INDEX idx_messages_peerId ON $_tableName (peerId)',
        );
        await db.execute(
          'CREATE INDEX idx_messages_timestamp ON $_tableName (peerId, timestamp)',
        );
      },
    );
  }

  /// Save a message to the database.
  Future<void> saveMessage(Message message) async {
    final db = _db;
    if (db == null) return;

    await db.insert(
      _tableName,
      {
        'localId': message.localId,
        'peerId': message.peerId,
        'content': message.content,
        'type': message.type.name,
        'status': message.status.name,
        'timestamp': message.timestamp.toIso8601String(),
        'isOutgoing': message.isOutgoing ? 1 : 0,
        'attachmentPath': message.attachmentPath,
        'attachmentSize': message.attachmentSize,
        'attachmentName': message.attachmentName,
      },
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  /// Update a message's status.
  Future<void> updateMessageStatus(String localId, MessageStatus status) async {
    final db = _db;
    if (db == null) return;

    await db.update(
      _tableName,
      {'status': status.name},
      where: 'localId = ?',
      whereArgs: [localId],
    );
  }

  /// Get messages for a peer, ordered by timestamp ascending.
  /// Returns the most recent [limit] messages, offset by [offset].
  Future<List<Message>> getMessages(
    String peerId, {
    int limit = 100,
    int offset = 0,
  }) async {
    final db = _db;
    if (db == null) return [];

    final rows = await db.query(
      _tableName,
      where: 'peerId = ?',
      whereArgs: [peerId],
      orderBy: 'timestamp ASC',
      limit: limit,
      offset: offset,
    );

    return rows.map(_rowToMessage).toList();
  }

  /// Get the last message for a peer (for conversation list preview).
  Future<Message?> getLastMessage(String peerId) async {
    final db = _db;
    if (db == null) return null;

    final rows = await db.query(
      _tableName,
      where: 'peerId = ?',
      whereArgs: [peerId],
      orderBy: 'timestamp DESC',
      limit: 1,
    );

    if (rows.isEmpty) return null;
    return _rowToMessage(rows.first);
  }

  /// Get the total message count for a peer.
  Future<int> getMessageCount(String peerId) async {
    final db = _db;
    if (db == null) return 0;

    final result = await db.rawQuery(
      'SELECT COUNT(*) as count FROM $_tableName WHERE peerId = ?',
      [peerId],
    );
    return Sqflite.firstIntValue(result) ?? 0;
  }

  /// Delete all messages for a peer.
  Future<void> deleteMessages(String peerId) async {
    final db = _db;
    if (db == null) return;

    await db.delete(
      _tableName,
      where: 'peerId = ?',
      whereArgs: [peerId],
    );
  }

  /// Delete all messages.
  Future<void> deleteAllMessages() async {
    final db = _db;
    if (db == null) return;

    await db.delete(_tableName);
  }

  /// Close the database.
  Future<void> close() async {
    await _db?.close();
    _db = null;
  }

  Message _rowToMessage(Map<String, dynamic> row) {
    return Message(
      localId: row['localId'] as String,
      peerId: row['peerId'] as String,
      content: row['content'] as String,
      type: MessageType.values.firstWhere(
        (e) => e.name == row['type'],
        orElse: () => MessageType.text,
      ),
      status: MessageStatus.values.firstWhere(
        (e) => e.name == row['status'],
        orElse: () => MessageStatus.pending,
      ),
      timestamp: DateTime.parse(row['timestamp'] as String),
      isOutgoing: (row['isOutgoing'] as int) == 1,
      attachmentPath: row['attachmentPath'] as String?,
      attachmentSize: row['attachmentSize'] as int?,
      attachmentName: row['attachmentName'] as String?,
    );
  }
}
