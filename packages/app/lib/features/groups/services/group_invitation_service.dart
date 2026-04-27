import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import '../../../core/logging/logger_service.dart';
import '../../../core/network/connection_manager.dart';
import '../models/group.dart';
import '../models/group_message.dart';
import 'group_crypto_service.dart';
import 'group_service.dart';

/// Wire prefix for group invitations sent over 1:1 P2P channels.
const String _invitePrefix = 'ginv:';

/// A group invitation that has been received but not yet accepted or declined
/// by the user.
class PendingGroupInvite {
  /// Stable identifier — the group ID. Used as the key in [acceptInvitation] /
  /// [declineInvitation] and the dedup key in the pending map.
  final String groupId;

  /// Peer ID of the inviter on the 1:1 channel that delivered the invite.
  final String fromPeerId;

  /// Display name of the group (from the wire payload).
  final String groupName;

  /// The fully-parsed [Group] object — used by [acceptInvitation] to persist.
  final Group group;

  /// All sender keys delivered with the invitation, including the invitee's
  /// own freshly-generated key for outbound messages in this group.
  final Map<String, String> senderKeys;

  /// The invitee's own sender key for this group (subset of [senderKeys]).
  final String inviteeSenderKey;

  /// Wall-clock time the invitation arrived (used for sorting / TTL display).
  final DateTime receivedAt;

  const PendingGroupInvite({
    required this.groupId,
    required this.fromPeerId,
    required this.groupName,
    required this.group,
    required this.senderKeys,
    required this.inviteeSenderKey,
    required this.receivedAt,
  });
}

/// Handles sending and receiving group invitations over existing 1:1
/// WebRTC data channels.
///
/// When a group owner adds a member, we need to deliver the group
/// metadata and sender keys to the invitee's device. This service
/// bridges the group layer to the 1:1 P2P channel.
///
/// Incoming invitations are **staged as pending** and emitted on
/// [pendingInvites]. The UI is responsible for prompting the user and
/// calling [acceptInvitation] or [declineInvitation]. The service does
/// not auto-accept (that would let any peer who knows your peer ID
/// silently insert you into a group).
class GroupInvitationService {
  final ConnectionManager _connectionManager;
  final GroupService _groupService;
  final GroupCryptoService _cryptoService;
  final String _selfDeviceId;

  StreamSubscription<(String, String)>? _inviteSub;
  StreamSubscription<(String, String)>? _groupDataSub;

  /// Pending invitations keyed by group ID. We dedupe by group ID so a peer
  /// re-sending the same invite doesn't queue duplicates for the user.
  final Map<String, PendingGroupInvite> _pendingInvites = {};

  final StreamController<PendingGroupInvite> _pendingController =
      StreamController<PendingGroupInvite>.broadcast();

  /// Stream of newly-staged group invitations awaiting user approval.
  /// UI handler should listen and show an Accept/Decline prompt.
  Stream<PendingGroupInvite> get pendingInvites => _pendingController.stream;

  /// Snapshot of currently pending invitations (e.g. for a notification badge).
  List<PendingGroupInvite> get currentPending =>
      List.unmodifiable(_pendingInvites.values);

  /// Callback invoked when a group invitation has been **accepted by the
  /// user** (via [acceptInvitation]) and the group persisted locally.
  void Function(Group group)? onGroupJoined;

  /// Callback invoked when a group message is received over a 1:1 channel.
  void Function(String groupId, GroupMessage message)? onGroupMessageReceived;

  GroupInvitationService({
    required ConnectionManager connectionManager,
    required GroupService groupService,
    required GroupCryptoService cryptoService,
    required String selfDeviceId,
  })  : _connectionManager = connectionManager,
        _groupService = groupService,
        _cryptoService = cryptoService,
        _selfDeviceId = selfDeviceId;

  /// Start listening for incoming group invitations and group messages
  /// on the dedicated streams from ConnectionManager.
  void start() {
    _inviteSub = _connectionManager.groupInvitations.listen((event) {
      final (peerId, payload) = event;
      _handleInvitation(peerId, payload);
    });
    _groupDataSub = _connectionManager.groupData.listen((event) {
      final (peerId, payload) = event;
      _handleGroupData(peerId, payload);
    });
  }

