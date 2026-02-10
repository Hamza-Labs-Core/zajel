import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path/path.dart';
import 'package:path_provider/path_provider.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../models/group.dart';
import '../models/group_message.dart';
import '../models/vector_clock.dart';

/// SQLite-backed storage for groups, messages, vector clocks, and sender keys.
///
/// Groups and messages are stored in SQLite. Sender keys are kept
/// in [FlutterSecureStorage] to protect them if the database file
/// is compromised.
class GroupStorageService {
  static const _dbName = 'zajel_groups.db';
  static const _groupsTable = 'groups';
  static const _messagesTable = 'group_messages';
  static const _vectorClocksTable = 'vector_clocks';
  static const _dbVersion = 1;

  static const _secureKeyPrefix = 'zajel_group_';

  Database? _db;
  final FlutterSecureStorage _secureStorage;

  GroupStorageService({FlutterSecureStorage? secureStorage})
      : _secureStorage = secureStorage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  /// Open the database, creating tables if necessary.
  Future<void> initialize() async {
    if (_db != null) return;

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
          CREATE TABLE $_groupsTable (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            self_device_id TEXT NOT NULL,
            members TEXT NOT NULL,
            created_at TEXT NOT NULL,
            created_by TEXT NOT NULL
          )
        ''');

        await db.execute('''
          CREATE TABLE $_messagesTable (
            group_id TEXT NOT NULL,
            author_device_id TEXT NOT NULL,
            sequence_number INTEGER NOT NULL,
            type TEXT NOT NULL,
            content TEXT NOT NULL,
            metadata TEXT NOT NULL DEFAULT '{}',
            timestamp TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'delivered',
            is_outgoing INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (group_id, author_device_id, sequence_number)
          )
        ''');

        await db.execute(
          'CREATE INDEX idx_messages_group ON $_messagesTable (group_id)',
        );
        await db.execute(
          'CREATE INDEX idx_messages_timestamp ON $_messagesTable (group_id, timestamp)',
        );

        await db.execute('''
          CREATE TABLE $_vectorClocksTable (
            group_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            sequence_number INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (group_id, device_id)
          )
        ''');
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Group CRUD
  // ---------------------------------------------------------------------------

  /// Save a group to the database.
  Future<void> saveGroup(Group group) async {
    final db = _requireDb();
    await db.insert(
      _groupsTable,
      group.toJson(),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  /// Get a group by ID.
  Future<Group?> getGroup(String groupId) async {
    final db = _requireDb();
    final rows = await db.query(
      _groupsTable,
      where: 'id = ?',
      whereArgs: [groupId],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return Group.fromJson(rows.first);
  }

  /// Get all groups.
  Future<List<Group>> getAllGroups() async {
    final db = _requireDb();
    final rows = await db.query(_groupsTable, orderBy: 'created_at DESC');
    return rows.map((r) => Group.fromJson(r)).toList();
  }

  /// Update a group (e.g., when members change).
  Future<void> updateGroup(Group group) async {
    final db = _requireDb();
    await db.update(
      _groupsTable,
      group.toJson(),
      where: 'id = ?',
      whereArgs: [group.id],
    );
  }

  /// Delete a group and all its data.
  Future<void> deleteGroup(String groupId) async {
    final db = _requireDb();
    await db.delete(_groupsTable, where: 'id = ?', whereArgs: [groupId]);
    await db
        .delete(_messagesTable, where: 'group_id = ?', whereArgs: [groupId]);
    await db.delete(_vectorClocksTable,
        where: 'group_id = ?', whereArgs: [groupId]);

    // Clean up sender keys from secure storage
    await _deleteSenderKeys(groupId);
  }

  // ---------------------------------------------------------------------------
  // Message CRUD
  // ---------------------------------------------------------------------------

  /// Save a message to the database.
  Future<void> saveMessage(GroupMessage message) async {
    final db = _requireDb();
    await db.insert(
      _messagesTable,
      message.toJson(),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  /// Get a specific message by its composite key.
  Future<GroupMessage?> getMessage(
    String groupId,
    String authorDeviceId,
    int sequenceNumber,
  ) async {
    final db = _requireDb();
    final rows = await db.query(
      _messagesTable,
      where: 'group_id = ? AND author_device_id = ? AND sequence_number = ?',
      whereArgs: [groupId, authorDeviceId, sequenceNumber],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return GroupMessage.fromJson(rows.first);
  }

  /// Get all messages for a group, ordered by timestamp.
  Future<List<GroupMessage>> getMessages(
    String groupId, {
    int? limit,
    int? offset,
  }) async {
    final db = _requireDb();
    final rows = await db.query(
      _messagesTable,
      where: 'group_id = ?',
      whereArgs: [groupId],
      orderBy: 'timestamp ASC',
      limit: limit,
      offset: offset,
    );
    return rows.map((r) => GroupMessage.fromJson(r)).toList();
  }

  /// Get the latest N messages for a group.
  Future<List<GroupMessage>> getLatestMessages(
    String groupId, {
    int limit = 50,
  }) async {
    final db = _requireDb();
    final rows = await db.query(
      _messagesTable,
      where: 'group_id = ?',
      whereArgs: [groupId],
      orderBy: 'timestamp DESC',
      limit: limit,
    );
    return rows.map((r) => GroupMessage.fromJson(r)).toList().reversed.toList();
  }

  /// Get the count of messages in a group.
  Future<int> getMessageCount(String groupId) async {
    final db = _requireDb();
    final result = await db.rawQuery(
      'SELECT COUNT(*) as count FROM $_messagesTable WHERE group_id = ?',
      [groupId],
    );
    return (result.first['count'] as int?) ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Vector clock operations
  // ---------------------------------------------------------------------------

  /// Get the vector clock for a group.
  Future<VectorClock> getVectorClock(String groupId) async {
    final db = _requireDb();
    final rows = await db.query(
      _vectorClocksTable,
      where: 'group_id = ?',
      whereArgs: [groupId],
    );

    final clock = <String, int>{};
    for (final row in rows) {
      clock[row['device_id'] as String] = row['sequence_number'] as int;
    }
    return VectorClock.fromMap(clock);
  }

  /// Save a vector clock for a group.
  Future<void> saveVectorClock(String groupId, VectorClock clock) async {
    final db = _requireDb();
    final batch = db.batch();

    // Delete existing entries for this group
    batch.delete(_vectorClocksTable,
        where: 'group_id = ?', whereArgs: [groupId]);

    // Insert updated entries
    for (final entry in clock.toMap().entries) {
      batch.insert(_vectorClocksTable, {
        'group_id': groupId,
        'device_id': entry.key,
        'sequence_number': entry.value,
      });
    }

    await batch.commit(noResult: true);
  }

  // ---------------------------------------------------------------------------
  // Sender key storage (secure)
  // ---------------------------------------------------------------------------

  /// Save a sender key for a member in secure storage.
  Future<void> saveSenderKey(
    String groupId,
    String deviceId,
    String senderKeyBase64,
  ) async {
    await _secureStorage.write(
      key: '${_secureKeyPrefix}${groupId}_sender_$deviceId',
      value: senderKeyBase64,
    );
  }

  /// Load a sender key for a member from secure storage.
  Future<String?> loadSenderKey(String groupId, String deviceId) async {
    return _secureStorage.read(
      key: '${_secureKeyPrefix}${groupId}_sender_$deviceId',
    );
  }

  /// Load all sender keys for a group from secure storage.
  ///
  /// Returns {deviceId: base64Key}.
  Future<Map<String, String>> loadAllSenderKeys(String groupId) async {
    final allKeys = await _secureStorage.readAll();
    final prefix = '${_secureKeyPrefix}${groupId}_sender_';
    final groupKeys = <String, String>{};

    for (final entry in allKeys.entries) {
      if (entry.key.startsWith(prefix)) {
        final deviceId = entry.key.substring(prefix.length);
        groupKeys[deviceId] = entry.value;
      }
    }

    return groupKeys;
  }

  /// Delete a sender key for a member.
  Future<void> deleteSenderKey(String groupId, String deviceId) async {
    await _secureStorage.delete(
      key: '${_secureKeyPrefix}${groupId}_sender_$deviceId',
    );
  }

  /// Delete all sender keys for a group.
  Future<void> _deleteSenderKeys(String groupId) async {
    final allKeys = await _secureStorage.readAll();
    final prefix = '${_secureKeyPrefix}${groupId}_sender_';
    for (final key in allKeys.keys) {
      if (key.startsWith(prefix)) {
        await _secureStorage.delete(key: key);
      }
    }
  }

  /// Close the database.
  Future<void> close() async {
    await _db?.close();
    _db = null;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  Database _requireDb() {
    final db = _db;
    if (db == null) {
      throw GroupStorageException('Database not initialized');
    }
    return db;
  }
}

/// Exception thrown by group storage operations.
class GroupStorageException implements Exception {
  final String message;
  GroupStorageException(this.message);

  @override
  String toString() => 'GroupStorageException: $message';
}
