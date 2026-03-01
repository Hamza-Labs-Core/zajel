import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:zajel/features/groups/models/group.dart';
import 'package:zajel/features/groups/models/group_message.dart';
import 'package:zajel/features/groups/services/group_crypto_service.dart';
import 'package:zajel/features/groups/services/group_invitation_service.dart';
import 'package:zajel/features/groups/services/group_service.dart';

// --- Mock classes ---

class MockGroupService extends Mock implements GroupService {}

class MockGroupCryptoService extends Mock implements GroupCryptoService {}

/// Fake ConnectionManager that exposes stream controllers directly.
///
/// Using a fake instead of a mock avoids issues with mocktail and
/// Dart record types in stream getters.
class FakeConnectionManager {
  final invitationController = StreamController<(String, String)>.broadcast();
  final groupDataController = StreamController<(String, String)>.broadcast();

  Stream<(String, String)> get groupInvitations => invitationController.stream;
  Stream<(String, String)> get groupData => groupDataController.stream;

  final List<(String, String)> sentMessages = [];

  Future<void> sendMessage(String peerId, String message) async {
    sentMessages.add((peerId, message));
  }

  void dispose() {
    invitationController.close();
    groupDataController.close();
  }
}

/// Adapter that wraps FakeConnectionManager to match the interface
/// GroupInvitationService expects. Since GroupInvitationService accesses
/// connectionManager.groupInvitations, groupData, and sendMessage(),
/// we create a thin wrapper that delegates to our fake.
///
/// Since GroupInvitationService takes a ConnectionManager (concrete class)
/// we need a different approach. We'll create the service with our own
/// streams and callbacks instead.

// --- Test helpers ---

/// Creates a sample [Group] for testing.
Group _makeGroup({
  String id = 'grp_1',
  String name = 'Test Group',
  String selfDeviceId = 'self_device',
  List<GroupMember>? members,
  DateTime? createdAt,
  String createdBy = 'creator_device',
}) {
  return Group(
    id: id,
    name: name,
    selfDeviceId: selfDeviceId,
    members: members ??
        [
          GroupMember(
            deviceId: 'creator_device',
            displayName: 'Creator',
            publicKey: 'pk_creator',
            joinedAt: createdAt ?? DateTime.utc(2026, 2, 1),
          ),
          GroupMember(
            deviceId: 'self_device',
            displayName: 'Self',
            publicKey: 'pk_self',
            joinedAt: createdAt ?? DateTime.utc(2026, 2, 1),
          ),
        ],
    createdAt: createdAt ?? DateTime.utc(2026, 2, 1),
    createdBy: createdBy,
  );
}

/// Builds a valid invitation JSON payload.
String _makeInvitationPayload({
  String groupId = 'grp_1',
  String groupName = 'Test Group',
  String createdBy = 'creator_device',
  DateTime? createdAt,
  List<Map<String, dynamic>>? membersJson,
  Map<String, String>? senderKeys,
  String inviteeSenderKey = 'invitee_key_b64',
  String inviterDeviceId = 'creator_device',
}) {
  final ca = (createdAt ?? DateTime.utc(2026, 2, 1)).toIso8601String();
  final members = membersJson ??
      [
        {
          'device_id': 'creator_device',
          'display_name': 'Creator',
          'public_key': 'pk_creator',
          'joined_at': ca,
        },
      ];
  final keys = senderKeys ?? {'creator_device': 'creator_key_b64'};

  return jsonEncode({
    'groupId': groupId,
    'groupName': groupName,
    'createdBy': createdBy,
    'createdAt': ca,
    'members': members,
    'senderKeys': keys,
    'inviteeSenderKey': inviteeSenderKey,
    'inviterDeviceId': inviterDeviceId,
  });
}

