import 'dart:async';
import 'dart:convert';

import '../../../core/logging/logger_service.dart';
import '../../../core/network/connection_manager.dart';
import '../models/group.dart';
import 'group_crypto_service.dart';
import 'group_service.dart';

/// Wire prefix for group invitations sent over 1:1 P2P channels.
const String _invitePrefix = 'ginv:';

/// Handles sending and receiving group invitations over existing 1:1
/// WebRTC data channels.
///
/// When a group owner adds a member, we need to deliver the group
/// metadata and sender keys to the invitee's device. This service
/// bridges the group layer to the 1:1 P2P channel.
class GroupInvitationService {
  final ConnectionManager _connectionManager;
  final GroupService _groupService;
  final GroupCryptoService _cryptoService;
  final String _selfDeviceId;

  StreamSubscription<(String, String)>? _messageSub;

  /// Callback invoked when a group invitation is received and accepted.
  void Function(Group group)? onGroupJoined;

  GroupInvitationService({
    required ConnectionManager connectionManager,
    required GroupService groupService,
    required GroupCryptoService cryptoService,
    required String selfDeviceId,
  })  : _connectionManager = connectionManager,
        _groupService = groupService,
        _cryptoService = cryptoService,
        _selfDeviceId = selfDeviceId;

  /// Start listening for incoming group invitations on the 1:1 message stream.
  void start() {
    _messageSub = _connectionManager.messages.listen((event) {
      final (peerId, message) = event;
      if (message.startsWith(_invitePrefix)) {
        _handleInvitation(peerId, message.substring(_invitePrefix.length));
      }
    });
  }

  /// Stop listening.
  Future<void> dispose() async {
    await _messageSub?.cancel();
    _messageSub = null;
  }

  /// Send a group invitation to a peer over the 1:1 data channel.
  ///
  /// The invitation includes:
  /// - Group metadata (id, name, members)
  /// - All existing members' sender keys (so invitee can decrypt)
  /// - A new sender key for the invitee (so invitee can encrypt)
  Future<void> sendInvitation({
    required String targetPeerId,
    required Group group,
    required String inviteeSenderKey,
  }) async {
    // Collect all sender keys the invitee needs
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

    final payload = '$_invitePrefix${jsonEncode(invitation)}';
    await _connectionManager.sendMessage(targetPeerId, payload);

    logger.info(
      'GroupInvitationService',
      'Sent group invitation for "${group.name}" to $targetPeerId',
    );
  }

  /// Handle an incoming group invitation.
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

      // Check if we already have this group
      final existing = await _groupService.getGroup(groupId);
      if (existing != null) {
        logger.info(
          'GroupInvitationService',
          'Already in group "$groupName", ignoring invitation',
        );
        return;
      }

      // Parse members
      final members = membersJson
          .map((m) => GroupMember.fromJson(m as Map<String, dynamic>))
          .toList();

      // Create the group locally
      final group = Group(
        id: groupId,
        name: groupName,
        selfDeviceId: _selfDeviceId,
        members: members,
        createdAt: createdAt,
        createdBy: createdBy,
      );

      // Import sender keys for all existing members
      _cryptoService.importGroupKeys(groupId, senderKeys);

      // Set our own sender key
      _cryptoService.setSenderKey(groupId, _selfDeviceId, inviteeSenderKey);

      // Persist group and keys via the service
      await _groupService.acceptInvitation(
        group: group,
        senderKeys: {...senderKeys, _selfDeviceId: inviteeSenderKey},
      );

      logger.info(
        'GroupInvitationService',
        'Accepted invitation to group "$groupName" from $fromPeerId',
      );

      onGroupJoined?.call(group);
    } catch (e, stack) {
      logger.error(
        'GroupInvitationService',
        'Failed to handle group invitation from $fromPeerId',
        e,
        stack,
      );
    }
  }
}