  /// Stop listening.
  Future<void> dispose() async {
    await _inviteSub?.cancel();
    _inviteSub = null;
    await _groupDataSub?.cancel();
    _groupDataSub = null;
    await _pendingController.close();
    _pendingInvites.clear();
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
  ///
  /// Parses the invitation, dedupes against existing memberships and pending
  /// queue, then **stages the invite as pending** and emits on
  /// [pendingInvites]. Does NOT touch group storage or crypto state — those
  /// happen in [acceptInvitation] only after explicit user approval.
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

      // Already a member — invite is a no-op.
      final existing = await _groupService.getGroup(groupId);
      if (existing != null) {
        logger.info(
          'GroupInvitationService',
          'Already in group "$groupName", ignoring invitation',
        );
        return;
      }

      // Already pending the same group — ignore the dup so re-sends from a
      // flaky inviter don't queue multiple identical prompts.
      if (_pendingInvites.containsKey(groupId)) {
        logger.info(
          'GroupInvitationService',
          'Invitation for "$groupName" already pending, ignoring duplicate',
        );
        return;
      }

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

      final pending = PendingGroupInvite(
        groupId: groupId,
        fromPeerId: fromPeerId,
        groupName: groupName,
        group: group,
        senderKeys: {...senderKeys, _selfDeviceId: inviteeSenderKey},
        inviteeSenderKey: inviteeSenderKey,
        receivedAt: DateTime.now(),
      );

      _pendingInvites[groupId] = pending;
      _pendingController.add(pending);

      logger.info(
        'GroupInvitationService',
        'Staged pending invitation to group "$groupName" from $fromPeerId',
      );
    } catch (e, stack) {
      logger.error(
        'GroupInvitationService',
        'Failed to handle group invitation from $fromPeerId',
        e,
        stack,
      );
    }
  }

  /// Accept a pending group invitation by ID. Persists the group + sender
  /// keys, fires [onGroupJoined], and removes the pending entry.
  ///
  /// Returns the persisted [Group] on success, or null if no pending invite
  /// exists for [groupId] (already accepted, declined, or never received).
  Future<Group?> acceptInvitation(String groupId) async {
    final pending = _pendingInvites.remove(groupId);
    if (pending == null) {
      logger.warning('GroupInvitationService',
          'acceptInvitation($groupId): no pending invite');
      return null;
    }

    try {
      _cryptoService.importGroupKeys(groupId, pending.senderKeys);
      _cryptoService.setSenderKey(
          groupId, _selfDeviceId, pending.inviteeSenderKey);

      await _groupService.acceptInvitation(
        group: pending.group,
        senderKeys: pending.senderKeys,
      );

      logger.info(
        'GroupInvitationService',
        'Accepted invitation to "${pending.groupName}" from ${pending.fromPeerId}',
      );

      onGroupJoined?.call(pending.group);
      return pending.group;
    } catch (e, stack) {
      // On failure, restore the pending entry so the user can retry.
      _pendingInvites[groupId] = pending;
      logger.error(
        'GroupInvitationService',
        'Failed to accept invitation $groupId',
        e,
        stack,
      );
      return null;
    }
  }

  /// Decline a pending group invitation by ID. Drops the pending entry
  /// silently — no message is sent back to the inviter (dropping is
  /// indistinguishable from being offline / app-killed, which is the
  /// correct privacy posture).
  bool declineInvitation(String groupId) {
    final removed = _pendingInvites.remove(groupId);
    if (removed == null) return false;
    logger.info(
      'GroupInvitationService',
      'Declined invitation to "${removed.groupName}" from ${removed.fromPeerId}',
    );
    return true;
  }

  /// Handle incoming group message data from a 1:1 peer connection.
  ///
  /// The payload is base64-encoded encrypted bytes. We try decrypting
  /// with each group where [fromPeerId] is a member.
  Future<void> _handleGroupData(String fromPeerId, String payloadB64) async {
    try {
      final encryptedBytes = Uint8List.fromList(base64Decode(payloadB64));

      // The encrypted payload has no unencrypted group-ID header (by design:
      // revealing which group a message belongs to would leak metadata).
      // We therefore try decryption against each group where fromPeerId is a
      // member. This is O(G) in the number of groups, but bounded by
      // MAX_GROUP_MEMBERS (15 groups max per user) and short-circuits on the
      // first successful decryption.
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
            logger.info(
              'GroupInvitationService',
              'Received group message from $fromPeerId in "${group.name}"',
            );
            onGroupMessageReceived?.call(group.id, message);
          }
          return;
        } catch (e) {
          logger.debug(
            'GroupInvitationService',
            'Group decrypt failed for $fromPeerId in ${group.id}: $e',
          );
        }
      }

      logger.warning(
        'GroupInvitationService',
        'Could not decrypt group data from $fromPeerId',
      );
    } catch (e, stack) {
      logger.error(
        'GroupInvitationService',
        'Failed to handle group data from $fromPeerId',
        e,
        stack,
      );
    }
  }
}