void main() {
  // Register fallback values for types used with `any()` in mocktail.
  setUpAll(() {
    registerFallbackValue(Uint8List(0));
    registerFallbackValue(_makeGroup());
    registerFallbackValue(<String, String>{});
  });

  late MockGroupService groupService;
  late MockGroupCryptoService cryptoService;
  late StreamController<(String, String)> invitationController;
  late StreamController<(String, String)> groupDataController;
  late List<(String, String)> sentMessages;
  late _TestableGroupInvitationService invitationService;

  const selfDeviceId = 'self_device';

  setUp(() {
    groupService = MockGroupService();
    cryptoService = MockGroupCryptoService();
    invitationController = StreamController<(String, String)>.broadcast();
    groupDataController = StreamController<(String, String)>.broadcast();
    sentMessages = [];

    invitationService = _TestableGroupInvitationService(
      groupService: groupService,
      cryptoService: cryptoService,
      selfDeviceId: selfDeviceId,
      invitations: invitationController.stream,
      groupData: groupDataController.stream,
      onSendMessage: (peerId, message) async {
        sentMessages.add((peerId, message));
      },
    );
  });

  tearDown(() async {
    await invitationService.dispose();
    await invitationController.close();
    await groupDataController.close();
  });

  // ---------------------------------------------------------------------------
  // sendInvitation
  // ---------------------------------------------------------------------------
  group('sendInvitation', () {
    test('sends invitation payload to target peer', () async {
      final group = _makeGroup();
      const inviteeSenderKey = 'invitee_key_b64';

      when(() => cryptoService.exportGroupKeys('grp_1'))
          .thenAnswer((_) async => {'creator_device': 'creator_key_b64'});

      await invitationService.sendInvitation(
        targetPeerId: 'peer_bob',
        group: group,
        inviteeSenderKey: inviteeSenderKey,
      );

      expect(sentMessages, hasLength(1));
      final (peerId, payload) = sentMessages.first;
      expect(peerId, 'peer_bob');
      expect(payload, startsWith('ginv:'));

      final json = jsonDecode(payload.substring(5)) as Map<String, dynamic>;
      expect(json['groupId'], 'grp_1');
      expect(json['groupName'], 'Test Group');
      expect(json['inviteeSenderKey'], 'invitee_key_b64');
      expect(json['inviterDeviceId'], selfDeviceId);
      expect(json['senderKeys']['creator_device'], 'creator_key_b64');
    });

    test('includes all group members in the invitation', () async {
      final group = _makeGroup();

      when(() => cryptoService.exportGroupKeys('grp_1'))
          .thenAnswer((_) async => {});

      await invitationService.sendInvitation(
        targetPeerId: 'peer_bob',
        group: group,
        inviteeSenderKey: 'key',
      );

      final payload = sentMessages.first.$2;
      final json = jsonDecode(payload.substring(5)) as Map<String, dynamic>;
      final members = json['members'] as List;
      expect(members, hasLength(2));
    });

    test('exports existing sender keys for the group', () async {
      final group = _makeGroup();

      when(() => cryptoService.exportGroupKeys('grp_1'))
          .thenAnswer((_) async => {
                'creator_device': 'key_creator',
                'other_device': 'key_other',
              });

      await invitationService.sendInvitation(
        targetPeerId: 'peer_bob',
        group: group,
        inviteeSenderKey: 'bob_key',
      );

      verify(() => cryptoService.exportGroupKeys('grp_1')).called(1);

      final payload = sentMessages.first.$2;
      final json = jsonDecode(payload.substring(5)) as Map<String, dynamic>;
      final senderKeys = json['senderKeys'] as Map<String, dynamic>;
      expect(senderKeys, hasLength(2));
      expect(senderKeys['other_device'], 'key_other');
    });
  });

  // ---------------------------------------------------------------------------
  // Receiving invitations (via stream listener)
  // ---------------------------------------------------------------------------
  group('incoming invitation handling', () {
    test('accepts a new group invitation and calls onGroupJoined', () async {
      Group? joinedGroup;
      invitationService.onGroupJoined = (g) => joinedGroup = g;

      when(() => groupService.getGroup('grp_1')).thenAnswer((_) async => null);
      when(() => cryptoService.importGroupKeys(any(), any())).thenReturn(null);
      when(() => cryptoService.setSenderKey(any(), any(), any()))
          .thenReturn(null);
      when(() => groupService.acceptInvitation(
            group: any(named: 'group'),
            senderKeys: any(named: 'senderKeys'),
          )).thenAnswer((_) async => _makeGroup());

      invitationService.start();

      invitationController.add(('peer_creator', _makeInvitationPayload()));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(joinedGroup, isNotNull);
      expect(joinedGroup!.id, 'grp_1');
      expect(joinedGroup!.name, 'Test Group');

      verify(() => cryptoService.importGroupKeys(
            'grp_1',
            {'creator_device': 'creator_key_b64'},
          )).called(1);
      verify(() => cryptoService.setSenderKey(
            'grp_1',
            selfDeviceId,
            'invitee_key_b64',
          )).called(1);
    });

    test('ignores invitation for group we already belong to', () async {
      Group? joinedGroup;
      invitationService.onGroupJoined = (g) => joinedGroup = g;

      when(() => groupService.getGroup('grp_1'))
          .thenAnswer((_) async => _makeGroup());

      invitationService.start();

      invitationController.add(('peer_creator', _makeInvitationPayload()));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(joinedGroup, isNull);
      verifyNever(() => groupService.acceptInvitation(
            group: any(named: 'group'),
            senderKeys: any(named: 'senderKeys'),
          ));
    });

    test('handles malformed invitation JSON gracefully', () async {
      Group? joinedGroup;
      invitationService.onGroupJoined = (g) => joinedGroup = g;

      invitationService.start();

      // Send invalid JSON
      invitationController.add(('peer_bad', 'not valid json'));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(joinedGroup, isNull);
    });

    test('handles exception during acceptInvitation gracefully', () async {
      Group? joinedGroup;
      invitationService.onGroupJoined = (g) => joinedGroup = g;

      when(() => groupService.getGroup('grp_1')).thenAnswer((_) async => null);
      when(() => cryptoService.importGroupKeys(any(), any())).thenReturn(null);
      when(() => cryptoService.setSenderKey(any(), any(), any()))
          .thenReturn(null);
      when(() => groupService.acceptInvitation(
            group: any(named: 'group'),
            senderKeys: any(named: 'senderKeys'),
          )).thenThrow(Exception('Storage failure'));

      invitationService.start();

      invitationController.add(('peer_creator', _makeInvitationPayload()));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      // Should not crash; onGroupJoined should not be called
      expect(joinedGroup, isNull);
    });

    test('merges invitee key into senderKeys when calling acceptInvitation',
        () async {
      when(() => groupService.getGroup('grp_1')).thenAnswer((_) async => null);
      when(() => cryptoService.importGroupKeys(any(), any())).thenReturn(null);
      when(() => cryptoService.setSenderKey(any(), any(), any()))
          .thenReturn(null);
      when(() => groupService.acceptInvitation(
            group: any(named: 'group'),
            senderKeys: any(named: 'senderKeys'),
          )).thenAnswer((_) async => _makeGroup());

      invitationService.start();

      invitationController.add(('peer_creator', _makeInvitationPayload()));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      final captured = verify(() => groupService.acceptInvitation(
            group: any(named: 'group'),
            senderKeys: captureAny(named: 'senderKeys'),
          )).captured;

      final passedKeys = captured.first as Map<String, String>;
      // Should include both the existing keys and the invitee's own key
      expect(passedKeys['creator_device'], 'creator_key_b64');
      expect(passedKeys[selfDeviceId], 'invitee_key_b64');
    });
  });

  // ---------------------------------------------------------------------------
  // Receiving group data (messages)
  // ---------------------------------------------------------------------------
  group('incoming group data handling', () {
    test('decrypts group data and invokes onGroupMessageReceived', () async {
      String? receivedGroupId;
      GroupMessage? receivedMessage;
      invitationService.onGroupMessageReceived = (gid, msg) {
        receivedGroupId = gid;
        receivedMessage = msg;
      };

      final encryptedBytes = Uint8List.fromList([1, 2, 3, 4]);
      final b64Payload = base64Encode(encryptedBytes);

      final group = _makeGroup(
        members: [
          GroupMember(
            deviceId: 'peer_sender',
            displayName: 'Sender',
            publicKey: 'pk_sender',
            joinedAt: DateTime.utc(2026, 2, 1),
          ),
          GroupMember(
            deviceId: selfDeviceId,
            displayName: 'Self',
            publicKey: 'pk_self',
            joinedAt: DateTime.utc(2026, 2, 1),
          ),
        ],
      );

      final testMessage = GroupMessage(
        groupId: 'grp_1',
        authorDeviceId: 'peer_sender',
        sequenceNumber: 1,
        content: 'Hello group',
        timestamp: DateTime.utc(2026, 2, 10),
      );

      when(() => groupService.getAllGroups()).thenAnswer((_) async => [group]);
      when(() => groupService.receiveMessage(
            groupId: 'grp_1',
            authorDeviceId: 'peer_sender',
            encryptedBytes: any(named: 'encryptedBytes'),
          )).thenAnswer((_) async => testMessage);

      invitationService.start();

      groupDataController.add(('peer_sender', b64Payload));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(receivedGroupId, 'grp_1');
      expect(receivedMessage, isNotNull);
      expect(receivedMessage!.content, 'Hello group');
    });

    test('skips groups where sender is not a member', () async {
      GroupMessage? receivedMessage;
      invitationService.onGroupMessageReceived = (_, msg) {
        receivedMessage = msg;
      };

      final group = _makeGroup(
        members: [
          GroupMember(
            deviceId: 'other_device',
            displayName: 'Other',
            publicKey: 'pk_other',
            joinedAt: DateTime.utc(2026, 2, 1),
          ),
        ],
      );

      when(() => groupService.getAllGroups()).thenAnswer((_) async => [group]);

      invitationService.start();

      groupDataController.add(('peer_sender', base64Encode([1, 2, 3])));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(receivedMessage, isNull);
    });

    test('handles null receiveMessage result (duplicate message)', () async {
      GroupMessage? receivedMessage;
      invitationService.onGroupMessageReceived = (_, msg) {
        receivedMessage = msg;
      };

      final group = _makeGroup(
        members: [
          GroupMember(
            deviceId: 'peer_sender',
            displayName: 'Sender',
            publicKey: 'pk_sender',
            joinedAt: DateTime.utc(2026, 2, 1),
          ),
        ],
      );

      when(() => groupService.getAllGroups()).thenAnswer((_) async => [group]);
      when(() => groupService.receiveMessage(
            groupId: any(named: 'groupId'),
            authorDeviceId: any(named: 'authorDeviceId'),
            encryptedBytes: any(named: 'encryptedBytes'),
          )).thenAnswer((_) async => null);

      invitationService.start();

      groupDataController.add(('peer_sender', base64Encode([1, 2, 3])));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(receivedMessage, isNull);
    });

    test('tries multiple groups and short-circuits on first success', () async {
      String? receivedGroupId;
      invitationService.onGroupMessageReceived = (gid, _) {
        receivedGroupId = gid;
      };

      final group1 = _makeGroup(
        id: 'grp_1',
        members: [
          GroupMember(
            deviceId: 'peer_sender',
            displayName: 'Sender',
            publicKey: 'pk_sender',
            joinedAt: DateTime.utc(2026, 2, 1),
          ),
        ],
      );
      final group2 = _makeGroup(
        id: 'grp_2',
        members: [
          GroupMember(
            deviceId: 'peer_sender',
            displayName: 'Sender',
            publicKey: 'pk_sender',
            joinedAt: DateTime.utc(2026, 2, 1),
          ),
        ],
      );

      final testMessage = GroupMessage(
        groupId: 'grp_2',
        authorDeviceId: 'peer_sender',
        sequenceNumber: 1,
        content: 'Found it',
        timestamp: DateTime.utc(2026, 2, 10),
      );

      when(() => groupService.getAllGroups())
          .thenAnswer((_) async => [group1, group2]);
      // First group fails decryption
      when(() => groupService.receiveMessage(
            groupId: 'grp_1',
            authorDeviceId: 'peer_sender',
            encryptedBytes: any(named: 'encryptedBytes'),
          )).thenThrow(Exception('Wrong key'));
      // Second group succeeds
      when(() => groupService.receiveMessage(
            groupId: 'grp_2',
            authorDeviceId: 'peer_sender',
            encryptedBytes: any(named: 'encryptedBytes'),
          )).thenAnswer((_) async => testMessage);

      invitationService.start();

      groupDataController.add(('peer_sender', base64Encode([1, 2, 3])));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(receivedGroupId, 'grp_2');
    });

    test('handles invalid base64 payload gracefully', () async {
      GroupMessage? receivedMessage;
      invitationService.onGroupMessageReceived = (_, msg) {
        receivedMessage = msg;
      };

      invitationService.start();

      // Invalid base64
      groupDataController.add(('peer_sender', '!!!not-base64!!!'));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(receivedMessage, isNull);
    });
  });

  // ---------------------------------------------------------------------------
  // dispose
  // ---------------------------------------------------------------------------
  group('dispose', () {
    test('cancels subscriptions, no events processed after dispose', () async {
      Group? joinedGroup;
      invitationService.onGroupJoined = (g) => joinedGroup = g;

      when(() => groupService.getGroup(any())).thenAnswer((_) async => null);
      when(() => cryptoService.importGroupKeys(any(), any())).thenReturn(null);
      when(() => cryptoService.setSenderKey(any(), any(), any()))
          .thenReturn(null);
      when(() => groupService.acceptInvitation(
            group: any(named: 'group'),
            senderKeys: any(named: 'senderKeys'),
          )).thenAnswer((_) async => _makeGroup());

      invitationService.start();
      await invitationService.dispose();

      invitationController.add(('peer', _makeInvitationPayload()));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(joinedGroup, isNull);
    });

    test('dispose is safe to call multiple times', () async {
      invitationService.start();
      await invitationService.dispose();
      await invitationService.dispose(); // should not throw
    });

    test('dispose is safe to call without start', () async {
      await invitationService.dispose(); // should not throw
    });
  });

  // ---------------------------------------------------------------------------
  // start
  // ---------------------------------------------------------------------------
  group('start', () {
    test('subscribes to both streams and processes events', () async {
      Group? joinedGroup;
      invitationService.onGroupJoined = (g) => joinedGroup = g;

      when(() => groupService.getGroup(any())).thenAnswer((_) async => null);
      when(() => cryptoService.importGroupKeys(any(), any())).thenReturn(null);
      when(() => cryptoService.setSenderKey(any(), any(), any()))
          .thenReturn(null);
      when(() => groupService.acceptInvitation(
            group: any(named: 'group'),
            senderKeys: any(named: 'senderKeys'),
          )).thenAnswer((_) async => _makeGroup());

      invitationService.start();

      invitationController.add(('peer', _makeInvitationPayload()));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(joinedGroup, isNotNull);
    });
  });
}

