import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/groups/models/group.dart';
import 'package:zajel/features/groups/models/group_message.dart';
import 'package:zajel/features/groups/models/vector_clock.dart';
import 'package:zajel/features/groups/services/group_storage_service.dart';
import 'package:zajel/features/groups/services/group_sync_service.dart';

import '../../mocks/mocks.dart';

/// In-memory implementation of GroupStorageService for unit testing.
///
/// Avoids SQLite and secure storage dependencies.
class FakeGroupStorageService extends GroupStorageService {
  final Map<String, Group> _groups = {};
  final Map<String, List<GroupMessage>> _messages = {};
  final Map<String, VectorClock> _vectorClocks = {};
  final Map<String, Map<String, String>> _senderKeys = {};

  FakeGroupStorageService() : super(secureStorage: FakeSecureStorage());

  @override
  Future<void> initialize() async {}

  @override
  Future<void> saveGroup(Group group) async {
    _groups[group.id] = group;
  }

  @override
  Future<Group?> getGroup(String groupId) async {
    return _groups[groupId];
  }

  @override
  Future<List<Group>> getAllGroups() async {
    return _groups.values.toList();
  }

  @override
  Future<void> updateGroup(Group group) async {
    _groups[group.id] = group;
  }

  @override
  Future<void> deleteGroup(String groupId) async {
    _groups.remove(groupId);
    _messages.remove(groupId);
    _vectorClocks.remove(groupId);
    _senderKeys.remove(groupId);
  }

  @override
  Future<void> saveMessage(GroupMessage message) async {
    _messages.putIfAbsent(message.groupId, () => []);
    // Replace existing or add
    final list = _messages[message.groupId]!;
    final existingIdx = list.indexWhere(
      (m) =>
          m.authorDeviceId == message.authorDeviceId &&
          m.sequenceNumber == message.sequenceNumber,
    );
    if (existingIdx >= 0) {
      list[existingIdx] = message;
    } else {
      list.add(message);
    }
  }

  @override
  Future<GroupMessage?> getMessage(
    String groupId,
    String authorDeviceId,
    int sequenceNumber,
  ) async {
    final list = _messages[groupId];
    if (list == null) return null;
    try {
      return list.firstWhere(
        (m) =>
            m.authorDeviceId == authorDeviceId &&
            m.sequenceNumber == sequenceNumber,
      );
    } catch (_) {
      return null;
    }
  }

  @override
  Future<List<GroupMessage>> getMessages(
    String groupId, {
    int? limit,
    int? offset,
  }) async {
    var list = (_messages[groupId] ?? []).toList()
      ..sort((a, b) => a.timestamp.compareTo(b.timestamp));
    if (offset != null) {
      list = list.skip(offset).toList();
    }
    if (limit != null) {
      list = list.take(limit).toList();
    }
    return list;
  }

  @override
  Future<List<GroupMessage>> getLatestMessages(
    String groupId, {
    int limit = 50,
  }) async {
    final list = (_messages[groupId] ?? []).toList()
      ..sort((a, b) => a.timestamp.compareTo(b.timestamp));
    if (list.length <= limit) return list;
    return list.sublist(list.length - limit);
  }

  @override
  Future<int> getMessageCount(String groupId) async {
    return (_messages[groupId] ?? []).length;
  }

  @override
  Future<VectorClock> getVectorClock(String groupId) async {
    return _vectorClocks[groupId] ?? const VectorClock();
  }

  @override
  Future<void> saveVectorClock(String groupId, VectorClock clock) async {
    _vectorClocks[groupId] = clock;
  }

  @override
  Future<void> saveSenderKey(
    String groupId,
    String deviceId,
    String senderKeyBase64,
  ) async {
    _senderKeys.putIfAbsent(groupId, () => {});
    _senderKeys[groupId]![deviceId] = senderKeyBase64;
  }

  @override
  Future<String?> loadSenderKey(String groupId, String deviceId) async {
    return _senderKeys[groupId]?[deviceId];
  }

