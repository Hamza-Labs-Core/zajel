import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/models/peer.dart';
import 'package:zajel/features/groups/models/group.dart';
import 'package:zajel/features/groups/services/group_connection_service.dart';

/// Fake P2P adapter that tracks connection operations in memory.
class FakeP2PConnectionAdapter implements P2PConnectionAdapter {
  final Map<String, PeerConnectionState> _states = {};
  final List<String> connectCalls = [];
  final List<String> disconnectCalls = [];
  final List<(String, Uint8List)> sendDataCalls = [];

  final _stateChangeController =
      StreamController<(String, PeerConnectionState)>.broadcast(sync: true);
  final _incomingDataController =
      StreamController<(String, Uint8List)>.broadcast(sync: true);

  /// Whether connectToPeer should throw.
  bool failOnConnect = false;

  /// Whether sendData should throw.
  bool failOnSend = false;

  @override
  Stream<(String, PeerConnectionState)> get connectionStateChanges =>
      _stateChangeController.stream;

  @override
  Stream<(String, Uint8List)> get incomingData =>
      _incomingDataController.stream;

  @override
  Future<void> connectToPeer(String peerId) async {
    connectCalls.add(peerId);
    if (failOnConnect) {
      throw Exception('Connection failed (test)');
    }
    _states[peerId] = PeerConnectionState.connecting;
  }

  @override
  Future<void> disconnectPeer(String peerId) async {
    disconnectCalls.add(peerId);
    _states[peerId] = PeerConnectionState.disconnected;
  }

  @override
  PeerConnectionState getConnectionState(String peerId) {
    return _states[peerId] ?? PeerConnectionState.disconnected;
  }

  @override
  Future<void> sendData(String peerId, Uint8List data) async {
    if (failOnSend) {
      throw Exception('Send failed (test)');
    }
    sendDataCalls.add((peerId, data));
  }

  /// Simulate a connection state change from the P2P layer.
  void simulateStateChange(String peerId, PeerConnectionState state) {
    _states[peerId] = state;
    _stateChangeController.add((peerId, state));
  }

  /// Simulate incoming data from a peer.
  void simulateIncomingData(String peerId, Uint8List data) {
    _incomingDataController.add((peerId, data));
  }

  Future<void> dispose() async {
    await _stateChangeController.close();
    await _incomingDataController.close();
  }
}

/// Helper to create a test Group with members.
Group createTestGroup({
  String groupId = 'test-uuid-1234-5678-90ab-cdef12345678',
  String selfDeviceId = 'self_device',
  List<GroupMember>? members,
}) {
  return Group(
    id: groupId,
    name: 'Test Group',
    selfDeviceId: selfDeviceId,
    members: members ??
        [
          GroupMember(
            deviceId: selfDeviceId,
            displayName: 'Self',
            publicKey: 'pk_self',
            joinedAt: DateTime.utc(2026, 2, 10),
          ),
          GroupMember(
            deviceId: 'device_B',
            displayName: 'Bob',
            publicKey: 'pk_bob',
            joinedAt: DateTime.utc(2026, 2, 10),
          ),
          GroupMember(
            deviceId: 'device_C',
            displayName: 'Charlie',
            publicKey: 'pk_charlie',
            joinedAt: DateTime.utc(2026, 2, 10),
          ),
        ],
    createdAt: DateTime.utc(2026, 2, 10),
    createdBy: selfDeviceId,
  );
}

/// Allow stream events to propagate through multiple async hops.
///
/// Stream events in GroupConnectionService go through two hops:
///   adapter stream -> service handler -> service output stream -> test listener
/// Each hop requires a separate microtask round, so we yield multiple times.
Future<void> _pumpEvents() async {
  // Yield to the event loop multiple times to allow stream events
  // to propagate through the chain of broadcast stream controllers.
  for (var i = 0; i < 5; i++) {
    await Future.delayed(Duration.zero);
  }
}

