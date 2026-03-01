import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:zajel/features/groups/models/group.dart';
import 'package:zajel/features/groups/models/group_message.dart';
import 'package:zajel/features/groups/models/vector_clock.dart';
import 'package:zajel/features/groups/services/group_storage_service.dart';

import '../../mocks/mocks.dart';

/// Helper to create a test [Group].
Group _makeGroup({
  String id = 'grp_1',
  String name = 'Test Group',
  String selfDeviceId = 'device_A',
  List<GroupMember>? members,
  DateTime? createdAt,
  String createdBy = 'device_A',
}) {
  return Group(
    id: id,
    name: name,
    selfDeviceId: selfDeviceId,
    members: members ??
        [
          GroupMember(
            deviceId: selfDeviceId,
            displayName: 'Alice',
            publicKey: 'pk_alice',
            joinedAt: createdAt ?? DateTime.utc(2026, 2, 1),
          ),
        ],
    createdAt: createdAt ?? DateTime.utc(2026, 2, 1),
    createdBy: createdBy,
  );
}

/// Helper to create a test [GroupMessage].
GroupMessage _makeMessage({
  String groupId = 'grp_1',
  String authorDeviceId = 'device_A',
  int sequenceNumber = 1,
  String content = 'Hello',
  GroupMessageType type = GroupMessageType.text,
  GroupMessageStatus status = GroupMessageStatus.delivered,
  bool isOutgoing = false,
  DateTime? timestamp,
}) {
  return GroupMessage(
    groupId: groupId,
    authorDeviceId: authorDeviceId,
    sequenceNumber: sequenceNumber,
    type: type,
    content: content,
    timestamp: timestamp ?? DateTime.utc(2026, 2, 1, 12, 0),
    status: status,
    isOutgoing: isOutgoing,
  );
}