  @override
  Future<Map<String, String>> loadAllSenderKeys(String groupId) async {
    return Map<String, String>.from(_senderKeys[groupId] ?? {});
  }

  @override
  Future<void> deleteSenderKey(String groupId, String deviceId) async {
    _senderKeys[groupId]?.remove(deviceId);
  }

  @override
  Future<void> close() async {}
}

void main() {
  late FakeGroupStorageService storageService;
  late GroupSyncService syncService;

  setUp(() {
    storageService = FakeGroupStorageService();
    syncService = GroupSyncService(storageService: storageService);
  });

  group('Vector clock operations', () {
    test('getVectorClock returns empty clock for new group', () async {
      final clock = await syncService.getVectorClock('group1');
      expect(clock.isEmpty, isTrue);
    });

    test('updateVectorClock updates the clock', () async {
      await syncService.updateVectorClock('group1', 'deviceA', 3);

      final clock = await syncService.getVectorClock('group1');
      expect(clock['deviceA'], 3);
    });

    test('updateVectorClock only advances forward', () async {
      await syncService.updateVectorClock('group1', 'deviceA', 5);
      await syncService.updateVectorClock('group1', 'deviceA', 3); // Older

      final clock = await syncService.getVectorClock('group1');
      expect(clock['deviceA'], 5); // Still 5, not rolled back to 3
    });

    test('updateVectorClock handles multiple devices', () async {
      await syncService.updateVectorClock('group1', 'deviceA', 3);
      await syncService.updateVectorClock('group1', 'deviceB', 5);

      final clock = await syncService.getVectorClock('group1');
      expect(clock['deviceA'], 3);
      expect(clock['deviceB'], 5);
    });
  });

  group('Sync computation', () {
    test('computeMissingMessages finds messages remote is missing', () {
      final local = VectorClock.fromMap({'A': 5, 'B': 3, 'C': 1});
      final remote = VectorClock.fromMap({'A': 3, 'B': 3});

      final missing = syncService.computeMissingMessages(local, remote);

      expect(missing['A'], [4, 5]);
      expect(missing['C'], [1]);
      expect(missing.containsKey('B'), isFalse);
    });

    test('computeMissingMessages returns empty when in sync', () {
      final local = VectorClock.fromMap({'A': 3, 'B': 3});
      final remote = VectorClock.fromMap({'A': 3, 'B': 5});

      final missing = syncService.computeMissingMessages(local, remote);
      expect(missing, isEmpty);
    });

    test('getMessagesForSync retrieves actual messages', () async {
      // Store some messages
      for (var i = 1; i <= 5; i++) {
        final message = GroupMessage(
          groupId: 'group1',
          authorDeviceId: 'deviceA',
          sequenceNumber: i,
          content: 'Message $i',
          timestamp: DateTime.utc(2026, 2, 10, 0, i),
        );
        await storageService.saveMessage(message);
        await syncService.updateVectorClock('group1', 'deviceA', i);
      }

      // Remote has only messages up to 3
      final remoteClock = VectorClock.fromMap({'deviceA': 3});

      final messages =
          await syncService.getMessagesForSync('group1', remoteClock);

      expect(messages, hasLength(2));
      expect(messages[0].sequenceNumber, 4);
      expect(messages[1].sequenceNumber, 5);
    });

    test('getMessagesForSync returns empty when remote is caught up', () async {
      await storageService.saveMessage(GroupMessage(
        groupId: 'group1',
        authorDeviceId: 'deviceA',
        sequenceNumber: 1,
        content: 'Message 1',
        timestamp: DateTime.utc(2026, 2, 10),
      ));
      await syncService.updateVectorClock('group1', 'deviceA', 1);

      final remoteClock = VectorClock.fromMap({'deviceA': 1});
      final messages =
          await syncService.getMessagesForSync('group1', remoteClock);

      expect(messages, isEmpty);
    });

    test('getMessagesForSync handles multiple devices', () async {
      // Device A sent 3 messages, Device B sent 2
      for (var i = 1; i <= 3; i++) {
        await storageService.saveMessage(GroupMessage(
          groupId: 'group1',
          authorDeviceId: 'deviceA',
          sequenceNumber: i,
          content: 'A-$i',
          timestamp: DateTime.utc(2026, 2, 10, 0, i),
        ));
        await syncService.updateVectorClock('group1', 'deviceA', i);
      }
      for (var i = 1; i <= 2; i++) {
        await storageService.saveMessage(GroupMessage(
          groupId: 'group1',
          authorDeviceId: 'deviceB',
          sequenceNumber: i,
          content: 'B-$i',
          timestamp: DateTime.utc(2026, 2, 10, 0, 10 + i),
        ));
        await syncService.updateVectorClock('group1', 'deviceB', i);
      }

      // Remote has A:1, B:2
      final remoteClock = VectorClock.fromMap({'deviceA': 1, 'deviceB': 2});
      final messages =
          await syncService.getMessagesForSync('group1', remoteClock);

      expect(messages, hasLength(2)); // A:2, A:3
      expect(messages.every((m) => m.authorDeviceId == 'deviceA'), isTrue);
    });
  });

  group('Message application', () {
    test('applyMessage stores new message and updates clock', () async {
      final message = GroupMessage(
        groupId: 'group1',
        authorDeviceId: 'deviceA',
        sequenceNumber: 1,
        content: 'Hello',
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final wasNew = await syncService.applyMessage(message);

      expect(wasNew, isTrue);

      // Verify stored
      final stored = await storageService.getMessage('group1', 'deviceA', 1);
      expect(stored, isNotNull);
      expect(stored!.content, 'Hello');

      // Verify clock updated
      final clock = await syncService.getVectorClock('group1');
      expect(clock['deviceA'], 1);
    });

    test('applyMessage rejects duplicate', () async {
      final message = GroupMessage(
        groupId: 'group1',
        authorDeviceId: 'deviceA',
        sequenceNumber: 1,
        content: 'Hello',
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final first = await syncService.applyMessage(message);
      final second = await syncService.applyMessage(message);

      expect(first, isTrue);
      expect(second, isFalse); // Duplicate
    });

    test('applyMessages handles batch with some duplicates', () async {
      // Apply first batch
      final batch1 = [
        GroupMessage(
          groupId: 'group1',
          authorDeviceId: 'deviceA',
          sequenceNumber: 1,
          content: 'First',
          timestamp: DateTime.utc(2026, 2, 10, 0, 1),
        ),
        GroupMessage(
          groupId: 'group1',
          authorDeviceId: 'deviceA',
          sequenceNumber: 2,
          content: 'Second',
          timestamp: DateTime.utc(2026, 2, 10, 0, 2),
        ),
      ];
      await syncService.applyMessages(batch1);

      // Apply second batch with overlap
      final batch2 = [
        GroupMessage(
          groupId: 'group1',
          authorDeviceId: 'deviceA',
          sequenceNumber: 2, // Duplicate
          content: 'Second',
          timestamp: DateTime.utc(2026, 2, 10, 0, 2),
        ),
        GroupMessage(
          groupId: 'group1',
          authorDeviceId: 'deviceA',
          sequenceNumber: 3, // New
          content: 'Third',
          timestamp: DateTime.utc(2026, 2, 10, 0, 3),
        ),
      ];

      final applied = await syncService.applyMessages(batch2);
      expect(applied, 1); // Only the new message
    });

    test('applyMessage handles out-of-order delivery', () async {
      // Messages arrive out of order
      final msg3 = GroupMessage(
        groupId: 'group1',
        authorDeviceId: 'deviceA',
        sequenceNumber: 3,
        content: 'Third',
        timestamp: DateTime.utc(2026, 2, 10, 0, 3),
      );
      final msg1 = GroupMessage(
        groupId: 'group1',
        authorDeviceId: 'deviceA',
        sequenceNumber: 1,
        content: 'First',
        timestamp: DateTime.utc(2026, 2, 10, 0, 1),
      );

      await syncService.applyMessage(msg3);
      await syncService.applyMessage(msg1);

      // Clock should reflect the highest sequence (3), even though
      // message 2 is still missing
      final clock = await syncService.getVectorClock('group1');
      expect(clock['deviceA'], 3);

      // Both messages should be stored
      expect(
          await storageService.getMessage('group1', 'deviceA', 1), isNotNull);
      expect(
          await storageService.getMessage('group1', 'deviceA', 3), isNotNull);
    });
  });

  group('Sequence tracking', () {
    test('getNextSequenceNumber returns 1 for new group', () async {
      final next = await syncService.getNextSequenceNumber('group1', 'self');
      expect(next, 1);
    });

    test('getNextSequenceNumber increments correctly', () async {
      await syncService.updateVectorClock('group1', 'self', 5);
      final next = await syncService.getNextSequenceNumber('group1', 'self');
      expect(next, 6);
    });

    test('findGaps detects missing messages', () async {
      // Store messages 1, 3, 5 (missing 2 and 4)
      for (final seq in [1, 3, 5]) {
        await storageService.saveMessage(GroupMessage(
          groupId: 'group1',
          authorDeviceId: 'deviceA',
          sequenceNumber: seq,
          content: 'Msg $seq',
          timestamp: DateTime.utc(2026, 2, 10, 0, seq),
        ));
      }
      await syncService.updateVectorClock('group1', 'deviceA', 5);

      final gaps = await syncService.findGaps('group1', 'deviceA');
      expect(gaps, containsAll([2, 4]));
      expect(gaps.length, 2);
    });

    test('findGaps returns empty when no gaps', () async {
      for (var i = 1; i <= 3; i++) {
        await storageService.saveMessage(GroupMessage(
          groupId: 'group1',
          authorDeviceId: 'deviceA',
          sequenceNumber: i,
          content: 'Msg $i',
          timestamp: DateTime.utc(2026, 2, 10, 0, i),
        ));
      }
      await syncService.updateVectorClock('group1', 'deviceA', 3);

      final gaps = await syncService.findGaps('group1', 'deviceA');
      expect(gaps, isEmpty);
    });

    test('findGaps returns empty for unknown device', () async {
      final gaps = await syncService.findGaps('group1', 'unknown');
      expect(gaps, isEmpty);
    });
  });

  group('Full sync scenario', () {
    test('two peers sync after offline period', () async {
      // Set up: Alice has messages A:1-3 and B:1-2
      // Bob has messages A:1-2 and B:1-3
      // After sync, both should have A:1-3 and B:1-3

      // Alice's storage (this service)
      for (var i = 1; i <= 3; i++) {
        await storageService.saveMessage(GroupMessage(
          groupId: 'g1',
          authorDeviceId: 'Alice',
          sequenceNumber: i,
          content: 'Alice-$i',
          timestamp: DateTime.utc(2026, 2, 10, 0, i),
        ));
        await syncService.updateVectorClock('g1', 'Alice', i);
      }
      for (var i = 1; i <= 2; i++) {
        await storageService.saveMessage(GroupMessage(
          groupId: 'g1',
          authorDeviceId: 'Bob',
          sequenceNumber: i,
          content: 'Bob-$i',
          timestamp: DateTime.utc(2026, 2, 10, 1, i),
        ));
        await syncService.updateVectorClock('g1', 'Bob', i);
      }

      // Bob's clock
      final bobClock = VectorClock.fromMap({'Alice': 2, 'Bob': 3});

      // What does Bob need from Alice?
      final messagesForBob =
          await syncService.getMessagesForSync('g1', bobClock);
      expect(messagesForBob, hasLength(1)); // Alice:3
      expect(messagesForBob.first.content, 'Alice-3');

      // What does Alice need from Bob?
      final aliceClock = await syncService.getVectorClock('g1');
      final missingFromBob =
          syncService.computeMissingMessages(bobClock, aliceClock);
      expect(missingFromBob['Bob'], [3]); // Alice needs Bob:3
    });
  });
}
