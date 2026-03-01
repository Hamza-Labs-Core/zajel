import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/logging/logger_service.dart';
import '../../core/models/peer.dart';
import '../../core/providers/app_providers.dart';
import '../../shared/widgets/compose_bar.dart';
import 'models/group.dart';
import 'providers/group_providers.dart';
import 'services/group_connection_service.dart';

/// Screen showing details and messages for a single group.
class GroupDetailScreen extends ConsumerStatefulWidget {
  final String groupId;

  const GroupDetailScreen({super.key, required this.groupId});

  @override
  ConsumerState<GroupDetailScreen> createState() => _GroupDetailScreenState();
}

class _GroupDetailScreenState extends ConsumerState<GroupDetailScreen> {
  final _messageController = TextEditingController();
  final _messageFocusNode = FocusNode();
  bool _sending = false;
  bool _groupActivated = false;

  // Cache the connection service reference before dispose, since
  // ref.read() throws after the widget is disposed.
  GroupConnectionService? _cachedConnectionService;

  @override
  void initState() {
    super.initState();
    _activateGroupConnection();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(activeScreenProvider.notifier).state =
          ActiveScreen(type: 'group', id: widget.groupId);
    });
  }

  Future<void> _activateGroupConnection() async {
    try {
      final groupService = ref.read(groupServiceProvider);
      final group = await groupService.getGroup(widget.groupId);
      if (group != null && mounted) {
        _cachedConnectionService = ref.read(groupConnectionServiceProvider);
        await _cachedConnectionService!.activateGroup(group);
        _groupActivated = true;
      }
    } catch (e) {
      logger.error('GroupDetailScreen',
          'Failed to activate mesh for group ${widget.groupId}', e);
    }
  }

  @override
  void dispose() {
    try {
      ref.read(activeScreenProvider.notifier).state = ActiveScreen.other;
    } catch (_) {} // ref may be invalid during tree teardown
    if (_groupActivated && _cachedConnectionService != null) {
      try {
        _cachedConnectionService!.deactivateGroup(widget.groupId);
      } catch (e) {
        logger.error('GroupDetailScreen',
            'Failed to deactivate mesh for group ${widget.groupId}', e);
      }
    }
    _messageController.dispose();
    _messageFocusNode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final groupAsync = ref.watch(groupByIdProvider(widget.groupId));
    final messagesAsync = ref.watch(groupMessagesProvider(widget.groupId));

    return Scaffold(
      appBar: AppBar(
        title: groupAsync.when(
          loading: () => const Text('Group'),
          error: (_, __) => const Text('Group'),
          data: (group) => Text(group?.name ?? 'Unknown Group'),
        ),
        actions: [
          groupAsync.when(
            loading: () => const SizedBox.shrink(),
            error: (_, __) => const SizedBox.shrink(),
            data: (group) {
              if (group == null) return const SizedBox.shrink();
              return Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  IconButton(
                    icon: const Icon(Icons.person_add),
                    tooltip: 'Add member',
                    onPressed: () => _showAddMemberDialog(context, group),
                  ),
                  IconButton(
                    icon: const Icon(Icons.people),
                    tooltip: '${group.memberCount} members',
                    onPressed: () => _showMembersSheet(context, group),
                  ),
                ],
              );
            },
          ),
        ],
      ),
      body: groupAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, stack) => Center(
          child: Text('Error loading group: $error'),
        ),
        data: (group) {
          if (group == null) {
            return const Center(
              child: Text('Group not found'),
            );
          }

          return Column(
            children: [
              Expanded(
                child: messagesAsync.when(
                  loading: () =>
                      const Center(child: CircularProgressIndicator()),
                  error: (error, stack) => Center(
                    child: Text('Error loading messages: $error'),
                  ),
                  data: (messages) {
                    if (messages.isEmpty) {
                      return const Center(
                        child: Text(
                          'No messages yet.\nSend the first message!',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: Colors.grey),
                        ),
                      );
                    }

                    return ListView.builder(
                      reverse: true,
                      itemCount: messages.length,
                      padding: const EdgeInsets.all(8),
                      itemBuilder: (context, index) {
                        final msg = messages[messages.length - 1 - index];
                        final isOutgoing = msg.isOutgoing;
                        return Align(
                          alignment: isOutgoing
                              ? Alignment.centerRight
                              : Alignment.centerLeft,
                          child: GestureDetector(
                            onLongPressStart: (details) {
                              _showMessageCopyMenu(
                                context,
                                details.globalPosition,
                                msg.content,
                              );
                            },
                            onSecondaryTapDown: (details) {
                              _showMessageCopyMenu(
                                context,
                                details.globalPosition,
                                msg.content,
                              );
                            },
                            child: Container(
                              margin: const EdgeInsets.symmetric(vertical: 4),
                              padding: const EdgeInsets.all(12),
                              constraints: BoxConstraints(
                                maxWidth:
                                    MediaQuery.of(context).size.width * 0.75,
                              ),
                              decoration: BoxDecoration(
                                color: isOutgoing
                                    ? Theme.of(context)
                                        .colorScheme
                                        .primaryContainer
                                    : Theme.of(context)
                                        .colorScheme
                                        .surfaceContainerHighest,
                                borderRadius: BorderRadius.circular(12),
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  if (!isOutgoing)
                                    Padding(
                                      padding: const EdgeInsets.only(bottom: 4),
                                      child: Text(
                                        _resolveAuthorName(
                                            group, msg.authorDeviceId),
                                        style: TextStyle(
                                          fontSize: 12,
                                          fontWeight: FontWeight.bold,
                                          color: Theme.of(context)
                                              .colorScheme
                                              .primary,
                                        ),
                                      ),
                                    ),
                                  Text(msg.content),
                                ],
                              ),
                            ),
                          ),
                        );
                      },
                    );
                  },
                ),
              ),
              ComposeBar(
                controller: _messageController,
                focusNode: _messageFocusNode,
                onSend: _sendMessage,
                isSending: _sending,
              ),
            ],
          );
        },
      ),
    );
  }

  Future<void> _sendMessage() async {
    final text = _messageController.text.trim();
    if (text.isEmpty) return;

    setState(() => _sending = true);
    _messageController.clear();

    try {
      final groupService = ref.read(groupServiceProvider);
      final connectionService = ref.read(groupConnectionServiceProvider);
      final cryptoService = ref.read(cryptoServiceProvider);

      final result = await groupService.sendMessage(
        groupId: widget.groupId,
        selfDeviceId: cryptoService.stableId,
        content: text,
      );

      // Broadcast encrypted bytes to connected group members via mesh
      final meshCount = await connectionService.broadcastToGroup(
        widget.groupId,
        result.encryptedBytes,
      );

      logger.info('GroupDetailScreen',
          'broadcastToGroup returned meshCount=$meshCount');

      // Fallback: also send via 1-on-1 direct connections for group
      // members who are directly connected peers (e.g. HeadlessBob).
      // This handles the case where mesh group_ connections aren't
      // established but the member is reachable as a regular peer.
      if (meshCount == 0) {
        final group = await groupService.getGroup(widget.groupId);
        if (group != null) {
          final connectionManager = ref.read(connectionManagerProvider);
          final directPeers = connectionManager.currentPeers
              .where((p) => p.connectionState == PeerConnectionState.connected)
              .map((p) => p.id)
              .toSet();

          logger.info(
              'GroupDetailScreen',
              'Direct fallback: otherMembers=${group.otherMembers.map((m) => m.deviceId).toList()}, '
                  'directPeers=$directPeers');

          final payload = 'grp:${base64Encode(result.encryptedBytes)}';
          for (final member in group.otherMembers) {
            if (directPeers.contains(member.deviceId)) {
              try {
                logger.info('GroupDetailScreen',
                    'Sending grp: message to ${member.deviceId} (${payload.length} chars)');
                await connectionManager.sendMessage(member.deviceId, payload);
                logger.info('GroupDetailScreen',
                    'Successfully sent grp: message to ${member.deviceId}');
              } catch (e) {
                logger.error('GroupDetailScreen',
                    'Failed to send group message to ${member.deviceId}', e);
              }
            } else {
              logger.warning('GroupDetailScreen',
                  'Member ${member.deviceId} not in directPeers, skipping');
            }
          }
        } else {
          logger.warning(
              'GroupDetailScreen', 'getGroup(${widget.groupId}) returned null');
        }
      }

      // Refresh messages
      ref.invalidate(groupMessagesProvider(widget.groupId));
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to send: $e'),
            duration: const Duration(seconds: 3),
          ),
        );
      }
    } finally {
      if (mounted) {
        setState(() => _sending = false);
        _messageFocusNode.requestFocus();
      }
    }
  }

  void _showMessageCopyMenu(
      BuildContext context, Offset globalPosition, String content) {
    final overlay = Overlay.of(context).context.findRenderObject() as RenderBox;
    final position = RelativeRect.fromRect(
      globalPosition & const Size(1, 1),
      Offset.zero & overlay.size,
    );

    showMenu<String>(
      context: context,
      position: position,
      items: [
        const PopupMenuItem<String>(
          value: 'copy',
          child: Row(
            children: [
              Icon(Icons.copy, size: 18),
              SizedBox(width: 8),
              Text('Copy'),
            ],
          ),
        ),
      ],
    ).then((value) {
      if (value == 'copy') {
        Clipboard.setData(ClipboardData(text: content));
        if (!context.mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Message copied to clipboard'),
            duration: Duration(seconds: 2),
          ),
        );
      }
    });
  }

  String _resolveAuthorName(Group group, String deviceId) {
    final member = group.members.where((m) => m.deviceId == deviceId);
    if (member.isNotEmpty) return member.first.displayName;
    return deviceId.length > 8 ? '${deviceId.substring(0, 8)}...' : deviceId;
  }

  Future<void> _showAddMemberDialog(BuildContext context, Group group) async {
    final peersAsync = ref.read(visiblePeersProvider);

    final peers = peersAsync.valueOrNull;
    if (peers == null) return;

    // Filter out peers already in the group, peers without public keys,
    // and disconnected peers (can't receive invitations over WebRTC).
    final groupDeviceIds = group.members.map((m) => m.deviceId).toSet();
    final availablePeers = peers
        .where((p) =>
            p.publicKey != null &&
            !groupDeviceIds.contains(p.id) &&
            p.connectionState == PeerConnectionState.connected)
        .toList();

    if (availablePeers.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
              'No connected peers available. Peers must be online to add.'),
          duration: Duration(seconds: 3),
        ),
      );
      return;
    }

    final selectedPeer = await showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Add Member'),
        content: SizedBox(
          width: double.maxFinite,
          child: ListView.builder(
            shrinkWrap: true,
            itemCount: availablePeers.length,
            itemBuilder: (context, index) {
              final peer = availablePeers[index];
              return ListTile(
                leading: Stack(
                  children: [
                    const Icon(Icons.person),
                    Positioned(
                      right: 0,
                      bottom: 0,
                      child: Container(
                        width: 10,
                        height: 10,
                        decoration: BoxDecoration(
                          color: Colors.green,
                          shape: BoxShape.circle,
                          border: Border.all(color: Colors.white, width: 1.5),
                        ),
                      ),
                    ),
                  ],
                ),
                title: Text(peer.displayName),
                subtitle: Text(
                  peer.publicKey!.length > 16
                      ? '${peer.publicKey!.substring(0, 16)}...'
                      : peer.publicKey!,
                  style: const TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 11,
                  ),
                ),
                onTap: () => Navigator.pop(context, peer),
              );
            },
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
        ],
      ),
    );

    if (selectedPeer != null) {
      try {
        final groupService = ref.read(groupServiceProvider);
        final cryptoService = ref.read(groupCryptoServiceProvider);
        final invitationService = ref.read(groupInvitationServiceProvider);
        final senderKey = await cryptoService.generateSenderKey();

        final updatedGroup = await groupService.addMember(
          groupId: widget.groupId,
          newMember: GroupMember(
            deviceId: selectedPeer.id,
            displayName: selectedPeer.displayName,
            publicKey: selectedPeer.publicKey!,
            joinedAt: DateTime.now(),
          ),
          newMemberSenderKey: senderKey,
        );

        // Send the invitation over the 1:1 P2P channel
        await invitationService.sendInvitation(
          targetPeerId: selectedPeer.id,
          group: updatedGroup,
          inviteeSenderKey: senderKey,
        );

        ref.invalidate(groupByIdProvider(widget.groupId));

        if (!context.mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Invitation sent to ${selectedPeer.displayName}'),
            duration: const Duration(seconds: 3),
          ),
        );
      } catch (e) {
        if (!context.mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to add member: $e'),
            duration: const Duration(seconds: 3),
          ),
        );
      }
    }
  }

  void _showMembersSheet(BuildContext context, Group group) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (context) => DraggableScrollableSheet(
        initialChildSize: 0.4,
        minChildSize: 0.25,
        maxChildSize: 0.75,
        expand: false,
        builder: (context, scrollController) => SafeArea(
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.all(16),
                child: Text(
                  'Members (${group.memberCount})',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              const Divider(height: 1),
              Expanded(
                child: ListView.builder(
                  controller: scrollController,
                  itemCount: group.members.length,
                  itemBuilder: (context, index) {
                    final member = group.members[index];
                    final isSelf = member.deviceId == group.selfDeviceId;
                    return ListTile(
                      leading: CircleAvatar(
                        backgroundColor: isSelf
                            ? Theme.of(context).colorScheme.primaryContainer
                            : Theme.of(context)
                                .colorScheme
                                .surfaceContainerHighest,
                        child: Icon(
                          isSelf ? Icons.person : Icons.person_outline,
                          color: isSelf
                              ? Theme.of(context).colorScheme.primary
                              : null,
                        ),
                      ),
                      title: Text(
                        member.displayName,
                        style: isSelf
                            ? const TextStyle(fontWeight: FontWeight.bold)
                            : null,
                      ),
                      subtitle: Text(isSelf ? 'You' : 'Member'),
                      trailing: isSelf
                          ? null
                          : Icon(
                              Icons.circle,
                              size: 10,
                              color: Colors.green.shade400,
                            ),
                    );
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