void main() {
  late FakeP2PConnectionAdapter adapter;
  late GroupConnectionService service;

  setUp(() {
    adapter = FakeP2PConnectionAdapter();
    service = GroupConnectionService(adapter: adapter);
  });

  tearDown(() async {
    await service.dispose();
    await adapter.dispose();
  });

  group('Group activation', () {
    test('activateGroup connects to all other members', () async {
      final group = createTestGroup();
      await service.activateGroup(group);

      // Should connect to Bob and Charlie (not self)
      expect(adapter.connectCalls, hasLength(2));
      expect(
        adapter.connectCalls,
        containsAll([
          'group_${group.id}_device_B',
          'group_${group.id}_device_C',
        ]),
      );
    });

    test('activateGroup marks the group as active', () async {
      final group = createTestGroup();
      expect(service.isGroupActive(group.id), isFalse);

      await service.activateGroup(group);
      expect(service.isGroupActive(group.id), isTrue);
    });

    test('activateGroup initializes member connection tracking', () async {
      final group = createTestGroup();
      await service.activateGroup(group);

      final connections = service.getGroupConnections(group.id);
      expect(connections, hasLength(2));
      expect(connections.containsKey('device_B'), isTrue);
      expect(connections.containsKey('device_C'), isTrue);

      // Self should not be in the connections
      expect(connections.containsKey('self_device'), isFalse);
    });

    test('activateGroup sets members to connecting state', () async {
      final group = createTestGroup();
      await service.activateGroup(group);

      final bobConn = service.getMemberConnection(group.id, 'device_B');
      expect(bobConn, isNotNull);
      expect(bobConn!.state, PeerConnectionState.connecting);

      final charlieConn = service.getMemberConnection(group.id, 'device_C');
      expect(charlieConn, isNotNull);
      expect(charlieConn!.state, PeerConnectionState.connecting);
    });

    test('activateGroup handles connection failure gracefully', () async {
      adapter.failOnConnect = true;
      final group = createTestGroup();

      // Should not throw
      await service.activateGroup(group);

      // Members should be marked as failed
      final bobConn = service.getMemberConnection(group.id, 'device_B');
      expect(bobConn!.state, PeerConnectionState.failed);
    });

    test('activateGroup with single member (only self) makes no connections',
        () async {
      final group = createTestGroup(
        members: [
          GroupMember(
            deviceId: 'self_device',
            displayName: 'Self',
            publicKey: 'pk_self',
            joinedAt: DateTime.utc(2026, 2, 10),
          ),
        ],
      );

      await service.activateGroup(group);

      expect(adapter.connectCalls, isEmpty);
      expect(service.getGroupConnections(group.id), isEmpty);
    });
  });

  group('Group deactivation', () {
    test('deactivateGroup disconnects all members', () async {
      final group = createTestGroup();
      await service.activateGroup(group);

      await service.deactivateGroup(group.id);

      expect(adapter.disconnectCalls, hasLength(2));
      expect(service.isGroupActive(group.id), isFalse);
    });

    test('deactivateGroup cleans up connection tracking', () async {
      final group = createTestGroup();
      await service.activateGroup(group);
      await service.deactivateGroup(group.id);

      expect(service.getGroupConnections(group.id), isEmpty);
    });

    test('deactivateGroup on inactive group is a no-op', () async {
      await service.deactivateGroup('nonexistent');
      expect(adapter.disconnectCalls, isEmpty);
    });
  });

  group('Member join', () {
    test('handleMemberJoined connects to new member when group is active',
        () async {
      final group = createTestGroup();
      await service.activateGroup(group);
      adapter.connectCalls.clear(); // Reset from activation

      final newMember = GroupMember(
        deviceId: 'device_D',
        displayName: 'Dave',
        publicKey: 'pk_dave',
        joinedAt: DateTime.utc(2026, 2, 10),
      );

      await service.handleMemberJoined(group.id, newMember);

      expect(adapter.connectCalls, hasLength(1));
      expect(adapter.connectCalls.first, 'group_${group.id}_device_D');

      final daveConn = service.getMemberConnection(group.id, 'device_D');
      expect(daveConn, isNotNull);
      expect(daveConn!.displayName, 'Dave');
      expect(daveConn.state, PeerConnectionState.connecting);
    });

    test('handleMemberJoined is a no-op when group is not active', () async {
      final newMember = GroupMember(
        deviceId: 'device_D',
        displayName: 'Dave',
        publicKey: 'pk_dave',
        joinedAt: DateTime.utc(2026, 2, 10),
      );

      await service.handleMemberJoined('inactive_group', newMember);

      expect(adapter.connectCalls, isEmpty);
    });

    test('handleMemberJoined handles connection failure', () async {
      final group = createTestGroup();
      await service.activateGroup(group);
      adapter.connectCalls.clear();
      adapter.failOnConnect = true;

      final newMember = GroupMember(
        deviceId: 'device_D',
        displayName: 'Dave',
        publicKey: 'pk_dave',
        joinedAt: DateTime.utc(2026, 2, 10),
      );

      // Should not throw
      await service.handleMemberJoined(group.id, newMember);

      final daveConn = service.getMemberConnection(group.id, 'device_D');
      expect(daveConn!.state, PeerConnectionState.failed);
    });
  });

  group('Member leave', () {
    test('handleMemberLeft disconnects and removes member', () async {
      final group = createTestGroup();
      await service.activateGroup(group);
      adapter.disconnectCalls.clear();

      await service.handleMemberLeft(group.id, 'device_B');

      expect(adapter.disconnectCalls, hasLength(1));
      expect(adapter.disconnectCalls.first, 'group_${group.id}_device_B');

      // Member should be removed from tracking
      expect(service.getMemberConnection(group.id, 'device_B'), isNull);

      // Charlie should still be tracked
      expect(service.getMemberConnection(group.id, 'device_C'), isNotNull);
    });

    test('handleMemberLeft on nonexistent group is a no-op', () async {
      await service.handleMemberLeft('nonexistent', 'device_B');
      expect(adapter.disconnectCalls, isEmpty);
    });

    test('handleMemberLeft on nonexistent member is a no-op', () async {
      final group = createTestGroup();
      await service.activateGroup(group);
      adapter.disconnectCalls.clear();

      await service.handleMemberLeft(group.id, 'device_unknown');
      // Still disconnects (adapter doesn't know the member isn't tracked),
      // but the internal tracking doesn't fail
      expect(adapter.disconnectCalls, hasLength(1));
    });
  });

  group('Connection state tracking', () {
    test('connection state changes are tracked per member', () async {
      final group = createTestGroup();
      await service.activateGroup(group);

      // Simulate Bob connecting
      adapter.simulateStateChange(
          'group_${group.id}_device_B', PeerConnectionState.connected);

      // Allow async event to propagate
      await _pumpEvents();

      final bobConn = service.getMemberConnection(group.id, 'device_B');
      expect(bobConn!.state, PeerConnectionState.connected);

      // Charlie should still be connecting
      final charlieConn = service.getMemberConnection(group.id, 'device_C');
      expect(charlieConn!.state, PeerConnectionState.connecting);
    });

    test('connection events are emitted', () async {
      final group = createTestGroup();
      await service.activateGroup(group);

      final events = <GroupConnectionEvent>[];
      service.connectionEvents.listen(events.add);

      adapter.simulateStateChange(
          'group_${group.id}_device_B', PeerConnectionState.connected);

      await _pumpEvents();

      expect(events, hasLength(1));
      expect(events.first.groupId, group.id);
      expect(events.first.deviceId, 'device_B');
      expect(events.first.oldState, PeerConnectionState.connecting);
      expect(events.first.newState, PeerConnectionState.connected);
    });

    test('non-group peer state changes are ignored', () async {
      final group = createTestGroup();
      await service.activateGroup(group);

      final events = <GroupConnectionEvent>[];
      service.connectionEvents.listen(events.add);

      // Simulate a non-group connection state change
      adapter.simulateStateChange(
          'regular_peer_123', PeerConnectionState.connected);

      await _pumpEvents();

      expect(events, isEmpty);
    });

    test('state changes for inactive groups are ignored', () async {
      final group = createTestGroup();
      await service.activateGroup(group);
      await service.deactivateGroup(group.id);

      final events = <GroupConnectionEvent>[];
      service.connectionEvents.listen(events.add);

      adapter.simulateStateChange(
          'group_${group.id}_device_B', PeerConnectionState.connected);

      await _pumpEvents();

      expect(events, isEmpty);
    });

    test('duplicate state changes are not emitted', () async {
      final group = createTestGroup();
      await service.activateGroup(group);

      final events = <GroupConnectionEvent>[];
      service.connectionEvents.listen(events.add);

      // Set to connected
      adapter.simulateStateChange(
          'group_${group.id}_device_B', PeerConnectionState.connected);
      await _pumpEvents();

      // Set to connected again (same state)
      adapter.simulateStateChange(
          'group_${group.id}_device_B', PeerConnectionState.connected);
      await _pumpEvents();

      // Only one event should be emitted
      expect(events, hasLength(1));
    });
  });

  group('Data operations', () {
    test('broadcastToGroup sends to all connected members', () async {
      final group = createTestGroup();
      await service.activateGroup(group);

      // Simulate both members connected
      adapter.simulateStateChange(
          'group_${group.id}_device_B', PeerConnectionState.connected);
      adapter.simulateStateChange(
          'group_${group.id}_device_C', PeerConnectionState.connected);
      await _pumpEvents();

      final data = Uint8List.fromList([1, 2, 3, 4]);
      final sentCount = await service.broadcastToGroup(group.id, data);

      expect(sentCount, 2);
      expect(adapter.sendDataCalls, hasLength(2));
    });

    test('broadcastToGroup skips disconnected members', () async {
      final group = createTestGroup();
      await service.activateGroup(group);

      // Only Bob is connected
      adapter.simulateStateChange(
          'group_${group.id}_device_B', PeerConnectionState.connected);
      await _pumpEvents();

      final data = Uint8List.fromList([1, 2, 3]);
      final sentCount = await service.broadcastToGroup(group.id, data);

      expect(sentCount, 1);
      expect(adapter.sendDataCalls, hasLength(1));
      expect(adapter.sendDataCalls.first.$1, 'group_${group.id}_device_B');
    });

    test('broadcastToGroup returns 0 for unknown group', () async {
      final data = Uint8List.fromList([1, 2, 3]);
      final sentCount = await service.broadcastToGroup('unknown', data);
      expect(sentCount, 0);
    });

    test('broadcastToGroup handles send failures gracefully', () async {
      final group = createTestGroup();
      await service.activateGroup(group);

      adapter.simulateStateChange(
          'group_${group.id}_device_B', PeerConnectionState.connected);
      adapter.simulateStateChange(
          'group_${group.id}_device_C', PeerConnectionState.connected);
      await _pumpEvents();

      adapter.failOnSend = true;

      final data = Uint8List.fromList([1, 2, 3]);
      // Should not throw
      final sentCount = await service.broadcastToGroup(group.id, data);
      expect(sentCount, 0);
    });

    test('sendToMember sends to a specific member', () async {
      final group = createTestGroup();
      await service.activateGroup(group);

      final data = Uint8List.fromList([5, 6, 7]);
      await service.sendToMember(group.id, 'device_B', data);

      expect(adapter.sendDataCalls, hasLength(1));
      expect(adapter.sendDataCalls.first.$1, 'group_${group.id}_device_B');
      expect(adapter.sendDataCalls.first.$2, data);
    });

    test('incoming data is routed to the correct group', () async {
      final group = createTestGroup();
      await service.activateGroup(group);

      final events = <GroupDataEvent>[];
      service.dataEvents.listen(events.add);

      final data = Uint8List.fromList([10, 20, 30]);
      adapter.simulateIncomingData('group_${group.id}_device_B', data);

      await _pumpEvents();

      expect(events, hasLength(1));
      expect(events.first.groupId, group.id);
      expect(events.first.fromDeviceId, 'device_B');
      expect(events.first.data, data);
    });

    test('incoming data from non-group peers is ignored', () async {
      final group = createTestGroup();
      await service.activateGroup(group);

      final events = <GroupDataEvent>[];
      service.dataEvents.listen(events.add);

      adapter.simulateIncomingData('regular_peer', Uint8List.fromList([1, 2]));
      await _pumpEvents();

      expect(events, isEmpty);
    });

    test('incoming data from inactive group is ignored', () async {
      final group = createTestGroup();
      await service.activateGroup(group);
      await service.deactivateGroup(group.id);

      final events = <GroupDataEvent>[];
      service.dataEvents.listen(events.add);

      adapter.simulateIncomingData(
          'group_${group.id}_device_B', Uint8List.fromList([1]));
      await _pumpEvents();

      expect(events, isEmpty);
    });
  });

  group('State queries', () {
    test('getConnectedMembers returns only connected device IDs', () async {
      final group = createTestGroup();
      await service.activateGroup(group);

      adapter.simulateStateChange(
          'group_${group.id}_device_B', PeerConnectionState.connected);
      await _pumpEvents();

      final connected = service.getConnectedMembers(group.id);
      expect(connected, ['device_B']);
    });

    test('getConnectedMemberCount returns correct count', () async {
      final group = createTestGroup();
      await service.activateGroup(group);

      expect(service.getConnectedMemberCount(group.id), 0);

      adapter.simulateStateChange(
          'group_${group.id}_device_B', PeerConnectionState.connected);
      adapter.simulateStateChange(
          'group_${group.id}_device_C', PeerConnectionState.connected);
      await _pumpEvents();

      expect(service.getConnectedMemberCount(group.id), 2);
    });

    test('isFullyConnected returns true when all members are connected',
        () async {
      final group = createTestGroup();
      await service.activateGroup(group);

      expect(service.isFullyConnected(group.id), isFalse);

      adapter.simulateStateChange(
          'group_${group.id}_device_B', PeerConnectionState.connected);
      adapter.simulateStateChange(
          'group_${group.id}_device_C', PeerConnectionState.connected);
      await _pumpEvents();

      expect(service.isFullyConnected(group.id), isTrue);
    });

    test('isFullyConnected returns false when any member is not connected',
        () async {
      final group = createTestGroup();
      await service.activateGroup(group);

      adapter.simulateStateChange(
          'group_${group.id}_device_B', PeerConnectionState.connected);
      await _pumpEvents();

      expect(service.isFullyConnected(group.id), isFalse);
    });

    test('isFullyConnected returns false for empty/unknown group', () {
      expect(service.isFullyConnected('unknown'), isFalse);
    });

    test('getGroupConnections returns unmodifiable map', () async {
      final group = createTestGroup();
      await service.activateGroup(group);

      final connections = service.getGroupConnections(group.id);

      // Should throw if we try to modify
      expect(() => (connections as Map).remove('device_B'),
          throwsA(isA<UnsupportedError>()));
    });
  });

  group('Multiple groups', () {
    test('can activate multiple groups simultaneously', () async {
      final group1 = createTestGroup(
        groupId: 'test-uuid-1234-5678-90ab-cdef12345678',
        members: [
          GroupMember(
            deviceId: 'self_device',
            displayName: 'Self',
            publicKey: 'pk_self',
            joinedAt: DateTime.utc(2026, 2, 10),
          ),
          GroupMember(
            deviceId: 'device_B',
            displayName: 'Bob',
            publicKey: 'pk_bob',
            joinedAt: DateTime.utc(2026, 2, 10),
          ),
        ],
      );
      final group2 = createTestGroup(
        groupId: 'test-uuid-aaaa-bbbb-cccc-ddddeeeeeeee',
        members: [
          GroupMember(
            deviceId: 'self_device',
            displayName: 'Self',
            publicKey: 'pk_self',
            joinedAt: DateTime.utc(2026, 2, 10),
          ),
          GroupMember(
            deviceId: 'device_D',
            displayName: 'Dave',
            publicKey: 'pk_dave',
            joinedAt: DateTime.utc(2026, 2, 10),
          ),
        ],
      );

      await service.activateGroup(group1);
      await service.activateGroup(group2);

      expect(service.isGroupActive(group1.id), isTrue);
      expect(service.isGroupActive(group2.id), isTrue);
      expect(adapter.connectCalls, hasLength(2)); // One per group
    });

    test('deactivating one group does not affect another', () async {
      final group1 = createTestGroup(
        groupId: 'test-uuid-1234-5678-90ab-cdef12345678',
        members: [
          GroupMember(
            deviceId: 'self_device',
            displayName: 'Self',
            publicKey: 'pk_self',
            joinedAt: DateTime.utc(2026, 2, 10),
          ),
          GroupMember(
            deviceId: 'device_B',
            displayName: 'Bob',
            publicKey: 'pk_bob',
            joinedAt: DateTime.utc(2026, 2, 10),
          ),
        ],
      );
      final group2 = createTestGroup(
        groupId: 'test-uuid-aaaa-bbbb-cccc-ddddeeeeeeee',
        members: [
          GroupMember(
            deviceId: 'self_device',
            displayName: 'Self',
            publicKey: 'pk_self',
            joinedAt: DateTime.utc(2026, 2, 10),
          ),
          GroupMember(
            deviceId: 'device_D',
            displayName: 'Dave',
            publicKey: 'pk_dave',
            joinedAt: DateTime.utc(2026, 2, 10),
          ),
        ],
      );

      await service.activateGroup(group1);
      await service.activateGroup(group2);

      await service.deactivateGroup(group1.id);

      expect(service.isGroupActive(group1.id), isFalse);
      expect(service.isGroupActive(group2.id), isTrue);

      // Group2 connections should still be intact
      expect(service.getGroupConnections(group2.id), hasLength(1));
    });
  });

  group('Mesh topology properties', () {
    test('N members create N-1 connections (self excluded)', () async {
      final members = <GroupMember>[
        GroupMember(
          deviceId: 'self_device',
          displayName: 'Self',
          publicKey: 'pk_self',
          joinedAt: DateTime.utc(2026, 2, 10),
        ),
      ];

      // Add 5 other members
      for (var i = 0; i < 5; i++) {
        members.add(GroupMember(
          deviceId: 'device_$i',
          displayName: 'Member $i',
          publicKey: 'pk_$i',
          joinedAt: DateTime.utc(2026, 2, 10),
        ));
      }

      final group = createTestGroup(members: members);
      await service.activateGroup(group);

      // Should connect to 5 other members
      expect(adapter.connectCalls, hasLength(5));
      expect(service.getGroupConnections(group.id), hasLength(5));
    });

    test('connection state transitions through expected lifecycle', () async {
      final group = createTestGroup();
      await service.activateGroup(group);

      final events = <GroupConnectionEvent>[];
      service.connectionEvents.listen(events.add);

      final peerId = 'group_${group.id}_device_B';

      // connecting -> handshaking
      adapter.simulateStateChange(peerId, PeerConnectionState.handshaking);
      await _pumpEvents();

      // handshaking -> connected
      adapter.simulateStateChange(peerId, PeerConnectionState.connected);
      await _pumpEvents();

      expect(events, hasLength(2));
      expect(events[0].oldState, PeerConnectionState.connecting);
      expect(events[0].newState, PeerConnectionState.handshaking);
      expect(events[1].oldState, PeerConnectionState.handshaking);
      expect(events[1].newState, PeerConnectionState.connected);
    });
  });

  group('Dispose', () {
    test('dispose deactivates all groups', () async {
      final group = createTestGroup();
      await service.activateGroup(group);

      await service.dispose();

      expect(service.isGroupActive(group.id), isFalse);
      expect(adapter.disconnectCalls, hasLength(2)); // Bob and Charlie
    });
  });
}