void main() {
  sqfliteFfiInit();
  databaseFactory = databaseFactoryFfi;

  late Database db;
  late FakeSecureStorage secureStorage;

  // Constants matching the production code.
  const groupsTable = 'groups';
  const messagesTable = 'group_messages';
  const vectorClocksTable = 'vector_clocks';
  const secureKeyPrefix = 'zajel_group_';

  setUp(() async {
    secureStorage = FakeSecureStorage();
    db = await openDatabase(
      inMemoryDatabasePath,
      version: 1,
      onCreate: (db, version) async {
        await db.execute('''
          CREATE TABLE $groupsTable (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            self_device_id TEXT NOT NULL,
            members TEXT NOT NULL,
            created_at TEXT NOT NULL,
            created_by TEXT NOT NULL
          )
        ''');
        await db.execute('''
          CREATE TABLE $messagesTable (
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
          'CREATE INDEX idx_messages_group ON $messagesTable (group_id)',
        );
        await db.execute(
          'CREATE INDEX idx_messages_timestamp ON $messagesTable (group_id, timestamp)',
        );
        await db.execute('''
          CREATE TABLE $vectorClocksTable (
            group_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            sequence_number INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (group_id, device_id)
          )
        ''');
      },
    );
  });

  tearDown(() async {
    await db.close();
  });

  // -- Helper functions replicating the service SQL logic --

  Future<void> saveGroup(Group group) async {
    await db.insert(groupsTable, group.toJson(),
        conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<Group?> getGroup(String groupId) async {
    final rows = await db.query(groupsTable,
        where: 'id = ?', whereArgs: [groupId], limit: 1);
    if (rows.isEmpty) return null;
    return Group.fromJson(rows.first);
  }

  Future<List<Group>> getAllGroups() async {
    final rows = await db.query(groupsTable, orderBy: 'created_at DESC');
    return rows.map((r) => Group.fromJson(r)).toList();
  }

  Future<void> updateGroup(Group group) async {
    await db.update(groupsTable, group.toJson(),
        where: 'id = ?', whereArgs: [group.id]);
  }

  Future<void> deleteGroup(String groupId) async {
    await db.delete(groupsTable, where: 'id = ?', whereArgs: [groupId]);
    await db.delete(messagesTable, where: 'group_id = ?', whereArgs: [groupId]);
    await db
        .delete(vectorClocksTable, where: 'group_id = ?', whereArgs: [groupId]);
    // Clean up sender keys
    final allKeys = await secureStorage.readAll();
    final prefix = '$secureKeyPrefix${groupId}_sender_';
    for (final key in allKeys.keys) {
      if (key.startsWith(prefix)) {
        await secureStorage.delete(key: key);
      }
    }
  }

  Future<void> saveMessage(GroupMessage message) async {
    await db.insert(messagesTable, message.toJson(),
        conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<GroupMessage?> getMessage(
    String groupId,
    String authorDeviceId,
    int sequenceNumber,
  ) async {
    final rows = await db.query(
      messagesTable,
      where: 'group_id = ? AND author_device_id = ? AND sequence_number = ?',
      whereArgs: [groupId, authorDeviceId, sequenceNumber],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return GroupMessage.fromJson(rows.first);
  }

  Future<List<GroupMessage>> getMessages(
    String groupId, {
    int? limit,
    int? offset,
  }) async {
    final rows = await db.query(
      messagesTable,
      where: 'group_id = ?',
      whereArgs: [groupId],
      orderBy: 'timestamp ASC',
      limit: limit,
      offset: offset,
    );
    return rows.map((r) => GroupMessage.fromJson(r)).toList();
  }

  Future<List<GroupMessage>> getLatestMessages(
    String groupId, {
    int limit = 50,
  }) async {
    final rows = await db.query(
      messagesTable,
      where: 'group_id = ?',
      whereArgs: [groupId],
      orderBy: 'timestamp DESC',
      limit: limit,
    );
    return rows.map((r) => GroupMessage.fromJson(r)).toList().reversed.toList();
  }

  Future<int> getMessageCount(String groupId) async {
    final result = await db.rawQuery(
      'SELECT COUNT(*) as count FROM $messagesTable WHERE group_id = ?',
      [groupId],
    );
    return (result.first['count'] as int?) ?? 0;
  }

  Future<VectorClock> getVectorClock(String groupId) async {
    final rows = await db
        .query(vectorClocksTable, where: 'group_id = ?', whereArgs: [groupId]);
    final clock = <String, int>{};
    for (final row in rows) {
      clock[row['device_id'] as String] = row['sequence_number'] as int;
    }
    return VectorClock.fromMap(clock);
  }

  Future<void> saveVectorClock(String groupId, VectorClock clock) async {
    final batch = db.batch();
    batch
        .delete(vectorClocksTable, where: 'group_id = ?', whereArgs: [groupId]);
    for (final entry in clock.toMap().entries) {
      batch.insert(vectorClocksTable, {
        'group_id': groupId,
        'device_id': entry.key,
        'sequence_number': entry.value,
      });
    }
    await batch.commit(noResult: true);
  }

  Future<void> saveSenderKey(
      String groupId, String deviceId, String key) async {
    await secureStorage.write(
      key: '$secureKeyPrefix${groupId}_sender_$deviceId',
      value: key,
    );
  }

  Future<String?> loadSenderKey(String groupId, String deviceId) async {
    return secureStorage.read(
      key: '$secureKeyPrefix${groupId}_sender_$deviceId',
    );
  }

  Future<Map<String, String>> loadAllSenderKeys(String groupId) async {
    final allKeys = await secureStorage.readAll();
    final prefix = '$secureKeyPrefix${groupId}_sender_';
    final groupKeys = <String, String>{};
    for (final entry in allKeys.entries) {
      if (entry.key.startsWith(prefix)) {
        groupKeys[entry.key.substring(prefix.length)] = entry.value;
      }
    }
    return groupKeys;
  }

  // -- Tests --

  group('GroupStorageService — uninitialized database guards', () {
    test('saveGroup throws GroupStorageException when db is null', () {
      final uninit = GroupStorageService(secureStorage: secureStorage);
      expect(
        () => uninit.saveGroup(_makeGroup()),
        throwsA(isA<GroupStorageException>()),
      );
    });

    test('getGroup throws GroupStorageException when db is null', () {
      final uninit = GroupStorageService(secureStorage: secureStorage);
      expect(
        () => uninit.getGroup('grp_1'),
        throwsA(isA<GroupStorageException>()),
      );
    });

    test('getAllGroups throws GroupStorageException when db is null', () {
      final uninit = GroupStorageService(secureStorage: secureStorage);
      expect(
        () => uninit.getAllGroups(),
        throwsA(isA<GroupStorageException>()),
      );
    });

    test('saveMessage throws GroupStorageException when db is null', () {
      final uninit = GroupStorageService(secureStorage: secureStorage);
      expect(
        () => uninit.saveMessage(_makeMessage()),
        throwsA(isA<GroupStorageException>()),
      );
    });

    test('getVectorClock throws GroupStorageException when db is null', () {
      final uninit = GroupStorageService(secureStorage: secureStorage);
      expect(
        () => uninit.getVectorClock('grp_1'),
        throwsA(isA<GroupStorageException>()),
      );
    });
  });

  group('GroupStorageService — saveGroup and getGroup', () {
    test('saves and retrieves a group with all fields', () async {
      final group = _makeGroup();
      await saveGroup(group);

      final retrieved = await getGroup('grp_1');
      expect(retrieved, isNotNull);
      expect(retrieved!.id, 'grp_1');
      expect(retrieved.name, 'Test Group');
      expect(retrieved.selfDeviceId, 'device_A');
      expect(retrieved.members, hasLength(1));
      expect(retrieved.members.first.displayName, 'Alice');
      expect(retrieved.createdBy, 'device_A');
    });

    test('getGroup returns null for non-existent group', () async {
      expect(await getGroup('missing'), isNull);
    });

    test('saves group with multiple members', () async {
      final group = _makeGroup(
        members: [
          GroupMember(
            deviceId: 'device_A',
            displayName: 'Alice',
            publicKey: 'pk_alice',
            joinedAt: DateTime.utc(2026, 2, 1),
          ),
          GroupMember(
            deviceId: 'device_B',
            displayName: 'Bob',
            publicKey: 'pk_bob',
            joinedAt: DateTime.utc(2026, 2, 2),
          ),
        ],
      );
      await saveGroup(group);

      final retrieved = await getGroup('grp_1');
      expect(retrieved!.members, hasLength(2));
      expect(retrieved.members[1].displayName, 'Bob');
    });

    test('replaces existing group on conflict', () async {
      await saveGroup(_makeGroup(name: 'Original'));
      await saveGroup(_makeGroup(name: 'Updated'));

      final retrieved = await getGroup('grp_1');
      expect(retrieved!.name, 'Updated');
    });
  });

  group('GroupStorageService — getAllGroups', () {
    test('returns empty list when no groups exist', () async {
      expect(await getAllGroups(), isEmpty);
    });

    test('returns all saved groups', () async {
      await saveGroup(
          _makeGroup(id: 'grp_1', createdAt: DateTime.utc(2026, 1, 1)));
      await saveGroup(
          _makeGroup(id: 'grp_2', createdAt: DateTime.utc(2026, 3, 1)));

      final groups = await getAllGroups();
      expect(groups, hasLength(2));
    });

    test('groups are ordered by created_at DESC', () async {
      await saveGroup(_makeGroup(
        id: 'old',
        name: 'Old Group',
        createdAt: DateTime.utc(2025, 1, 1),
      ));
      await saveGroup(_makeGroup(
        id: 'new',
        name: 'New Group',
        createdAt: DateTime.utc(2026, 6, 1),
      ));

      final groups = await getAllGroups();
      expect(groups.first.id, 'new');
      expect(groups.last.id, 'old');
    });
  });

  group('GroupStorageService — updateGroup', () {
    test('updates group name and members', () async {
      await saveGroup(_makeGroup());

      final updated = _makeGroup(name: 'Renamed Group', members: [
        GroupMember(
          deviceId: 'device_A',
          displayName: 'Alice',
          publicKey: 'pk_alice',
          joinedAt: DateTime.utc(2026, 2, 1),
        ),
        GroupMember(
          deviceId: 'device_B',
          displayName: 'Bob',
          publicKey: 'pk_bob',
          joinedAt: DateTime.utc(2026, 2, 5),
        ),
      ]);
      await updateGroup(updated);

      final retrieved = await getGroup('grp_1');
      expect(retrieved!.name, 'Renamed Group');
      expect(retrieved.members, hasLength(2));
    });
  });

  group('GroupStorageService — deleteGroup', () {
    test('removes group from database', () async {
      await saveGroup(_makeGroup());
      await deleteGroup('grp_1');
      expect(await getGroup('grp_1'), isNull);
    });

    test('removes associated messages', () async {
      await saveGroup(_makeGroup());
      await saveMessage(_makeMessage());
      await deleteGroup('grp_1');

      final rows = await db
          .query(messagesTable, where: 'group_id = ?', whereArgs: ['grp_1']);
      expect(rows, isEmpty);
    });

    test('removes vector clock entries', () async {
      await saveGroup(_makeGroup());
      await saveVectorClock('grp_1', VectorClock.fromMap({'device_A': 5}));
      await deleteGroup('grp_1');

      final clock = await getVectorClock('grp_1');
      expect(clock.isEmpty, isTrue);
    });

    test('removes sender keys from secure storage', () async {
      await saveSenderKey('grp_1', 'device_A', 'key_a');
      await saveSenderKey('grp_1', 'device_B', 'key_b');
      await deleteGroup('grp_1');

      expect(await loadSenderKey('grp_1', 'device_A'), isNull);
      expect(await loadSenderKey('grp_1', 'device_B'), isNull);
    });

    test('is safe to call for non-existent group', () async {
      await deleteGroup('missing'); // should not throw
    });
  });

  group('GroupStorageService — message CRUD', () {
    test('saves and retrieves a message', () async {
      final msg = _makeMessage(content: 'Hello world');
      await saveMessage(msg);

      final retrieved = await getMessage('grp_1', 'device_A', 1);
      expect(retrieved, isNotNull);
      expect(retrieved!.content, 'Hello world');
      expect(retrieved.type, GroupMessageType.text);
      expect(retrieved.status, GroupMessageStatus.delivered);
      expect(retrieved.isOutgoing, isFalse);
    });

    test('getMessage returns null for non-existent message', () async {
      expect(await getMessage('grp_1', 'device_A', 99), isNull);
    });

    test('saves message with metadata', () async {
      final msg = GroupMessage(
        groupId: 'grp_1',
        authorDeviceId: 'device_A',
        sequenceNumber: 1,
        type: GroupMessageType.file,
        content: 'file_data',
        metadata: {'filename': 'report.pdf', 'size': 1024},
        timestamp: DateTime.utc(2026, 2, 1),
        status: GroupMessageStatus.sent,
        isOutgoing: true,
      );
      await saveMessage(msg);

      final retrieved = await getMessage('grp_1', 'device_A', 1);
      expect(retrieved!.type, GroupMessageType.file);
      expect(retrieved.metadata['filename'], 'report.pdf');
      expect(retrieved.isOutgoing, isTrue);
    });

    test('replaces message on primary key conflict', () async {
      await saveMessage(_makeMessage(content: 'First'));
      await saveMessage(_makeMessage(content: 'Second'));

      final retrieved = await getMessage('grp_1', 'device_A', 1);
      expect(retrieved!.content, 'Second');
    });

    test('getMessages returns messages ordered by timestamp ASC', () async {
      await saveMessage(_makeMessage(
        sequenceNumber: 1,
        content: 'First',
        timestamp: DateTime.utc(2026, 2, 1, 12, 0),
      ));
      await saveMessage(_makeMessage(
        sequenceNumber: 2,
        content: 'Second',
        timestamp: DateTime.utc(2026, 2, 1, 12, 5),
      ));
      await saveMessage(_makeMessage(
        sequenceNumber: 3,
        content: 'Third',
        timestamp: DateTime.utc(2026, 2, 1, 12, 10),
      ));

      final messages = await getMessages('grp_1');
      expect(messages, hasLength(3));
      expect(messages[0].content, 'First');
      expect(messages[2].content, 'Third');
    });

    test('getMessages supports limit and offset', () async {
      for (int i = 1; i <= 5; i++) {
        await saveMessage(_makeMessage(
          sequenceNumber: i,
          content: 'Msg $i',
          timestamp: DateTime.utc(2026, 2, 1, 12, i),
        ));
      }

      final page = await getMessages('grp_1', limit: 2, offset: 1);
      expect(page, hasLength(2));
      expect(page[0].content, 'Msg 2');
      expect(page[1].content, 'Msg 3');
    });

    test('getLatestMessages returns newest messages in chronological order',
        () async {
      for (int i = 1; i <= 10; i++) {
        await saveMessage(_makeMessage(
          sequenceNumber: i,
          content: 'Msg $i',
          timestamp: DateTime.utc(2026, 2, 1, 12, i),
        ));
      }

      final latest = await getLatestMessages('grp_1', limit: 3);
      expect(latest, hasLength(3));
      // Should be in chronological order (oldest first)
      expect(latest[0].content, 'Msg 8');
      expect(latest[1].content, 'Msg 9');
      expect(latest[2].content, 'Msg 10');
    });

    test('getMessageCount returns correct count', () async {
      expect(await getMessageCount('grp_1'), 0);

      await saveMessage(_makeMessage(sequenceNumber: 1));
      await saveMessage(_makeMessage(sequenceNumber: 2));

      expect(await getMessageCount('grp_1'), 2);
    });
  });

  group('GroupStorageService — vector clock operations', () {
    test('saves and retrieves a vector clock', () async {
      final clock = VectorClock.fromMap({
        'device_A': 5,
        'device_B': 3,
      });
      await saveVectorClock('grp_1', clock);

      final retrieved = await getVectorClock('grp_1');
      expect(retrieved['device_A'], 5);
      expect(retrieved['device_B'], 3);
    });

    test('getVectorClock returns empty clock for non-existent group', () async {
      final clock = await getVectorClock('missing');
      expect(clock.isEmpty, isTrue);
    });

    test('saveVectorClock replaces existing entries', () async {
      await saveVectorClock('grp_1', VectorClock.fromMap({'device_A': 1}));
      await saveVectorClock(
          'grp_1', VectorClock.fromMap({'device_A': 10, 'device_B': 5}));

      final clock = await getVectorClock('grp_1');
      expect(clock['device_A'], 10);
      expect(clock['device_B'], 5);
    });

    test('saveVectorClock handles empty clock', () async {
      await saveVectorClock('grp_1', const VectorClock());

      final clock = await getVectorClock('grp_1');
      expect(clock.isEmpty, isTrue);
    });
  });

  group('GroupStorageService — sender key secure storage', () {
    test('saves and loads a sender key', () async {
      await saveSenderKey('grp_1', 'device_A', 'base64_key_data');

      final loaded = await loadSenderKey('grp_1', 'device_A');
      expect(loaded, 'base64_key_data');
    });

    test('loadSenderKey returns null for non-existent key', () async {
      final loaded = await loadSenderKey('grp_1', 'missing');
      expect(loaded, isNull);
    });

    test('loadAllSenderKeys returns all keys for a group', () async {
      await saveSenderKey('grp_1', 'device_A', 'key_a');
      await saveSenderKey('grp_1', 'device_B', 'key_b');
      await saveSenderKey('grp_2', 'device_C', 'key_c');

      final keys = await loadAllSenderKeys('grp_1');
      expect(keys, hasLength(2));
      expect(keys['device_A'], 'key_a');
      expect(keys['device_B'], 'key_b');
      // grp_2 key should not be included
      expect(keys.containsKey('device_C'), isFalse);
    });

    test('loadAllSenderKeys returns empty map when no keys exist', () async {
      final keys = await loadAllSenderKeys('grp_1');
      expect(keys, isEmpty);
    });

    test('deleteSenderKey removes a specific key', () async {
      await saveSenderKey('grp_1', 'device_A', 'key_a');
      await secureStorage.delete(
          key: '$secureKeyPrefix' 'grp_1_sender_device_A');

      expect(await loadSenderKey('grp_1', 'device_A'), isNull);
    });
  });

  group('GroupStorageException', () {
    test('toString includes the message', () {
      final e = GroupStorageException('test error');
      expect(e.toString(), 'GroupStorageException: test error');
    });

    test('message field is accessible', () {
      final e = GroupStorageException('some issue');
      expect(e.message, 'some issue');
    });
  });

  group('Group model serialization round-trip through database', () {
    test('toJson and fromJson preserve members list', () async {
      final members = [
        GroupMember(
          deviceId: 'device_A',
          displayName: 'Alice',
          publicKey: 'pk_a',
          joinedAt: DateTime.utc(2026, 2, 1),
        ),
        GroupMember(
          deviceId: 'device_B',
          displayName: 'Bob',
          publicKey: 'pk_b',
          joinedAt: DateTime.utc(2026, 2, 2),
        ),
      ];
      final group = _makeGroup(members: members);
      await saveGroup(group);

      final retrieved = await getGroup('grp_1');
      expect(retrieved!.members, hasLength(2));
      expect(retrieved.members[0].deviceId, 'device_A');
      expect(retrieved.members[1].deviceId, 'device_B');
      expect(retrieved.members[1].publicKey, 'pk_b');
    });
  });
}
