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

  late GroupStorageService service;
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
          CREATE TABLE groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            self_device_id TEXT NOT NULL,
            members TEXT NOT NULL,
            created_at TEXT NOT NULL,
            created_by TEXT NOT NULL
          )
        ''');
        await db.execute('''
          CREATE TABLE group_messages (
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
          'CREATE INDEX idx_messages_group ON group_messages (group_id)',
        );
        await db.execute(
          'CREATE INDEX idx_messages_timestamp ON group_messages (group_id, timestamp)',
        );
        await db.execute('''
          CREATE TABLE vector_clocks (
            group_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            sequence_number INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (group_id, device_id)
          )
        ''');
      },
    );

    service = GroupStorageService.withDatabase(
      database: db,
      secureStorage: secureStorage,
    );
  });

  tearDown(() async {
    await service.close();
  });

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
      await service.saveGroup(group);

      final retrieved = await service.getGroup('grp_1');
      expect(retrieved, isNotNull);
      expect(retrieved!.id, 'grp_1');
      expect(retrieved.name, 'Test Group');
      expect(retrieved.selfDeviceId, 'device_A');
      expect(retrieved.members, hasLength(1));
      expect(retrieved.members.first.displayName, 'Alice');
      expect(retrieved.createdBy, 'device_A');
    });

    test('getGroup returns null for non-existent group', () async {
      expect(await service.getGroup('missing'), isNull);
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
      await service.saveGroup(group);

      final retrieved = await service.getGroup('grp_1');
      expect(retrieved!.members, hasLength(2));
      expect(retrieved.members[1].displayName, 'Bob');
    });

    test('replaces existing group on conflict', () async {
      await service.saveGroup(_makeGroup(name: 'Original'));
      await service.saveGroup(_makeGroup(name: 'Updated'));

      final retrieved = await service.getGroup('grp_1');
      expect(retrieved!.name, 'Updated');
    });
  });

  group('GroupStorageService — getAllGroups', () {
    test('returns empty list when no groups exist', () async {
      expect(await service.getAllGroups(), isEmpty);
    });

    test('returns all saved groups', () async {
      await service.saveGroup(
          _makeGroup(id: 'grp_1', createdAt: DateTime.utc(2026, 1, 1)));
      await service.saveGroup(
          _makeGroup(id: 'grp_2', createdAt: DateTime.utc(2026, 3, 1)));

      final groups = await service.getAllGroups();
      expect(groups, hasLength(2));
    });

    test('groups are ordered by created_at DESC', () async {
      await service.saveGroup(_makeGroup(
        id: 'old',
        name: 'Old Group',
        createdAt: DateTime.utc(2025, 1, 1),
      ));
      await service.saveGroup(_makeGroup(
        id: 'new',
        name: 'New Group',
        createdAt: DateTime.utc(2026, 6, 1),
      ));

      final groups = await service.getAllGroups();
      expect(groups.first.id, 'new');
      expect(groups.last.id, 'old');
    });
  });

  group('GroupStorageService — updateGroup', () {
    test('updates group name and members', () async {
      await service.saveGroup(_makeGroup());

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
      await service.updateGroup(updated);

      final retrieved = await service.getGroup('grp_1');
      expect(retrieved!.name, 'Renamed Group');
      expect(retrieved.members, hasLength(2));
    });
  });

  group('GroupStorageService — deleteGroup', () {
    test('removes group from database', () async {
      await service.saveGroup(_makeGroup());
      await service.deleteGroup('grp_1');
      expect(await service.getGroup('grp_1'), isNull);
    });

    test('removes associated messages', () async {
      await service.saveGroup(_makeGroup());
      await service.saveMessage(_makeMessage());
      await service.deleteGroup('grp_1');

      final count = await service.getMessageCount('grp_1');
      expect(count, 0);
    });

    test('removes vector clock entries', () async {
      await service.saveGroup(_makeGroup());
      await service.saveVectorClock(
          'grp_1', VectorClock.fromMap({'device_A': 5}));
      await service.deleteGroup('grp_1');

      final clock = await service.getVectorClock('grp_1');
      expect(clock.isEmpty, isTrue);
    });

    test('removes sender keys from secure storage', () async {
      await service.saveSenderKey('grp_1', 'device_A', 'key_a');
      await service.saveSenderKey('grp_1', 'device_B', 'key_b');
      await service.deleteGroup('grp_1');

      expect(await service.loadSenderKey('grp_1', 'device_A'), isNull);
      expect(await service.loadSenderKey('grp_1', 'device_B'), isNull);
    });

    test('is safe to call for non-existent group', () async {
      await service.deleteGroup('missing'); // should not throw
    });
  });

  group('GroupStorageService — message CRUD', () {
    test('saves and retrieves a message', () async {
      final msg = _makeMessage(content: 'Hello world');
      await service.saveMessage(msg);

      final retrieved = await service.getMessage('grp_1', 'device_A', 1);
      expect(retrieved, isNotNull);
      expect(retrieved!.content, 'Hello world');
      expect(retrieved.type, GroupMessageType.text);
      expect(retrieved.status, GroupMessageStatus.delivered);
      expect(retrieved.isOutgoing, isFalse);
    });

    test('getMessage returns null for non-existent message', () async {
      expect(await service.getMessage('grp_1', 'device_A', 99), isNull);
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
      await service.saveMessage(msg);

      final retrieved = await service.getMessage('grp_1', 'device_A', 1);
      expect(retrieved!.type, GroupMessageType.file);
      expect(retrieved.metadata['filename'], 'report.pdf');
      expect(retrieved.isOutgoing, isTrue);
    });

    test('replaces message on primary key conflict', () async {
      await service.saveMessage(_makeMessage(content: 'First'));
      await service.saveMessage(_makeMessage(content: 'Second'));

      final retrieved = await service.getMessage('grp_1', 'device_A', 1);
      expect(retrieved!.content, 'Second');
    });

    test('getMessages returns messages ordered by timestamp ASC', () async {
      await service.saveMessage(_makeMessage(
        sequenceNumber: 1,
        content: 'First',
        timestamp: DateTime.utc(2026, 2, 1, 12, 0),
      ));
      await service.saveMessage(_makeMessage(
        sequenceNumber: 2,
        content: 'Second',
        timestamp: DateTime.utc(2026, 2, 1, 12, 5),
      ));
      await service.saveMessage(_makeMessage(
        sequenceNumber: 3,
        content: 'Third',
        timestamp: DateTime.utc(2026, 2, 1, 12, 10),
      ));

      final messages = await service.getMessages('grp_1');
      expect(messages, hasLength(3));
      expect(messages[0].content, 'First');
      expect(messages[2].content, 'Third');
    });

    test('getMessages supports limit and offset', () async {
      for (int i = 1; i <= 5; i++) {
        await service.saveMessage(_makeMessage(
          sequenceNumber: i,
          content: 'Msg $i',
          timestamp: DateTime.utc(2026, 2, 1, 12, i),
        ));
      }

      final page = await service.getMessages('grp_1', limit: 2, offset: 1);
      expect(page, hasLength(2));
      expect(page[0].content, 'Msg 2');
      expect(page[1].content, 'Msg 3');
    });

    test('getLatestMessages returns newest messages in chronological order',
        () async {
      for (int i = 1; i <= 10; i++) {
        await service.saveMessage(_makeMessage(
          sequenceNumber: i,
          content: 'Msg $i',
          timestamp: DateTime.utc(2026, 2, 1, 12, i),
        ));
      }

      final latest = await service.getLatestMessages('grp_1', limit: 3);
      expect(latest, hasLength(3));
      // Should be in chronological order (oldest first)
      expect(latest[0].content, 'Msg 8');
      expect(latest[1].content, 'Msg 9');
      expect(latest[2].content, 'Msg 10');
    });

    test('getMessageCount returns correct count', () async {
      expect(await service.getMessageCount('grp_1'), 0);

      await service.saveMessage(_makeMessage(sequenceNumber: 1));
      await service.saveMessage(_makeMessage(sequenceNumber: 2));

      expect(await service.getMessageCount('grp_1'), 2);
    });
  });

  group('GroupStorageService — vector clock operations', () {
    test('saves and retrieves a vector clock', () async {
      final clock = VectorClock.fromMap({
        'device_A': 5,
        'device_B': 3,
      });
      await service.saveVectorClock('grp_1', clock);

      final retrieved = await service.getVectorClock('grp_1');
      expect(retrieved['device_A'], 5);
      expect(retrieved['device_B'], 3);
    });

    test('getVectorClock returns empty clock for non-existent group', () async {
      final clock = await service.getVectorClock('missing');
      expect(clock.isEmpty, isTrue);
    });

    test('saveVectorClock replaces existing entries', () async {
      await service.saveVectorClock(
          'grp_1', VectorClock.fromMap({'device_A': 1}));
      await service.saveVectorClock(
          'grp_1', VectorClock.fromMap({'device_A': 10, 'device_B': 5}));

      final clock = await service.getVectorClock('grp_1');
      expect(clock['device_A'], 10);
      expect(clock['device_B'], 5);
    });

    test('saveVectorClock handles empty clock', () async {
      await service.saveVectorClock('grp_1', const VectorClock());

      final clock = await service.getVectorClock('grp_1');
      expect(clock.isEmpty, isTrue);
    });
  });

  group('GroupStorageService — sender key secure storage', () {
    test('saves and loads a sender key', () async {
      await service.saveSenderKey('grp_1', 'device_A', 'base64_key_data');

      final loaded = await service.loadSenderKey('grp_1', 'device_A');
      expect(loaded, 'base64_key_data');
    });

    test('loadSenderKey returns null for non-existent key', () async {
      final loaded = await service.loadSenderKey('grp_1', 'missing');
      expect(loaded, isNull);
    });

    test('loadAllSenderKeys returns all keys for a group', () async {
      await service.saveSenderKey('grp_1', 'device_A', 'key_a');
      await service.saveSenderKey('grp_1', 'device_B', 'key_b');
      await service.saveSenderKey('grp_2', 'device_C', 'key_c');

      final keys = await service.loadAllSenderKeys('grp_1');
      expect(keys, hasLength(2));
      expect(keys['device_A'], 'key_a');
      expect(keys['device_B'], 'key_b');
      // grp_2 key should not be included
      expect(keys.containsKey('device_C'), isFalse);
    });

    test('loadAllSenderKeys returns empty map when no keys exist', () async {
      final keys = await service.loadAllSenderKeys('grp_1');
      expect(keys, isEmpty);
    });

    test('deleteSenderKey removes a specific key', () async {
      await service.saveSenderKey('grp_1', 'device_A', 'key_a');
      await service.deleteSenderKey('grp_1', 'device_A');

      expect(await service.loadSenderKey('grp_1', 'device_A'), isNull);
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
      await service.saveGroup(group);

      final retrieved = await service.getGroup('grp_1');
      expect(retrieved!.members, hasLength(2));
      expect(retrieved.members[0].deviceId, 'device_A');
      expect(retrieved.members[1].deviceId, 'device_B');
      expect(retrieved.members[1].publicKey, 'pk_b');
    });
  });
}