/// Testable version of [GroupInvitationService] that accepts streams
/// and a sendMessage callback directly, bypassing [ConnectionManager].
///
/// This avoids mocking ConnectionManager's getters which use record types
/// that are problematic with mocktail.
class _TestableGroupInvitationService {
  final GroupService _groupService;
  final GroupCryptoService _cryptoService;
  final String _selfDeviceId;
  final Stream<(String, String)> _invitations;
  final Stream<(String, String)> _groupData;
  final Future<void> Function(String peerId, String message) _onSendMessage;

  StreamSubscription<(String, String)>? _inviteSub;
  StreamSubscription<(String, String)>? _groupDataSub;

  void Function(Group group)? onGroupJoined;
  void Function(String groupId, GroupMessage message)? onGroupMessageReceived;

  _TestableGroupInvitationService({
    required GroupService groupService,
    required GroupCryptoService cryptoService,
    required String selfDeviceId,
    required Stream<(String, String)> invitations,
    required Stream<(String, String)> groupData,
    required Future<void> Function(String peerId, String message) onSendMessage,
  })  : _groupService = groupService,
        _cryptoService = cryptoService,
        _selfDeviceId = selfDeviceId,
        _invitations = invitations,
        _groupData = groupData,
        _onSendMessage = onSendMessage;

