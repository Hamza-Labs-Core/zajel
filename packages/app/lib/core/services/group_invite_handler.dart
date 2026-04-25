import 'dart:async';

import 'package:flutter/material.dart';

import '../../features/groups/services/group_invitation_service.dart';
import '../logging/logger_service.dart';

/// Listens to incoming group invitations from [GroupInvitationService] and
/// surfaces both an OS notification (for backgrounded users) and an
/// in-app Accept/Decline dialog.
///
/// Mirrors the closure-based DI pattern of `PairRequestHandler`. The actual
/// accept/decline work lives on the service; this class is just the UI
/// bridge.
class GroupInviteHandler {
  final Stream<PendingGroupInvite> pendingInvites;
  final Future<void> Function(String groupId) acceptInvitation;
  final void Function(String groupId) declineInvitation;
  final BuildContext? Function() getContext;

  /// Optional callback to dispatch an OS-level notification when an invite
  /// arrives. Decoupled via a callback (rather than holding a
  /// `NotificationService`) so this class stays pure-UI and trivially
  /// testable. Wire-through happens in `main.dart`.
  final Future<void> Function(PendingGroupInvite invite)? notifyInvite;

  StreamSubscription<PendingGroupInvite>? _subscription;

  GroupInviteHandler({
    required this.pendingInvites,
    required this.acceptInvitation,
    required this.declineInvitation,
    required this.getContext,
    this.notifyInvite,
  });

  void listen() {
    logger.info(
        'GroupInviteHandler', 'listen() called — stream subscription active');
    _subscription = pendingInvites.listen((invite) {
      logger.info('GroupInviteHandler',
          'Stream event: pending invite for ${invite.groupId} ("${invite.groupName}") — dispatching notification + dialog');
      // Fire-and-forget — never block the dialog on the OS notification.
      notifyInvite?.call(invite).catchError((Object e) {
        logger.warning(
            'GroupInviteHandler', 'notifyInvite callback failed: $e');
      });
      _showDialog(invite);
    });
  }

  Future<void> _showDialog(PendingGroupInvite invite) async {
    final context = getContext();
    if (context == null) {
      logger.warning('GroupInviteHandler',
          'No context available to show group invite dialog (rootNavigatorKey.currentContext is null)');
      return;
    }
    logger.info('GroupInviteHandler',
        'showDialog() about to be called for ${invite.groupId} (context found)');

    final accepted = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        title: const Row(
          children: [
            Icon(Icons.group_add, color: Colors.blue),
            SizedBox(width: 8),
            Text('Group Invitation'),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
                'You have been invited to join the group "${invite.groupName}".'),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.grey.shade100,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Group',
                    style: TextStyle(fontSize: 12, color: Colors.grey),
                  ),
                  Text(
                    invite.groupName,
                    style: const TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    '${invite.group.members.length} members',
                    style: const TextStyle(fontSize: 12, color: Colors.grey),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.orange.shade50,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: Colors.orange.shade200),
              ),
              child: const Row(
                children: [
                  Icon(Icons.warning_amber, color: Colors.orange, size: 20),
                  SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Only accept if you trust the inviter. Joining shares '
                      'your identity with all current group members.',
                      style: TextStyle(fontSize: 12),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Decline'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Accept'),
          ),
        ],
      ),
    );

    if (accepted == true) {
      logger.info('GroupInviteHandler',
          'User accepted invite ${invite.groupId} — calling acceptInvitation');
      await acceptInvitation(invite.groupId);
    } else {
      logger.info('GroupInviteHandler',
          'User declined invite ${invite.groupId} — calling declineInvitation');
      declineInvitation(invite.groupId);
    }
  }

  void dispose() {
    _subscription?.cancel();
  }
}
