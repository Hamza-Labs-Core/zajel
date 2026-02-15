import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/groups/models/group.dart';
import 'package:zajel/features/groups/models/group_message.dart';
import 'package:zajel/features/groups/models/vector_clock.dart';

void main() {
  // ===========================================================================
  // VectorClock
  // ===========================================================================

  group('VectorClock', () {
    test('default constructor creates empty clock', () {
      const clock = VectorClock();
      expect(clock.isEmpty, isTrue);
      expect(clock.length, 0);
      expect(clock.deviceIds, isEmpty);
    });

    test('fromMap creates clock from map', () {
      final clock = VectorClock.fromMap({'A': 3, 'B': 5});
      expect(clock['A'], 3);
      expect(clock['B'], 5);
      expect(clock.length, 2);
    });

    test('operator[] returns 0 for unknown device', () {
      const clock = VectorClock();
      expect(clock['unknown'], 0);
    });

    test('increment increases sequence number by 1', () {
      const clock = VectorClock();
      final updated = clock.increment('A');
      expect(updated['A'], 1);

      final again = updated.increment('A');
      expect(again['A'], 2);
    });

    test('increment does not modify original clock', () {
      const clock = VectorClock();
      final updated = clock.increment('A');
      expect(clock['A'], 0);
      expect(updated['A'], 1);
    });

    test('set updates a specific device sequence', () {
      const clock = VectorClock();
      final updated = clock.set('A', 10);
      expect(updated['A'], 10);
    });

    test('merge takes maximum for each device', () {
      final a = VectorClock.fromMap({'X': 3, 'Y': 5});
      final b = VectorClock.fromMap({'X': 7, 'Z': 2});

      final merged = a.merge(b);
      expect(merged['X'], 7); // max(3, 7)
      expect(merged['Y'], 5); // only in a
      expect(merged['Z'], 2); // only in b
    });

    test('merge is commutative', () {
      final a = VectorClock.fromMap({'X': 3, 'Y': 5});
      final b = VectorClock.fromMap({'X': 7, 'Z': 2});

      final ab = a.merge(b);
      final ba = b.merge(a);

      expect(ab.toMap(), ba.toMap());
    });

    test('isBeforeOrEqual returns true when all entries are <=', () {
      final a = VectorClock.fromMap({'X': 1, 'Y': 2});
      final b = VectorClock.fromMap({'X': 3, 'Y': 2});

      expect(a.isBeforeOrEqual(b), isTrue);
      expect(b.isBeforeOrEqual(a), isFalse);
    });

    test('isBeforeOrEqual returns true for identical clocks', () {
      final a = VectorClock.fromMap({'X': 3, 'Y': 5});
      final b = VectorClock.fromMap({'X': 3, 'Y': 5});

      expect(a.isBeforeOrEqual(b), isTrue);
      expect(b.isBeforeOrEqual(a), isTrue);
    });

    test('isBeforeOrEqual returns true for empty clock', () {
      const empty = VectorClock();
      final nonEmpty = VectorClock.fromMap({'X': 3});

      expect(empty.isBeforeOrEqual(nonEmpty), isTrue);
    });

    test('isBefore returns true for strictly less', () {
      final a = VectorClock.fromMap({'X': 1, 'Y': 2});
      final b = VectorClock.fromMap({'X': 3, 'Y': 5});

      expect(a.isBefore(b), isTrue);
      expect(b.isBefore(a), isFalse);
    });

    test('isBefore returns false for equal clocks', () {
      final a = VectorClock.fromMap({'X': 3, 'Y': 5});
      final b = VectorClock.fromMap({'X': 3, 'Y': 5});

      expect(a.isBefore(b), isFalse);
    });

    test('isConcurrentWith detects concurrent events', () {
      final a = VectorClock.fromMap({'X': 3, 'Y': 2});
      final b = VectorClock.fromMap({'X': 2, 'Y': 4});

      expect(a.isConcurrentWith(b), isTrue);
      expect(b.isConcurrentWith(a), isTrue);
    });

    test('isConcurrentWith returns false for ordered events', () {
      final a = VectorClock.fromMap({'X': 1, 'Y': 2});
      final b = VectorClock.fromMap({'X': 3, 'Y': 5});

      expect(a.isConcurrentWith(b), isFalse);
    });

    test('missingFrom computes correct missing sequences', () {
      final local = VectorClock.fromMap({'A': 5, 'B': 3, 'C': 1});
      final remote = VectorClock.fromMap({'A': 3, 'B': 3});

      final missing = local.missingFrom(remote);

      // Remote is missing A:4, A:5, and C:1
      expect(missing['A'], [4, 5]);
      expect(missing['C'], [1]);
      expect(missing.containsKey('B'), isFalse); // B is equal
    });

    test('missingFrom returns empty when remote has everything', () {
      final local = VectorClock.fromMap({'A': 3, 'B': 3});
      final remote = VectorClock.fromMap({'A': 5, 'B': 3});

      final missing = local.missingFrom(remote);
      expect(missing, isEmpty);
    });

    test('toJson and fromJson roundtrip', () {
      final clock = VectorClock.fromMap({'A': 3, 'B': 7, 'C': 1});
      final json = clock.toJson();
      final restored = VectorClock.fromJson(json);

      expect(restored['A'], 3);
      expect(restored['B'], 7);
      expect(restored['C'], 1);
      expect(restored, clock);
    });

    test('toMap returns unmodifiable map', () {
      final clock = VectorClock.fromMap({'A': 3});
      final map = clock.toMap();

      expect(() => map['A'] = 10, throwsA(isA<UnsupportedError>()));
    });

    test('equality works correctly', () {
      final a = VectorClock.fromMap({'X': 3, 'Y': 5});
      final b = VectorClock.fromMap({'X': 3, 'Y': 5});
      final c = VectorClock.fromMap({'X': 3, 'Y': 6});

      expect(a, equals(b));
      expect(a, isNot(equals(c)));
    });
  });

  // ===========================================================================
  // GroupMessageType
  // ===========================================================================

  group('GroupMessageType', () {
    test('fromString returns correct enum values', () {
      expect(GroupMessageType.fromString('text'), GroupMessageType.text);
      expect(GroupMessageType.fromString('file'), GroupMessageType.file);
      expect(GroupMessageType.fromString('image'), GroupMessageType.image);
      expect(GroupMessageType.fromString('system'), GroupMessageType.system);
    });

    test('fromString defaults to text for unknown values', () {
      expect(GroupMessageType.fromString('unknown'), GroupMessageType.text);
    });
  });

  // ===========================================================================
  // GroupMessage
  // ===========================================================================

  group('GroupMessage', () {
    test('id is composite of author and sequence', () {
      final msg = GroupMessage(
        groupId: 'g1',
        authorDeviceId: 'device_A',
        sequenceNumber: 42,
        content: 'Hello',
        timestamp: DateTime.utc(2026, 2, 10),
      );
      expect(msg.id, 'device_A:42');
    });

    test('toBytes and fromBytes roundtrip for text message', () {
      final message = GroupMessage(
        groupId: 'g1',
        authorDeviceId: 'device_A',
        sequenceNumber: 1,
        type: GroupMessageType.text,
        content: 'Hello, group!',
        timestamp: DateTime.utc(2026, 2, 10, 12, 0),
      );

      final bytes = message.toBytes();
      final restored = GroupMessage.fromBytes(
        bytes,
        groupId: 'g1',
      );

      expect(restored.authorDeviceId, 'device_A');
      expect(restored.sequenceNumber, 1);
      expect(restored.type, GroupMessageType.text);
      expect(restored.content, 'Hello, group!');
      expect(restored.timestamp, DateTime.utc(2026, 2, 10, 12, 0));
    });

    test('toBytes and fromBytes roundtrip with metadata', () {
      final message = GroupMessage(
        groupId: 'g1',
        authorDeviceId: 'device_B',
        sequenceNumber: 5,
        type: GroupMessageType.file,
        content: 'file_data',
        metadata: {'filename': 'doc.pdf', 'size': 1024},
        timestamp: DateTime.utc(2026, 2, 10, 14, 30),
      );

      final bytes = message.toBytes();
      final restored = GroupMessage.fromBytes(bytes, groupId: 'g1');

      expect(restored.type, GroupMessageType.file);
      expect(restored.metadata['filename'], 'doc.pdf');
      expect(restored.metadata['size'], 1024);
    });

    test('toJson and fromJson roundtrip', () {
      final message = GroupMessage(
        groupId: 'g1',
        authorDeviceId: 'device_A',
        sequenceNumber: 3,
        type: GroupMessageType.text,
        content: 'Test message',
        metadata: {'key': 'value'},
        timestamp: DateTime.utc(2026, 2, 10),
        status: GroupMessageStatus.sent,
        isOutgoing: true,
      );

      final json = message.toJson();
      final restored = GroupMessage.fromJson(json);

      expect(restored.groupId, 'g1');
      expect(restored.authorDeviceId, 'device_A');
      expect(restored.sequenceNumber, 3);
      expect(restored.type, GroupMessageType.text);
      expect(restored.content, 'Test message');
      expect(restored.status, GroupMessageStatus.sent);
      expect(restored.isOutgoing, isTrue);
    });

    test('copyWith creates modified copy', () {
      final message = GroupMessage(
        groupId: 'g1',
        authorDeviceId: 'device_A',
        sequenceNumber: 1,
        content: 'Original',
        timestamp: DateTime.utc(2026, 2, 10),
      );

      final modified = message.copyWith(
        content: 'Modified',
        status: GroupMessageStatus.delivered,
      );

      expect(modified.content, 'Modified');
      expect(modified.status, GroupMessageStatus.delivered);
      expect(modified.authorDeviceId, 'device_A'); // Unchanged
      expect(message.content, 'Original'); // Original unchanged
    });

    test('equality is based on groupId, author, and sequence', () {
      final a = GroupMessage(
        groupId: 'g1',
        authorDeviceId: 'device_A',
        sequenceNumber: 1,
        content: 'Hello',
        timestamp: DateTime.utc(2026, 2, 10),
      );
      final b = GroupMessage(
        groupId: 'g1',
        authorDeviceId: 'device_A',
        sequenceNumber: 1,
        content: 'Different content',
        timestamp: DateTime.utc(2026, 2, 11),
      );
      final c = GroupMessage(
        groupId: 'g1',
        authorDeviceId: 'device_A',
        sequenceNumber: 2,
        content: 'Hello',
        timestamp: DateTime.utc(2026, 2, 10),
      );

      expect(a, equals(b)); // Same group, author, sequence
      expect(a, isNot(equals(c))); // Different sequence
    });

    test('fromBytes throws FormatException for invalid data', () {
      expect(
        () => GroupMessage.fromBytes(
          Uint8List.fromList([0, 1, 2]),
          groupId: 'g1',
        ),
        throwsA(isA<FormatException>()),
      );
    });
  });

  // ===========================================================================
  // GroupMember
  // ===========================================================================

  group('GroupMember', () {
    test('toJson and fromJson roundtrip', () {
      final member = GroupMember(
        deviceId: 'device_A',
        displayName: 'Alice',
        publicKey: 'pk_base64',
        joinedAt: DateTime.utc(2026, 2, 10),
      );

      final json = member.toJson();
      final restored = GroupMember.fromJson(json);

      expect(restored.deviceId, 'device_A');
      expect(restored.displayName, 'Alice');
      expect(restored.publicKey, 'pk_base64');
      expect(restored.joinedAt, DateTime.utc(2026, 2, 10));
    });

    test('copyWith creates modified copy', () {
      final member = GroupMember(
        deviceId: 'device_A',
        displayName: 'Alice',
        publicKey: 'pk_base64',
        joinedAt: DateTime.utc(2026, 2, 10),
      );

      final modified = member.copyWith(displayName: 'Alicia');
      expect(modified.displayName, 'Alicia');
      expect(modified.deviceId, 'device_A'); // Unchanged
      expect(member.displayName, 'Alice'); // Original unchanged
    });

    test('equality is based on deviceId and publicKey', () {
      final a = GroupMember(
        deviceId: 'device_A',
        displayName: 'Alice',
        publicKey: 'pk_base64',
        joinedAt: DateTime.utc(2026, 2, 10),
      );
      final b = GroupMember(
        deviceId: 'device_A',
        displayName: 'Different Name',
        publicKey: 'pk_base64',
        joinedAt: DateTime.utc(2026, 2, 11),
      );

      expect(a, equals(b)); // Same deviceId and publicKey
    });
  });

  // ===========================================================================
  // Group
  // ===========================================================================

  group('Group', () {
    final now = DateTime.utc(2026, 2, 10);
    final alice = GroupMember(
      deviceId: 'device_A',
      displayName: 'Alice',
      publicKey: 'pk_alice',
      joinedAt: now,
    );
    final bob = GroupMember(
      deviceId: 'device_B',
      displayName: 'Bob',
      publicKey: 'pk_bob',
      joinedAt: now,
    );

    test('toJson and fromJson roundtrip', () {
      final group = Group(
        id: 'group_123',
        name: 'Test Group',
        selfDeviceId: 'device_A',
        members: [alice, bob],
        createdAt: now,
        createdBy: 'device_A',
      );

      final json = group.toJson();
      final restored = Group.fromJson(json);

      expect(restored.id, 'group_123');
      expect(restored.name, 'Test Group');
      expect(restored.selfDeviceId, 'device_A');
      expect(restored.members, hasLength(2));
      expect(restored.members[0].displayName, 'Alice');
      expect(restored.members[1].displayName, 'Bob');
      expect(restored.createdBy, 'device_A');
    });

    test('selfMember returns our member entry', () {
      final group = Group(
        id: 'group_123',
        name: 'Test Group',
        selfDeviceId: 'device_A',
        members: [alice, bob],
        createdAt: now,
        createdBy: 'device_A',
      );

      expect(group.selfMember, isNotNull);
      expect(group.selfMember!.displayName, 'Alice');
    });

    test('selfMember returns null when not in members', () {
      final group = Group(
        id: 'group_123',
        name: 'Test Group',
        selfDeviceId: 'device_C', // Not in members
        members: [alice, bob],
        createdAt: now,
        createdBy: 'device_A',
      );

      expect(group.selfMember, isNull);
    });

    test('otherMembers excludes self', () {
      final group = Group(
        id: 'group_123',
        name: 'Test Group',
        selfDeviceId: 'device_A',
        members: [alice, bob],
        createdAt: now,
        createdBy: 'device_A',
      );

      final others = group.otherMembers;
      expect(others, hasLength(1));
      expect(others.first.displayName, 'Bob');
    });

    test('memberCount returns correct count', () {
      final group = Group(
        id: 'group_123',
        name: 'Test Group',
        selfDeviceId: 'device_A',
        members: [alice, bob],
        createdAt: now,
        createdBy: 'device_A',
      );

      expect(group.memberCount, 2);
    });

    test('copyWith creates modified copy', () {
      final group = Group(
        id: 'group_123',
        name: 'Original',
        selfDeviceId: 'device_A',
        members: [alice],
        createdAt: now,
        createdBy: 'device_A',
      );

      final modified = group.copyWith(
        name: 'Modified',
        members: [alice, bob],
      );

      expect(modified.name, 'Modified');
      expect(modified.members, hasLength(2));
      expect(group.name, 'Original'); // Original unchanged
      expect(group.members, hasLength(1));
    });

    test('fromJson handles string-encoded members', () {
      // Simulate what comes from SQLite (members stored as JSON string)
      final json = {
        'id': 'group_123',
        'name': 'Test',
        'self_device_id': 'device_A',
        'members': jsonEncode([alice.toJson()]),
        'created_at': now.toIso8601String(),
        'created_by': 'device_A',
      };

      final group = Group.fromJson(json);
      expect(group.members, hasLength(1));
      expect(group.members.first.displayName, 'Alice');
    });

    test('fromJson handles list-typed members', () {
      // Simulate what comes from in-memory (members as list)
      final json = {
        'id': 'group_123',
        'name': 'Test',
        'self_device_id': 'device_A',
        'members': [alice.toJson()],
        'created_at': now.toIso8601String(),
        'created_by': 'device_A',
      };

      final group = Group.fromJson(json);
      expect(group.members, hasLength(1));
      expect(group.members.first.displayName, 'Alice');
    });
  });
}