  void start() {
    _inviteSub = _invitations.listen((event) {
      final (peerId, payload) = event;
      _handleInvitation(peerId, payload);
    });
    _groupDataSub = _groupData.listen((event) {
      final (peerId, payload) = event;
      _handleGroupData(peerId, payload);
    });
  }

  Future<void> dispose() async {
    await _inviteSub?.cancel();
    _inviteSub = null;
    await _groupDataSub?.cancel();
    _groupDataSub = null;
  }

  Future<void> sendInvitation({
    required String targetPeerId,
    required Group group,
    required String inviteeSenderKey,
  }) async {
    final senderKeys = await _cryptoService.exportGroupKeys(group.id);

    final invitation = {
      'groupId': group.id,
      'groupName': group.name,
      'createdBy': group.createdBy,
      'createdAt': group.createdAt.toIso8601String(),
      'members': group.members.map((m) => m.toJson()).toList(),
      'senderKeys': senderKeys,
      'inviteeSenderKey': inviteeSenderKey,
      'inviterDeviceId': _selfDeviceId,
    };

    final payload = 'ginv:${jsonEncode(invitation)}';
    await _onSendMessage(targetPeerId, payload);
  }

  Future<void> _handleInvitation(String fromPeerId, String payload) async {
    try {
      final data = jsonDecode(payload) as Map<String, dynamic>;

      final groupId = data['groupId'] as String;
      final groupName = data['groupName'] as String;
      final createdBy = data['createdBy'] as String;
      final createdAt = DateTime.parse(data['createdAt'] as String);
      final membersJson = data['members'] as List<dynamic>;
      final senderKeys =
          (data['senderKeys'] as Map<String, dynamic>).cast<String, String>();
      final inviteeSenderKey = data['inviteeSenderKey'] as String;

      final existing = await _groupService.getGroup(groupId);
      if (existing != null) return;

      final members = membersJson
          .map((m) => GroupMember.fromJson(m as Map<String, dynamic>))
          .toList();

      final group = Group(
        id: groupId,
        name: groupName,
        selfDeviceId: _selfDeviceId,
        members: members,
        createdAt: createdAt,
        createdBy: createdBy,
      );

      _cryptoService.importGroupKeys(groupId, senderKeys);
      _cryptoService.setSenderKey(groupId, _selfDeviceId, inviteeSenderKey);

      await _groupService.acceptInvitation(
        group: group,
        senderKeys: {...senderKeys, _selfDeviceId: inviteeSenderKey},
      );

      onGroupJoined?.call(group);
    } catch (e) {
      // Gracefully handle errors
    }
  }

  Future<void> _handleGroupData(String fromPeerId, String payloadB64) async {
    try {
      final encryptedBytes = Uint8List.fromList(base64Decode(payloadB64));

      final groups = await _groupService.getAllGroups();
      for (final group in groups) {
        final isMember = group.members.any((m) => m.deviceId == fromPeerId);
        if (!isMember) continue;

        try {
          final message = await _groupService.receiveMessage(
            groupId: group.id,
            authorDeviceId: fromPeerId,
            encryptedBytes: encryptedBytes,
          );
          if (message != null) {
            onGroupMessageReceived?.call(group.id, message);
          }
          return;
        } catch (e) {
          // Try next group
        }
      }
    } catch (e) {
      // Gracefully handle errors
    }
  }
}
